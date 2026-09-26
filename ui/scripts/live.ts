// Local preview of the site (not part of CI). A fresh Anvil, the protocol deployed, then:
//   1. the settled week (skip with --no-settled): a 7D market from 2026-09-11 00:00 UTC, run to maturity on the real
//      1-minute data of the local store and settled, in which the taker holds Long and Short — so /redeem.html has
//      something to redeem;
//   2. the live week: the 7D / 14D / 28D markets from 2026-09-18 00:00 UTC created together (DEC-27) from calibrations
//      with that cutoff (S06 adopted values, as on testnet); the maker funded with 1,000,000 tUSDC by the owner and its
//      books opened with the testnet settings (DEC-33, testnet.sh maker). From there the chain clock runs in real
//      time and the reporter posts the local store's data every 5 minutes as chain time passes.
// The pages are served with the taker as a dev account (unlocked on Anvil); its tUSDC goes into the settled week's
// positions, so it starts at zero — use Get tUSDC. Ctrl+C stops everything.
// --metamask: for a demo with a browser wallet instead. The chain listens on a fixed port (--rpc-port, 8545) so the
// wallet's network keeps working, config.json has no dev account, and the wallet's account (--taker <address>, or
// Anvil's public test account #8, which no role here uses) gets 100 ETH for gas and 10,000 tUSDC.
//   node scripts/live.ts [--port 5173] [--calib <dir>] [--store <dir>] [--no-settled] [--metamask [--rpc-port 8545] [--taker <address>]]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { createServer } from "vite";
import { erc20Abi, testUsdcAbi } from "../../engine/src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../engine/src/createMarket.ts";
import { finalizeTick } from "../../engine/src/finalizer.ts";
import { MakerOps, MVP_CONFIG } from "../../engine/src/maker.ts";
import { Reporter } from "../../engine/src/reporter.ts";
import { StoreSource } from "../../engine/src/sources.ts";
import { breakdown, registeredOrders, trade } from "../../engine/src/taker.ts";
import { ROOT, startChain } from "../../engine/test/anvil/harness.ts";

const T0 = 1_789_689_600; // 2026-09-18 00:00 UTC: the live markets' obsStart (the calibration cutoff)
const T_OLD = T0 - 7 * 86_400; // 2026-09-11 00:00 UTC: the settled 7D market (its obsEnd is T0)
const U = 10n ** 6n;
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("port") ?? 5173);
const settledWeek = !process.argv.includes("--no-settled");
const metamask = process.argv.includes("--metamask");
const rpcPort = Number(arg("rpc-port") ?? 8545);
const store = arg("store") ?? join(ROOT, "data", "store", "1m");
if (!existsSync(store)) throw new Error(`${store} is missing: the reporter reads the local 1-minute store (data/fetch_klines.py)`);

// calibrations, made once with the same tool as testnet.sh calib
const calibDir = arg("calib") ?? join(tmpdir(), "corrfi-local-calib");
mkdirSync(calibDir, { recursive: true });
const calib = (tenor: number, cutoff: string) => {
  const out = join(calibDir, `calib_${tenor}d_${cutoff.slice(0, 10)}.json`);
  if (!existsSync(out)) {
    const py = process.platform === "win32" ? "python" : "python3";
    const r = spawnSync(py, [join(ROOT, "data", "make_calib.py"), "--cutoff", cutoff, "--tenor", String(tenor), "--store", store, "--out", out], { cwd: ROOT, stdio: "inherit" });
    if (r.status !== 0) throw new Error(`make_calib.py failed for ${tenor}D at ${cutoff}`);
  }
  return marketInputFromCalib(out);
};

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const c = await startChain({ genesis: (settledWeek ? T_OLD : T0) - 3600, blockTime: 2, port: metamask ? rpcPort : undefined });
let server: Awaited<ReturnType<typeof createServer>> | undefined;
const stop = async () => {
  await server?.close();
  c.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());

