// Replay driver (R §5, §6, §4.4-4.5): restores the Setup snapshot on a fresh Anvil, runs the preflight, then plays
// the week — every block time chosen here (R §2.1-1) — as the reporter (points, crank and the price engine's report
// in one transaction, R §5.2), the takers (S0-S4 through the router's entry with the breakdown quote first) and
// finally settlement (R §6.1). It streams one frame per step to the UI (R §8.2) and never reads the wall clock for
// chain purposes: the wall clock only paces the show (R §5.5).
//   node replay/driver.ts <week dir> [--bars bars.json|bars_void.json] [--reference] [--no-pacing] [--wait-start]
//                                    [--port 8545] [--ws 8787] [--engine 8788] [--out run.json]
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { aquaAbi, erc20Abi, hubAbi, lensAbi, routerAbi, vaultAbi } from "../src/abi.ts";
import { fairValue, riskCapital, utilization, WAD } from "../src/fixedpoint.ts";
import { orderHash, type Order } from "../src/orders.ts";
import { canonicalHash } from "./canonical.ts";
import { account, CHAIN_ID, connect, type ReplayChain, type Role, startAnvil } from "./chain.ts";
import type { Addresses } from "./setup.ts";
import { broadcaster, type Broadcaster } from "./ws.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const flag = (k: string) => process.argv.includes(`--${k}`);

interface Point { k: number; t: number; pA: string; pB: string; validA: boolean; validB: boolean; venuesA: number; venuesB: number }
interface TradeSpec { id: string; k: number; actor: "A" | "B" | "C"; op: "mint" | "burn" | "trade"; side?: "long" | "short"; isBuy?: boolean; exactIn?: boolean; amount: string; expect?: Record<string, unknown> }

const dec = (x: bigint, d = 18, places = 6) => {
  const neg = x < 0n;
  const a = neg ? -x : x;
  const s = (a * 10n ** BigInt(places)) / 10n ** BigInt(d);
  const str = s.toString().padStart(places + 1, "0");
  return `${neg ? "-" : ""}${str.slice(0, -places)}.${str.slice(-places)}`;
};

