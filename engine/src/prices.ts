// Price points from 1-minute bars (M §2.5.1 p.8, §8.3 p.41; R §3.1 p.7) — the same rules as
// data/aquacorr_data/grid.py, which the demo data prep and the verifier use:
//   venue v is valid at grid time t iff its 1-minute bar with open_time = t - 60 exists and base_volume > 0
//   (and quote_volume > 0); its VWAP over [t-60, t) is quote_volume / base_volume;
//   the asset price is valid iff >= 3 venues are valid: their median (mean of the middle two for an even count),
//   truncated to WAD.
// Arithmetic is exact (rationals from the venues' decimal strings), so no working precision is involved.

export const WAD = 10n ** 18n;
export const VENUES = ["binance", "okx", "bybit", "bitget", "kucoin"] as const;
export type Venue = (typeof VENUES)[number];
export const SYMBOLS = { A: "ETHUSDT", B: "BTCUSDT" } as const;
export const MIN_VALID_VENUES = 3;
export const VWAP_SECONDS = 60;

export interface MinuteBar {
  openTime: number; // seconds, UTC, bar covers [openTime, openTime + 60)
  open: string;
  high: string;
  low: string;
  close: string;
  baseVolume: string;
  quoteVolume: string;
}

/** An exact positive-denominator rational. */
export interface Rational {
  n: bigint;
  d: bigint;
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;

/** Exact value of a decimal string such as "2512.37", "0.00001", "1e-8" (no binary floating point). */
export function parseDecimal(s: string): Rational {
  const m = DECIMAL.exec(s.trim());
  if (!m || (m[2] === "" && (m[3] === undefined || m[3] === ""))) throw new Error(`not a decimal: ${s}`);
  const sign = m[1] === "-" ? -1n : 1n;
  const frac = m[3] ?? "";
  let n = BigInt((m[2] || "0") + frac) * sign;
  let d = 10n ** BigInt(frac.length);
  const e = m[4] ? Number(m[4]) : 0;
  if (e > 0) n *= 10n ** BigInt(e);
  else if (e < 0) d *= 10n ** BigInt(-e);
  return reduce({ n, d });
}

function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function reduce(x: Rational): Rational {
  const g = gcd(x.n, x.d) || 1n;
  return { n: x.n / g, d: x.d / g };
}

export function cmp(a: Rational, b: Rational): number {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
}

export type VenueReason = "missing" | "zero_base_volume" | "non_positive_quote_volume" | null;

/** VWAP of one venue for the minute, or the reason it is invalid (grid.py venue_vwap). */
export function venueVwap(bar: MinuteBar | null | undefined): { vwap: Rational | null; reason: VenueReason } {
  if (!bar) return { vwap: null, reason: "missing" };
  const base = parseDecimal(bar.baseVolume);
  if (base.n <= 0n) return { vwap: null, reason: "zero_base_volume" };
  const quote = parseDecimal(bar.quoteVolume);
  if (quote.n <= 0n) return { vwap: null, reason: "non_positive_quote_volume" };
  return { vwap: reduce({ n: quote.n * base.d, d: quote.d * base.n }), reason: null };
}

export function median(values: Rational[]): Rational {
  if (values.length === 0) throw new Error("median of empty list");
  const s = [...values].sort(cmp);
  const mid = s.length >> 1;
  if (s.length % 2) return s[mid];
  const a = s[mid - 1];
  const b = s[mid];
  return reduce({ n: a.n * b.d + b.n * a.d, d: 2n * a.d * b.d });
}

/** Truncate a positive price to WAD. */
export function toWad(x: Rational): bigint {
  if (x.n <= 0n) throw new Error("price must be positive");
  return (x.n * WAD) / x.d;
}

export interface PricePoint {
  t: number;
  priceWad: bigint | null; // null when invalid
  nValidVenues: number;
  reasons: Record<string, VenueReason>;
}

/** bars: venue -> the bar opening at t - 60 (null if the venue has none). */
export function pricePoint(t: number, bars: Record<string, MinuteBar | null | undefined>): PricePoint {
  if (t % 60 !== 0) throw new Error("grid time must be on a minute boundary");
  const valid: Rational[] = [];
  const reasons: Record<string, VenueReason> = {};
  for (const v of Object.keys(bars)) {
    const bar = bars[v];
    if (bar && bar.openTime !== t - VWAP_SECONDS) throw new Error(`${v}: bar ${bar.openTime} is not the minute before ${t}`);
    const r = venueVwap(bar);
    reasons[v] = r.reason;
    if (r.vwap) valid.push(r.vwap);
  }
  const priceWad = valid.length >= MIN_VALID_VENUES ? toWad(median(valid)) : null;
  return { t, priceWad, nValidVenues: valid.length, reasons };
}
