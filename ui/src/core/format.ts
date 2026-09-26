// Display formatting (no pricing): units (6 decimals) and WAD values as decimal strings, UTC times.

const WAD = 10n ** 18n;

export function fmtFixed(x: bigint, decimals: number, digits: number): string {
  const neg = x < 0n;
  const v = (neg ? -x : x) / 10n ** BigInt(decimals - digits); // truncate for display
  const int = v / 10n ** BigInt(digits);
  const frac = (v % 10n ** BigInt(digits)).toString().padStart(digits, "0");
  const intStr = int.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${intStr}${digits ? "." + frac : ""}`;
}

export const fmtUnits = (x: bigint, digits = 6) => fmtFixed(x, 6, digits);
export const fmtWad = (x: bigint, digits = 6) => fmtFixed(x, 18, digits);
export const fmtPct = (wad: bigint, digits = 3) => `${fmtFixed(wad * 100n, 18, digits)}%`;

export function fmtUtc(ts: number | bigint): string {
  return new Date(Number(ts) * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function fmtSec(s: number | undefined): string {
  if (s === undefined) return "—";
  const v = Math.max(0, Math.ceil(s));
  return v >= 60 ? `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}` : `${v}s`;
}

/** Parse a user decimal string into units of `decimals` (truncating extra digits is refused). */
export function parseDecimal(s: string, decimals: number): bigint {
  const m = /^\s*(\d*)(?:\.(\d*))?\s*$/.exec(s);
  if (!m || (m[1] === "" && !m[2])) throw new Error("Enter a number");
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new Error(`At most ${decimals} decimal places`);
  return BigInt(m[1] || "0") * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

export const WAD_ONE = WAD;
