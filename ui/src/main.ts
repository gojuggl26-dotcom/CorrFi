// CorrFi trade page (M §5.8, §8.3). Reads ./config.json: { chainId, rpcUrl, deployment, defaultMaker,
// devAccount?, multicall3? }. With devAccount (a local Anvil account, unlocked on the node) transactions go through
// the node; otherwise an injected wallet (EIP-1193) is used. State reads are batched with Multicall3 when the chain
// has it (config.multicall3; confirm its presence at deployment — M §8.3).
//
// Layout: one swap column. Typing in the top field fixes what you pay / sell (exact-in); typing in the bottom field
// fixes what you receive (exact-out). The flip button switches between buying and selling the chosen token.

import { type Address, createPublicClient, defineChain, http, type PublicClient, type WalletClient } from "viem";
import { erc20Abi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { CorrFiApp, type MarketInfo, type Position, type Quoted } from "./core/app.ts";
import { fmtFixed, fmtPct, fmtSec, fmtUnits, fmtUtc, fmtWad, parseDecimal } from "./core/format.ts";
import { CAUSE_TEXT, DELTA_DEFAULT, QuoteController, type QuoteInput, sameInput } from "./core/quote.ts";
import { LONG, SHORT, sideName } from "./core/labels.ts";
import { openPicker, type PickOption } from "./picker.ts";
import { connectWallet, walletError, watchToken } from "./core/wallet.ts";
import { REASONS } from "../../engine/src/taker.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  devAccount?: Address;
  multicall3?: Address;
  explorer?: string; // block explorer base URL, e.g. https://sepolia.basescan.org
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const WAD = 10n ** 18n;

const state = {
  cash: "USDC", // the quote token's symbol, read from the chain (tUSDC on Base Sepolia: DEC-13)
  markets: [] as MarketInfo[],
  sel: 0,
  side: 0,
  isBuy: true,
  exactIn: true, // true: the top field is fixed; false: the bottom field is fixed
  wc: undefined as WalletClient | undefined,
  account: undefined as Address | undefined,
  wallet: false, // an injected wallet (MetaMask), not a dev account
  positions: [] as Position[],
  cashBal: undefined as bigint | undefined,
  confirmPending: false,
  busy: false, // an execution is running
  message: "",
};

let app: CorrFiApp;
let pc: PublicClient;
let dep: Deployment;
let ctl: QuoteController<Quoted>;
let unwatch: (() => void) | undefined;
let explorer: string | undefined;

const tokenName = sideName; // "ETH/BTC Long" / "ETH/BTC Short" (DEC-31)

/** A failed transaction in words: the router's CorrReject reason when viem decoded it, else the wallet's message. */
function failure(e: unknown): string {
  for (let x = e as { data?: { errorName?: string; args?: readonly unknown[] }; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.data?.errorName === "CorrReject") {
      const code = Number(x.data.args?.[0]);
      return `not tradable now — ${REASONS[code]?.en ?? `reason ${code}`}. Check the quote and try again.`;
    }
    // SwapVM's limit checks: the price moved past the tolerance between the quote and the block
    if (x.data?.errorName === "TakerTraitsInsufficientMinOutputAmount" || x.data?.errorName === "TakerTraitsExceedingMaxInputAmount") {
      return "the price moved beyond your tolerance. Check the new quote and try again.";
    }
  }
  return walletError(e);
}
const payToken = () => (state.isBuy ? state.cash : tokenName(state.side));
const getToken = () => (state.isBuy ? tokenName(state.side) : state.cash);
/** Shrink a big amount field so long numbers stay inside it (44px up to 9 characters, then proportionally). */
function fit(el: HTMLInputElement) {
  const n = Math.max(9, el.value.length || el.placeholder.length);
  el.style.fontSize = `${Math.max(24, Math.floor((44 * 9) / n))}px`;
}
/** Units as a plain decimal for an input field: no thousands separators, no trailing zeros. */
const plain = (x: bigint) => fmtFixed(x, 6, 6).replace(/,/g, "").replace(/\.?0+$/, "") || "0";

function readInput(): QuoteInput {
  return {
    marketId: state.sel,
    side: state.side,
    isBuy: state.isBuy,
    exactIn: state.exactIn,
    amount: parseDecimal(($(state.exactIn ? "amount" : "amountOut") as HTMLInputElement).value, 6),
    delta: parseDecimal(($("delta") as HTMLInputElement).value, 18),
  };
}

function input(): QuoteInput | undefined {
  try {
    return readInput();
  } catch (e) {
    state.message = (e as Error).message;
    return undefined;
  }
}

function onInput() {
  state.confirmPending = false;
  state.message = "";
  const i = input(); // sets state.message when the form does not parse
  if (!i) {
    ctl.clearInput();
    return renderStatus();
  }
  try {
    ctl.setInput(i);
  } catch (e) {
    state.message = (e as Error).message;
  }
  renderStatus();
}

// ---------------------------------------------------------------- rendering

// ---- tokens: "cash" (tUSDC) or a side ("0" Long, "1" Short); exactly one leg is always cash
type Tok = "cash" | "0" | "1";
const coin = (t: Tok) =>
  t === "cash" ? `<span class="coin coin-cash">$</span>` : `<span class="coin coin-${t === "0" ? "long" : "short"}">${t === "0" ? "L" : "S"}</span>`;
const tokLabel = (t: Tok) => (t === "cash" ? state.cash : tokenName(Number(t)));
const payTok = (): Tok => (state.isBuy ? "cash" : (String(state.side) as Tok));
const getTok = (): Tok => (state.isBuy ? (String(state.side) as Tok) : "cash");

function tokenChip(leg: "pay" | "get") {
  const t = leg === "pay" ? payTok() : getTok();
  return `<button type="button" class="token" id="${leg}Chip" aria-haspopup="listbox" aria-expanded="false">${coin(t)}${tokLabel(t)}<span class="chev" aria-hidden="true"></span></button>`;
}

function balanceOf(t: Tok): bigint | undefined {
  if (!state.account) return undefined;
  if (t === "cash") return state.cashBal;
  const p = state.positions.find((x) => x.marketId === state.sel);
  return p ? (t === "0" ? p.long : p.short) : 0n;
}

/** Choosing a token on one leg: tUSDC on a leg makes the other leg the side token, and vice versa (Long ↔ Short never trade directly). */
function pickToken(leg: "pay" | "get", t: Tok) {
  const wasBuy = state.isBuy;
  if (leg === "pay") state.isBuy = t === "cash";
  else state.isBuy = t !== "cash";
  if (t !== "cash") state.side = Number(t);
  if (state.isBuy !== wasBuy) {
    // the legs swapped: what was received is now what is given
    const top = $<HTMLInputElement>("amount");
    const bottom = $<HTMLInputElement>("amountOut");
    if (bottom.value) top.value = bottom.value;
    bottom.value = "";
    fit(top);
    fit(bottom);
    state.exactIn = true;
  }
  renderMarkets();
  onInput();
}

function openTokenPicker(leg: "pay" | "get") {
  const m = state.markets.find((x) => x.id === state.sel);
  const tag = m ? `${m.tenorDays}D #${m.id}` : "";
  const fair = (t: Tok) => (m && t !== "cash" ? ` · fair ${fmtWad(t === "0" ? m.pFair : WAD - m.pFair, 4)}` : "");
  const opts: PickOption[] = (["cash", "0", "1"] as Tok[]).map((t) => {
    const bal = balanceOf(t);
    return {
      value: t,
      label: tokLabel(t),
      sub: t === "cash" ? "Test USDC · collateral" : `${tokLabel(t)} token · ${tag}${fair(t)}`,
      right: bal === undefined ? undefined : fmtUnits(bal, 2),
      icon: coin(t),
    };
  });
  openPicker($(`${leg}Chip`), leg === "pay" ? "Select the token you give" : "Select the token you get", opts, leg === "pay" ? payTok() : getTok(), (v) => pickToken(leg, v as Tok));
}

const COMING_SOON = ["ETH / XAUT", "BTC / XAUT"];

function openMarketPicker() {
  const opts: PickOption[] = state.markets.map((m) => ({
    value: String(m.id),
    label: `${m.tenorDays}D · #${m.id}`,
    sub: m.finalized ? `Settled · Long_T ${fmtWad(m.longT!, 4)}${m.isVoid ? " (VOID)" : ""} — redeem on the Redeem page` : `Ends ${fmtUtc(m.obsEnd).slice(0, 16)} UTC`,
    right: m.finalized ? undefined : `Long ${fmtWad(m.pFair, 4)}`,
    group: "ETH / BTC",
    disabled: m.finalized,
  }));
  for (const pair of COMING_SOON) opts.push({ value: pair, label: pair, sub: "7D · 14D · 28D", right: "Coming soon", group: "Coming soon", disabled: true });
  openPicker($("marketSel"), "Select a market", opts, String(state.sel), (v) => selectMarket(Number(v)));
}

function renderMarkets() {
  const m = state.markets.find((x) => x.id === state.sel);
  $("marketSel").textContent = m ? `ETH / BTC · ${m.tenorDays}D · #${m.id} · ends ${fmtUtc(m.obsEnd).slice(5, 16)} UTC` : "Select a market";
  $("payLabel").textContent = state.isBuy ? "You pay" : "You sell";
  $("getLabel").textContent = state.isBuy ? "You buy" : "You receive";
  $("payToken").innerHTML = tokenChip("pay");
  $("getToken").innerHTML = tokenChip("get");
  $("payChip").onclick = () => openTokenPicker("pay");
  $("getChip").onclick = () => openTokenPicker("get");
  $("deltaUnit").textContent = `${state.cash} / token`;
  renderBalance();
}

/** Balance of what you pay / sell, with Max. */
function balanceOfPay(): bigint | undefined {
  if (!state.account) return undefined;
  if (state.isBuy) return state.cashBal;
  const p = state.positions.find((x) => x.marketId === state.sel);
  return p ? (state.side === 0 ? p.long : p.short) : 0n;
}

function renderBalance() {
  const bal = balanceOfPay();
  $("paySub").textContent = bal === undefined ? "Connect to see your balance" : `Balance ${fmtUnits(bal, 2)} ${payToken()}`;
  $("maxBtn").hidden = bal === undefined || bal === 0n;
}

function row(label: string, value: string) {
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function renderBreakdown() {
  const q = ctl.quote;
  const t = $("bd");
  if (!q) {
    t.innerHTML = row("—", ctl.error ?? "Quoting…");
    for (const id of ["rateVal", "fairVal", "devVal", "limitVal"]) $(id).textContent = "—";
    $("getSub").textContent = "";
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
  const fair = q.input.side === 0 ? b.pFair : WAD - b.pFair; // the traded side's own fair value

  // the field you did not type in shows the quoted counterpart (never overwrite the field being edited)
  const cur = (() => {
    try {
      return readInput();
    } catch {
      return undefined;
    }
  })();
  if (cur && sameInput(cur, q.input)) {
    const other = $<HTMLInputElement>(q.input.exactIn ? "amountOut" : "amount");
    if (document.activeElement !== other) {
      other.value = priced ? plain(q.input.exactIn ? b.amountOut : b.amountIn) : "";
      fit(other);
    }
  }

  // the headline facts
  $("rateVal").textContent = dash(`1 ${tok} = ${fmtWad(b.avgPrice, 6)} ${cash}`);
  $("fairVal").textContent = b.pFair > 0n ? `${fmtWad(fair, 6)} ${cash}` : "—";
  $("devVal").textContent = dash(`${fmtPct(b.deviationRate)} · ${fmtUnits(b.deviation, 2)} ${cash}`);
  $("limitLabel").textContent = q.input.exactIn ? "Minimum received" : buy ? "Maximum paid" : "Maximum sold";
  $("limitVal").textContent = dash(b.limitDefined ? `${fmtUnits(b.limit)} ${q.input.exactIn ? outUnit : inUnit}` : "Undefined (average price ≤ δ)");
  $("getSub").textContent = !priced ? "" : buy ? `≈ ${fmtUnits((b.amountOut * fair) / WAD, 2)} ${cash} at fair value` : `${fmtWad(b.avgPrice, 4)} ${cash} per ${tok}`;

  // the full breakdown (collapsed by default)
  let html = "";
  html += `<tr class="group"><td colspan="2">Status</td></tr>`;
  html += row(b.reason === 0 ? "Tradable" : "Not tradable", b.reason === 0 ? "" : ctl.view().reasonText ?? "");
  html += `<tr class="group"><td colspan="2">Amounts</td></tr>`;
  html += row("Amount in", dash(`${fmtUnits(b.amountIn)} ${inUnit}`));
  html += row("Amount out", dash(`${fmtUnits(b.amountOut)} ${outUnit}`));
  const limitLabel = q.input.exactIn ? "Minimum received (with tolerance)" : buy ? "Maximum paid (with tolerance)" : "Maximum sold (with tolerance)";
  html += row(limitLabel, dash(b.limitDefined ? `${fmtUnits(b.limit)} ${q.input.exactIn ? outUnit : inUnit}` : "Undefined (average price ≤ δ)"));
  html += `<tr class="group"><td colspan="2">Price (per ${tok} token)</td></tr>`;
  html += row("Average price", dash(`${fmtWad(b.avgPrice)} ${cash}`));
  html += row(`Fair value (${tok})`, b.pFair > 0n ? `${fmtWad(fair)} ${cash}` : "—");
  html += row("Deviation from fair value", dash(`${fmtUnits(b.deviation)} ${cash} (${fmtPct(b.deviationRate)})`));
  html += row("　of which min spread (h_min·Q)", dash(`${fmtUnits(b.devHmin)} ${cash}`));
  html += row("　of which utilization (h_U·Q)", dash(`${fmtUnits(b.devHU)} ${cash}`));
  html += row("　of which inventory slope", dash(`${fmtUnits(b.devSize)} ${cash}`));
  html += `<tr class="group"><td colspan="2">Spread components</td></tr>`;
  html += row("h₀", fmtWad(b.h0));
  html += row("h_M", fmtWad(b.hM));
  html += row("h_O (current age)", fmtWad(b.hO));
  html += row("h_U", fmtWad(b.hU));
  html += `<tr class="group"><td colspan="2">Inventory &amp; mint</td></tr>`;
  html += row(buy ? "Q1 from inventory" : "Q1 paired burn", dash(`${fmtUnits(b.q1)} ${tok}`));
  html += row(buy ? "Q2 newly minted" : "Q2 bought into custody", dash(`${fmtUnits(b.q2)} ${tok}`));
  html += row(`Maker inventory q (${LONG})`, dash(`${fmtUnits(b.inv0)} → ${fmtUnits(b.inv1)}`));
  html += row("Maker utilization U", dash(`${fmtPct(b.uPre)} → ${fmtPct(b.uPost)}`));
  html += `<tr class="group"><td colspan="2">Validity</td></tr>`;
  html += row("Confirmed bar k", String(b.k));
  html += row("Confirmed at t_k", fmtUtc(b.tK));
  html += row("Next bar due t_k+1", fmtUtc(b.tNext));
  html += row("Halts at t_k + Δ + g", fmtUtc(b.tStop));
  html += row("Evaluated at (chain time)", fmtUtc(b.evaluatedAt));
  t.innerHTML = html;
}

function renderStatus() {
  const v = ctl?.view();
  const s = $("status");
  s.className = "status";
  // before connecting, the card's button is the soft "Connect wallet"; after, the one filled orange action.
  // Only the settled quote of the form's current input can be executed (review 2026-09-26 #1).
  const exec = $<HTMLButtonElement>("execute");
  exec.classList.toggle("soft", !state.wc);
  exec.toggleAttribute("disabled", !!state.wc && (!v?.canExecute || !!state.message || state.busy));
  exec.textContent = !state.wc ? "Connect wallet" : state.busy ? "Sending…" : `${state.isBuy ? "Buy" : "Sell"} ${tokenName(state.side)}`;
  const confirm = state.confirmPending ? "The quote changed. Review it and press the button again." : "";
  if (state.message) {
    s.textContent = state.message;
    s.classList.add("warn");
  } else if (v?.error) {
    s.textContent = `Quote failed: ${v.error.split("\n")[0]}`;
    s.classList.add("warn");
  } else if (!v || v.reason === undefined || !v.settled) {
    s.textContent = v?.loading || v?.reason !== undefined ? "Quoting…" : "";
  } else if (v.reason !== 0) {
    s.textContent = `Not tradable: ${v.reasonText}${v.clears === "report" ? " — resumes automatically once the next report is confirmed" : ""}`;
    s.classList.add("stop");
  } else if (v.stopWarning) {
    s.textContent = [confirm, `Price update due soon (halts in ${fmtSec(v.stopInSec)})`].filter(Boolean).join(" ");
    s.classList.add("warn");
  } else {
    s.textContent = confirm || "Tradable";
    s.classList.add(confirm ? "warn" : "ok");
  }
  $("refreshIn").textContent = fmtSec(v?.refreshInSec);
  $("nextUpdate").textContent = v?.waitingForPrice ? "Waiting for the next report" : fmtSec(v?.nextFairValueInSec);
  $("chainTime").textContent = v?.chainNow ? `Chain time ${fmtUtc(Math.floor(v.chainNow))}` : "";
  $("tolVal").textContent = `${($("delta") as HTMLInputElement).value} ${state.cash} / token`;
}

function renderPositions() {
  const t = $("pos");
  let html = `<tr><th>Market</th><th>${LONG}</th><th>${SHORT}</th><th>Value at fair price (${state.cash})</th><th>Payout (after settlement)</th><th></th></tr>`;
  for (const p of state.positions) {
    const m = state.markets.find((x) => x.id === p.marketId)!;
    const redeem = m.finalized && p.long + p.short > 0n ? `<button data-redeem="${m.id}" class="seg">Redeem</button>` : "";
    html += `<tr><td>${m.tenorDays}D #${m.id}</td><td>${fmtUnits(p.long)}</td><td>${fmtUnits(p.short)}</td><td>${fmtUnits(p.value)}</td><td>${p.payout === undefined ? "—" : fmtUnits(p.payout)}</td><td>${redeem}</td></tr>`;
  }
  if (!state.account) html += `<tr><td colspan="6">Connect to see your positions.</td></tr>`;
  t.innerHTML = html;
  t.querySelectorAll<HTMLButtonElement>("[data-redeem]").forEach((b) => {
    b.onclick = async () => {
      const m = state.markets.find((x) => x.id === Number(b.dataset.redeem))!;
      const p = state.positions.find((x) => x.marketId === m.id)!;
      try {
        await app.redeem(state.wc!, m, p.long, p.short);
      } catch (e) {
        $("result").textContent = `Failed: ${failure(e)}`;
      }
      await refreshData();
    };
  });
}

// ---------------------------------------------------------------- data and actions

async function refreshData() {
  state.markets = await app.markets();
  if (state.account) {
    [state.positions, state.cashBal] = await Promise.all([
      app.positions(state.account, state.markets),
      pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [state.account] }),
    ]);
  }
  renderMarkets();
  renderPositions();
}

function selectMarket(id: number) {
  state.sel = id;
  history.replaceState(null, "", `?market=${id}`);
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
  if (!i || !state.wc || state.message || state.busy) return renderStatus();
  state.busy = true;
  $("result").textContent = "";
  renderStatus();
  let sent = false;
  try {
    // executes only the quote on screen for this input; a changed fresh quote is shown and needs another click (#7)
    const pre = await ctl.beforeExecute(i);
    if (!pre.proceed) {
      state.confirmPending = pre.changed;
      if (!pre.changed && !pre.quote) $("result").textContent = "Updating the quote. Press the button again once it shows.";
      return;
    }
    state.confirmPending = false;
    sent = true;
    const q = pre.quote!;
    const { fill, causes } = await app.execute(state.wc, q.input, q.b);
    const lines = [`Filled: in ${fmtUnits(fill.amountIn)} · out ${fmtUnits(fill.amountOut)} (Q1 ${fmtUnits(fill.q1)} · Q2 ${fmtUnits(fill.q2)})`];
    for (const c of causes) lines.push(`Differs from the quote: ${CAUSE_TEXT[c]}`);
    const txLabel = `${fill.hash.slice(0, 10)}…${fill.hash.slice(-6)}`;
    lines.push(explorer ? `<a href="${explorer}/tx/${fill.hash}" target="_blank" rel="noopener">View transaction ${txLabel} ↗</a>` : `<span class="muted">Transaction ${fill.hash} · block ${fill.block}</span>`);
    $("result").innerHTML = lines.join("<br>");
    // a bought side token can be added to the wallet's asset list (EIP-747), so the wallet shows it arriving
    const m = state.markets.find((x) => x.id === q.input.marketId);
    if (state.wallet && q.input.isBuy && m) {
      const token = q.input.side === 0 ? m.longToken : m.shortToken;
      const add = document.createElement("button");
      add.className = "btn-primary";
      add.textContent = `Add ${tokenName(q.input.side)} (${m.tenorDays}D #${m.id}) to wallet`;
      add.onclick = async () => {
        try {
          const symbol = await pc.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }); // ETHBTC-L / -S (DEC-31)
          await watchToken(state.wc!, token, symbol, 6);
        } catch (e) {
          $("result").append(` ${walletError(e)}`);
        }
      };
      $("result").append(document.createElement("br"), add);
    }
  } catch (e) {
    $("result").textContent = `Failed: ${failure(e)}`;
  } finally {
    state.busy = false;
    renderStatus();
  }
  if (sent) {
    await refreshData();
    await ctl.refresh();
  }
}

