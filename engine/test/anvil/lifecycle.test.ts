// Full 7D market on a local Anvil with real data (needs the local store; skipped without it):
// create -> maker opens -> reporter posts all 2,017 points with reports -> takers trade in all four directions at
// several τ (breakdown limit, entry point) -> obsEnd -> final report -> finalize by the executor -> takers redeem,
// the maker claims its custody. The vault's Long_T must equal the verifier's independent fixed-point settlement
// from the same store (and the 50-digit reference within 1e-9); the last confirmed P_fair must equal Long_T.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { erc20Abi, hubAbi, mockUsdcAbi, vaultAbi } from "../../src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../src/createMarket.ts";
import { finalizeTick } from "../../src/finalizer.ts";
import { MakerOps, MVP_CONFIG } from "../../src/maker.ts";
import { Reporter } from "../../src/reporter.ts";
import { StoreSource } from "../../src/sources.ts";
import { breakdown, registeredOrders, trade } from "../../src/taker.ts";
import { type Chain, ROOT, startChain } from "./harness.ts";

const T0 = 1_789_689_600;
const U = 10n ** 6n;
const WAD = 10n ** 18n;
const STORE = join(ROOT, "data", "store", "1m");
const skip = !existsSync(STORE) && "local 1-minute store not present";
let c: Chain;
let reporter: Reporter;
const log: Record<string, unknown>[] = [];

async function catchUp(k: number) {
  await c.setTime(T0 + k * 300 + 10);
  const r = await reporter.tick();
  const q = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "quoteState", args: [0] });
  assert.equal(q.confirmed, k, `confirmed after catching up to ${k} (${JSON.stringify(r.problems)})`);
}

async function take(who: "taker" | "taker2", side: number, isBuy: boolean, exactIn: boolean, amount: bigint) {
  const [o] = (await registeredOrders(c.pc, c.dep)).filter((x) => x.marketId === 0 && x.side === side && x.generation === 1);
  const b = await breakdown(c.pc, c.dep, o.order, 0, side, isBuy, exactIn, amount, 2n * 10n ** 15n);
  assert.equal(b.reason, 0);
  assert.ok(b.limitDefined);
  const f = await trade(c.pc, c.wallet(who), c.dep, o.order, 0, side, isBuy, exactIn, amount, b.limit);
  // one block later: the fill may differ from the quote only by h_O's growth with age (PROP-02), within the limit
  if (exactIn) assert.ok(b.amountOut - f.amountOut <= b.amountOut / 1000n && f.amountOut >= b.limit);
  else assert.ok(f.amountIn - b.amountIn <= b.amountIn / 1000n && f.amountIn <= b.limit);
  return f;
}

before(async () => {
  if (skip) return;
  c = await startChain({ genesis: T0 - 3600 });
  await c.setTime(T0 - 240);
  await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
  const usdc = { address: c.dep.usdc, abi: mockUsdcAbi } as const;
  for (const [who, amt] of [["maker", 200_000n], ["taker", 5_000n], ["taker2", 5_000n]] as const) {
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ ...usdc, functionName: "mint", args: [c.account(who).address, amt * U] }) });
    if (who !== "maker") {
      await c.pc.waitForTransactionReceipt({ hash: await c.wallet(who).writeContract({ address: c.dep.usdc, abi: erc20Abi, functionName: "approve", args: [c.dep.router, 2n ** 255n] }) });
    }
  }
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  await maker.open(0, 1, 55_000n * U, 105_000n * U);
  reporter = new Reporter(
    { pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new StoreSource(STORE), now: c.now, log: (e) => log.push(e) },
    { maxPointsPerTx: 96, maxCrankPerTx: 288 },
  );
});

after(() => c?.stop());

