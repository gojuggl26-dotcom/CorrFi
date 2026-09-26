// Maker page (read-only, public for the demo): the default maker's wallet, its one approval to Aqua, and per market how
// much tUSDC its two books provide (virtual Aqua balances) and which tokens it holds in custody; the latest fill shows
// what Aqua pulled from the wallet (a buy: the mint) and which market moved (core/makerView.ts). Nothing is signed here.

import { type Address, createPublicClient, defineChain, http, type PublicClient } from "viem";
import { erc20Abi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { CorrFiApp, type MarketInfo } from "./core/app.ts";
import { fmtPct, fmtUnits } from "./core/format.ts";
import { LONG, SHORT, sideName } from "./core/labels.ts";
import { fillIsBuy, fillSide, type FillView, MakerView, type MakerSnapshot, summarizeFill } from "./core/makerView.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  defaultMaker: Address;
  multicall3?: Address;
  explorer?: string; // e.g. https://sepolia.basescan.org
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
let cash = "tUSDC";
let explorer: string | undefined;
let pc: PublicClient;
let dep: Deployment;
let app: CorrFiApp;
let view: MakerView;

/** 2 decimals for the page (the chain keeps 6). */
const amt = (x: bigint) => fmtUnits(x).replace(/(\.\d{2})\d*$/, "$1");
const delta = (x: bigint) => (x === 0n ? "" : `<span class="delta ${x > 0n ? "up" : "down"}">${x > 0n ? "+" : "−"}${amt(x < 0n ? -x : x)}</span>`);

function render(s: MakerSnapshot, markets: MarketInfo[], f?: FillView) {
  $("wallet").textContent = `${amt(s.wallet)} ${cash}`;
  $("approval").textContent = `${amt(s.approval)} ${cash}`;
  $("util").textContent = fmtPct(s.utilization);

  const sum = f ? summarizeFill(f, dep.usdc) : undefined;
  if (f && sum) {
    $("fill").hidden = false;
    $("pulled").textContent = `${amt(sum.pulledUsdc)} ${cash}`;
    const mint = fillIsBuy(f.dir) && f.q2 > 0n;
    $("pulledCheck").textContent = mint ? (sum.pulledUsdc === f.q2 ? "= mint ✓" : "") : fillIsBuy(f.dir) ? "from custody" : "paid to the taker";
    const m = markets.find((x) => x.id === f.marketId);
    const tx = `${f.hash.slice(0, 8)}…${f.hash.slice(-4)}`;
    const link = explorer ? `<a href="${explorer}/tx/${f.hash}" target="_blank" rel="noopener">${tx} ↗</a>` : tx;
    $("fillLine").innerHTML = `${fillIsBuy(f.dir) ? "Buy" : "Sell"} ${amt(f.qty)} ${sideName(fillSide(f.dir))} · ${m ? `${m.tenorDays}D` : `#${f.marketId}`} · ${link}`;
  }

  // the one pool every market draws on: what Aqua may still pull (the approval), within what the wallet holds. A pull
  // uses up the approval, so the latest fill lowered it for all markets at once (pushes pay the wallet, not the approval).
  const approvalBinds = s.approval <= s.wallet;
  const shared = approvalBinds ? s.approval : s.wallet;
  const sharedDelta = sum ? (approvalBinds ? -sum.pulledUsdc : sum.walletChange) : 0n;
  let html = "";
  for (const m of markets.filter((x) => !x.finalized)) {
    const books = s.books.filter((b) => b.marketId === m.id);
    const long = books.find((b) => b.side === 0);
    const short = books.find((b) => b.side === 1);
    const c = s.custody.find((x) => x.marketId === m.id);
    const touched = f?.marketId === m.id;
    const d = (b?: { hash: string }) => (touched && b ? (sum!.bookDelta.get(b.hash.toLowerCase()) ?? 0n) : 0n);
    html += `<div class="mk-card${touched ? " touched" : ""}">
      <div class="mk-head"><b>ETH/BTC ${m.tenorDays}D</b>${touched ? `<span class="mk-tag">latest fill</span>` : ""}</div>
      <div class="mk-k">Available (shared)</div>
      <div class="mk-v">${amt(shared)} <small>${cash}</small> ${delta(sharedDelta)}</div>
      <div class="mk-sub">Book caps (virtual)<br>Long ${amt(long?.usdc ?? 0n)} ${delta(d(long))} · Short ${amt(short?.usdc ?? 0n)} ${delta(d(short))}</div>
      <div class="mk-k">Holding</div>
      <div class="mk-hold"><span>${LONG} ${amt(c?.long ?? 0n)} ${touched ? delta(sum!.custodyLong) : ""}</span><span>${SHORT} ${amt(c?.short ?? 0n)} ${touched ? delta(sum!.custodyShort) : ""}</span></div>
    </div>`;
  }
  $("markets").innerHTML = html || `<div class="muted">No live markets.</div>`;
}

async function refresh() {
  const markets = await app.markets();
  const [snap, fill] = await Promise.all([view.snapshot(markets), view.latestFill()]);
  render(snap, markets, fill);
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
  explorer = cfg.explorer?.replace(/\/$/, "");
  app = new CorrFiApp(pc, dep, cfg.defaultMaker);
  view = new MakerView(pc, dep, cfg.defaultMaker);
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  const [sym, name] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "name" }),
  ]);
  cash = sym;
  if (sym !== "USDC" || /test|replay/i.test(name)) $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  await refresh();
  setInterval(() => void refresh().catch(() => {}), 6_000);
}

void main();