async function connect(cfg: UiConfig, chain: ReturnType<typeof defineChain>, silent = false) {
  let c;
  try {
    c = await connectWallet(chain, cfg.devAccount, silent, pc);
  } catch (e) {
    if (!silent) $("result").textContent = walletError(e);
    return renderStatus();
  }
  if (!c) return;
  $("result").textContent = "";
  state.wc = c.wc;
  state.account = c.account;
  state.wallet = c.wallet;
  $("account").textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
  $("connect").hidden = true;
  await refreshData();
  renderStatus();
}

function setField(exactIn: boolean) {
  state.exactIn = exactIn;
  onInput();
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
  dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  explorer = cfg.explorer?.replace(/\/$/, "");
  app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  ctl = new QuoteController<Quoted>({
    fetch: (i) => app.quote(i),
    nowMs: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as number),
    onChange: () => {
      renderBreakdown();
      renderStatus();
    },
  });
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  state.cash = sym;
  document.querySelectorAll(".cash").forEach((e) => (e.textContent = sym));
  if (sym !== "USDC" || /test|replay/i.test(name)) {
    $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  }
  ($("delta") as HTMLInputElement).value = fmtWad(DELTA_DEFAULT, 3);
  $("amount").oninput = () => (fit($("amount")), setField(true));
  $("amountOut").oninput = () => (fit($("amountOut")), setField(false));
  $("delta").oninput = onInput;
  ($("refresh") as HTMLSelectElement).onchange = (e) => ctl.setRefreshSec(Number((e.target as HTMLSelectElement).value));
  $("marketSel").onclick = () => openMarketPicker();
  $("flip").onclick = () => {
    state.isBuy = !state.isBuy;
    // like any swap screen: what you were receiving becomes what you give
    const top = $<HTMLInputElement>("amount");
    const bottom = $<HTMLInputElement>("amountOut");
    if (bottom.value) top.value = bottom.value;
    bottom.value = "";
    fit(top);
    fit(bottom);
    renderMarkets();
    setField(true);
  };
  $("maxBtn").onclick = () => {
    const bal = balanceOfPay();
    if (bal === undefined) return;
    $<HTMLInputElement>("amount").value = plain(bal);
    fit($("amount"));
    setField(true);
  };
  const toggleSettings = () => {
    const s = $("settings");
    s.hidden = !s.hidden;
    $("settingsBtn").setAttribute("aria-expanded", String(!s.hidden));
  };
  $("settingsBtn").onclick = toggleSettings;
  $("editTol").onclick = () => {
    if ($("settings").hidden) toggleSettings();
    $<HTMLInputElement>("delta").focus();
  };
  $("execute").onclick = () => void (state.wc ? execute() : connect(cfg, chain));
  $("connect").onclick = () => void connect(cfg, chain);
  if (!cfg.devAccount) void connect(cfg, chain, true); // a wallet that already allowed this site reconnects by itself
  await refreshData();
  if (state.markets.length) {
    // the market in ?market= if it still trades, else the first one that does
    const want = Number(new URLSearchParams(location.search).get("market"));
    const live = state.markets.filter((x) => !x.finalized);
    const m = live.find((x) => x.id === want) ?? live[0] ?? state.markets[state.markets.length - 1];
    selectMarket(m.id);
  }
  renderPositions();
  setInterval(renderStatus, 250);
}

void main();
