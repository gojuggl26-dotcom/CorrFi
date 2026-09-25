// 1-minute spot klines from the five venues (M §2.5.1 p.8, §8.3 p.41), the TypeScript counterpart of
// data/aquacorr_data/venues.py. Endpoint semantics are the ones measured in docs/s02/01-venue-api-survey.md;
// for the latest minutes two venues need their "recent" endpoint (OKX /market/candles: last 1,440 bars;
// Bitget /market/candles: about 29 days). Only closed bars (open + 60 <= now) are returned.

import type { MinuteBar, Venue } from "./prices.ts";

export type GetJson = (url: string) => Promise<unknown>;

/** The venue answered with an API-level error (the request itself worked). */
export class VenueError extends Error {}

const MIN = 60;
const closed = (t: number, now: number) => t + MIN <= now;
const qs = (q: Record<string, string | number>) =>
  Object.entries(q)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");

function bar(t: number, r: unknown[], base: number, quote: number, order: [number, number, number, number]): MinuteBar {
  const s = (i: number) => String(r[i]);
  return {
    openTime: t,
    open: s(order[0]),
    high: s(order[1]),
    low: s(order[2]),
    close: s(order[3]),
    baseVolume: s(base),
    quoteVolume: s(quote),
  };
}

const OHLC: [number, number, number, number] = [1, 2, 3, 4];

export interface Adapter {
  name: Venue;
  ratePerSec: number;
  /** Closed bars with open time in [start, end), any order. */
  fetch(getJson: GetJson, symbol: string, start: number, end: number, now: number): Promise<MinuteBar[]>;
}

const binance: Adapter = {
  name: "binance",
  ratePerSec: 8,
  async fetch(getJson, symbol, start, end, now) {
    const out: MinuteBar[] = [];
    let cursor = start;
    while (cursor < end) {
      const q = { symbol, interval: "1m", startTime: cursor * 1000, endTime: end * 1000 - 1, limit: 1000 };
      const rows = await getJson(`https://api.binance.com/api/v3/klines?${qs(q)}`);
      if (!Array.isArray(rows)) throw new VenueError(`binance: ${JSON.stringify(rows).slice(0, 200)}`);
      if (rows.length === 0) break;
      for (const r of rows as unknown[][]) {
        const t = Number(r[0]) / 1000;
        if (t >= start && t < end && closed(t, now)) out.push(bar(t, r, 5, 7, OHLC));
      }
      const last = Number((rows[rows.length - 1] as unknown[])[0]) / 1000;
      if (last < cursor) throw new VenueError("binance: pagination did not advance");
      cursor = last + MIN;
    }
    return out;
  },
};

/** OKX: `after` returns bars strictly older than the cursor, newest first; `confirm` = "1" for closed bars. */
const okx: Adapter = {
  name: "okx",
  ratePerSec: 8,
  async fetch(getJson, symbol, start, end, now) {
    const instId = symbol.slice(0, -4) + "-USDT";
    const recent = start >= now - 1_380 * MIN; // /market/candles keeps the latest 1,440 bars
    const url = recent ? "https://www.okx.com/api/v5/market/candles" : "https://www.okx.com/api/v5/market/history-candles";
    const out: MinuteBar[] = [];
    let cursor = end;
    while (cursor > start) {
      const resp = (await getJson(`${url}?${qs({ instId, bar: "1m", after: cursor * 1000, limit: 300 })}`)) as {
        code?: string;
        data?: unknown[][];
      };
      if (resp?.code !== "0" || !Array.isArray(resp.data)) throw new VenueError(`okx: ${JSON.stringify(resp).slice(0, 200)}`);
      if (resp.data.length === 0) break;
      for (const r of resp.data) {
        const t = Number(r[0]) / 1000;
        if (t >= start && t < end && r[8] === "1" && closed(t, now)) out.push(bar(t, r, 5, 7, OHLC));
      }
      const oldest = Math.min(...resp.data.map((r) => Number(r[0]) / 1000));
      if (oldest >= cursor) throw new VenueError("okx: pagination did not advance");
      cursor = oldest;
    }
    return out;
  },
};

