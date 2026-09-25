// Live check of the TypeScript venue adapters (docs/s05): for each venue and symbol,
//  1. bars fetched now for the last `hours` of the local store must equal the stored bars (same decimal strings),
//     through the endpoint the reporter would use for that age (OKX / Bitget "recent" or "history");
//  2. the latest closed minute is reported with its delay after the minute closed.
// Usage: node scripts/check_venues.ts [--store ../data/store/1m] [--store-end 2026-09-25] [--hours 5]
import { RestSource, StoreSource } from "../src/sources.ts";
import { VENUES, SYMBOLS } from "../src/prices.ts";

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const storeEnd = Date.parse(`${arg("store-end", "2026-09-25")}T00:00:00Z`) / 1000;
const hours = Number(arg("hours", "5"));
const store = new StoreSource(arg("store", "../data/store/1m"));
const rest = new RestSource();

let failures = 0;
for (const symbol of Object.values(SYMBOLS)) {
  for (const venue of VENUES) {
    const now = Math.floor(Date.now() / 1000);
    const start = storeEnd - hours * 3600;
    try {
      const [live, stored] = await Promise.all([
        rest.bars(venue, symbol, start, storeEnd, now),
        store.bars(venue, symbol, start, storeEnd, now),
      ]);
      let same = 0;
      const diffs: string[] = [];
      for (const [t, b] of stored) {
        const l = live.get(t);
        if (l && JSON.stringify(l) === JSON.stringify(b)) ++same;
        else if (diffs.length < 3) diffs.push(`${t}: live ${JSON.stringify(l)} store ${JSON.stringify(b)}`);
      }
      const extra = [...live.keys()].filter((t) => !stored.has(t)).length;
      const ok = same === stored.size && extra === 0;
      if (!ok) ++failures;
      const latest = await rest.bars(venue, symbol, now - 600, now, now);
      const last = Math.max(...latest.keys());
      console.log(
        `${ok ? "ok  " : "FAIL"} ${venue.padEnd(8)} ${symbol}  store ${stored.size} / identical ${same} / live-only ${extra}` +
          `  latest closed ${new Date(last * 1000).toISOString()} (closed ${now - last - 60}s before the request)`,
      );
      for (const d of diffs) console.log(`       ${d}`);
    } catch (e) {
      ++failures;
      console.log(`FAIL ${venue.padEnd(8)} ${symbol}  ${(e as Error).message}`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
