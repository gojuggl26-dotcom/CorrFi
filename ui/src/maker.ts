// Maker page (read-only): the default maker's wallet, its one approval to Aqua, every book with its virtual balances,
// and the latest fill broken down from its receipt (core/makerView.ts). No wallet connection: nothing is signed here.

import { type Address, createPublicClient, defineChain, http, type PublicClient } from "viem";
import { erc20Abi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { CorrFiApp, type MarketInfo } from "./core/app.ts";
import { fmtPct, fmtUnits, fmtUtc } from "./core/format.ts";
import { sideName } from "./core/labels.ts";
import { type FillView, MakerView, type MakerSnapshot, summarizeFill } from "./core/makerView.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  multicall3?: Address;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const DIRS: Record<number, (s: string) => string> = { 1: (s) => `Buy ${s}`, 2: (s) => `Sell ${s}`, 3: (s) => `Buy ${s}`, 4: (s) => `Sell ${s}` };
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

let cash = "tUSDC";
let pc: PublicClient;
let dep: Deployment;
let app: CorrFiApp;
let view: MakerView;

const marketName = (markets: MarketInfo[], id: number) => {
  const m = markets.find((x) => x.id === id);
  return m ? `${m.tenorDays}D #${m.id}` : `#${id}`;
};
/** Shrink a big number so it stays clear of the token chip (44px up to 9 characters, as on the trade page). */
function setBig(id: string, text: string) {
  const el = $(id);
  el.textContent = text;
  el.style.fontSize = `${Math.max(24, Math.floor((44 * 9) / Math.max(9, text.length)))}px`;
}
const signed = (x: bigint) => `${x > 0n ? "+" : x < 0n ? "−" : "±"}${fmtUnits(x < 0n ? -x : x)}`;

function renderSnapshot(s: MakerSnapshot, markets: MarketInfo[], fill?: FillView) {
  setBig("wallet", fmtUnits(s.wallet));
  $("approval").textContent = `${fmtUnits(s.approval)} ${cash} left · one approval for every book`;
  const live = s.books.filter((b) => !markets.find((m) => m.id === b.marketId)?.finalized);
  const nMarkets = new Set(live.map((b) => b.marketId)).size;
  $("bookCount").textContent = `${live.length} live in ${nMarkets} market${nMarkets === 1 ? "" : "s"}${s.books.length > live.length ? ` (+${s.books.length - live.length} settled)` : ""}`;
  const total = live.reduce((x, b) => x + b.usdc, 0n);
  $("allocTotal").textContent = `${fmtUnits(total)} ${cash}${s.approval > 0n && total > s.approval ? ` · ${(Number(total) / Number(s.approval)).toFixed(1)}× the approval` : ""}`;
  $("util").textContent = `${fmtUnits(s.riskBudget)} ${cash} · U ${fmtPct(s.utilization)}`;

  const delta = new Map((fill?.books ?? []).map((b) => [b.hash, b.after - b.before]));
  let html = `<tr><th>Market</th><th>Book</th><th>${cash} allocation</th><th>Latest fill</th><th>Side tokens in book</th><th>Status</th></tr>`;
  for (const b of s.books) {
    const m = markets.find((x) => x.id === b.marketId);
    const d = delta.get(b.hash);
    const moved = d !== undefined && d !== 0n;
    const status = m?.finalized ? "settled" : b.docked ? "docked" : "live";
    html += `<tr class="${moved ? "row-changed" : ""}${status !== "live" ? " row-dim" : ""}"><td>${marketName(markets, b.marketId)}</td><td>${sideName(b.side)}</td><td>${fmtUnits(b.usdc)}</td><td>${d === undefined ? "—" : moved ? signed(d) : "unchanged"}</td><td>${fmtUnits(b.sideTokens)}</td><td>${status}</td></tr>`;
  }
  $("books").innerHTML = html;
}

function renderFill(f: FillView | undefined, markets: MarketInfo[]) {
  if (!f) return;
  const s = summarizeFill(f, dep.usdc);
  const buy = f.dir === 1 || f.dir === 3;
  const side = f.dir <= 2 ? 0 : 1;
  setBig("pulled", fmtUnits(s.pulledUsdc));
  $("pulledSub").textContent = buy
    ? f.q2 > 0n
      ? s.pulledUsdc === f.q2
        ? `Exactly the ${fmtUnits(f.q2)} ${cash} needed to mint ${fmtUnits(f.q2)} new Long + Short pairs ✓`
        : `The mint needed ${fmtUnits(f.q2)} ${cash}`
      : "Served from the maker's custody: nothing was minted"
    : "The taker's proceeds, paid out of the maker's wallet";
  $("fillTrade").textContent = `${DIRS[f.dir]?.(sideName(side)) ?? `dir ${f.dir}`} · ${marketName(markets, f.marketId)}`;
  $("fillQty").textContent = buy ? `${fmtUnits(f.qty)} (from custody ${fmtUnits(f.q1)} · minted ${fmtUnits(f.q2)})` : `${fmtUnits(f.qty)} (paired and burned ${fmtUnits(f.q1)} · into custody ${fmtUnits(f.q2)})`;
  $("fillPushed").textContent = `${fmtUnits(s.pushedUsdc)} ${cash}`;
  const kept = [
    s.custodyLong !== 0n ? `${signed(s.custodyLong)} ${sideName(0)}` : "",
    s.custodyShort !== 0n ? `${signed(s.custodyShort)} ${sideName(1)}` : "",
  ].filter(Boolean);
  $("fillCustody").textContent = kept.length ? kept.join(" · ") : "unchanged";
  // a buy with a mint: the maker paid Q2 for the pair and was paid for the side it sold; the other side sits in custody
  $("fillWallet").textContent = `${signed(s.walletChange)} ${cash}${buy && f.q2 > 0n ? " (the pair's other side is in custody)" : ""}`;
  $("fillBooks").textContent = `${s.changed.length} of ${f.books.length} · the other ${s.unchanged.length} unchanged`;
  $("fillTx").textContent = `${short(f.hash)} · block ${f.block}`;
  $("fillTx").title = f.hash;
}

async function refresh() {
  const markets = await app.markets();
  const [snap, fill] = await Promise.all([view.snapshot(markets), view.latestFill()]);
  renderFill(fill, markets);
  renderSnapshot(snap, markets, fill);
  if (fill) {
    const b = await pc.getBlock({ blockNumber: fill.block });
    $("fillWhen").textContent = `chain time ${fmtUtc(Number(b.timestamp)).slice(0, 16)} UTC`;
  }
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
  dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  view = new MakerView(pc, dep, cfg.defaultMaker);
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  $("makerAddr").textContent = `${cfg.defaultMaker.slice(0, 6)}…${cfg.defaultMaker.slice(-4)}`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  cash = sym;
  document.querySelectorAll(".cash").forEach((e) => (e.textContent = sym));
  if (sym !== "USDC" || /test|replay/i.test(name)) $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  await refresh();
  setInterval(() => void refresh().catch(() => {}), 4_000);
}

void main();