/** Bybit: start and end are both inclusive, newest first. */
const bybit: Adapter = {
  name: "bybit",
  ratePerSec: 8,
  async fetch(getJson, symbol, start, end, now) {
    const out: MinuteBar[] = [];
    let cursor = start;
    while (cursor < end) {
      const last = Math.min(cursor + 999 * MIN, end - MIN);
      const q = { category: "spot", symbol, interval: "1", start: cursor * 1000, end: last * 1000, limit: 1000 };
      const resp = (await getJson(`https://api.bybit.com/v5/market/kline?${qs(q)}`)) as {
        retCode?: number;
        result?: { list?: unknown[][] };
      };
      if (resp?.retCode !== 0 || !Array.isArray(resp.result?.list)) throw new VenueError(`bybit: ${JSON.stringify(resp).slice(0, 200)}`);
      for (const r of resp.result.list) {
        const t = Number(r[0]) / 1000;
        if (t >= cursor && t <= last && closed(t, now)) out.push(bar(t, r, 5, 6, OHLC));
      }
      cursor = last + MIN;
    }
    return out;
  },
};

/** Bitget: history-candles pages back from an exclusive endTime (200 bars, ascending); candles covers ~29 days. */
const bitget: Adapter = {
  name: "bitget",
  ratePerSec: 8,
  async fetch(getJson, symbol, start, end, now) {
    const recent = start >= now - 28 * 86_400;
    const out: MinuteBar[] = [];
    if (recent) {
      // /market/candles: startTime is exclusive (measured 2026-09-25: the first minute of a window is not
      // returned), so ask from one minute earlier and filter client-side to [cursor, stop); windows of 990 minutes
      for (let cursor = start; cursor < end; cursor += 990 * MIN) {
        const stop = Math.min(cursor + 990 * MIN, end);
        const q = { symbol, granularity: "1min", startTime: (cursor - MIN) * 1000, endTime: stop * 1000, limit: 1000 };
        const resp = (await getJson(`https://api.bitget.com/api/v2/spot/market/candles?${qs(q)}`)) as {
          code?: string;
          data?: unknown[][];
        };
        if (resp?.code !== "00000" || !Array.isArray(resp.data)) throw new VenueError(`bitget: ${JSON.stringify(resp).slice(0, 200)}`);
        for (const r of resp.data) {
          const t = Number(r[0]) / 1000;
          if (t >= cursor && t < stop && closed(t, now)) out.push(bar(t, r, 5, 7, OHLC));
        }
      }
      return out;
    }
    let cursor = end;
    while (cursor > start) {
      const q = { symbol, granularity: "1min", endTime: cursor * 1000, limit: 200 };
      const resp = (await getJson(`https://api.bitget.com/api/v2/spot/market/history-candles?${qs(q)}`)) as {
        code?: string;
        data?: unknown[][];
      };
      if (resp?.code !== "00000" || !Array.isArray(resp.data)) throw new VenueError(`bitget: ${JSON.stringify(resp).slice(0, 200)}`);
      if (resp.data.length === 0) break;
      for (const r of resp.data) {
        const t = Number(r[0]) / 1000;
        if (t >= start && t < end && closed(t, now)) out.push(bar(t, r, 5, 7, OHLC));
      }
      const oldest = Math.min(...resp.data.map((r) => Number(r[0]) / 1000));
      if (oldest >= cursor) throw new VenueError("bitget: pagination did not advance");
      cursor = oldest;
    }
    return out;
  },
};

/** KuCoin: [startAt, endAt) in seconds, newest first; columns time, open, close, high, low, volume, turnover. */
const kucoin: Adapter = {
  name: "kucoin",
  ratePerSec: 5,
  async fetch(getJson, symbol, start, end, now) {
    const sym = symbol.slice(0, -4) + "-USDT";
    const out: MinuteBar[] = [];
    let cursor = start;
    while (cursor < end) {
      const stop = Math.min(cursor + 1500 * MIN, end);
      const resp = (await getJson(
        `https://api.kucoin.com/api/v1/market/candles?${qs({ type: "1min", symbol: sym, startAt: cursor, endAt: stop })}`,
      )) as { code?: string; data?: unknown[][] };
      if (resp?.code !== "200000" || !Array.isArray(resp.data)) throw new VenueError(`kucoin: ${JSON.stringify(resp).slice(0, 200)}`);
      for (const r of resp.data) {
        const t = Number(r[0]);
        if (t >= cursor && t < stop && closed(t, now)) out.push(bar(t, r, 5, 6, [1, 3, 4, 2]));
      }
      cursor = stop;
    }
    return out;
  },
};

export const ADAPTERS: Record<Venue, Adapter> = { binance, okx, bybit, bitget, kucoin };

/** fetch() as JSON with a timeout; HTTP errors become exceptions (the caller retries or gives up). */
export function httpGetJson(timeoutMs = 10_000): GetJson {
  return async (url) => {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url.split("?")[0]}`);
    return res.json();
  };
}
