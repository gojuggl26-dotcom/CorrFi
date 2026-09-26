// CorrFi home page: the hero with the featured market's numbers and a card per market linking to the trade page.
// Read-only; reads the same ./config.json as the trade page.

import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { erc20Abi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { CorrFiApp, type MarketInfo } from "./core/app.ts";
import { fmtUtc, fmtWad } from "./core/format.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  multicall3?: Address;
}

const WAD = 10n ** 18n;
const $ = (id: string) => document.getElementById(id) as HTMLElement;

/** The market the "Start trading" button opens: the shortest one still trading (7D first), else the newest. */
function featured(ms: MarketInfo[]) {
  return ms.find((m) => !m.finalized) ?? ms[ms.length - 1];
}

function renderHero(ms: MarketInfo[]) {
  const m = featured(ms);
  if (m) ($("heroCta") as HTMLAnchorElement).href = `trade.html?market=${m.id}`;
}

/** Pairs shown as "Coming soon" (display only: no contracts, no prices). */
const COMING_SOON = [
  { pair: "ETH / XAUT", note: "Ether vs. Tether Gold" },
  { pair: "BTC / XAUT", note: "Bitcoin vs. Tether Gold" },
];
const TENORS = [7, 14, 28];

function liveCard(m: MarketInfo) {
  const done = m.finalized;
  const long = done ? m.longT! : m.pFair;
  const pct = Math.min(100, (m.confirmed / Math.max(1, m.n)) * 100);
  return `<a class="mkt" href="trade.html?market=${m.id}">
    <div class="mkt-top"><span class="mkt-name">${m.tenorDays}D · #${m.id}</span><span class="mkt-state${done ? " done" : ""}">${done ? (m.isVoid ? "Void" : "Settled") : "Live"}</span></div>
    <div class="mkt-dates">${fmtUtc(m.obsStart).slice(0, 16)} → ${fmtUtc(m.obsEnd).slice(0, 16)} UTC</div>
    <div class="mkt-prices">
      <div><small>${done ? "Long payout" : "Long"}</small><b>${fmtWad(long, 4)}</b></div>
      <div><small>${done ? "Short payout" : "Short"}</small><b>${fmtWad(WAD - long, 4)}</b></div>
    </div>
    <div class="bar"><span style="width:${pct.toFixed(2)}%"></span></div>
    <div class="mkt-foot"><span>${m.confirmed} / ${m.n} bars</span><span class="go">${done ? "Redeem →" : "Trade →"}</span></div>
  </a>`;
}

function soonCard(pair: string, tenor: number) {
  return `<div class="mkt soon" aria-disabled="true">
    <div class="mkt-top"><span class="mkt-name">${tenor}D</span><span class="mkt-state soon-tag">Coming soon</span></div>
    <div class="mkt-dates">${pair} realized correlation</div>
    <div class="mkt-prices">
      <div><small>Long</small><b>—</b></div>
      <div><small>Short</small><b>—</b></div>
    </div>
    <div class="bar"></div>
    <div class="mkt-foot"><span>${tenor * 288} bars</span><span>Not listed yet</span></div>
  </div>`;
}

function group(pair: string, note: string, live: boolean, cards: string) {
  return `<div class="pair-group">
    <div class="pair-head"><span class="pair-name">${pair}</span><span class="pair-note">${note}</span>${live ? '<span class="pair-live">Live</span>' : ""}</div>
    <div class="markets-grid">${cards}</div>
  </div>`;
}

function renderMarkets(ms: MarketInfo[]) {
  let html = group("ETH / BTC", "Ether vs. Bitcoin", true, ms.map(liveCard).join(""));
  for (const c of COMING_SOON) html += group(c.pair, c.note, false, TENORS.map((t) => soonCard(c.pair, t)).join(""));
  $("marketsGrid").innerHTML = html;
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
  const pc = createPublicClient({ chain, transport: http(cfg.rpcUrl), batch: { multicall: !!cfg.multicall3 } }) as PublicClient;
  const dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  const app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  document.querySelectorAll(".cash").forEach((e) => (e.textContent = sym));
  if (sym !== "USDC" || /test|replay/i.test(name)) {
    $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  }
  const refresh = async () => {
    const ms = await app.markets();
    renderHero(ms);
    renderMarkets(ms);
    // diagram cards open the live market of their tenor
    document.querySelectorAll<HTMLAnchorElement>(".flow-mkt[data-tenor]").forEach((a) => {
      const m = ms.find((x) => !x.finalized && x.tenorDays === Number(a.dataset.tenor));
      if (m) a.href = `trade.html?market=${m.id}`;
    });
  };
  await refresh();
  setInterval(() => void refresh(), 30_000);
}

void main();
