// Reporter (M §4.2.1, §6.2, §8.3): every 5 minutes, post the price point of the new grid time, crank and have the
// price engine's signed report accepted, all in one transaction. After an outage it backfills the missing points
// from the venues' 1-minute bars and reports the latest bar (in several transactions when the batch is large).
//
// Every tick starts from the chain state, so the reporter is idempotent and can be restarted at any time.
//
// When a venue gives no bar for t - 60 the reporter must tell "the venue had no bar" (the venue is invalid for that
// point) from "the reporter could not ask" (unknown). A bar counts as missing only when the venue has already
// published a later minute or `venueWaitSec` has passed since t. A venue whose request fails is left out of the
// median only after it has kept failing for `venueWaitSec` since its first failure for that point (not since t: after
// an outage every backfilled point is past t + venueWaitSec — review 2026-09-26 #3), only if at least three venues
// answered, and only if the price stays valid without it. Otherwise the point waits: trading stops by T-2 while it
// waits, and the point is posted later (backfill) — an unknown is never posted as an invalid price.
//
// The hub rejects a valid price whose log return to a posted, valid neighbour exceeds 0.5 (M §6.2.1). Such a price
// would block every later point and report, so the reporter checks it first and posts that asset invalid instead
// (DEC-29, a judgment the spec leaves open — review #5). A report the hub refuses must not hold back the points or the
// other markets: the combined transaction falls back to the points alone and one report per market.

import type { Account, Address, Hex, PublicClient, WalletClient } from "viem";
import { hubAbi } from "./abi.ts";
import { type Deployment, type MarketView, readMarket, readPoint, signReport } from "./chain.ts";
import { logRatio } from "./fixedpoint.ts";
import { type ChainPoint, crank, DELTA, pointTime, type Report, reportFor } from "./market.ts";
import { MIN_VALID_VENUES, type MinuteBar, pricePoint, SYMBOLS, VENUES, type Venue } from "./prices.ts";
import type { KlineSource } from "./sources.ts";

export interface ReporterOptions {
  postDelaySec: number; // post a grid time t no earlier than t + postDelaySec (M §5.8.3: about 10 s)
  venueWaitSec: number; // after t + venueWaitSec a missing / failing venue counts as invalid (see above)
  maxPointsPerTx: number;
  maxCrankPerTx: number;
  readConcurrency: number; // price points read from the chain at once (a long backfill needs thousands — review #14)
}

export const DEFAULT_OPTIONS: ReporterOptions = { postDelaySec: 10, venueWaitSec: 60, maxPointsPerTx: 48, maxCrankPerTx: 144, readConcurrency: 32 };

/** |ln(P_k / P_k-1)| the hub accepts between posted, valid neighbours (CorrFiHub.MAX_ABS_LOG_RETURN, M §6.2.1). */
export const MAX_ABS_LOG_RETURN = 5n * 10n ** 17n;

