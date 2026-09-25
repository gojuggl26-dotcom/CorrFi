// The reporter's decision per venue: a bar, "no bar" (invalid for that point) or "unknown" (wait) — M §2.5.1 and
// the rule that an unknown is never posted as an invalid price (docs/s05, S05-D2).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Reporter } from "../src/reporter.ts";
import { type MinuteBar, VENUES, type Venue } from "../src/prices.ts";
import type { KlineSource } from "../src/sources.ts";

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

test("a failed request waits; after venueWaitSec it counts as missing if >= 3 venues answered", async () => {
  const src = source({ okx: "error" });
  assert.deepEqual((await reporter(src).pricePoints([T], T + 10)).ready, []);
  const late = await reporter(src).pricePoints([T], T + 60);
  assert.equal(late.ready.length, 1);
  assert.equal(late.ready[0].pA, 2002n * 10n ** 18n + 5n * 10n ** 17n); // median of 2000, 2002, 2003, 2004
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
