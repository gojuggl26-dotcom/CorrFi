// Replay UI state (R §8): a pure reducer over the Driver's frames (ws :8787) and the Verifier's messages (ws :8789).
// The UI never reads the chain (R §8.1); rendering (view.ts) only reads this state, so the design can change freely.

import { LONG, SHORT } from "../core/labels.ts";

export type Status = "connecting" | "preflight" | "ready" | "running" | "settled" | "done" | "failed";
export const V_ITEMS = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"] as const;
export type VItem = (typeof V_ITEMS)[number];

export interface ChartPoint {
  tau: number;
  pFair: number;
  bid: number | null;
  ask: number | null;
  realized: number | null; // (1 + rho_obs) / 2
}

export interface TradeRow {
  id: string;
  op: string;
  actor?: string;
  dir?: number;
  exactIn?: boolean;
  qty?: string;
  cash?: string;
  avgPrice?: string;
  kind?: string;
  aqua?: { pulls: number; pushes: number };
  q1?: string;
  q2?: string;
  tau: number;
  reason?: number;
  amount?: string;
}

export interface ReplayState {
  status: Status;
  preflight: { id: string; ok: boolean; detail: string }[];
  week?: { obsStart: number; obsStartIso: string; tenorDays: number };
  bars?: string;
  n: number;
  rho0?: number;
  p0?: number;
  phase: string;
  elapsedMs: number;
  chainTime?: number;
  block?: number;
  processed: number;
  tau: number;
  invalidBars: number;
  price?: { pFair: number; bid: number | null; ask: number | null; h: number; hmin: number; rhoObs: number | null };
  inventory?: { q: string; nl: string; ns: string; u: string };
  supply?: { long: string; short: string; collateral: string; usdcInVault: string };
  series: ChartPoint[];
  trades: TradeRow[];
  settlement?: Record<string, unknown>[];
  longT?: number;
  isVoid?: boolean;
  payouts?: Record<string, string>;
  timing?: { totalMs: number; stepP99Ms: number };
  stateRoot?: string;
  verify: { items: Partial<Record<VItem, { ok: boolean; checked: number; failures: number; detail: string }>>; pass?: boolean; v2LongT?: string; v2Diff?: string; done: boolean };
}

export const initialState = (): ReplayState => ({
  status: "connecting",
  preflight: [],
  n: 2016,
  phase: "",
  elapsedMs: 0,
  processed: 0,
  tau: 0,
  invalidBars: 0,
  series: [],
  trades: [],
  verify: { items: {}, done: false },
});

const num = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x));

// biome-ignore lint: frames are plain JSON
type Msg = Record<string, any>;

export function reduceDriver(s: ReplayState, m: Msg): ReplayState {
  switch (m.type) {
    case "preflight":
      return { ...s, status: m.ready ? "preflight" : "failed", preflight: m.checks };
    case "ready":
      return { ...s, status: "ready", week: m.week, bars: m.bars, n: m.n, rho0: Number(m.rho0), p0: Number(m.p0) };
    case "step": {
      const pr = m.price;
      const point: ChartPoint = {
        tau: m.tau,
        pFair: Number(pr.pFair),
        bid: num(pr.bid),
        ask: num(pr.ask),
        realized: pr.rhoObs === null ? null : (1 + Number(pr.rhoObs)) / 2,
      };
      const newTrades = [...(m.trade ? [m.trade] : []), ...(m.trades ?? [])].map((t: Msg) => ({ ...t, tau: m.tau }) as TradeRow);
      const settled = m.phase === "settlement";
      return {
        ...s,
        status: settled ? "settled" : "running",
        phase: m.phase,
        elapsedMs: m.elapsedMs,
        chainTime: m.chainTime,
        block: m.block,
        processed: m.processed,
        tau: m.tau,
        invalidBars: m.invalidBars,
        price: { pFair: Number(pr.pFair), bid: num(pr.bid), ask: num(pr.ask), h: Number(pr.h), hmin: Number(pr.hmin), rhoObs: num(pr.rhoObs) },
        inventory: m.inventory,
        supply: m.supply,
        series: settled ? s.series : [...s.series, point],
        trades: [...s.trades, ...newTrades],
        ...(settled ? { settlement: m.settlement, longT: Number(m.longT), isVoid: m.isVoid, payouts: m.payouts } : {}),
      };
    }
    case "phase":
      return { ...s, phase: m.phase, elapsedMs: m.elapsedMs };
    case "done":
      return { ...s, status: "done", elapsedMs: m.elapsedMs, timing: m.result?.timing, stateRoot: m.result?.stateRoot };
    default:
      return s;
  }
}

export function reduceVerifier(s: ReplayState, m: Msg): ReplayState {
  if (m.type === "item") {
    const v = m.item as VItem;
    return { ...s, verify: { ...s.verify, items: { ...s.verify.items, [v]: { ok: (s.verify.items[v]?.ok ?? true) && m.ok, checked: m.checked, failures: m.failures, detail: m.detail } } } };
  }
  if (m.type === "summary") {
    const items = { ...s.verify.items };
    for (const v of V_ITEMS) {
      const it = m.items?.[v];
      if (it) items[v] = { ok: it.pass, checked: it.checked, failures: it.failures.length, detail: items[v]?.detail ?? "" };
    }
    return { ...s, verify: { items, pass: m.pass, v2LongT: m.V2?.longT_hp, v2Diff: m.V2?.diff, done: true } };
  }
  return s;
}

/** Real-time budget of the show (R §1.2 D1): target 107 s, limit 120 s. */
export const TARGET_MS = 107_000;
export const LIMIT_MS = 120_000;
export const PHASE_NAMES: Record<string, string> = { scene1: "シーン 1", A: "フェーズ A", B: "フェーズ B", settlement: "決済", verification: "検証", "": "—" };

/** The verdict is revealed in the verification phase (R §5.1), after the settlement has been shown. */
export const showVerdict = (s: ReplayState) => s.verify.done && (s.phase === "verification" || s.status === "done");
export const DIR_NAMES: Record<number, string> = { 1: `D1 ${LONG} を買う`, 2: `D2 ${LONG} を売る`, 3: `D3 ${SHORT} を買う`, 4: `D4 ${SHORT} を売る` };
