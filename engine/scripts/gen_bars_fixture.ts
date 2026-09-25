// Writes vectors/bars_7d_20260918.json: the real 1-minute bars (all five venues, ETH and BTC) that the price points
// k = 0..K of the 7D market starting 2026-09-18 00:00 UTC use, taken from the local store. The integration tests use
// it when the store (not in git) is absent, e.g. in CI.   node scripts/gen_bars_fixture.ts [--k 64]
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StoreSource } from "../src/sources.ts";
import { SYMBOLS, VENUES } from "../src/prices.ts";

const T0 = 1_789_689_600;
const i = process.argv.indexOf("--k");
const K = i > 0 ? Number(process.argv[i + 1]) : 64;
const store = new StoreSource(fileURLToPath(new URL("../../data/store/1m", import.meta.url)));
const bars: Record<string, Record<string, unknown[]>> = {};
for (const v of VENUES) {
  bars[v] = {};
  for (const s of Object.values(SYMBOLS)) {
    bars[v][s] = [];
    for (let k = 0; k <= K; ++k) {
      const t = T0 + k * 300;
      const b = (await store.bars(v, s, t - 60, t, t)).get(t - 60);
      if (b) bars[v][s].push(b);
    }
  }
}
const out = fileURLToPath(new URL("../../vectors/bars_7d_20260918.json", import.meta.url));
writeFileSync(out, JSON.stringify({ source: "data/store/1m", obsStart: T0, k: K, bars }) + "\n");
console.log(`${out}: points 0..${K}`);