try {
  log(`chain ${c.rpc}, protocol deployed`);
  const owner = c.wallet("owner");
  const mint = async (to: `0x${string}`, amount: bigint) =>
    c.pc.waitForTransactionReceipt({ hash: await owner.writeContract({ address: c.dep.usdc, abi: testUsdcAbi, functionName: "mint", args: [to, amount] }) });
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  const reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new StoreSource(store), now: c.now, log: () => {} });
  const reportAt = async (t: number) => {
    await c.setTime(Math.max(t, (await c.now()) + 1));
    await reporter.tick();
  };
  await mint(c.account("maker").address, 1_000_000n * U);
  await maker.setConfig(MVP_CONFIG);

  // ---- 1. the settled week (market #0)
  if (settledWeek) {
    await c.setTime(T_OLD - 240);
    const { id } = await createMarket(c.pc, owner, c.account("engine"), c.dep, calib(7, "2026-09-11T00:00Z"));
    await maker.open(id, 1, 55_000n * U, 105_000n * U);
    await reportAt(T_OLD + 10);
    // the taker spends exactly 1,000 tUSDC (exact-in): 800 on Long, 200 on Short (Short is cheap: stay under Qmax)
    const taker = c.wallet("taker");
    await mint(c.account("taker").address, 1_000n * U);
    await c.pc.waitForTransactionReceipt({ hash: await taker.writeContract({ address: c.dep.usdc, abi: erc20Abi, functionName: "approve", args: [c.dep.router, 1_000n * U] }) });
    for (const [side, amount] of [[0, 800n], [1, 200n]] as const) {
      const [o] = (await registeredOrders(c.pc, c.dep)).filter((x) => x.marketId === id && x.side === side);
      const b = await breakdown(c.pc, c.dep, o.order, id, side, true, true, amount * U, 2n * 10n ** 15n);
      if (b.reason !== 0) throw new Error(`settled week: the taker's trade was rejected (reason ${b.reason})`);
      await trade(c.pc, taker, c.dep, o.order, id, side, true, true, amount * U, b.limit);
    }
    for (let k = 288; k < 2016; k += 288) await reportAt(T_OLD + k * 300 + 10);
    await reportAt(T0 - 290); // bar 2015; the last one comes with the live week's first report
    log(`market #${id}: 7D from 2026-09-11 (taker holds Long and Short)`);
  }

  // ---- 2. the live week: the three tenors in the 5-minute window before obsStart (DEC-27)
  await c.setTime(T0 - 240);
  for (const t of [7, 14, 28]) {
    const { id } = await createMarket(c.pc, owner, c.account("engine"), c.dep, calib(t, "2026-09-18T00:00Z"));
    await maker.open(id, 1, 55_000n * U, 105_000n * U);
    log(`market #${id}: ${t}D`);
  }
  log("maker: 1,000,000 tUSDC, books open in every market");
  if (settledWeek) {
    await reportAt(T0 + 10); // the settled week's final bar and the live week's first
    const fin = await finalizeTick({ pc: c.pc, wc: c.wallet("anyone"), dep: c.dep, now: c.now, log: () => {} });
    log(`settled: ${JSON.stringify(fin.finalized)}`);
  }

  // start a little into the week so the markets have some history; the reporter backfills it at once
  await c.setTime(Math.max(T0 + 3600 + 10, (await c.now()) + 1));
  let running = false; // one tick at a time (a backfill can outlast the 5 s interval)
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await reporter.tick();
      if (r.posted.length || r.reports.length) log(`reporter: ${r.posted.length} point(s), reports ${r.reports.map((x) => `#${x.marketId} k=${x.k}`).join(" ") || "-"}`);
    } catch (e) {
      log(`reporter error: ${(e as Error).message.split("\n")[0]}`);
    } finally {
      running = false;
    }
  };
  await tick();

  const pub = mkdtempSync(join(tmpdir(), "corrfi-ui-"));
  const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  writeFileSync(
    join(pub, "config.json"),
    json({
      chainId: c.dep.chainId,
      chainName: "Anvil (local)",
      rpcUrl: c.rpc,
      deployment: c.dep,
      defaultMaker: c.account("maker").address,
      devAccount: metamask ? undefined : c.account("taker").address,
    }),
  );
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), publicDir: pub, server: { port, strictPort: true }, logLevel: "error" });
  await server.listen();
  if (metamask) {
    // the wallet's account: gas and tUSDC (Anvil's test key #8 is public — never send real funds to it)
    const test8 = mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: 8 });
    const who = (arg("taker") as `0x${string}` | undefined) ?? test8.address;
    await c.rpcCall("anvil_setBalance", [who, "0x56bc75e2d63100000"]); // 100 ETH
    await mint(who, 10_000n * U);
    log(`MetaMask: add a network — name "Anvil (local)", RPC URL ${c.rpc}, chain ID ${c.dep.chainId}, currency ETH`);
    if (arg("taker")) log(`MetaMask: account ${who} funded with 100 ETH and 10,000 tUSDC`);
    else log(`MetaMask: import Anvil's public test account #8 ${who} (private key ${bytesToHex(test8.getHdKey().privateKey!)}); funded with 100 ETH and 10,000 tUSDC`);
    log("MetaMask: after every restart of this script use Settings → Advanced → Clear activity tab data (old nonces and blocks)");
  }
  log(`open http://localhost:${port}/  (trade: /trade.html, Get tUSDC: /faucet.html, redeem: /redeem.html, maker: /maker.html) — Ctrl+C stops`);
  setInterval(() => void tick(), 5_000);
} catch (e) {
  await server?.close();
  c.stop();
  throw e;
}
