// The reporter's decision per venue: a bar, "no bar" (invalid for that point) or "unknown" (wait) — M §2.5.1 and
// the rule that an unknown is never posted as an invalid price (docs/s05, S05-D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapLimited, Reporter, type PointInput, type TickResult } from "../src/reporter.ts";
import { type MinuteBar, VENUES, type Venue } from "../src/prices.ts";
import { type KlineSource, RestSource } from "../src/sources.ts";

const T = 1_789_690_200; // a 5-minute boundary
const bar = (openTime: number, px: string): MinuteBar => ({ openTime, open: px, high: px, low: px, close: px, baseVolume: "1", quoteVolume: px });

/** Each venue: "bar" (has t-60), "later" (no t-60 but a later minute), "none" (nothing yet), "error". */
function source(spec: Partial<Record<Venue, "bar" | "later" | "none" | "error">>): KlineSource {
  return {
    async bars(venue, symbol, start, end, now) {
      const s = spec[venue] ?? "bar";
      if (s === "error") throw new Error(`${venue} down`);
      const px = symbol === "ETHUSDT" ? String(2000 + VENUES.indexOf(venue)) : String(60_000 + VENUES.indexOf(venue));
      const out = new Map<number, MinuteBar>();
      if (s === "bar" && T - 60 >= start && T - 60 < end && T <= now) out.set(T - 60, bar(T - 60, px));
      if (s === "later" && now >= T + 60) out.set(T, bar(T, px));
      return out;
    },
  };
}

const reporter = (src: KlineSource) =>
  new Reporter({ source: src, log: () => {} } as never, { venueWaitSec: 60 });

test("all five venues answer: the point is ready at t + 10", async () => {
  const r = await reporter(source({})).pricePoints([T], T + 10);
  assert.equal(r.ready.length, 1);
  assert.equal(r.ready[0].pA, 2002n * 10n ** 18n); // median of 2000..2004
  assert.ok(r.ready[0].validA && r.ready[0].validB);
});

test("a failed request waits; it counts as missing after failing for venueWaitSec, if >= 3 venues answered", async () => {
  const src = source({ okx: "error" });
  const r = reporter(src);
  assert.deepEqual((await r.pricePoints([T], T + 10)).ready, []); // first failure at t + 10
  assert.deepEqual((await r.pricePoints([T], T + 60)).ready, []); // t + 60 but failing for 50 s only
  const late = await r.pricePoints([T], T + 70);
  assert.equal(late.ready.length, 1);
  assert.equal(late.ready[0].pA, 2002n * 10n ** 18n + 5n * 10n ** 17n); // median of 2000, 2002, 2003, 2004
});

test("after an outage a failing venue still gets venueWaitSec from its first failure (review #3)", async () => {
  const r = reporter(source({ okx: "error" }));
  const back = await r.pricePoints([T], T + 3600); // every backfilled point is long past t + venueWaitSec
  assert.equal(back.ready.length, 0);
  assert.match(back.waiting[0].why, /failing for 0 s/);
  assert.equal((await r.pricePoints([T], T + 3660)).ready.length, 1);
});

test("a venue that could not be asked never makes a price invalid: the point waits (review #3)", async () => {
  // two venues have the bar, two have published later minutes without it, one fails: 4 answered, 2 valid
  const r = reporter(source({ okx: "error", bybit: "later", bitget: "later" }));
  for (const now of [T + 10, T + 70, T + 3600]) {
    const x = await r.pricePoints([T], now);
    assert.equal(x.ready.length, 0, `now = t + ${now - T}`);
  }
  assert.match((await r.pricePoints([T], T + 3700)).waiting[0].why, /2 venues have the bar and 1 could not be asked/);
});

test("when fewer than three venues answer, the point is never posted as invalid (it waits)", async () => {
  const src = source({ okx: "error", bybit: "error", bitget: "error" });
  for (const now of [T + 10, T + 60, T + 3600]) {
    const r = await reporter(src).pricePoints([T], now);
    assert.equal(r.ready.length, 0, `now = t + ${now - T}`);
    assert.match(r.waiting[0].why, /request failed/);
  }
});

test("a venue without the bar is missing once it has published a later minute, or after venueWaitSec", async () => {
  const later = source({ kucoin: "later" });
  assert.equal((await reporter(later).pricePoints([T], T + 10)).ready.length, 0); // could still arrive
  const r = await reporter(later).pricePoints([T], T + 61);
  assert.equal(r.ready.length, 1);
  const none = source({ kucoin: "none" });
  assert.equal((await reporter(none).pricePoints([T], T + 30)).ready.length, 0);
  assert.equal((await reporter(none).pricePoints([T], T + 60)).ready.length, 1);
});

test("fewer than three venues with a bar: an invalid price point (a legitimate value)", async () => {
  const src = source({ okx: "later", bybit: "later", bitget: "later" });
  const r = await reporter(src).pricePoints([T], T + 61);
  assert.equal(r.ready.length, 1);
  assert.equal(r.ready[0].validA, false);
  assert.equal(r.ready[0].pA, 0n);
});

test("points are decided oldest first and stop at the first undecided one", async () => {
  const src = source({});
  const r = await reporter(src).pricePoints([T, T + 300], T + 10);
  assert.equal(r.ready.length, 1);
  assert.equal(r.waiting[0].t, T + 300);
});

