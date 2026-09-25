// Integration on a local Anvil (not Base Sepolia): the deployed protocol, a 7D market created from calib.json with the
// price engine's signed initial report, a maker opening both books with orders built in TypeScript, and the reporter
// posting real 1-minute data (the local store, or the committed fixture) — every report must pass the hub's exact
// recomputation (U-3). Also: backfill after an outage, recovery from a crank-ahead (T-1), T-2 stop and resume.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hubAbi, lensAbi, mockUsdcAbi, routerAbi } from "../../src/abi.ts";
import { readMarket } from "../../src/chain.ts";
import { createMarket, marketInputFromCalib } from "../../src/createMarket.ts";
import { MakerOps, MVP_CONFIG } from "../../src/maker.ts";
import { orderHash } from "../../src/orders.ts";
import { Reporter } from "../../src/reporter.ts";
import { type KlineSource, StoreSource } from "../../src/sources.ts";
import { FixtureSource } from "./fixtureSource.ts";
import { type Chain, ROOT, startChain } from "./harness.ts";

const T0 = 1_789_689_600; // 2026-09-18 00:00 UTC = the calib cutoff = obsStart
const U = 10n ** 6n;
const STORE = join(ROOT, "data", "store", "1m");
const source: KlineSource = existsSync(STORE) && !process.env.CORRFI_FIXTURE_ONLY ? new StoreSource(STORE) : new FixtureSource();
const events: Record<string, unknown>[] = [];
let c: Chain;
let reporter: Reporter;
let books: Awaited<ReturnType<MakerOps["open"]>>;

before(async () => {
  c = await startChain({ genesis: T0 - 3600 });
  await c.setTime(T0 - 240);
  const { id } = await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
  assert.equal(id, 0);
  const usdc = { address: c.dep.usdc, abi: mockUsdcAbi } as const;
  for (const [who, amt] of [["maker", 200_000n], ["taker", 20_000n]] as const) {
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ ...usdc, functionName: "mint", args: [c.account(who).address, amt * U] }) });
  }
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  books = await maker.open(0, 1, 55_000n * U, 105_000n * U);
  reporter = new Reporter(
    { pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source, now: c.now, log: (e) => events.push(e) },
    { maxPointsPerTx: 8, maxCrankPerTx: 10 },
  );
});

after(() => c?.stop());

const quote = async () => c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "quoteState", args: [0] });

test("market created at T0 - 240 starts at the calib cutoff; TypeScript order hashes equal the router's", async () => {
  const q = await quote();
  assert.equal(Number(q.obsStart), T0);
  assert.equal(q.confirmed, 0);
  for (const [o, h] of [[books.long, books.longHash], [books.short, books.shortHash]] as const) {
    assert.equal(await c.pc.readContract({ address: c.dep.router, abi: routerAbi, functionName: "hash", args: [o] }), h);
    assert.equal(orderHash(o), h);
    const info = await c.pc.readContract({ address: c.dep.router, abi: routerAbi, functionName: "orderInfo", args: [h] });
    assert.ok(info.registered);
  }
});

test("k = 0 is posted without a report; each later bar with an accepted report (U-3 exact)", async () => {
  await c.setTime(T0 + 10);
  let r = await reporter.tick();
  assert.deepEqual(r.posted, [T0]);
  assert.equal(r.reports.length, 0);
  for (let k = 1; k <= 12; ++k) {
    await c.setTime(T0 + k * 300 + 10);
    r = await reporter.tick();
    assert.deepEqual(r.posted, [T0 + k * 300], `bar ${k}`);
    assert.equal(r.reports.length, 1);
    const q = await quote();
    assert.equal(q.confirmed, k);
    assert.equal(q.pFair, r.reports[0].pFair);
    assert.equal(q.h0, r.reports[0].h0);
  }
  // nothing new before t + postDelay
  await c.setTime(T0 + 13 * 300 + 5);
  r = await reporter.tick();
  assert.equal(r.posted.length, 0);
});

test("after an outage the reporter backfills in several transactions and reports the latest bar", async () => {
  // trading stops on T-2 while the reporter is down
  const lens = { address: c.dep.lens, abi: lensAbi } as const;
  await c.setTime(T0 + 20 * 300);
  const stale = await c.pc.readContract({ ...lens, functionName: "breakdown", args: [books.long, 0, 0, true, true, 100n * U, 2n * 10n ** 15n] });
  assert.equal(stale.reason, 4); // STALE
  await c.setTime(T0 + 40 * 300 + 10);
  const r = await reporter.tick();
  assert.equal(r.posted.length, 40 - 13 + 1); // t13..t40
  assert.ok(r.txs.length > 2, "chunked");
  const q = await quote();
  assert.equal(q.confirmed, 40);
  const fresh = await c.pc.readContract({ ...lens, functionName: "breakdown", args: [books.long, 0, 0, true, true, 100n * U, 2n * 10n ** 15n] });
  assert.equal(fresh.reason, 0);
});

test("a crank ahead of the report (T-1) is cleared by the next tick without new points", async () => {
  await c.setTime(T0 + 41 * 300 + 10);
  // someone posts nothing but cranks: here the reporter's points are needed first, so post via a tick with a
  // report-less path: simulate by posting the point and cranking directly as 'anyone'
  const pts = await reporter.pricePoints([T0 + 41 * 300], T0 + 41 * 300 + 10);
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet("reporter").writeContract({ address: c.dep.hub, abi: hubAbi, functionName: "postPoints", args: [pts.ready] }) });
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet("anyone").writeContract({ address: c.dep.hub, abi: hubAbi, functionName: "crank", args: [0, 10] }) });
  let q = await quote();
  assert.equal(q.processed, 41);
  assert.equal(q.confirmed, 40);
  const b = await c.pc.readContract({ address: c.dep.lens, abi: lensAbi, functionName: "breakdown", args: [books.long, 0, 0, true, true, 100n * U, 2n * 10n ** 15n] });
  assert.equal(b.reason, 3); // UNSYNCED
  const r = await reporter.tick();
  assert.equal(r.posted.length, 0);
  assert.equal(r.reports[0].k, 41);
  q = await quote();
  assert.equal(q.confirmed, 41);
});

test("the engine's accumulator equals the hub's", async () => {
  const hFloor = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "hFloor" });
  const m = await readMarket(c.pc, c.dep, 0, hFloor);
  assert.equal(m.acc.processed, 41);
  assert.ok(m.acc.nValid > 0);
  assert.ok(events.some((e) => e.ev === "tx"));
});
