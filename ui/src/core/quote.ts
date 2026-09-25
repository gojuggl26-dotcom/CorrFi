// Quote controller of the swap screen (M §5.8.2-5.8.4, §8.3). It never prices anything itself: every number it
// shows is the lens breakdown (the same code as the router's opcodes). It owns the timing rules:
//   - automatic re-quote every `refreshSec` (default 10, 5-15), input changes after `debounceMs` (0.3 s),
//     immediately on a price-confirmation event (ReportAccepted);
//   - two countdowns in chain time — chain time = the quote's evaluation time + local time elapsed since, i.e. the
//     local clock corrected by (latest block time - local time) at every quote;
//       (1) until the next automatic re-quote, (2) until the next fair-value update t_{k+1} + posting delay (10 s),
//       after which it shows "waiting for the price update" until a report arrives;
//   - the stop warning from t_stop - 60 s (t_stop = t_k + Δ + g) and the stopped state (reason != 0): execution is
//     disabled; a stop that a report clears (T-1 / T-2) ends by itself on the next report, T-4 never does;
//   - before executing: re-quote if the quote is older than 3 s or a newer bar has been confirmed, and ask the user
//     to confirm when the amounts changed.

import { REASONS } from "../../../engine/src/taker.ts";

export const DELTA_DEFAULT = 2n * 10n ** 15n; // 0.002 USDC / token (M §5.8.3)
export const DELTA_MIN = 5n * 10n ** 14n; // 0.0005
export const DELTA_MAX = 10n ** 16n; // 0.01
export const REFRESH_MIN = 5;
export const REFRESH_MAX = 15;

export interface QuoteInput {
  marketId: number;
  side: number; // 0 Long, 1 Short
  isBuy: boolean;
  exactIn: boolean;
  amount: bigint;
  delta: bigint;
}

/** The subset of the lens breakdown the controller reads (the whole struct is kept for display). */
export interface BreakdownLike {
  reason: number;
  amountIn: bigint;
  amountOut: bigint;
  qty: bigint;
  limit: bigint;
  limitDefined: boolean;
  pFair: bigint;
  hmin: bigint;
  h: bigint;
  hU: bigint;
  inv0: bigint;
  k: number;
  tK: bigint;
  tNext: bigint;
  tStop: bigint;
  evaluatedAt: bigint;
}

export interface Quote<B extends BreakdownLike = BreakdownLike> {
  input: QuoteInput;
  b: B;
  localMs: number; // local clock when the answer arrived
}

export interface Settings {
  refreshSec: number;
  debounceMs: number;
  postDelaySec: number;
  staleQuoteMs: number;
  warnBeforeStopSec: number;
}

export const DEFAULT_SETTINGS: Settings = { refreshSec: 10, debounceMs: 300, postDelaySec: 10, staleQuoteMs: 3000, warnBeforeStopSec: 60 };

export interface Deps<B extends BreakdownLike> {
  fetch(input: QuoteInput): Promise<B>;
  nowMs(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
  onChange(): void;
}

export function validDelta(d: bigint) {
  return d >= DELTA_MIN && d <= DELTA_MAX;
}

export interface ViewState {
  loading: boolean;
  error?: string;
  chainNow?: number;
  refreshInSec?: number;
  nextFairValueInSec?: number; // undefined when waiting
  waitingForPrice: boolean;
  stopInSec?: number;
  stopWarning: boolean;
  reason?: number;
  reasonText?: string;
  clears?: string;
  canExecute: boolean;
}

export class QuoteController<B extends BreakdownLike = BreakdownLike> {
  input?: QuoteInput;
  quote?: Quote<B>;
  latestConfirmedK = -1;
  loading = false;
  error?: string;
  settings: Settings;
  private readonly d: Deps<B>;
  private debounce?: unknown;
  private refreshTimer?: unknown;
  private nextRefreshMs?: number;
  private seq = 0;

