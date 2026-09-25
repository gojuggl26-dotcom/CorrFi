import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseDecimal, pricePoint, type MinuteBar } from "../src/prices.ts";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../vectors/price_points.json", import.meta.url)), "utf8"),
) as { cases: { t: number; note: string; A: Side; B: Side }[] };

interface Side {
  bars: Record<string, MinuteBar | null>;
  priceWad: string | null;
  nValid: number;
}

test("price points match data/aquacorr_data/grid.py on real and synthetic bars", () => {
  let n = 0;
  for (const c of vectors.cases) {
    for (const side of [c.A, c.B]) {
      const p = pricePoint(c.t, side.bars);
      assert.equal(p.nValidVenues, side.nValid, `${c.t} ${c.note}`);
      assert.equal(p.priceWad === null ? null : p.priceWad.toString(), side.priceWad, `${c.t} ${c.note}`);
      ++n;
    }
  }
  assert.ok(n >= 700);
  assert.ok(vectors.cases.some((c) => c.A.nValid < 5 || c.B.nValid < 5), "cases with missing venues");
});

test("decimal parsing is exact", () => {
  assert.deepEqual(parseDecimal("2512.370"), { n: 251237n, d: 100n });
  assert.deepEqual(parseDecimal("1e-8"), { n: 1n, d: 100000000n });
  assert.deepEqual(parseDecimal("1.5E2"), { n: 150n, d: 1n });
  assert.deepEqual(parseDecimal("0.000"), { n: 0n, d: 1n });
  assert.throws(() => parseDecimal("abc"));
  assert.throws(() => parseDecimal("."));
});

test("a bar from the wrong minute is rejected", () => {
  const bar: MinuteBar = { openTime: 0, open: "1", high: "1", low: "1", close: "1", baseVolume: "1", quoteVolume: "1" };
  assert.throws(() => pricePoint(300, { binance: bar }));
});
