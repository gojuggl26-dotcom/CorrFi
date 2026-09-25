// CorrFi MVP swap screen (M §5.8, §8.3). Reads ./config.json: { chainId, rpcUrl, deployment, defaultMaker,
// devAccount?, multicall3? }. With devAccount (a local Anvil account, unlocked on the node) transactions go through
// the node; otherwise an injected wallet (EIP-1193) is used. State reads are batched with Multicall3 when the chain
// has it (config.multicall3; confirm its presence at deployment — M §8.3).

import { type Address, createPublicClient, createWalletClient, custom, defineChain, http, type PublicClient, type WalletClient } from "viem";
import { erc20Abi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import type { Breakdown } from "../../engine/src/taker.ts";
import { CorrFiApp, type MarketInfo, type Position } from "./core/app.ts";
import { fmtPct, fmtSec, fmtUnits, fmtUtc, fmtWad, parseDecimal } from "./core/format.ts";
import { CAUSE_TEXT, DELTA_DEFAULT, QuoteController, type QuoteInput } from "./core/quote.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  devAccount?: Address;
  multicall3?: Address;
}

type Mode = "buy-in" | "buy-out" | "sell-in" | "sell-out";
const MODES: Record<Mode, { isBuy: boolean; exactIn: boolean; unit: "USDC" | "token" }> = {
  "buy-in": { isBuy: true, exactIn: true, unit: "USDC" },
  "buy-out": { isBuy: true, exactIn: false, unit: "token" },
  "sell-in": { isBuy: false, exactIn: true, unit: "token" },
  "sell-out": { isBuy: false, exactIn: false, unit: "USDC" },
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  cash: "USDC", // the quote token's symbol, read from the chain (tUSDC on Base Sepolia: DEC-13)
  markets: [] as MarketInfo[],
  sel: 0,
  side: 0,
  mode: "buy-in" as Mode,
  wc: undefined as WalletClient | undefined,
  account: undefined as Address | undefined,
  positions: [] as Position[],
  confirmPending: false,
  message: "",
};

let app: CorrFiApp;
let pc: PublicClient;
let ctl: QuoteController<Breakdown>;
let unwatch: (() => void) | undefined;

function input(): QuoteInput | undefined {
  try {
    const m = MODES[state.mode];
    return {
      marketId: state.sel,
      side: state.side,
      isBuy: m.isBuy,
      exactIn: m.exactIn,
      amount: parseDecimal(($("amount") as HTMLInputElement).value, 6),
      delta: parseDecimal(($("delta") as HTMLInputElement).value, 18),
    };
  } catch (e) {
    state.message = (e as Error).message;
    return undefined;
  }
}

function onInput() {
  state.confirmPending = false;
  const i = input();
  if (!i) return renderStatus();
  try {
    state.message = "";
    ctl.setInput(i);
  } catch (e) {
    state.message = (e as Error).message;
  }
  renderStatus();
}

const tokenName = (side: number) => (side === 0 ? "Long" : "Short");

function renderMarkets() {
  const nav = $("markets");
  nav.innerHTML = "";
  for (const m of state.markets) {
    const b = document.createElement("button");
    b.className = m.id === state.sel ? "on" : "";
    const status = m.finalized ? `決済済み Long_T ${fmtWad(m.longT!, 4)}${m.isVoid ? "（VOID）" : ""}` : `P_fair ${fmtWad(m.pFair, 4)} · バー ${m.confirmed}/${m.n}`;
    b.innerHTML = `<b>${m.tenorDays}D #${m.id}</b><br><small>${fmtUtc(m.obsStart).slice(0, 16)} → ${fmtUtc(m.obsEnd).slice(0, 16)}</small><br><small>${status}</small>`;
    b.onclick = () => selectMarket(m.id);
    nav.appendChild(b);
  }
  document.querySelectorAll<HTMLButtonElement>("[data-side]").forEach((b) => b.classList.toggle("on", Number(b.dataset.side) === state.side));
  const modeText: Record<Mode, string> = {
    "buy-in": `買う：支払う ${state.cash}`,
    "buy-out": "買う：受け取る数量",
    "sell-in": "売る：売る数量",
    "sell-out": `売る：受け取る ${state.cash}`,
  };
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => {
    b.classList.toggle("on", b.dataset.mode === state.mode);
    b.textContent = modeText[b.dataset.mode as Mode];
  });
  $("deltaUnit").textContent = `${state.cash} / token`;
  $("amountUnit").textContent = MODES[state.mode].unit === "USDC" ? state.cash : tokenName(state.side);
}

