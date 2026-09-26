// Reporter latency and trading stop time from the chain alone (S08; M §8.4, B §7): RPC_URL, DEPLOYMENT.
//   node bin/reporter-stats.ts [--grace 60] [--log reporter.jsonl] [--out stats.json]
// - latency of every price point: block time of its PointPosted - t_k (the reporter posts at t_k + 10 s by design).
//   The 99th percentile is the candidate for the grace g (B §7).
// - stop time per market between obsStart and min(obsEnd, now): trading is halted (T-2) while
//   now - t_confirmed > Δ + g; the fraction must stay below 1 %.
// - with --log (the reporter's LOG_FILE): ticks that failed, and U-3 recompute mismatches among them (must be 0).
import { readFileSync, writeFileSync } from "node:fs";
import { hubAbi } from "../src/abi.ts";
import { logsInChunks } from "../src/logs.ts";
import { DELTA } from "../src/market.ts";
import { setup } from "./common.ts";

const { pc, dep } = setup();
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const grace = Number(arg("grace") ?? 60);

async function events<N extends "PointPosted" | "ReportAccepted" | "MarketCreated">(eventName: N) {
  const latest = await pc.getBlockNumber();
  return logsInChunks(BigInt(dep.block ?? 0), latest, (fromBlock, toBlock) =>
    pc.getContractEvents({ address: dep.hub, abi: hubAbi, eventName, fromBlock, toBlock }),
  );
}

const times = new Map<bigint, number>();
async function blockTime(n: bigint): Promise<number> {
  if (!times.has(n)) times.set(n, Number((await pc.getBlock({ blockNumber: n })).timestamp));
  return times.get(n)!;
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

const now = Number((await pc.getBlock({ blockTag: "latest" })).timestamp);
const points = await events("PointPosted");
const lat: number[] = [];
for (const p of points) lat.push((await blockTime(p.blockNumber)) - Number(p.args.t));

const created = await events("MarketCreated");
const reports = await events("ReportAccepted");
const markets = [];
for (const c of created) {
  const id = Number(c.args.marketId);
  const obsStart = Number(c.args.obsStart);
  const obsEnd = Number(c.args.obsEnd);
  const end = Math.min(obsEnd, now);
  // accepted reports of this market in time order: (acceptance time, confirmed bar)
  const acc: [number, number][] = [];
  for (const r of reports.filter((r) => Number(r.args.marketId) === id)) acc.push([await blockTime(r.blockNumber), Number(r.args.k)]);
  acc.sort((a, b) => a[0] - b[0]);
  let stopped = 0;
  let confirmedT = obsStart; // the initial report confirms k = 0 (t_0 = obsStart) at creation
  let cursor = obsStart;
  for (const [at, k] of [...acc, [end, -1] as [number, number]]) {
    const until = Math.min(at, end);
    const haltFrom = Math.max(cursor, confirmedT + DELTA + grace);
    if (until > haltFrom) stopped += until - haltFrom;
    cursor = Math.max(cursor, until);
    if (k >= 0) confirmedT = obsStart + k * DELTA;
    if (at >= end) break;
  }
  const span = Math.max(0, end - obsStart);
  markets.push({ id, obsStart, obsEnd, reports: acc.length, observedSeconds: span, stoppedSeconds: stopped, stoppedFraction: span ? stopped / span : 0 });
}

let failed = 0;
let mismatches = 0;
const logPath = arg("log");
if (logPath) {
  for (const line of readFileSync(logPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.ev !== "error") continue; // a tick that failed (RPC, a reverted transaction, ...)
    failed += 1;
    if (/RecomputeMismatch/.test(String(e.error))) mismatches += 1;
  }
}

const first = points.length ? await blockTime(points[0].blockNumber) : now;
const summary = {
  chainId: dep.chainId,
  hub: dep.hub,
  generatedAt: new Date().toISOString(),
  observedDays: (now - first) / 86_400,
  points: points.length,
  latencySeconds: { p50: quantile(lat, 0.5), p90: quantile(lat, 0.9), p99: quantile(lat, 0.99), max: lat.length ? Math.max(...lat) : NaN },
  graceCandidateSeconds: quantile(lat, 0.99),
  graceInForce: grace,
  markets,
  reporterLog: logPath ? { failedTicks: failed, recomputeMismatches: mismatches } : "not given",
};
const text = JSON.stringify(summary, null, 1);
console.log(text);
const out = arg("out");
if (out) writeFileSync(out, text + "\n");