  constructor(deps: Deps<B>, settings: Partial<Settings> = {}) {
    this.d = deps;
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  setRefreshSec(s: number) {
    if (s < REFRESH_MIN || s > REFRESH_MAX) throw new Error(`refresh interval must be ${REFRESH_MIN}-${REFRESH_MAX} s`);
    this.settings.refreshSec = s;
    this.schedule();
  }

  /** An input change: re-quote after the debounce. */
  setInput(input: QuoteInput) {
    if (!validDelta(input.delta)) throw new Error("tolerance must be 0.0005-0.01 USDC per token");
    this.input = input;
    if (this.debounce !== undefined) this.d.clearTimer(this.debounce);
    this.debounce = this.d.setTimer(() => {
      this.debounce = undefined;
      void this.refresh();
    }, this.settings.debounceMs);
  }

  /** A ReportAccepted event: quote again at once and reset the countdowns. */
  onReport(k: number) {
    if (k > this.latestConfirmedK) this.latestConfirmedK = k;
    if (this.input) void this.refresh();
  }

  async refresh(): Promise<Quote<B> | undefined> {
    if (!this.input) return undefined;
    const input = this.input;
    const my = ++this.seq;
    this.loading = true;
    this.d.onChange();
    try {
      const b = await this.d.fetch(input);
      if (my !== this.seq) return this.quote; // a newer request is running
      this.quote = { input, b, localMs: this.d.nowMs() };
      if (b.k > this.latestConfirmedK) this.latestConfirmedK = b.k;
      this.error = undefined;
    } catch (e) {
      if (my === this.seq) this.error = e instanceof Error ? e.message : String(e);
    } finally {
      if (my === this.seq) {
        this.loading = false;
        this.schedule();
        this.d.onChange();
      }
    }
    return this.quote;
  }

  private schedule() {
    if (this.refreshTimer !== undefined) this.d.clearTimer(this.refreshTimer);
    if (!this.input) return;
    const ms = this.settings.refreshSec * 1000;
    this.nextRefreshMs = this.d.nowMs() + ms;
    this.refreshTimer = this.d.setTimer(() => void this.refresh(), ms);
  }

  stop() {
    for (const h of [this.debounce, this.refreshTimer]) if (h !== undefined) this.d.clearTimer(h);
    this.debounce = this.refreshTimer = undefined;
  }

  /** Chain time now, from the last quote's evaluation time plus local time elapsed since. */
  chainNow(): number | undefined {
    if (!this.quote) return undefined;
    return Number(this.quote.b.evaluatedAt) + (this.d.nowMs() - this.quote.localMs) / 1000;
  }

  view(): ViewState {
    const v: ViewState = { loading: this.loading, error: this.error, waitingForPrice: false, stopWarning: false, canExecute: false };
    const q = this.quote;
    if (!q) return v;
    const now = this.chainNow()!;
    v.chainNow = now;
    v.refreshInSec = this.nextRefreshMs === undefined ? undefined : Math.max(0, (this.nextRefreshMs - this.d.nowMs()) / 1000);
    const nextUpdate = Number(q.b.tNext) + this.settings.postDelaySec;
    if (now < nextUpdate) v.nextFairValueInSec = nextUpdate - now;
    else v.waitingForPrice = true;
    v.stopInSec = Number(q.b.tStop) - now;
    v.stopWarning = v.stopInSec <= this.settings.warnBeforeStopSec;
    v.reason = q.b.reason;
    const r = REASONS[q.b.reason];
    v.reasonText = r?.ja ?? `理由コード ${q.b.reason}`;
    v.clears = r?.clears;
    v.canExecute = q.b.reason === 0 && !this.loading && v.stopInSec > 0;
    return v;
  }

  /** Before sending: re-quote when the quote is older than 3 s or a newer bar exists; report what changed. */
  async beforeExecute(): Promise<{ proceed: boolean; requoted: boolean; before?: B; after?: B; changed: boolean }> {
    const q = this.quote;
    if (!q) return { proceed: false, requoted: false, changed: false };
    const stale = this.d.nowMs() - q.localMs > this.settings.staleQuoteMs || this.latestConfirmedK > q.b.k;
    if (!stale) return { proceed: q.b.reason === 0, requoted: false, before: q.b, after: q.b, changed: false };
    const after = await this.refresh();
    const b = after?.b;
    if (!b) return { proceed: false, requoted: true, changed: true };
    const changed = b.amountIn !== q.b.amountIn || b.amountOut !== q.b.amountOut || b.reason !== q.b.reason;
    return { proceed: b.reason === 0 && !changed, requoted: true, before: q.b, after: b, changed };
  }
}

export interface FillFacts {
  amountIn: bigint;
  amountOut: bigint;
  pFair: bigint;
  hmin: bigint;
  h: bigint;
}

/** Why a fill differs from its quote (M §5.8.3): a new bar, elapsed time (h_O), or other trades (inventory, h_U). */
export function explainFill(q: BreakdownLike, f: FillFacts): string[] {
  if (f.amountIn === q.amountIn && f.amountOut === q.amountOut) return [];
  const causes: string[] = [];
  if (f.pFair !== q.pFair) causes.push("new-bar");
  else if (f.hmin !== q.hmin) causes.push("elapsed-time");
  if (f.pFair === q.pFair && f.h - f.hmin !== q.h - q.hmin) causes.push("inventory");
  if (causes.length === 0) causes.push("inventory"); // same P and spreads: the curve position (other fills) moved
  return causes;
}

export const CAUSE_TEXT: Record<string, string> = {
  "new-bar": "見積もりの後に新しいバーが確認され、公正価格が更新されました",
  "elapsed-time": "見積もりから約定までの経過時間で鮮度の上乗せ（h_O）が増えました",
  inventory: "見積もりの後に他の約定があり、Maker の在庫（または使用率の上乗せ h_U）が変わりました",
};