export async function runReplay(o: {
  weekDir: string;
  barsFile: string;
  reference: boolean;
  pacing: boolean;
  waitStart: boolean;
  port: number;
  wsPort: number;
  enginePort: number;
  verifyPort?: number; // the Verifier's GET /result: waited for before the chain stops (R §7.4)
}) {
  const read = (f: string) => JSON.parse(readFileSync(join(o.weekDir, f), "utf8"));
  const manifest = read("manifest.json");
  const sched = read("schedule.json");
  const calib = read("calib.json");
  const addr: Addresses = read("addresses.json");
  const bars = read(o.barsFile);
  const pts: Point[] = bars.points;
  const t0: number = calib.obsStart;
  const N: number = bars.n;
  const mid = addr.market.id;
  const dep = { hub: addr.protocol.hub, router: addr.protocol.router, lens: addr.protocol.lens, usdc: addr.protocol.usdc, aqua: addr.protocol.aqua };
  const vault = addr.market.vault;
  const orders = { long: addr.orders.long as Order, short: addr.orders.short as Order };
  const tol = BigInt(sched.toleranceWad);
  const p0 = fairValue(0n, 0n, 0n, 0n, BigInt(N), BigInt(calib.sAB), BigInt(calib.sA2), BigInt(calib.sB2));
  const rho0 = 2n * p0 - WAD;
  const riskBudget = BigInt(sched.maker.config.riskBudget);

  // ---- chain and helper processes
  let started = false;
  let startResolve: () => void = () => {};
  const startSignal = new Promise<void>((r) => (startResolve = r));
  const ws: Broadcaster = await broadcaster(o.wsPort, (path) => {
    if (path === "/start" && !started) {
      started = true;
      startResolve();
    }
  });
  const { proc, rpc } = await startAnvil(o.port, t0 + sched.chain.genesisOffset);
  const c: ReplayChain = connect(rpc, proc);
  const engine: ChildProcess = spawn(process.execPath, [join(HERE, "engine-server.ts"), join(o.weekDir, "calib.json"), join(o.weekDir, "addresses.json"), "--port", String(o.enginePort)], { stdio: ["ignore", "pipe", "inherit"] });
  const engineReady = new Promise<void>((r) => engine.stdout!.once("data", () => r()));
  const cleanup = async () => {
    engine.kill();
    c.stop();
    await ws.close();
  };
  let seq = 0;
  const t00 = { at: 0 };
  const elapsed = () => (t00.at ? Date.now() - t00.at : 0);
  const frame = (f: Record<string, unknown>) => ws.send({ seq: seq++, elapsedMs: elapsed(), ...f });

  try {
    const state = readFileSync(join(o.weekDir, "state.hex"), "utf8").trim() as Hex;
    await c.call("anvil_loadState", [state]);
    await engineReady;

    // ---- preflight (R §4.5)
    const checks: { id: string; ok: boolean; detail: string }[] = [];
    const check = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
    const chainId = Number(await c.call("eth_chainId"));
    const latest = await c.pc.getBlock({ blockTag: "latest" });
    const codeOk = (await Promise.all([dep.hub, dep.router, dep.lens, dep.aqua, dep.usdc, addr.multicall3].map((a) => c.pc.getCode({ address: a as Address })))).every((x) => x && x !== "0x");
    const addrHashOk = canonicalHash(addr) === manifest.chain.addressesKeccak256;
    const tLatest = Number(latest.timestamp);
    check("P1", chainId === CHAIN_ID && codeOk && addrHashOk && tLatest >= t0 - 230 && tLatest <= t0 - 60 && Number(latest.number) === manifest.chain.snapshot.latestBlock,
      `chainId ${chainId}, block ${latest.number} at T0${tLatest - t0}, code ${codeOk}, addresses ${addrHashOk}`);
    const mcAbi = [{ type: "function", name: "getCurrentBlockTimestamp", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] }] as const;
    const seen = Number(await c.pc.readContract({ address: addr.multicall3, abi: mcAbi, functionName: "getCurrentBlockTimestamp" }));
    check("P2", seen === tLatest || seen === tLatest + 1, `eth_call sees ${seen}, latest block ${tLatest}`);
    const files = ["bars.json", "calib.json", "schedule.json", ...(o.barsFile !== "bars.json" ? [o.barsFile] : [])];
    const bad = files.filter((f) => canonicalHash(read(f)) !== manifest.files[f]?.keccak256);
    check("P3", bad.length === 0, bad.length ? `hash mismatch: ${bad.join(", ")}` : `${files.length} files match the manifest`);
    const [csA, csB] = await c.pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "marketParams", args: [mid] });
    const q0 = await c.pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "quoteState", args: [mid] });
    check("P4", csA === 4n * BigInt(calib.sA) && csB === 4n * BigInt(calib.sB) && Number(q0.obsStart) === t0 && q0.n === N && q0.nMin === bars.nMin,
      `sA ${csA / 4n}, sB ${csB / 4n}, obsStart ${q0.obsStart}, N ${q0.n}, N_min ${q0.nMin}`);
    const health = await fetch(`http://127.0.0.1:${o.enginePort}/health`).then((r) => r.ok).catch(() => false);
    check("P5", health, `price engine ${health ? "up" : "down"}, UI clients ${ws.clients()}`);
    const dummy = await c.pc.readContract({ address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [orders.long, mid, 0, true, false, 10n ** 6n, tol] });
    check("P6", dummy.reason === 0, `dummy quote reason ${dummy.reason}`);
    frame({ type: "preflight", checks, ready: checks.every((x) => x.ok) });
    if (!checks.every((x) => x.ok)) throw new Error(`preflight failed: ${JSON.stringify(checks.filter((x) => !x.ok))}`);

    frame({ type: "ready", week: manifest.week, rho0: dec(rho0), p0: dec(p0), n: N, bars: o.barsFile });
    if (o.waitStart) await startSignal;
    t00.at = Date.now();

    // ---- helpers
    const W = (r: Role) => c.wallet(account(r));
    const send = async (r: Role, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]) => {
      // simulate at the block the transaction will be in (its time is set here, not the previous block's)
      const nb = (await c.pc.getBlockNumber()) + 1n;
      const { request } = await c.pc.simulateContract({ address, abi, functionName, args, account: account(r), blockOverrides: { time: BigInt(c.clock()), number: nb } } as never);
      const hash = await W(r).writeContract(request as never);
      const rc = await c.pc.waitForTransactionReceipt({ hash });
      if (rc.status !== "success") throw new Error(`${functionName} reverted`);
      return rc;
    };
    const P = (p: Point) => ({ t: BigInt(p.t), pA: BigInt(p.pA), pB: BigInt(p.pB), validA: p.validA, validB: p.validB });
    const engineReport = async (ps: Point[]) => {
      const r = await fetch(`http://127.0.0.1:${o.enginePort}/bars`, { method: "POST", body: JSON.stringify({ points: ps }) });
      const j = await r.json();
      if (!r.ok) throw new Error(`price engine: ${j.error}`);
      return j as { marketId: number; k: number; pFair: string; h0: string; signature: Hex };
    };
    const reportsAccepted: { k: number; pFair: string; h0: string }[] = [];
    const post = async (ps: Point[], withReport: boolean, at: number) => {
      const rep = await engineReport(ps);
      c.setClock(at);
      if (!withReport) return send("reporter", dep.hub, hubAbi, "postPoints", [ps.map(P)]);
      const input = { marketId: rep.marketId, k: rep.k, pFair: BigInt(rep.pFair), h0: BigInt(rep.h0), signature: rep.signature };
      const rc = await send("reporter", dep.hub, hubAbi, "postAndReport", [ps.map(P), [input]]);
      reportsAccepted.push({ k: rep.k, pFair: rep.pFair, h0: rep.h0 });
      return rc;
    };
    const mc = <T>(contracts: readonly unknown[]) => c.pc.multicall({ contracts: contracts as never, multicallAddress: addr.multicall3, allowFailure: false }) as Promise<T>;
    const snapshot = async () => {
      const [q, s, cust, supL, supS, coll, usdcV] = await mc<[any, any, readonly [bigint, bigint, boolean], bigint, bigint, bigint, bigint]>([
        { address: dep.hub, abi: hubAbi, functionName: "quoteState", args: [mid] },
        { address: dep.hub, abi: hubAbi, functionName: "settlement", args: [mid] },
        { address: vault, abi: vaultAbi, functionName: "custodyOf", args: [addr.accounts.maker] },
        { address: addr.market.longToken, abi: erc20Abi, functionName: "totalSupply" },
        { address: addr.market.shortToken, abi: erc20Abi, functionName: "totalSupply" },
        { address: vault, abi: vaultAbi, functionName: "collateral" },
        { address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [vault] },
      ]);
      const [nl, ns] = cust;
      const inv = nl - ns;
      const rhoObs = s.va > 0n && s.vb > 0n ? Number(s.c) / Math.sqrt(Number(s.va) * Number(s.vb)) : null;
      return { q, s, nl, ns, inv, supL, supS, coll, usdcV, rhoObs };
    };
    const quotes = async () => {
      // marginal prices at the current inventory: the average of 1 token (display only)
      const [a, b] = await Promise.all([
        c.pc.readContract({ address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [orders.long, mid, 0, true, false, 10n ** 6n, tol] }),
        c.pc.readContract({ address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [orders.long, mid, 0, false, true, 10n ** 6n, tol] }),
      ]);
      return { ask: a.reason === 0 ? dec(a.avgPrice) : null, bid: b.reason === 0 ? dec(b.avgPrice) : null, h: dec(a.h), hmin: dec(a.hmin) };
    };
    const stateFrame = async (phase: string, extra: Record<string, unknown> = {}) => {
      const [st, qs] = await Promise.all([snapshot(), quotes()]);
      const blk = await c.pc.getBlock({ blockTag: "latest" });
      const rc = riskCapital(st.inv, st.q.pFair);
      frame({
        type: "step", phase, chainTime: Number(blk.timestamp), block: Number(blk.number),
        processed: st.q.processed, confirmed: st.q.confirmed, tau: st.q.processed / N, invalidBars: st.q.invalidBars,
        price: { pFair: dec(st.q.pFair), bid: qs.bid, ask: qs.ask, h: qs.h, hmin: qs.hmin, rho0: dec(rho0), rhoObs: st.rhoObs, weightObs: st.q.processed / N, forecastLine: dec(p0) },
        inventory: { q: dec(st.inv, 6, 2), nl: dec(st.nl, 6, 2), ns: dec(st.ns, 6, 2), u: dec(utilization(rc, riskBudget)) },
        supply: { long: dec(st.supL, 6, 2), short: dec(st.supS, 6, 2), collateral: dec(st.coll, 6, 2), usdcInVault: dec(st.usdcV, 6, 2) },
        ...extra,
      });
      return st;
    };
    const tradeLog: Record<string, unknown>[] = [];
    const runTrade = async (tr: TradeSpec) => {
      const who = tr.actor as Role;
      if (tr.op === "mint" || tr.op === "burn") {
        const rc = await send(who, vault, vaultAbi, tr.op, [BigInt(tr.amount)]);
        const e = { id: tr.id, op: tr.op, actor: tr.actor, amount: dec(BigInt(tr.amount), 6, 2), tx: rc.transactionHash, block: Number(rc.blockNumber) };
        tradeLog.push(e);
        return e;
      }
      const side = tr.side === "long" ? 0 : 1;
      const o = side === 0 ? orders.long : orders.short;
      const amount = BigInt(tr.amount);
      const latestBlk = await c.pc.getBlock({ blockTag: "latest" });
      // the quote at the time the trade will execute (next block), on the current state (R §5.2, V5)
      const quote = await c.pc.readContract({
        address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [o, mid, side, tr.isBuy!, tr.exactIn!, amount, tol],
        blockOverrides: { time: BigInt(c.clock()), number: latestBlk.number + 1n },
      });
      if (quote.reason !== 0) {
        const e = { id: tr.id, op: "refused", reason: quote.reason };
        tradeLog.push(e);
        return e;
      }
      const rc = await send(who, dep.router, routerAbi, "trade", [o, mid, side, tr.isBuy!, tr.exactIn!, amount, quote.limit, 0]);
      const logs = rc.logs;
      const { parseEventLogs } = await import("viem");
      const ev = parseEventLogs({ abi: routerAbi, logs });
      const sw = ev.find((x) => x.eventName === "Swapped") as any;
      const cs = ev.find((x) => x.eventName === "CorrSwap") as any;
      const dir = side === 0 ? (tr.isBuy ? 1 : 2) : tr.isBuy ? 3 : 4;
      const qty: bigint = tr.isBuy ? sw.args.amountOut : sw.args.amountIn;
      const cash: bigint = tr.isBuy ? sw.args.amountIn : sw.args.amountOut;
      const kind = dir === 1 || dir === 3 ? (cs.args.q1 > 0n ? "from custody" : "mint") : cs.args.q1 > 0n ? "paired burn" : "bought into custody";
      const e = {
        id: tr.id, op: "trade", actor: tr.actor, dir, exactIn: tr.exactIn, qty: dec(qty, 6, 6), cash: dec(cash, 6, 6), avgPrice: dec((cash * WAD) / qty),
        q1: dec(cs.args.q1, 6, 6), q2: dec(cs.args.q2, 6, 6), kind, pFair: dec(cs.args.pFair), h: dec(cs.args.h), hmin: dec(cs.args.hmin),
        quoteEqualsFill: quote.amountIn === sw.args.amountIn && quote.amountOut === sw.args.amountOut && quote.q1 === cs.args.q1 && quote.q2 === cs.args.q2,
        expected: tr.expect, tx: rc.transactionHash, block: Number(rc.blockNumber), taker: sw.args.taker ?? null,
        raw: { amountIn: sw.args.amountIn.toString(), amountOut: sw.args.amountOut.toString(), q1: cs.args.q1.toString(), q2: cs.args.q2.toString() },
      };
      tradeLog.push(e);
      return e;
    };
    const trades: TradeSpec[] = sched.trades;
    const tradesAt = (k: number) => trades.filter((t) => t.k === k);
    const wait = async (deadlineMs: number) => {
      if (!o.pacing) return 0;
      const late = elapsed() - deadlineMs;
      if (late < 0) await new Promise((r) => setTimeout(r, -late));
      return Math.max(0, late);
    };
    const stepMs: number[] = [];

    // ---- scene 1 (R §5.1: T0 - 200 .. T0 + 12, 0-10 s)
    await stateFrame("scene1");
    c.setClock(t0 - 200);
    const s0 = tradesAt(0);
    for (const [i, tr] of s0.entries()) {
      c.setClock(t0 - 200 + i * 10);
      const e = await runTrade(tr);
      await stateFrame("scene1", { trade: e });
      await wait(((i + 1) * sched.pacing.scene1Ms) / (s0.length + 1));
    }
    await post([pts[0]], false, t0 + 10); // price point k = 0, no report (M §4.2: the initial report covers k = 0)
    await stateFrame("scene1");
    let deadline = sched.pacing.scene1Ms;
    await wait(deadline);

    // ---- phase A (1 step = 12 bars; 24 when late, R §5.5)
    const pa = sched.pacing.phaseA;
    const lastA = pa.barsPerStep * pa.steps; // 2004
    let k = 0;
    let barsPerStep = pa.barsPerStep;
    let tradeMs = pa.tradeStepMs;
    while (k < lastA) {
      const t1 = performance.now();
      const upto = Math.min(k + barsPerStep, lastA);
      const T = t0 + upto * 300;
      await post(pts.slice(k + 1, upto + 1), true, T + sched.chain.postDelay);
      const stepTrades = trades.filter((t) => t.k > k && t.k <= upto && t.k > 0);
      const done: unknown[] = [];
      for (const [i, tr] of stepTrades.entries()) {
        c.setClock(T + sched.chain.tradeDelay + i);
        done.push(await runTrade(tr));
      }
      k = upto;
      await stateFrame("A", done.length ? { trades: done } : {});
      stepMs.push(performance.now() - t1);
      deadline += done.length ? tradeMs : pa.stepMs;
      const late = await wait(deadline);
      if (late > sched.pacing.widen.lateMs && barsPerStep === pa.barsPerStep) barsPerStep = sched.pacing.widen.barsPerStep;
      if (late > sched.pacing.shortenPause.lateMs) tradeMs = pa.stepMs;
    }

    // ---- phase B (1 bar per step; the last bar k = N is at obsEnd: no trade there, T-3)
    for (let kk = lastA + 1; kk <= N; ++kk) {
      const t1 = performance.now();
      await post([pts[kk]], true, t0 + kk * 300 + sched.chain.postDelay);
      await stateFrame("B");
      stepMs.push(performance.now() - t1);
      deadline += sched.pacing.phaseB.stepMs;
      await wait(deadline);
    }

    // ---- settlement (R §6.1: obsEnd + 11 .. + 17)
    const obsEnd = t0 + N * 300;
    const settle: Record<string, unknown>[] = [];
    c.setClock(obsEnd + 11);
    let rc = await send("owner", vault, vaultAbi, "finalize", []);
    settle.push({ step: "finalize", tx: rc.transactionHash });
    c.setClock(obsEnd + 12);
    for (const [name, ord, token] of [["long", orders.long, addr.market.longToken], ["short", orders.short, addr.market.shortToken]] as const) {
      rc = await send("maker", dep.aqua, aquaAbi, "dock", [dep.router, orderHash(ord), [dep.usdc, token]]);
      settle.push({ step: `dock ${name}`, tx: rc.transactionHash });
    }
    const payouts: Record<string, string> = {};
    const bal = (t: Address, who: Address) => c.pc.readContract({ address: t, abi: erc20Abi, functionName: "balanceOf", args: [who] });
    for (const who of ["A", "B", "C"] as const) {
      const a = addr.accounts[who] as Address;
      const [ql, qs] = await Promise.all([bal(addr.market.longToken, a), bal(addr.market.shortToken, a)]);
      if (ql === 0n && qs === 0n) continue;
      const before = await bal(dep.usdc, a);
      rc = await send(who, vault, vaultAbi, "redeem", [ql, qs]);
      payouts[who] = ((await bal(dep.usdc, a)) - before).toString();
      settle.push({ step: `redeem ${who}`, long: ql.toString(), short: qs.toString(), payout: payouts[who], tx: rc.transactionHash });
    }
    {
      const before = await bal(dep.usdc, addr.accounts.maker as Address);
      rc = await send("maker", vault, vaultAbi, "claimDeposit", []);
      payouts.maker = ((await bal(dep.usdc, addr.accounts.maker as Address)) - before).toString();
      settle.push({ step: "maker claims custody", payout: payouts.maker, tx: rc.transactionHash });
    }
    const longT = await c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longT" });
    const isVoid = await c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "isVoid" });
    const final = await c.pc.getBlock({ blockTag: "latest" });
    await stateFrame("settlement", { settlement: settle, longT: dec(longT), isVoid, payouts });
    deadline += sched.pacing.settlementMs;
    await wait(deadline);

    // the Verifier follows the chain on its own; keep the chain up until it has its result
    let verification: unknown = null;
    if (o.verifyPort) {
      for (let i = 0; i < 1200; ++i) {
        const r = await fetch(`http://127.0.0.1:${o.verifyPort}/result`).then((x) => x.json()).catch(() => null);
        if (r?.done !== undefined && r.done !== false) {
          verification = r;
          break;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
    }
    deadline += sched.pacing.verificationMs;
    await wait(deadline);
    const sorted = [...stepMs].sort((a, b) => a - b);
    const result = {
      week: manifest.week, bars: o.barsFile, verification, stateRoot: final.stateRoot, block: Number(final.number), longT: longT.toString(), isVoid, payouts,
      reports: reportsAccepted.length, trades: tradeLog, settlement: settle,
      timing: { totalMs: elapsed(), steps: stepMs.length, stepP50Ms: sorted[Math.floor(sorted.length / 2)], stepP99Ms: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)], stepMaxMs: sorted[sorted.length - 1] },
      gas: { txs: c.gasLog.length, maxGasUsed: c.gasLog.reduce((m, g) => (g.gasUsed > m ? g.gasUsed : m), 0n).toString(), total: c.gasLog.reduce((s, g) => s + g.gasUsed, 0n).toString() },
    };
    frame({ type: "done", result: { stateRoot: result.stateRoot, longT: dec(longT), isVoid, payouts, timing: result.timing } });
    return result;
  } finally {
    await cleanup();
  }
}

