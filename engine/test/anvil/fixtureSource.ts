import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { MinuteBar, Venue } from "../../src/prices.ts";
import type { KlineSource } from "../../src/sources.ts";

/** Real bars committed in vectors/bars_7d_20260918.json (only the minutes the grid points use). */
export class FixtureSource implements KlineSource {
  private readonly data: Record<string, Record<string, MinuteBar[]>>;

  constructor() {
    const path = fileURLToPath(new URL("../../../vectors/bars_7d_20260918.json", import.meta.url));
    this.data = JSON.parse(readFileSync(path, "utf8")).bars;
  }

  async bars(venue: Venue, symbol: string, start: number, end: number, now: number) {
    const out = new Map<number, MinuteBar>();
    for (const b of this.data[venue]?.[symbol] ?? []) {
      if (b.openTime >= start && b.openTime < end && b.openTime + 60 <= now) out.set(b.openTime, b);
    }
    return out;
  }
}
