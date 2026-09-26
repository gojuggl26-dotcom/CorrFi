// The UI's chain side on a local Anvil (headless; the DOM layer only renders these values): every number shown is
// the lens breakdown at the quote's block, the clock is chain time, stopped states disable execution and a report
// clears T-1 / T-2 by itself while T-4 stays; fills are explained against their quote; positions use each side's
// own fair value; redemption after settlement pays F6. (M §5.8, §8.3; S05 completion conditions)

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { erc20Abi, lensAbi, testUsdcAbi } from "../../../engine/src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../../engine/src/createMarket.ts";
import { finalizeTick } from "../../../engine/src/finalizer.ts";
import { MakerOps, MVP_CONFIG } from "../../../engine/src/maker.ts";
import { Reporter } from "../../../engine/src/reporter.ts";
import type { KlineSource } from "../../../engine/src/sources.ts";
import { FixtureSource } from "../../../engine/test/anvil/fixtureSource.ts";
import { type Chain, ROOT, startChain } from "../../../engine/test/anvil/harness.ts";
import { CorrFiApp, type Quoted } from "../../src/core/app.ts";
import { DELTA_DEFAULT, QuoteController, type QuoteInput } from "../../src/core/quote.ts";
import { MakerView, summarizeFill } from "../../src/core/makerView.ts";

const T0 = 1_789_689_600;
const U = 10n ** 6n;
const WAD = 10n ** 18n;
let c: Chain;
let app: CorrFiApp;
let reporter: Reporter;
let localMs = 0; // the UI's local clock (ms), deliberately unrelated to chain time
const timers: (() => void)[] = [];

function controller() {
  return new QuoteController<Quoted>({
    fetch: (i) => app.quote(i),
    nowMs: () => localMs,
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => {},
    onChange: () => {},
  });
}
const BUY_LONG: QuoteInput = { marketId: 0, side: 0, isBuy: true, exactIn: true, amount: 500n * U, delta: DELTA_DEFAULT };

before(async () => {
  c = await startChain({ genesis: T0 - 3600 });
  await c.setTime(T0 - 240);
  await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
  const usdc = { address: c.dep.usdc, abi: testUsdcAbi } as const;
  for (const [who, amt] of [["maker", 200_000n], ["taker", 20_000n]] as const) {
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ ...usdc, functionName: "mint", args: [c.account(who).address, amt * U] }) });
  }
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  await maker.open(0, 1, 55_000n * U, 105_000n * U);
  reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new FixtureSource(), now: c.now, log: () => {} });
  for (let k = 0; k <= 2; ++k) {
    await c.setTime(T0 + k * 300 + 10);
    await reporter.tick();
  }
  app = new CorrFiApp(c.pc, c.dep, c.account("maker").address);
});

after(() => c?.stop());

test("the UI shows the lens breakdown of the quote's block and counts in chain time", async () => {
  const ctl = controller();
  ctl.setInput(BUY_LONG);
  await ctl.refresh();
  const q = ctl.quote!;
  const o = await app.orderFor(0, 0);
  const block = await c.pc.getBlock({ blockTag: "latest" });
  const direct = await c.pc.readContract({ address: c.dep.lens, abi: lensAbi, functionName: "breakdown", args: [o!.order, 0, 0, true, true, 500n * U, DELTA_DEFAULT], blockNumber: block.number });
  const { order, ...lens } = q.b;
  assert.deepEqual(lens, direct, "UI numbers = lens");
  assert.equal(order.hash, o!.hash, "the quote carries the order it was computed for");
  assert.equal(q.b.evaluatedAt, block.timestamp);
  localMs += 4_000;
  const v = ctl.view();
  assert.equal(v.chainNow, Number(block.timestamp) + 4);
  assert.equal(v.nextFairValueInSec, Number(q.b.tNext) + 10 - v.chainNow!);
  assert.equal(v.stopInSec, Number(q.b.tStop) - v.chainNow!);
  assert.ok(v.canExecute);
});

test("execution: the fill is within the limit and any difference is explained", async () => {
  const ctl = controller();
  ctl.setInput(BUY_LONG);
  await ctl.refresh();
  const { fill, causes } = await app.execute(c.wallet("taker"), BUY_LONG, ctl.quote!.b);
  assert.ok(fill.amountOut >= ctl.quote!.b.limit);
  for (const x of causes) assert.equal(x, "elapsed-time"); // one block later only h_O can have moved

  // a quote kept across a new bar: executing it unchanged shows the cause; beforeExecute re-quotes first
  const old = controller();
  old.setInput(BUY_LONG);
  await old.refresh();
  await c.setTime(T0 + 3 * 300 + 10);
  await reporter.tick();
  old.onReport(3);
  localMs += 500;
  const pre = await old.beforeExecute(BUY_LONG);
  assert.equal(pre.requoted, true);
  assert.equal(pre.quote!.b.k, 3);
  const stale = pre.before!;
  const r = await app.execute(c.wallet("taker"), BUY_LONG, { ...stale, limit: 0n });
  assert.ok(r.causes.includes("new-bar"));
});