if (process.argv[1]?.endsWith("driver.ts")) {
  const weekDir = process.argv[2];
  if (!weekDir) throw new Error("usage: driver.ts <week dir> [options]");
  const r = await runReplay({
    weekDir,
    barsFile: arg("bars") ?? "bars.json",
    reference: flag("reference"),
    pacing: !flag("no-pacing") && !flag("reference"),
    waitStart: flag("wait-start"),
    port: Number(arg("port") ?? 8545),
    wsPort: Number(arg("ws") ?? 8787),
    enginePort: Number(arg("engine") ?? 8788),
    verifyPort: flag("no-verify") ? undefined : Number(arg("verify") ?? 8789),
  });
  const json = JSON.stringify(r, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);
  const out = arg("out");
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json + "\n");
  }
  if (flag("reference")) {
    const mp = join(weekDir, "manifest.json");
    const m = JSON.parse(readFileSync(mp, "utf8"));
    const key = r.bars === "bars.json" ? "reference" : "referenceVoid";
    m[key] = { stateRoot: r.stateRoot, block: r.block, longT: r.longT, isVoid: r.isVoid, payouts: r.payouts, reports: r.reports, maxGasUsed: r.gas.maxGasUsed };
    writeFileSync(mp, JSON.stringify(m, null, 1) + "\n");
  }
  console.log(JSON.stringify({ stateRoot: r.stateRoot, longT: r.longT, isVoid: r.isVoid, payouts: r.payouts, timing: r.timing, gas: r.gas, trades: r.trades.map((t: any) => ({ id: t.id, op: t.op, qty: t.qty, cash: t.cash, q1: t.q1, q2: t.q2, kind: t.kind, eq: t.quoteEqualsFill })) }, null, 1));
}