function row(label: string, value: string) {
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function renderBreakdown() {
  const q = ctl.quote;
  const t = $("bd");
  if (!q) {
    t.innerHTML = row("—", ctl.error ?? "見積もり中");
    return;
  }
  const b = q.b;
  const buy = b.dir === 1 || b.dir === 3;
  const tok = tokenName(q.input.side);
  const cash = state.cash;
  const inUnit = buy ? cash : tok;
  const outUnit = buy ? tok : cash;
  // rejected before the curve: the lens computed no amounts — show the reason, not zeros
  const priced = b.amountIn + b.amountOut > 0n;
  const dash = (x: string) => (priced ? x : "—");
  const fair = q.input.side === 0 ? b.pFair : 10n ** 18n - b.pFair; // the traded side's own fair value
  let html = "";
  html += `<tr class="group"><td colspan="2">可否</td></tr>`;
  html += row(b.reason === 0 ? "取引できます" : "取引できません", b.reason === 0 ? "" : ctl.view().reasonText ?? "");
  html += `<tr class="group"><td colspan="2">数量</td></tr>`;
  html += row("入力量", dash(`${fmtUnits(b.amountIn)} ${inUnit}`));
  html += row("出力量", dash(`${fmtUnits(b.amountOut)} ${outUnit}`));
  const limitLabel = q.input.exactIn ? "最小受取（許容幅適用）" : buy ? "最大支払（許容幅適用）" : "最大の売却数（許容幅適用）";
  html += row(limitLabel, dash(b.limitDefined ? `${fmtUnits(b.limit)} ${q.input.exactIn ? outUnit : inUnit}` : "定義できません（平均価格 ≤ δ）"));
  html += `<tr class="group"><td colspan="2">価格（${tok} 1 枚あたり）</td></tr>`;
  html += row("平均価格", dash(`${fmtWad(b.avgPrice)} ${cash}`));
  html += row(`公正価格（${tok}）`, b.pFair > 0n ? `${fmtWad(fair)} ${cash}` : "—");
  html += row("公正価格からの乖離", dash(`${fmtUnits(b.deviation)} ${cash}（${fmtPct(b.deviationRate)}）`));
  html += row("　うちスプレッド下限分（h_min·Q）", dash(`${fmtUnits(b.devHmin)} ${cash}`));
  html += row("　うち使用率の上乗せ分（h_U·Q）", dash(`${fmtUnits(b.devHU)} ${cash}`));
  html += row("　うち在庫の傾きによるサイズ分", dash(`${fmtUnits(b.devSize)} ${cash}`));
  html += `<tr class="group"><td colspan="2">スプレッドの構成</td></tr>`;
  html += row("h₀", fmtWad(b.h0));
  html += row("h_M", fmtWad(b.hM));
  html += row("h_O（現在の経過時間）", fmtWad(b.hO));
  html += row("h_U", fmtWad(b.hU));
  html += `<tr class="group"><td colspan="2">在庫と mint</td></tr>`;
  html += row(buy ? "Q1 在庫から充当" : "Q1 対当 burn", dash(`${fmtUnits(b.q1)} ${tok}`));
  html += row(buy ? "Q2 新たな mint" : "Q2 買取（預かりへ）", dash(`${fmtUnits(b.q2)} ${tok}`));
  html += row("Maker 在庫 q（Long 換算）", dash(`${fmtUnits(b.inv0)} → ${fmtUnits(b.inv1)}`));
  html += row("Maker 使用率 U", dash(`${fmtPct(b.uPre)} → ${fmtPct(b.uPost)}`));
  html += `<tr class="group"><td colspan="2">有効期間</td></tr>`;
  html += row("価格確認済みバー k", String(b.k));
  html += row("その確定時刻 t_k", fmtUtc(b.tK));
  html += row("次のバーの確定予定 t_k+1", fmtUtc(b.tNext));
  html += row("停止予定（t_k + Δ + g）", fmtUtc(b.tStop));
  html += row("評価に使ったチェーン時刻", fmtUtc(b.evaluatedAt));
  t.innerHTML = html;
}

function renderStatus() {
  const v = ctl?.view();
  const s = $("status");
  s.className = "status";
  $("execute").toggleAttribute("disabled", !v?.canExecute || !state.wc);
  if (state.message) {
    s.textContent = state.message;
    s.classList.add("warn");
  } else if (!v || v.reason === undefined) {
    s.textContent = v?.loading ? "見積もり中…" : "";
  } else if (v.reason !== 0) {
    s.textContent = `取引できません：${v.reasonText}${v.clears === "report" ? "（新しいレポートが確認されれば自動で再開します）" : ""}`;
    s.classList.add("stop");
  } else if (v.stopWarning) {
    s.textContent = `まもなく価格更新待ち（あと ${fmtSec(v.stopInSec)}）`;
    s.classList.add("warn");
  } else {
    s.textContent = state.confirmPending ? "見積もりが変わりました。内容を確認して、もう一度「実行」を押してください。" : "取引できます";
    s.classList.add(state.confirmPending ? "warn" : "ok");
  }
  $("refreshIn").textContent = fmtSec(v?.refreshInSec);
  $("nextUpdate").textContent = v?.waitingForPrice ? "更新待ち" : fmtSec(v?.nextFairValueInSec);
  $("chainTime").textContent = v?.chainNow ? `チェーン時刻 ${fmtUtc(Math.floor(v.chainNow))}` : "";
}

function renderPositions() {
  const t = $("pos");
  let html = `<tr><th>市場</th><th>Long</th><th>Short</th><th>公正価値での評価（${state.cash}）</th><th>償還額（決済後）</th><th></th></tr>`;
  for (const p of state.positions) {
    const m = state.markets.find((x) => x.id === p.marketId)!;
    const redeem = m.finalized && p.long + p.short > 0n ? `<button data-redeem="${m.id}" class="seg">償還</button>` : "";
    html += `<tr><td>${m.tenorDays}D #${m.id}</td><td>${fmtUnits(p.long)}</td><td>${fmtUnits(p.short)}</td><td>${fmtUnits(p.value)}</td><td>${p.payout === undefined ? "—" : fmtUnits(p.payout)}</td><td>${redeem}</td></tr>`;
  }
  t.innerHTML = html;
  t.querySelectorAll<HTMLButtonElement>("[data-redeem]").forEach((b) => {
    b.onclick = async () => {
      const m = state.markets.find((x) => x.id === Number(b.dataset.redeem))!;
      const p = state.positions.find((x) => x.marketId === m.id)!;
      await app.redeem(state.wc!, m, p.long, p.short);
      await refreshData();
    };
  });
}

async function refreshData() {
  state.markets = await app.markets();
  if (state.account) state.positions = await app.positions(state.account, state.markets);
  renderMarkets();
  renderPositions();
}

function selectMarket(id: number) {
  state.sel = id;
  unwatch?.();
  unwatch = app.watchReports(id, (k) => {
    ctl.onReport(k);
    void refreshData();
  });
  renderMarkets();
  onInput();
}

async function execute() {
  const i = input();
  if (!i || !state.wc) return;
  $("result").textContent = "";
  const pre = await ctl.beforeExecute();
  if (pre.requoted && pre.changed && !state.confirmPending) {
    state.confirmPending = true; // show the new quote and ask again
    return renderStatus();
  }
  state.confirmPending = false;
  const b = ctl.quote?.b;
  if (!b || b.reason !== 0) return renderStatus();
  try {
    $("execute").setAttribute("disabled", "");
    const { fill, causes } = await app.execute(state.wc, i, b);
    const lines = [`約定：入力 ${fmtUnits(fill.amountIn)}・出力 ${fmtUnits(fill.amountOut)}（Q1 ${fmtUnits(fill.q1)}・Q2 ${fmtUnits(fill.q2)}）`];
    for (const c of causes) lines.push(`見積もりとの差：${CAUSE_TEXT[c]}`);
    $("result").innerHTML = lines.join("<br>");
  } catch (e) {
    $("result").textContent = `失敗：${(e as Error).message.split("\n")[0]}`;
  }
  await refreshData();
  await ctl.refresh();
}

async function connect(cfg: UiConfig, chain: ReturnType<typeof defineChain>) {
  if (cfg.devAccount) {
    state.wc = createWalletClient({ chain, transport: http(cfg.rpcUrl), account: cfg.devAccount });
    state.account = cfg.devAccount;
  } else {
    const eth = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum;
    if (!eth) {
      state.message = "ウォレットが見つかりません";
      return renderStatus();
    }
    const wc = createWalletClient({ chain, transport: custom(eth) });
    const [addr] = await wc.requestAddresses();
    state.wc = createWalletClient({ chain, transport: custom(eth), account: addr });
    state.account = addr;
  }
  $("account").textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
  await refreshData();
  renderStatus();
}

async function main() {
  const cfg = (await (await fetch("./config.json")).json()) as UiConfig;
  const chain = defineChain({
    id: cfg.chainId,
    name: cfg.chainName ?? `chain ${cfg.chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [cfg.rpcUrl] } },
    contracts: cfg.multicall3 ? { multicall3: { address: cfg.multicall3 } } : undefined,
  });
  pc = createPublicClient({ chain, transport: http(cfg.rpcUrl), batch: { multicall: !!cfg.multicall3 }, pollingInterval: 2_000 }) as PublicClient;
  const dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  ctl = new QuoteController<Breakdown>({
    fetch: (i) => app.quote(i),
    nowMs: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
    onChange: () => {
      renderBreakdown();
      renderStatus();
    },
  });
  $("network").textContent = `${chain.name}（chainId ${cfg.chainId}）`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  state.cash = sym;
  if (sym !== "USDC" || /test|replay/i.test(name)) {
    $("testToken").textContent = `${sym}（${name}）はテスト用のトークンです。Circle の USDC ではなく、価値はありません。`;
  }
  ($("delta") as HTMLInputElement).value = fmtWad(DELTA_DEFAULT, 3);
  document.querySelectorAll<HTMLButtonElement>("[data-side]").forEach((b) => (b.onclick = () => ((state.side = Number(b.dataset.side)), renderMarkets(), onInput())));
  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((b) => (b.onclick = () => ((state.mode = b.dataset.mode as Mode), renderMarkets(), onInput())));
  $("amount").oninput = onInput;
  $("delta").oninput = onInput;
  ($("refresh") as HTMLSelectElement).onchange = (e) => ctl.setRefreshSec(Number((e.target as HTMLSelectElement).value));
  $("execute").onclick = () => void execute();
  $("connect").onclick = () => void connect(cfg, chain);
  await refreshData();
  if (state.markets.length) selectMarket(state.markets[state.markets.length - 1].id);
  setInterval(renderStatus, 250);
}

void main();