test("maker page: Aqua pulled exactly the mint from the maker's wallet, and only the traded book moved", async () => {
  const maker = c.account("maker").address;
  const view = new MakerView(c.pc, c.dep, maker);
  const f = (await view.latestFill())!;
  const s = summarizeFill(f, c.dep.usdc);
  assert.equal(f.dir, 1); // the last buy of the test above
  assert.ok(f.q2 > 0n);
  assert.equal(s.pulledUsdc, f.q2, "pulled from the maker's wallet = the tUSDC minted into the new pair");
  assert.equal(s.pushedUsdc, f.amountIn, "the taker's payment went to the maker's wallet");
  assert.equal(s.walletChange, f.amountIn - f.q2);
  assert.equal(s.custodyShort, f.q2, "the new pair's Short stays in the maker's custody");
  assert.equal(s.custodyLong, -f.q1);
  assert.deepEqual(s.changed.map((b) => [b.side, b.after - b.before]), [[0, f.amountIn - f.q2]]);
  assert.equal(s.unchanged.length, 1, "the Short book did not move");
  const snap = await view.snapshot(await app.markets());
  assert.equal(snap.books.length, 2);
  assert.equal(snap.wallet, await c.pc.readContract({ address: c.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [maker] }));
  assert.ok(snap.utilization > 0n);
});

test("stops: T-2 disables execution and the next report re-enables it; T-4 is not lifted by a report", async () => {
  const ctl = controller();
  ctl.setInput(BUY_LONG);
  await c.setTime(T0 + 3 * 300 + 361);
  await ctl.refresh();
  assert.equal(ctl.view().reason, 4);
  assert.equal(ctl.view().canExecute, false);
  assert.equal(ctl.view().clears, "report");
  await c.setTime(T0 + 3 * 300 + 370); // the reporter comes back after the stop and posts bar 4
  const r = await reporter.tick();
  assert.equal(r.reports[0].k, 4);
  ctl.onReport(r.reports[0].k);
  await ctl.refresh();
  assert.equal(ctl.view().reason, 0);
  assert.equal(ctl.view().canExecute, true);

  // eleven bars with fewer than three venues: invalid points, reported; then valid data again
  const dead: KlineSource = { bars: async () => new Map() };
  const deadReporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: dead, now: c.now, log: () => {} });
  for (let k = 5; k <= 15; ++k) {
    await c.setTime(T0 + k * 300 + 61);
    await deadReporter.tick();
  }
  await ctl.refresh();
  assert.equal(ctl.view().reason, 6);
  assert.equal(ctl.view().clears, "never");
  await c.setTime(T0 + 16 * 300 + 10);
  const back = await reporter.tick();
  assert.equal(back.reports[0].k, 16);
  ctl.onReport(16);
  await ctl.refresh();
  assert.equal(ctl.view().reason, 6, "T-4 stays after a new report");
  assert.equal(ctl.view().canExecute, false);
});

test("positions use each side's own fair value; after settlement the payout is redeemed", async () => {
  const taker = c.account("taker").address;
  const [m] = await app.markets();
  const [p] = await app.positions(taker, [m]);
  assert.ok(p.long > 0n);
  assert.equal(p.value, (p.long * m.pFair) / WAD + (p.short * (WAD - m.pFair)) / WAD);
  // settle through the reporter-outage exit (VOID after the T-4 stop is irrelevant here: VOID needs > 1% invalid)
  await c.setTime(m.obsEnd + 48 * 3600);
  const fin = await finalizeTick({ pc: c.pc, wc: c.wallet("anyone"), dep: c.dep, now: c.now, log: () => {} });
  assert.deepEqual(fin.finalized, [0]);
  const [m2] = await app.markets();
  const [p2] = await app.positions(taker, [m2]);
  assert.equal(m2.isVoid, true);
  assert.equal(p2.payout, (p2.long * m2.longT!) / WAD + (p2.short * (WAD - m2.longT!)) / WAD);
  const before = await c.pc.readContract({ address: c.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [taker] });
  await app.redeem(c.wallet("taker"), m2, p2.long, p2.short);
  const got = (await c.pc.readContract({ address: c.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [taker] })) - before;
  assert.equal(got, p2.payout);
});
