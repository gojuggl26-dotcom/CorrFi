// CorrFi redeem page: after maturity each Long pays Long_T and each Short 1 − Long_T (vault.redeem burns them and pays
// tUSDC). Lists every market with the connected wallet's holdings; settled markets can be redeemed one by one or all at
// once, and a market past maturity whose final report is in can be settled by anyone (vault.finalize).

import { type Address, createPublicClient, createWalletClient, custom, defineChain, http, type PublicClient, type WalletClient } from "viem";
import { erc20Abi, vaultAbi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { CorrFiApp, type MarketInfo, type Position } from "./core/app.ts";
import { fmtSec, fmtUnits, fmtUtc, fmtWad } from "./core/format.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  devAccount?: Address;
  multicall3?: Address;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const WAD = 10n ** 18n;

const state = {
  cash: "tUSDC",
  markets: [] as MarketInfo[],
  positions: [] as Position[],
  wc: undefined as WalletClient | undefined,
  account: undefined as Address | undefined,
  chainOffset: 0,
  busy: new Set<number>(),
  message: "",
  results: new Map<number, string>(),
};

let pc: PublicClient;
let app: CorrFiApp;

const chainNow = () => Date.now() / 1000 + state.chainOffset;
const fmtWait = (sec: number) => {
  const v = Math.max(0, Math.ceil(sec));
  if (v >= 86400) return `${Math.floor(v / 86400)}d ${Math.floor((v % 86400) / 3600)}h`;
  return v >= 3600 ? `${Math.floor(v / 3600)}h ${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}m` : fmtSec(v);
};
const whole = (x: bigint) => fmtUnits(x, 2).replace(/\.00$/, "");

type Phase = "live" | "settling" | "ready-to-settle" | "settled";
function phase(m: MarketInfo): Phase {
  if (m.finalized) return "settled";
  if (chainNow() < m.obsEnd) return "live";
  return m.processed >= m.n ? "ready-to-settle" : "settling";
}

const pos = (m: MarketInfo) => state.positions.find((p) => p.marketId === m.id);
const redeemable = (m: MarketInfo) => {
  const p = pos(m);
  return m.finalized && p && p.long + p.short > 0n ? p : undefined;
};

async function refresh() {
  const block = await pc.getBlock({ blockTag: "latest" });
  state.chainOffset = Number(block.timestamp) - Date.now() / 1000;
  state.markets = await app.markets();
  if (state.account) state.positions = await app.positions(state.account, state.markets);
  render();
}

function row(label: string, value: string) {
  return `<div class="fact"><dt>${label}</dt><dd>${value}</dd></div>`;
}

function card(m: MarketInfo) {
  const ph = phase(m);
  const p = pos(m);
  const chip = { live: "Live", settling: "Awaiting final report", "ready-to-settle": "Ready to settle", settled: m.isVoid ? "Void" : "Settled" }[ph];
  let rows = "";
  rows += row(ph === "live" ? "Matures" : "Matured", `${fmtUtc(m.obsEnd).slice(0, 16)} UTC${ph === "live" ? ` · in <span data-until="${m.obsEnd}">${fmtWait(m.obsEnd - chainNow())}</span>` : ""}`);
  if (m.finalized) {
    rows += row("Settlement value Long_T", fmtWad(m.longT!, 6));
    rows += row("Long pays / Short pays", `${fmtWad(m.longT!, 4)} / ${fmtWad(WAD - m.longT!, 4)} ${state.cash}`);
  } else {
    rows += row("Fair value today (Long / Short)", `${fmtWad(m.pFair, 4)} / ${fmtWad(WAD - m.pFair, 4)}`);
    rows += row("Bars observed", `${m.confirmed} / ${m.n}`);
  }
  if (state.account) {
    rows += row("Your Long / Short", `${fmtUnits(p?.long ?? 0n, 2)} / ${fmtUnits(p?.short ?? 0n, 2)}`);
    rows += row(m.finalized ? "You receive" : "Worth at fair value", `<b>${whole(m.finalized ? p?.payout ?? 0n : p?.value ?? 0n)} ${state.cash}</b>`);
  }

  let action = "";
  const busy = state.busy.has(m.id);
  if (!state.account) action = `<button class="btn-cta small soft" data-connect>Connect wallet</button>`;
  else if (ph === "settled") {
    const r = redeemable(m);
    action = r
      ? `<button class="btn-cta small" data-redeem="${m.id}"${busy ? " disabled" : ""}>${busy ? "Redeeming…" : `Redeem ${whole(r.payout!)} ${state.cash}`}</button>`
      : `<button class="btn-cta small" disabled>Nothing to redeem</button>`;
  } else if (ph === "ready-to-settle")
    action = `<button class="btn-cta small soft" data-finalize="${m.id}"${busy ? " disabled" : ""}>${busy ? "Settling…" : "Settle market"}</button>`;
  else if (ph === "settling") action = `<button class="btn-cta small" disabled>Waiting for the final price report</button>`;
  else action = `<a class="btn-cta small soft" href="trade.html?market=${m.id}">Trade until maturity</a>`;

  const result = state.results.get(m.id);
  return `<section class="side-card redeem-card${ph === "settled" ? " done" : ""}">
    <div class="redeem-card-head"><span class="redeem-name">ETH / BTC · ${m.tenorDays}D · #${m.id}</span><span class="redeem-chip ${ph}">${chip}</span></div>
    <dl class="facts">${rows}</dl>
    ${action}
    ${result ? `<div class="faucet-result">${result}</div>` : ""}
  </section>`;
}

function render() {
  const settled = state.markets.filter((m) => redeemable(m));
  const total = settled.reduce((a, m) => a + (redeemable(m)!.payout ?? 0n), 0n);
  $("total").textContent = state.account ? whole(total) : "—";
  $("totalSub").textContent = !state.account
    ? "Connect to see your positions"
    : settled.length
      ? `From ${settled.length} settled market${settled.length > 1 ? "s" : ""}`
      : "Nothing settled to redeem yet";

  const s = $("status");
  s.className = "status";
  if (state.message) {
    s.textContent = state.message;
    s.classList.add("warn");
  } else if (state.account && settled.length) {
    s.textContent = `You can redeem ${whole(total)} ${state.cash} now.`;
    s.classList.add("ok");
  } else s.textContent = "";

  const b = $<HTMLButtonElement>("redeemAll");
  b.classList.toggle("soft", !state.wc);
  if (!state.wc) {
    b.textContent = "Connect wallet";
    b.disabled = false;
  } else if (state.busy.size) {
    b.textContent = "Redeeming…";
    b.disabled = true;
  } else {
    b.textContent = settled.length > 1 ? `Redeem all · ${whole(total)} ${state.cash}` : settled.length ? `Redeem ${whole(total)} ${state.cash}` : "Nothing to redeem";
    b.disabled = !settled.length;
  }

  // settled and redeemable first, then settling, then live
  const order: Record<Phase, number> = { settled: 0, "ready-to-settle": 1, settling: 2, live: 3 };
  const ms = [...state.markets].sort((a, c) => order[phase(a)] - order[phase(c)] || a.id - c.id);
  const grid = $("markets");
  grid.innerHTML = ms.map(card).join("");
  grid.querySelectorAll<HTMLButtonElement>("[data-redeem]").forEach((x) => (x.onclick = () => void redeem([Number(x.dataset.redeem)])));
  grid.querySelectorAll<HTMLButtonElement>("[data-finalize]").forEach((x) => (x.onclick = () => void finalize(Number(x.dataset.finalize))));
  grid.querySelectorAll<HTMLButtonElement>("[data-connect]").forEach((x) => (x.onclick = () => $("connect").click()));
}

/** Every second: only the countdowns change (rebuilding the cards would swallow clicks). */
function tick() {
  document.querySelectorAll<HTMLElement>("[data-until]").forEach((e) => (e.textContent = fmtWait(Number(e.dataset.until) - chainNow())));
}

async function redeem(ids: number[]) {
  if (!state.wc) return;
  state.message = "";
  for (const id of ids) {
    const m = state.markets.find((x) => x.id === id)!;
    const p = redeemable(m);
    if (!p) continue;
    state.busy.add(id);
    render();
    try {
      await app.redeem(state.wc, m, p.long, p.short);
      state.results.set(id, `Redeemed ${fmtUnits(p.long, 2)} Long + ${fmtUnits(p.short, 2)} Short for ${whole(p.payout!)} ${state.cash}.`);
    } catch (e) {
      state.message = `Redeem failed: ${(e as Error).message.split("\n")[0]}`;
    }
    state.busy.delete(id);
    await refresh();
  }
}

async function finalize(id: number) {
  if (!state.wc) return;
  const m = state.markets.find((x) => x.id === id)!;
  state.busy.add(id);
  render();
  try {
    const hash = await state.wc.writeContract({ address: m.vault, abi: vaultAbi, functionName: "finalize", account: state.wc.account!, chain: state.wc.chain });
    await pc.waitForTransactionReceipt({ hash });
    state.results.set(id, "Market settled.");
  } catch (e) {
    state.message = `Settlement failed: ${(e as Error).message.split("\n")[0]}`;
  }
  state.busy.delete(id);
  await refresh();
}

async function connect(cfg: UiConfig, chain: ReturnType<typeof defineChain>) {
  if (cfg.devAccount) {
    state.wc = createWalletClient({ chain, transport: http(cfg.rpcUrl), account: cfg.devAccount });
    state.account = cfg.devAccount;
  } else {
    const eth = (window as unknown as { ethereum?: Parameters<typeof custom>[0] }).ethereum;
    if (!eth) {
      state.message = "No wallet found";
      return render();
    }
    const [addr] = await createWalletClient({ chain, transport: custom(eth) }).requestAddresses();
    state.wc = createWalletClient({ chain, transport: custom(eth), account: addr });
    state.account = addr;
  }
  $("account").textContent = `${state.account.slice(0, 6)}…${state.account.slice(-4)}`;
  $("connect").hidden = true;
  await refresh();
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
  pc = createPublicClient({ chain, transport: http(cfg.rpcUrl), batch: { multicall: !!cfg.multicall3 } }) as PublicClient;
  const dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  state.cash = sym;
  document.querySelectorAll(".cash").forEach((e) => (e.textContent = sym));
  $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  $("connect").onclick = () => void connect(cfg, chain);
  $("redeemAll").onclick = () => void (state.wc ? redeem(state.markets.filter((m) => redeemable(m)).map((m) => m.id)) : connect(cfg, chain));
  await refresh();
  setInterval(tick, 1000);
  setInterval(() => void refresh(), 15_000);
}

void main();
