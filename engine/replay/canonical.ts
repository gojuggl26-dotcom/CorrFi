// The normalized form hashed in the manifest (R §3.5): JSON with sorted keys and no whitespace — the same bytes as
// Python's json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) for the replay's files, which
// contain only strings, integers, booleans, null, arrays and objects.
import { type Hex, keccak256, toBytes } from "viem";

export function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isInteger(v)) throw new Error(`non-integer number ${v} in a hashed file`);
    if (typeof v === "bigint") return JSON.stringify(v.toString());
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

export const canonicalHash = (v: unknown): Hex => keccak256(toBytes(canonical(v)));
