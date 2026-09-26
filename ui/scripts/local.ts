// Local preview of the site (not part of CI). A fresh Anvil whose clock runs in real time from shortly before
// 2026-09-18 00:00 UTC; the protocol deployed; the 7D / 14D / 28D markets created from calibrations with that cutoff
// (S06 adopted values, as on testnet); the maker funded with 1,000,000 tUSDC and its books opened with the testnet
// settings (DEC-33, testnet.sh maker); the reporter posting the real 1-minute data of the local store every 5 minutes
// as chain time passes. The pages are served with the taker as a dev account (unlocked on Anvil; it starts without
// tUSDC — use Get tUSDC). Ctrl+C stops everything.
//   node scripts/local.ts [--port 5173] [--calib <dir with calib_7.json, calib_14.json, calib_28.json>]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { testUsdcAbi } from "../../engine/src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../engine/src/createMarket.ts";
import { MakerOps, MVP_CONFIG } from "../../engine/src/maker.ts";
import { Reporter } from "../../engine/src/reporter.ts";
import { StoreSource } from "../../engine/src/sources.ts";
import { ROOT, startChain } from "../../engine/test/anvil/harness.ts";

const T0 = 1_789_689_600; // 2026-09-18 00:00 UTC: the markets' obsStart (the calibration cutoff)
const U = 10n ** 6n;
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const port = Number(arg("port") ?? 5173);
const store = join(ROOT, "data", "store", "1m");
if (!existsSync(store)) throw new Error(`${store} is missing: the reporter reads the local 1-minute store (data/fetch_klines.py)`);

// calibrations at the cutoff, made once with the same tool as testnet.sh calib
const calibDir = arg("calib") ?? join(tmpdir(), "corrfi-local-calib");
mkdirSync(calibDir, { recursive: true });
for (const t of [7, 14, 28]) {
  const out = join(calibDir, `calib_${t}.json`);
  if (existsSync(out)) continue;
  const py = process.platform === "win32" ? "python" : "python3";
  const r = spawnSync(py, [join(ROOT, "data", "make_calib.py"), "--cutoff", "2026-09-18T00:00Z", "--tenor", String(t), "--out", out], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`make_calib.py failed for ${t}D`);
}

const log = (s: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const c = await startChain({ genesis: T0 - 3600, blockTime: 2 });
let server: Awaited<ReturnType<typeof createServer>> | undefined;
const stop = async () => {
  await server?.close();
  c.stop();
  process.exit(0);
};
process.on("SIGINT", () => void stop());

try {
  log(`chain ${c.rpc}, protocol deployed`);
  await c.setTime(T0 - 240); // the 5-minute window before obsStart (DEC-27: all three tenors together)
  for (const t of [7, 14, 28]) {
    const { id } = await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(calibDir, `calib_${t}.json`)));
    log(`market #${id}: ${t}D`);
  }
  const usdc = { address: c.dep.usdc, abi: testUsdcAbi } as const;
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ ...usdc, functionName: "mint", args: [c.account("maker").address, 1_000_000n * U] }) });
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  for (const id of [0, 1, 2]) await maker.open(id, 1, 55_000n * U, 105_000n * U);
  log("maker: 1,000,000 tUSDC, books open in all three markets");

  // start a little into the week so the markets have some history; the reporter backfills it at once
  await c.setTime(T0 + 3600 + 10);
  const reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new StoreSource(store), now: c.now, log: () => {} });
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
    json({ chainId: c.dep.chainId, chainName: "Anvil (local)", rpcUrl: c.rpc, deployment: c.dep, defaultMaker: c.account("maker").address, devAccount: c.account("taker").address }),
  );
  server = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), publicDir: pub, server: { port, strictPort: true }, logLevel: "error" });
  await server.listen();
  log(`open http://localhost:${port}/  (trade: /trade.html, Get tUSDC: /faucet.html, redeem: /redeem.html) — Ctrl+C stops`);
  setInterval(() => void tick(), 5_000);
} catch (e) {
  await server?.close();
  c.stop();
  throw e;
}