/** `f` over `xs` with at most `n` calls running at a time; results in order. */
export async function mapLimited<T, R>(xs: readonly T[], n: number, f: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length);
  let next = 0;
  const worker = async () => {
    while (next < xs.length) {
      const i = next++;
      out[i] = await f(xs[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker));
  return out;
}

export interface ReporterDeps {
  pc: PublicClient;
  wc: WalletClient; // account = the registered reporter
  dep: Deployment;
  engine: Account; // the registered price-engine key (EIP-712)
  source: KlineSource;
  now: () => Promise<number>; // seconds
  log: (event: Record<string, unknown>) => void;
}

export interface PointInput {
  t: bigint;
  pA: bigint;
  pB: bigint;
  validA: boolean;
  validB: boolean;
}

export interface TickResult {
  now: number;
  posted: number[];
  reports: Report[];
  waiting: { t: number; why: string }[];
  problems: string[];
  /** assets posted invalid because their log return to a neighbour exceeds 0.5 (DEC-29) */
  implausible: { t: number; asset: string; logReturn: bigint; neighbour: number }[];
  txs: Hex[];
}

type VenueAnswer = Map<number, MinuteBar> | Error;
type SignedReport = { marketId: number; k: number; pFair: bigint; h0: bigint; signature: Hex };

export class Reporter {
  readonly opt: ReporterOptions;
  private readonly d: ReporterDeps;
  private hFloor?: bigint;
  /** first failure of a venue's request for a point: `${t}/${asset}/${venue}` -> seconds */
  private readonly failSince = new Map<string, number>();

  constructor(deps: ReporterDeps, opt: Partial<ReporterOptions> = {}) {
    this.d = deps;
    this.opt = { ...DEFAULT_OPTIONS, ...opt };
  }

  private async markets(): Promise<MarketView[]> {
    const { pc, dep } = this.d;
    this.hFloor ??= await pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "hFloor" });
    const count = await pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "marketCount" });
    const all = await Promise.all([...Array(count).keys()].map((id) => readMarket(pc, dep, id, this.hFloor!)));
    return all.filter((m) => !m.finalized && (m.acc.processed < m.params.n || m.confirmed < m.acc.processed));
  }

  /** Grid times some live market needs and nobody has posted yet, oldest first. */
  private async needed(live: MarketView[], now: number, chain: Map<number, ChainPoint>): Promise<number[]> {
    const times = new Set<number>();
    for (const m of live) {
      const due = Math.floor((now - this.opt.postDelaySec - m.params.obsStart) / DELTA);
      const last = Math.min(m.params.n, due);
      for (let k = m.acc.processed; k <= last; ++k) times.add(pointTime(m.params, k));
    }
    const sorted = [...times].sort((a, b) => a - b);
    const pts = await mapLimited(sorted, this.opt.readConcurrency, (t) => readPoint(this.d.pc, this.d.dep, t));
    sorted.forEach((t, i) => chain.set(t, pts[i]));
    return sorted.filter((t) => !chain.get(t)!.posted);
  }

  /** Price points for `times` (ascending), stopping at the first one that cannot be decided yet. */
  async pricePoints(times: number[], now: number): Promise<{ ready: PointInput[]; waiting: { t: number; why: string }[] }> {
    const ready: PointInput[] = [];
    if (times.length === 0) return { ready, waiting: [] };
    const start = times[0] - 60;
    const answers: Record<string, Record<Venue, VenueAnswer>> = {};
    for (const [asset, symbol] of Object.entries(SYMBOLS)) {
      answers[asset] = {} as Record<Venue, VenueAnswer>;
      await Promise.all(
        VENUES.map(async (v) => {
          try {
            answers[asset][v] = await this.d.source.bars(v, symbol, start, now, now);
          } catch (e) {
            answers[asset][v] = e instanceof Error ? e : new Error(String(e));
            this.d.log({ ev: "venue_error", venue: v, symbol, error: answers[asset][v].message });
          }
        }),
      );
    }
    for (const t of times) {
      const waited = now >= t + this.opt.venueWaitSec;
      const prices: Record<string, bigint | null> = {};
      let why = "";
      for (const asset of Object.keys(SYMBOLS)) {
        const bars: Record<string, MinuteBar | null> = {};
        const answered = VENUES.filter((v) => !(answers[asset][v] instanceof Error)).length;
        let unknown = 0;
        for (const v of VENUES) {
          const a = answers[asset][v];
          if (a instanceof Error) {
            const key = `${t}/${asset}/${v}`;
            const since = this.failSince.get(key) ?? now;
            this.failSince.set(key, since);
            if (waited && now >= since + this.opt.venueWaitSec && answered >= MIN_VALID_VENUES) {
              bars[v] = null;
              ++unknown;
            } else why ||= `${asset} ${v}: request failed (${answered} venues answered, failing for ${now - since} s)`;
            continue;
          }
          const b = a.get(t - 60);
          if (b) bars[v] = b;
          else if (waited || [...a.keys()].some((ot) => ot > t - 60)) bars[v] = null;
          else why ||= `${asset} ${v}: bar ${t - 60} not published yet`;
        }
        if (why) continue;
        const pp = pricePoint(t, bars);
        // invalid only because of venues that could not be asked: that is an unknown, not an invalid price
        if (pp.priceWad === null && unknown > 0) why = `${asset}: ${pp.nValidVenues} venues have the bar and ${unknown} could not be asked`;
        else prices[asset] = pp.priceWad;
      }
      if (why) return { ready, waiting: [{ t, why }] };
      for (const asset of Object.keys(SYMBOLS)) for (const v of VENUES) this.failSince.delete(`${t}/${asset}/${v}`);
      ready.push({ t: BigInt(t), pA: prices.A ?? 0n, pB: prices.B ?? 0n, validA: prices.A != null, validB: prices.B != null });
    }
    return { ready, waiting: [] };
  }

  /** Post an asset invalid where its log return to a posted, valid neighbour (on chain or earlier in `ready`) exceeds
   *  0.5, which the hub would reject (DEC-29). `ready` is ascending and adjusted in place. */
  private async plausible(ready: PointInput[], chain: Map<number, ChainPoint>, res: TickResult) {
    const at = async (t: number) => {
      if (!chain.has(t)) chain.set(t, await readPoint(this.d.pc, this.d.dep, t));
      return chain.get(t)!;
    };
    const assets = [["A", "pA", "validA"], ["B", "pB", "validB"]] as const;
    for (let i = 0; i < ready.length; ++i) {
      const p = ready[i];
      const t = Number(p.t);
      const prev: ChainPoint = i > 0 && ready[i - 1].t === p.t - BigInt(DELTA) ? { ...ready[i - 1], posted: true } : await at(t - DELTA);
      const next = await at(t + DELTA);
      for (const [asset, px, valid] of assets) {
        if (!p[valid]) continue;
        const checks = [
          { nb: prev, nt: t - DELTA, lr: () => logRatio(prev[px], p[px]) },
          { nb: next, nt: t + DELTA, lr: () => logRatio(p[px], next[px]) },
        ];
        for (const { nb, nt, lr } of checks) {
          if (!nb.posted || !nb[valid]) continue;
          const r = lr();
          if (r <= MAX_ABS_LOG_RETURN && r >= -MAX_ABS_LOG_RETURN) continue;
          res.implausible.push({ t, asset, logReturn: r, neighbour: nt });
          this.d.log({ ev: "implausible", t, asset, logReturn: r.toString(), neighbour: nt });
          p[px] = 0n;
          p[valid] = false;
          break;
        }
      }
    }
  }

  /** The points and reports in one transaction; if the hub refuses it, the points alone and then one transaction per
   *  report, so that one market's report cannot hold back the others (review #5). Returns the accepted reports. */
  private async postWithReports(points: PointInput[], signed: SignedReport[], res: TickResult): Promise<SignedReport[]> {
    try {
      res.txs.push(await this.send("postAndReport", [points, signed]));
      return signed;
    } catch (e) {
      this.d.log({ ev: "combined_failed", error: (e as Error).message.split("\n")[0] });
    }
    if (points.length) res.txs.push(await this.send("postPoints", [points]));
    const ok: SignedReport[] = [];
    for (const s of signed) {
      try {
        res.txs.push(await this.send("postAndReport", [[], [s]]));
        ok.push(s);
      } catch (e) {
        const msg = (e as Error).message.split("\n")[0];
        res.problems.push(`market ${s.marketId} bar ${s.k}: report refused (${msg})`);
        this.d.log({ ev: "report_failed", market: s.marketId, k: s.k, error: msg });
      }
    }
    return ok;
  }

  private async send(functionName: "postAndReport" | "postPoints" | "crank", args: readonly unknown[]): Promise<Hex> {
    const { pc, wc, dep } = this.d;
    const { request } = await pc.simulateContract({
      address: dep.hub,
      abi: hubAbi,
      functionName,
      args: args as never,
      account: wc.account!,
    });
    const hash = await wc.writeContract(request as never);
    const receipt = await pc.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    this.d.log({ ev: "tx", fn: functionName, hash, gasUsed: receipt.gasUsed.toString(), block: Number(receipt.blockNumber) });
    return hash;
  }

  async tick(): Promise<TickResult> {
    const now = await this.d.now();
    const res: TickResult = { now, posted: [], reports: [], waiting: [], problems: [], implausible: [], txs: [] };
    const live = await this.markets();
    const chain = new Map<number, ChainPoint>();
    const times = await this.needed(live, now, chain);
    const { ready, waiting } = await this.pricePoints(times, now);
    res.waiting = waiting;
    for (const w of waiting) this.d.log({ ev: "waiting", ...w });
    await this.plausible(ready, chain, res);
    for (const p of ready) chain.set(Number(p.t), { pA: p.pA, pB: p.pB, posted: true, validA: p.validA, validB: p.validB });

    // accumulator after the new points, per market; a report for every market that moves past `confirmed`
    const lookup = (t: number) => chain.get(t);
    const reports: { m: MarketView; r: Report; bars: number }[] = [];
    const stuck: { m: MarketView; bars: number }[] = [];
    for (const m of live) {
      // points of this market that are not yet known must be read before simulating its crank
      for (let k = m.acc.processed; k <= m.params.n; ++k) {
        const t = pointTime(m.params, k);
        if (t > now) break;
        if (!chain.has(t)) chain.set(t, await readPoint(this.d.pc, this.d.dep, t));
        if (!chain.get(t)!.posted) break;
      }
      const acc = crank(m.params, m.acc, lookup, Number.MAX_SAFE_INTEGER, now);
      if (acc.processed <= m.confirmed) continue;
      const { report, problem } = reportFor(m.params, acc);
      if (report) reports.push({ m, r: report, bars: acc.processed - m.acc.processed });
      else {
        res.problems.push(`market ${m.params.id} bar ${acc.processed}: ${problem}`);
        this.d.log({ ev: "no_report", market: m.params.id, k: acc.processed, problem });
        stuck.push({ m, bars: acc.processed - m.acc.processed });
      }
    }

    const signed: SignedReport[] = await Promise.all(
      reports.map(async ({ r }) => ({ marketId: r.marketId, k: r.k, pFair: r.pFair, h0: r.h0, signature: await signReport(this.d.engine, this.d.dep, r) })),
    );
    let accepted = signed;
    const crankBars = reports.reduce((s, x) => s + x.bars, 0);
    if (ready.length <= this.opt.maxPointsPerTx && crankBars <= this.opt.maxCrankPerTx) {
      if (signed.length) accepted = await this.postWithReports(ready, signed, res);
      else if (ready.length) res.txs.push(await this.send("postPoints", [ready]));
    } else {
      // large backfill: points in chunks, the accumulation in chunks, then the reports (trading halts on T-1 meanwhile)
      for (let i = 0; i < ready.length; i += this.opt.maxPointsPerTx) {
        res.txs.push(await this.send("postPoints", [ready.slice(i, i + this.opt.maxPointsPerTx)]));
      }
      for (const { m, bars } of reports) {
        for (let left = bars; left > this.opt.maxCrankPerTx; left -= this.opt.maxCrankPerTx) {
          res.txs.push(await this.send("crank", [m.params.id, this.opt.maxCrankPerTx]));
        }
      }
      if (signed.length) accepted = await this.postWithReports([], signed, res);
    }
    // markets whose report cannot be accepted (PROP-04: final bar outside (0, 1) or zero variance): accumulate
    // anyway so that finalize becomes possible; trading stays halted (T-1)
    for (const { m, bars } of stuck) {
      for (let left = bars; left > 0; left -= this.opt.maxCrankPerTx) {
        res.txs.push(await this.send("crank", [m.params.id, Math.min(left, this.opt.maxCrankPerTx)]));
      }
    }
    res.posted = ready.map((p) => Number(p.t));
    res.reports = reports.filter((x) => accepted.some((s) => s.marketId === x.r.marketId && s.k === x.r.k)).map((x) => x.r);
    if (res.posted.length || res.reports.length) {
      this.d.log({
        ev: "tick",
        now,
        posted: res.posted,
        reports: res.reports.map((r) => ({ market: r.marketId, k: r.k, pFair: r.pFair.toString(), h0: r.h0.toString() })),
        lagSec: res.posted.length ? now - res.posted[res.posted.length - 1] : undefined,
      });
    }
    return res;
  }
}

export type { Address };
