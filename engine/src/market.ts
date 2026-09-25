// The price engine (M §4.1-4.2, §8.3): the hub's BarFeed / Accumulator / FairValue arithmetic replayed off chain
// with the shared fixed-point port, so that a report (k, P_fair, h0) is exactly what the hub recomputes (U-3).

import { accumulate, fairValue, FixedPointError, h0, logRatio, tau, winsorize, WAD } from "./fixedpoint.ts";

export const DELTA = 300;
export const FINALIZE_GRACE = 48 * 3600;

/** Fixed market parameters as stored by createMarket (hub.marketParams + quoteState + hFloor). */
export interface MarketParams {
  id: number;
  obsStart: number;
  obsEnd: number;
  n: number;
  nMin: number;
  csA: bigint;
  csB: bigint;
  sAB: bigint;
  sA2: bigint;
  sB2: bigint;
  sigmaTable: readonly bigint[];
  cH: bigint;
  lambda: bigint;
  hFloor: bigint;
}

/** The hub's accumulator (hub.settlement). */
export interface AccState {
  processed: number;
  nValid: number;
  c: bigint;
  va: bigint;
  vb: bigint;
}

/** A price point as BarFeed stores it (hub.point). */
export interface ChainPoint {
  pA: bigint;
  pB: bigint;
  posted: boolean;
  validA: boolean;
  validB: boolean;
}

export type PointLookup = (t: number) => ChainPoint | undefined;

export const pointTime = (m: MarketParams, k: number) => m.obsStart + k * DELTA;

/** Mirror of CorrFiHub._crank: process consecutive posted bars; after obsEnd + 48 h unposted bars count as invalid. */
export function crank(m: MarketParams, acc: AccState, points: PointLookup, maxBars: number, now: number): AccState {
  let { processed: k, nValid, c, va, vb } = acc;
  const stop = maxBars > m.n - k ? m.n : k + maxBars;
  const pastGrace = now >= m.obsEnd + FINALIZE_GRACE;
  while (k < stop) {
    const t1 = pointTime(m, k + 1);
    const a = points(t1 - DELTA);
    const b = points(t1);
    const both = !!a?.posted && !!b?.posted;
    if (!both && !pastGrace) break;
    if (both && a!.validA && a!.validB && b!.validA && b!.validB) {
      const ra = winsorize(logRatio(a!.pA, b!.pA), m.csA);
      const rb = winsorize(logRatio(a!.pB, b!.pB), m.csB);
      [c, va, vb] = accumulate(c, va, vb, ra, rb);
      ++nValid;
    }
    ++k;
  }
  return { processed: k, nValid, c, va, vb };
}

export interface Report {
  marketId: number;
  k: number;
  pFair: bigint;
  h0: bigint;
}

/** The report for the accumulator state after bar k (U-3), or why it cannot be accepted (U-4 / zero variance). */
export function reportFor(m: MarketParams, acc: AccState): { report?: Report; problem?: string } {
  const k = BigInt(acc.processed);
  const n = BigInt(m.n);
  let p: bigint;
  try {
    p = fairValue(acc.c, acc.va, acc.vb, k, n, m.sAB, m.sA2, m.sB2);
  } catch (e) {
    if (e instanceof FixedPointError) return { problem: `fair value undefined: ${e.message}` };
    throw e;
  }
  if (p === 0n || p >= WAD) return { problem: `P_fair ${p} outside (0, 1) (U-4)` };
  return { report: { marketId: m.id, k: acc.processed, pFair: p, h0: h0(tau(k, n), m.sigmaTable, m.cH, m.hFloor) } };
}
