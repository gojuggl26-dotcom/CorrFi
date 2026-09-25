// Where the reporter gets 1-minute bars: the venues' REST APIs (live and backfill) or the normalized local store
// written by data/fetch_klines.py (replay, tests). Both answer "which bars exist in [start, end)", and a venue
// that could not be asked is an error, never an empty answer (an empty answer means the venue had no bar).

import { gunzipSync } from "node:zlib";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS, httpGetJson, type GetJson } from "./venues.ts";
import type { MinuteBar, Venue } from "./prices.ts";

export interface KlineSource {
  /** Closed bars of `venue` / `symbol` with open time in [start, end), keyed by open time. Throws if unknown. */
  bars(venue: Venue, symbol: string, start: number, end: number, now: number): Promise<Map<number, MinuteBar>>;
}

export class RestSource implements KlineSource {
  private readonly getJson: GetJson;
  private readonly retries: number;
  private readonly last = new Map<string, number>();

  constructor(getJson: GetJson = httpGetJson(), retries = 2) {
    this.getJson = getJson;
    this.retries = retries;
  }

  private async paced(venue: Venue) {
    const gap = 1000 / ADAPTERS[venue].ratePerSec;
    const wait = (this.last.get(venue) ?? 0) + gap - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last.set(venue, Date.now());
  }

  async bars(venue: Venue, symbol: string, start: number, end: number, now: number) {
    let error: unknown;
    for (let attempt = 0; attempt <= this.retries; ++attempt) {
      try {
        const out = new Map<number, MinuteBar>();
        const get: GetJson = async (url) => {
          await this.paced(venue);
          return this.getJson(url);
        };
        for (const b of await ADAPTERS[venue].fetch(get, symbol, start, end, now)) out.set(b.openTime, b);
        return out;
      } catch (e) {
        error = e;
      }
    }
    throw error;
  }
}

/** <root>/<venue>/<SYMBOL>/<YYYY-MM>.csv.gz, columns open_time,open,high,low,close,base_volume,quote_volume. */
export class StoreSource implements KlineSource {
  private readonly months = new Map<string, Map<number, MinuteBar>>();
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  private month(venue: string, symbol: string, t: number) {
    const d = new Date(t * 1000);
    const key = `${venue}/${symbol}/${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    let m = this.months.get(key);
    if (!m) {
      m = new Map();
      const path = join(this.root, `${key}.csv.gz`);
      if (existsSync(path)) {
        const lines = gunzipSync(readFileSync(path)).toString("utf8").split("\n");
        if (lines[0] !== "open_time,open,high,low,close,base_volume,quote_volume") throw new Error(`${path}: bad header`);
        for (const line of lines.slice(1)) {
          if (!line) continue;
          const [ot, open, high, low, close, baseVolume, quoteVolume] = line.split(",");
          m.set(Number(ot), { openTime: Number(ot), open, high, low, close, baseVolume, quoteVolume });
        }
      }
      this.months.set(key, m);
    }
    return m;
  }

  async bars(venue: Venue, symbol: string, start: number, end: number, now: number) {
    const out = new Map<number, MinuteBar>();
    for (let t = start - (start % 60); t < end; t += 60) {
      if (t < start || t + 60 > now) continue;
      const b = this.month(venue, symbol, t).get(t);
      if (b) out.set(t, b);
    }
    return out;
  }
}
