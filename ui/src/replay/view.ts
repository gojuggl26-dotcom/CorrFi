// Rendering of the replay state into the six panels of R §8.1 (clock, price chart, weight gauge, inventory and
// collateral, trade log, verification). Pure DOM / canvas from ReplayState; all look-and-feel lives in replay.css.
import { DIR_NAMES, LIMIT_MS, PHASE_NAMES, type ReplayState, showVerdict, TARGET_MS, V_ITEMS } from "./state.ts";

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const set = (id: string, text: string) => {
  const el = $(id);
  if (el && el.textContent !== text) el.textContent = text;
};
const pct = (x: number, d = 1) => `${(x * 100).toFixed(d)}%`;
const utc = (t?: number) => (t ? new Date(t * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC" : "—");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function render(s: ReplayState) {
  // status / START
  const statusText: Record<string, string> = {
    connecting: "接続中…", preflight: "プリフライト合格", ready: "READY", running: "再生中", settled: "決済済み", done: "完了", failed: "プリフライト失敗",
  };
  set("status", statusText[s.status] ?? s.status);
  document.body.dataset.status = s.status;
  ($("start") as HTMLButtonElement).disabled = s.status !== "ready";
  set("week", s.week ? `${s.week.obsStartIso.slice(0, 10)} からの 7 日間${s.bars === "bars_void.json" ? "（VOID シナリオ）" : ""}` : "—");
  const pf = $("preflight");
  pf.innerHTML = s.preflight.map((c) => `<span class="chip ${c.ok ? "ok" : "ng"}" title="${c.detail}">${c.id}</span>`).join("");

  // 1. clock
  set("chainTime", utc(s.chainTime));
  set("tau", `${pct(s.tau)}（${s.processed.toLocaleString()} / ${s.n.toLocaleString()} 本）`);
  set("elapsed", secs(s.elapsedMs));
  set("remaining", s.status === "running" || s.status === "settled" ? `目標まで ${secs(Math.max(0, TARGET_MS - s.elapsedMs))}（上限 ${LIMIT_MS / 1000} s）` : "");
  set("phase", PHASE_NAMES[s.phase] ?? s.phase);

  // 2. price chart
  drawChart($("chart") as HTMLCanvasElement, s);
  set("pFair", s.price ? s.price.pFair.toFixed(4) : "—");
  set("bidAsk", s.price ? `${s.price.bid?.toFixed(4) ?? "—"} / ${s.price.ask?.toFixed(4) ?? "—"}` : "—");
  set("spread", s.price && s.price.hmin > 0 ? `h_min ${s.price.hmin.toFixed(4)}、h ${s.price.h.toFixed(4)}` : s.price ? "取引期間の終了" : "");

  // 3. weight gauge (M §4.1: the realized share n_obs / N grows toward maturity)
  const w = s.n ? s.processed / s.n : 0;
  ($("wObs") as HTMLElement).style.width = pct(w, 2);
  ($("wRem") as HTMLElement).style.width = pct(1 - w, 2);
  set("wObsLabel", `実現 ${pct(w)}`);
  set("wRemLabel", `予測 ${pct(1 - w)}`);

  // 4. inventory and collateral
  if (s.inventory && s.supply) {
    set("q", s.inventory.q);
    set("nl", s.inventory.nl);
    set("ns", s.inventory.ns);
    set("u", pct(Number(s.inventory.u), 2));
    set("collateral", s.supply.collateral);
    set("supplyL", s.supply.long);
    set("supplyS", s.supply.short);
    const a1 = s.status !== "settled" && s.status !== "done" ? s.supply.long === s.supply.short && s.supply.short === s.supply.collateral : null;
    set("a1", a1 === null ? "決済後（担保 ≥ 全払出）" : a1 ? "Long 供給 = Short 供給 = 担保 ✓" : "不一致 ✗");
  }

  // 5. trade log
  const rows = s.trades.map((t) => {
    if (t.op === "refused") return `<tr class="refused"><td>${t.id}</td><td colspan="6">停止中のため取引しない（理由コード ${t.reason}）</td></tr>`;
    if (t.op === "mint" || t.op === "burn") return `<tr><td>${t.id}</td><td>vault ${t.op === "mint" ? "mint" : "burn"}（${t.actor}）</td><td>${t.amount}</td><td></td><td></td><td></td><td></td></tr>`;
    return `<tr><td>${t.id}</td><td>${DIR_NAMES[t.dir ?? 0] ?? ""}（${t.actor}、${t.exactIn ? "exact-in" : "exact-out"}）</td><td>${t.qty}</td><td>${t.cash}</td><td>${t.avgPrice}</td><td>${t.kind}${t.aqua ? `（Aqua pull ${t.aqua.pulls}・push ${t.aqua.pushes}）` : ""}</td><td>${t.q1} / ${t.q2}</td></tr>`;
  });
  const tb = $("trades");
  const html = rows.join("");
  if (tb.innerHTML !== html) tb.innerHTML = html;

  // settlement
  if (s.longT !== undefined) {
    set("longT", `${s.longT.toFixed(6)}${s.isVoid ? "（VOID）" : ""}`);
    set("payouts", Object.entries(s.payouts ?? {}).map(([k, v]) => `${k === "maker" ? "Maker（預かり）" : k}: ${(Number(v) / 1e6).toFixed(6)}`).join("  "));
  }

  // 6. verification
  const vt = V_ITEMS.map((v) => {
    const it = s.verify.items[v];
    const cls = !it ? "pending" : it.ok ? "ok" : "ng";
    return `<li class="${cls}"><b>${v}</b> ${!it ? "…" : it.ok ? "✓" : "✗"} <small>${it ? `${it.checked} 件` : ""}</small></li>`;
  }).join("");
  const vl = $("verify");
  if (vl.innerHTML !== vt) vl.innerHTML = vt;
  const reveal = showVerdict(s);
  set("ltChain", reveal && s.longT !== undefined ? s.longT.toFixed(12) : "—");
  set("ltV2", reveal && s.verify.v2LongT ? `${Number(s.verify.v2LongT).toFixed(12)}（差 ${s.verify.v2Diff}）` : "—");
  set("ltV3", reveal && s.verify.items.V3 ? (s.verify.items.V3.ok ? "on-chain と完全一致" : "不一致") : "—");
  set("verdict", reveal ? (s.verify.pass ? "V1–V8 すべて合格" : "不合格あり") : "");
  set("root", s.stateRoot ? `state root ${s.stateRoot.slice(0, 18)}…` : "");
}

function drawChart(cv: HTMLCanvasElement, s: ReplayState) {
  const dpr = window.devicePixelRatio || 1;
  const box = cv.parentElement!;
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (W === 0 || H === 0) return;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
  }
  const g = cv.getContext("2d")!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const pad = { l: 48, r: 12, t: 12, b: 24 };
  const vals = s.series.flatMap((p) => [p.pFair, p.bid, p.ask, p.realized]).filter((x): x is number => x !== null);
  if (s.p0) vals.push(s.p0);
  if (s.longT !== undefined) vals.push(s.longT);
  const lo = vals.length ? Math.min(...vals) : 0.8;
  const hi = vals.length ? Math.max(...vals) : 1;
  const span = Math.max(hi - lo, 0.01);
  const y0 = lo - span * 0.1;
  const y1 = Math.min(1, hi + span * 0.1);
  const X = (tau: number) => pad.l + tau * (W - pad.l - pad.r);
  const Y = (v: number) => pad.t + (1 - (v - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  // axes
  g.strokeStyle = css("--grid");
  g.fillStyle = css("--muted");
  g.font = "12px system-ui";
  g.lineWidth = 1;
  for (let i = 0; i <= 4; ++i) {
    const v = y0 + ((y1 - y0) * i) / 4;
    g.beginPath();
    g.moveTo(pad.l, Y(v));
    g.lineTo(W - pad.r, Y(v));
    g.stroke();
    g.fillText(v.toFixed(3), 4, Y(v) + 4);
  }
  for (let i = 0; i <= 4; ++i) g.fillText(`τ ${i * 25}%`, X(i / 4) - 16, H - 6);
  // bid / ask band
  const pts = s.series;
  if (pts.length > 1) {
    g.fillStyle = css("--band");
    g.beginPath();
    let first = true;
    for (const p of pts) if (p.ask !== null) (first ? g.moveTo(X(p.tau), Y(p.ask)) : g.lineTo(X(p.tau), Y(p.ask)), (first = false));
    for (const p of [...pts].reverse()) if (p.bid !== null) g.lineTo(X(p.tau), Y(p.bid));
    g.closePath();
    g.fill();
  }
  const line = (sel: (p: (typeof pts)[number]) => number | null, color: string, width: number, dash: number[] = []) => {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.setLineDash(dash);
    g.beginPath();
    let started = false;
    for (const p of pts) {
      const v = sel(p);
      if (v === null) continue;
      if (!started) g.moveTo(X(p.tau), Y(v));
      else g.lineTo(X(p.tau), Y(v));
      started = true;
    }
    g.stroke();
    g.setLineDash([]);
  };
  if (s.p0) {
    g.strokeStyle = css("--forecast");
    g.setLineDash([6, 4]);
    g.beginPath();
    g.moveTo(X(0), Y(s.p0));
    g.lineTo(X(1), Y(s.p0));
    g.stroke();
    g.setLineDash([]);
  }
  line((p) => p.realized, css("--realized"), 1.5, [2, 3]);
  line((p) => p.pFair, css("--fair"), 2.5);
  // trades
  for (const t of s.trades) {
    if (t.op !== "trade") continue;
    const p = pts.find((q) => q.tau >= t.tau) ?? pts[pts.length - 1];
    if (!p) continue;
    g.fillStyle = css(t.dir === 1 || t.dir === 3 ? "--buy" : "--sell");
    g.beginPath();
    g.arc(X(t.tau), Y(p.pFair), 5, 0, 2 * Math.PI);
    g.fill();
  }
  if (s.longT !== undefined) {
    g.fillStyle = css("--settle");
    g.beginPath();
    g.arc(X(1), Y(s.longT), 7, 0, 2 * Math.PI);
    g.fill();
  }
}