test("a 7D market from creation to redemption with real data", { skip }, async () => {
  const vault = (await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "marketVault", args: [0] })) as `0x${string}`;
  const [longT, shortT] = await Promise.all([
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longToken" }),
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "shortToken" }),
  ]);
  for (const who of ["taker", "taker2"] as const) {
    for (const t of [longT, shortT]) {
      await c.pc.waitForTransactionReceipt({ hash: await c.wallet(who).writeContract({ address: t, abi: erc20Abi, functionName: "approve", args: [c.dep.router, 2n ** 255n] }) });
    }
  }
  await catchUp(0);
  const f1 = await take("taker", 0, true, false, 1_000n * U); // buy Long 1,000 (exact-out): all minted
  assert.equal(f1.q2, 1_000n * U);
  await catchUp(504);
  const f2 = await take("taker", 0, false, true, 400n * U); // sell Long 400: paired with Short custody, burned
  assert.equal(f2.q1, 400n * U);
  await catchUp(1008);
  const f3 = await take("taker2", 1, true, false, 500n * U); // buy Short 500: from Short custody
  assert.equal(f3.q1, 500n * U);
  await catchUp(1512);
  const f4 = await take("taker2", 1, false, true, 50n * U); // sell Short 50: bought into custody
  assert.equal(f4.q2 + f4.q1, 50n * U);
  await catchUp(1920);
  const f5 = await take("taker", 0, true, true, 300n * U); // buy Long for 300 USDC (exact-in)
  assert.ok(f5.amountOut > 0n);
  await catchUp(2016);

  // settlement
  const fin = await finalizeTick({ pc: c.pc, wc: c.wallet("anyone"), dep: c.dep, now: c.now, log: (e) => log.push(e) });
  assert.deepEqual(fin.finalized, [0]);
  const [l, isVoid] = await Promise.all([
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longT" }),
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "isVoid" }),
  ]);
  const calib = JSON.parse(await (await import("node:fs/promises")).readFile(join(ROOT, "vectors", "calib_7d_20260918.json"), "utf8"));
  const v = spawnSync("python", [join(ROOT, "verifier", "settle_market.py"), "--obs-start", String(T0), "--tenor", "7", "--sA", calib.sA, "--sB", calib.sB], { encoding: "utf8", env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
  assert.equal(v.status, 0, v.stderr);
  const ref = JSON.parse(v.stdout);
  assert.equal(isVoid, false);
  assert.equal(l.toString(), ref.longT, "Long_T = verifier fixed-point (bit for bit)");
  const hp = Number(ref.longT_hp);
  assert.ok(Math.abs(Number(l) / 1e18 - hp) <= 1e-9, "Long_T vs 50-digit reference");
  const q = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "quoteState", args: [0] });
  assert.equal(q.pFair, l, "the final confirmed P_fair is the settlement value");

  // redemption and the maker's custody claim; the vault keeps what is still owed
  const bal = (t: `0x${string}`, a: `0x${string}`) => c.pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [a] });
  let paid = 0n;
  for (const who of ["taker", "taker2"] as const) {
    const a = c.account(who).address;
    const [ql, qs] = await Promise.all([bal(longT, a), bal(shortT, a)]);
    if (ql + qs === 0n) continue;
    const before = await bal(c.dep.usdc, a);
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet(who).writeContract({ address: vault, abi: vaultAbi, functionName: "redeem", args: [ql, qs] }) });
    const got = (await bal(c.dep.usdc, a)) - before;
    assert.equal(got, (ql * l) / WAD + (qs * (WAD - l)) / WAD);
    paid += got;
  }
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  const m0 = await bal(c.dep.usdc, c.account("maker").address);
  await maker.claim(0);
  paid += (await bal(c.dep.usdc, c.account("maker").address)) - m0;
  const left = await bal(c.dep.usdc, vault);
  assert.ok(left < 5n, `dust ${left} units`);
  await maker.dock(0, 1);
  const rep = await maker.monitor(200_000n * U);
  assert.ok(rep.markets[0].orders.every((o) => o.docked));
  // after the claim the maker holds only USDC: equity = wallet, P&L = wallet - the 200,000 it started with
  assert.equal(rep.markets[0].custodyValue, 0n);
  assert.equal(rep.equity, rep.wallet);
  assert.equal(rep.pnl, rep.wallet - 200_000n * U);
  log.push({ ev: "maker_pnl", pnl: rep.pnl!.toString() });
  log.push({ ev: "summary", longT: l.toString(), paid: paid.toString(), dust: left.toString(), makerPnl: rep.pnl!.toString(), fills: [f1, f2, f3, f4, f5].map((f) => [f.amountIn.toString(), f.amountOut.toString()]) });
  console.log(JSON.stringify(log.at(-1)));
});