const WAD = 10n ** 18n;
const P = (t: number, pA: bigint, pB: bigint, validA = true, validB = true): PointInput => ({ t: BigInt(t), pA, pB, validA, validB });
const tick = (): TickResult => ({ now: 0, posted: [], reports: [], waiting: [], problems: [], implausible: [], txs: [] });

/** A reporter whose chain reads come from `onChain` (grid time -> posted point). */
function withChain(onChain: Map<number, PointInput>) {
  const pc = {
    readContract: async ({ args }: { args: [bigint] }) => {
      const p = onChain.get(Number(args[0]));
      return p ? { pA: p.pA, pB: p.pB, posted: true, validA: p.validA, validB: p.validB } : { pA: 0n, pB: 0n, posted: false, validA: false, validB: false };
    },
  };
  return new Reporter({ pc, dep: { hub: "0x0000000000000000000000000000000000000001" }, log: () => {} } as never);
}

test("a price whose |ln r| to a posted valid neighbour exceeds 0.5 is posted invalid instead (review #5, DEC-29)", async () => {
  const r = withChain(new Map([[T - 300, P(T - 300, 2000n * WAD, 60_000n * WAD)]]));
  const ready = [P(T, 4000n * WAD, 60_100n * WAD), P(T + 300, 4010n * WAD, 60_200n * WAD), P(T + 600, 4020n * WAD, 100_000n * WAD)];
  const res = tick();
  await (r as unknown as { plausible: (a: PointInput[], b: Map<number, unknown>, c: TickResult) => Promise<void> }).plausible(ready, new Map(), res);
  // ETH doubled against the posted T - 300 (ln 2 = 0.69): invalid; the next point compares with that invalid one
  assert.deepEqual([ready[0].validA, ready[0].pA, ready[0].validB], [false, 0n, true]);
  assert.deepEqual([ready[1].validA, ready[1].pA], [true, 4010n * WAD]);
  // BTC 60,200 -> 100,000 within the batch: ln 1.66 = 0.51 exceeds 0.5 (the hub would revert the whole transaction)
  assert.equal(ready[2].validB, false);
  assert.deepEqual(res.implausible.map((x) => [x.t, x.asset, x.neighbour]), [[T, "A", T - 300], [T + 600, "B", T + 300]]);
  // exactly at the bound is accepted, as on chain (|r| <= 0.5)
  const edge = withChain(new Map([[T - 300, P(T - 300, WAD, WAD)]]));
  const ok = [P(T, 1648721270700128146n, WAD)]; // e^0.5 rounded down: ln < 0.5
  await (edge as unknown as { plausible: (a: PointInput[], b: Map<number, unknown>, c: TickResult) => Promise<void> }).plausible(ok, new Map(), tick());
  assert.equal(ok[0].validA, true);
});

test("a refused combined transaction falls back to the points alone and one report per market (review #5)", async () => {
  const r = new Reporter({ log: () => {} } as never);
  const sent: string[] = [];
  (r as unknown as { send: (fn: string, args: unknown[]) => Promise<string> }).send = async (fn, args) => {
    const reps = (args[1] ?? []) as { marketId: number }[];
    const label = `${fn}(${(args[0] as unknown[]).length}${fn === "postAndReport" ? `,[${reps.map((x) => x.marketId)}]` : ""})`;
    if (fn === "postAndReport" && reps.some((x) => x.marketId === 1)) throw new Error(`refused ${label}`);
    sent.push(label);
    return "0x";
  };
  const signed = [0, 1, 2].map((m) => ({ marketId: m, k: 5, pFair: 1n, h0: 1n, signature: "0x" as const }));
  const res = tick();
  const ok = await (r as unknown as { postWithReports: (p: PointInput[], s: typeof signed, res: TickResult) => Promise<typeof signed> }).postWithReports([P(T, WAD, WAD)], signed, res);
  assert.deepEqual(sent, ["postPoints(1)", "postAndReport(0,[0])", "postAndReport(0,[2])"]);
  assert.deepEqual(ok.map((x) => x.marketId), [0, 2]);
  assert.match(res.problems[0], /market 1 bar 5: report refused/);
});

test("chain reads run with bounded concurrency (review #14)", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimited([...Array(100).keys()], 8, async (i) => {
    peak = Math.max(peak, ++running);
    await new Promise((r) => setTimeout(r, 1));
    --running;
    return i * 2;
  });
  assert.equal(peak, 8);
  assert.deepEqual(out, [...Array(100).keys()].map((i) => i * 2));
});

test("a failing venue request is retried with a growing pause (review #3)", async () => {
  const calls: number[] = [];
  const src = new RestSource(async () => {
    calls.push(Date.now());
    throw new Error("503");
  }, 2, 40);
  await assert.rejects(src.bars("binance", "ETHUSDT", T - 60, T, T + 10), /503/);
  assert.equal(calls.length, 3);
  assert.ok(calls[1] - calls[0] >= 35 && calls[2] - calls[1] >= 75, `pauses ${calls[1] - calls[0]}, ${calls[2] - calls[1]} ms`);
});
