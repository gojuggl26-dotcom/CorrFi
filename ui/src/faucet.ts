// CorrFi tUSDC faucet page: anyone mints any amount up to TestUSDC.FAUCET_DAILY_LIMIT per wallet in each 24-hour window.
// Reads the same ./config.json as the other pages; with devAccount (a local Anvil account) transactions go through the
// node. Times are chain times (local chains may run on a replayed clock).

import { type Address, createPublicClient, defineChain, formatEther, http, type PublicClient, type WalletClient } from "viem";
import { connectWallet, walletError } from "./core/wallet.ts";
import { testUsdcAbi } from "../../engine/src/abi.ts";
import type { Deployment } from "../../engine/src/chain.ts";
import { fmtFixed, fmtSec, fmtUnits, fmtUtc, parseDecimal } from "./core/format.ts";

interface UiConfig {
  chainId: number;
  chainName?: string;
  rpcUrl: string;
  deployment: Deployment;
  devAccount?: Address;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const LOW_GAS = 5n * 10n ** 14n; // 0.0005 ETH

const state = {
  cash: "tUSDC",
  limit: 10_000n * 10n ** 6n,
  wc: undefined as WalletClient | undefined,
  account: undefined as Address | undefined,
  balance: undefined as bigint | undefined,
  gas: undefined as bigint | undefined,
  available: undefined as bigint | undefined,
  resetsAt: 0, // chain time the window resets (0: no open window)
  chainOffset: 0, // chain time − local time (s)
  pending: false,
  message: "",
  hasFaucet: true,
};

let pc: PublicClient;
let dep: Deployment;

const chainNow = () => Date.now() / 1000 + state.chainOffset;
/** A wait as "23h 59m" (an hour or more) or "4:59" / "12s". */
const fmtWait = (sec: number) => {
  const v = Math.max(0, Math.ceil(sec));
  return v >= 3600 ? `${Math.floor(v / 3600)}h ${String(Math.floor((v % 3600) / 60)).padStart(2, "0")}m` : fmtSec(v);
};
const plain = (x: bigint) => fmtFixed(x, 6, 6).replace(/,/g, "").replace(/\.?0+$/, "") || "0";

/** The typed amount, or an error message. */
function typed(): bigint | string {
  try {
    const a = parseDecimal($<HTMLInputElement>("claimAmount").value, 6);
    if (a === 0n) return "Enter an amount above zero.";
    if (state.available !== undefined && a > state.available)
      return state.available === 0n ? "You have used today's allowance." : `You can mint up to ${fmtUnits(state.available, 2)} ${state.cash} in this window.`;
    return a;
  } catch (e) {
    return (e as Error).message;
  }
}

async function refresh() {
  const block = await pc.getBlock({ blockTag: "latest" });
  state.chainOffset = Number(block.timestamp) - Date.now() / 1000;
  if (!state.account) return render();
  const [balance, gas, avail] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "balanceOf", args: [state.account] }),
    pc.getBalance({ address: state.account }),
    pc.readContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "faucetAvailable", args: [state.account] }).catch(() => undefined),
  ]);
  state.balance = balance;
  state.gas = gas;
  state.hasFaucet = avail !== undefined;
  state.available = avail?.[0];
  state.resetsAt = Number(avail?.[1] ?? 0n);
  render();
}

function render() {
  // an open window that has passed resets to the full limit (the chain agrees on the next read)
  if (state.resetsAt && chainNow() >= state.resetsAt) {
    state.available = state.limit;
    state.resetsAt = 0;
  }
  const lowGas = state.gas !== undefined && state.gas < LOW_GAS;
  const known = state.account && state.available !== undefined;
  $("balance").textContent = state.balance === undefined ? "Connect to see" : `${fmtUnits(state.balance, 2)} ${state.cash}`;
  $("available").textContent = known ? `${fmtUnits(state.available!, 2)} of ${fmtUnits(state.limit, 0)} ${state.cash}` : "—";
  $("resets").textContent = !known ? "—" : state.resetsAt ? `in ${fmtWait(state.resetsAt - chainNow())} · ${fmtUtc(state.resetsAt).slice(5, 16)} UTC` : "No open window";
  $("gasBalance").textContent = state.gas === undefined ? "—" : `${Number(formatEther(state.gas)).toFixed(4)} ETH`;
  $("availSub").textContent = known ? `Available now: ${fmtUnits(state.available!, 2)} ${state.cash}` : `Up to ${fmtUnits(state.limit, 0)} per wallet every 24 hours`;
  $("maxBtn").hidden = !known || state.available === 0n;
  $("gasNote").classList.toggle("attention", lowGas);

  const t = typed();
  const s = $("status");
  s.className = "status";
  if (state.message) {
    s.textContent = state.message;
    s.classList.add("warn");
  } else if (!state.account) {
    s.textContent = "";
  } else if (!state.hasFaucet) {
    s.textContent = "This token has no public faucet. Ask the operator for test tokens.";
    s.classList.add("stop");
  } else if (state.available === 0n) {
    s.textContent = `You have minted today's ${fmtUnits(state.limit, 0)} ${state.cash}. The allowance resets in ${fmtWait(state.resetsAt - chainNow())}.`;
    s.classList.add("warn");
  } else if (typeof t === "string") {
    s.textContent = t;
    s.classList.add("warn");
  } else if (lowGas) {
    s.textContent = "Your wallet needs a little Base Sepolia ETH for gas — see the faucets below.";
    s.classList.add("warn");
  } else {
    s.textContent = `Ready to mint ${fmtUnits(t, 2)} ${state.cash}.`;
    s.classList.add("ok");
  }

  const b = $<HTMLButtonElement>("claim");
  b.classList.toggle("soft", !state.wc);
  if (!state.wc) {
    b.textContent = "Connect wallet";
    b.disabled = false;
  } else if (state.pending) {
    b.textContent = "Minting…";
    b.disabled = true;
  } else if (state.available === 0n) {
    b.textContent = `Available again in ${fmtWait(state.resetsAt - chainNow())}`;
    b.disabled = true;
  } else if (typeof t === "string") {
    b.textContent = `Mint ${state.cash}`;
    b.disabled = true;
  } else {
    b.textContent = `Mint ${fmtUnits(t, 2).replace(/\.00$/, "")} ${state.cash}`;
    b.disabled = !state.hasFaucet;
  }
}

function fit(el: HTMLInputElement) {
  const n = Math.max(9, el.value.length);
  el.style.fontSize = `${Math.max(24, Math.floor((44 * 9) / n))}px`;
}

async function claim() {
  const t = typed();
  if (!state.wc || !state.account || typeof t === "string") return;
  state.pending = true;
  state.message = "";
  $("result").innerHTML = "";
  render();
  try {
    const hash = await state.wc.writeContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "faucet", args: [t], account: state.account, chain: state.wc.chain });
    await pc.waitForTransactionReceipt({ hash });
    $("result").innerHTML = `Minted ${fmtUnits(t, 2).replace(/\.00$/, "")} ${state.cash}. <a href="trade.html">Start trading →</a>`;
  } catch (e) {
    const msg = (e as Error).message;
    state.message = /FaucetLimitExceeded/.test(msg) ? "That is more than you can mint in this window." : `Failed: ${msg.split("\n")[0]}`;
  }
  state.pending = false;
  await refresh();
}

async function connect(cfg: UiConfig, chain: ReturnType<typeof defineChain>, silent = false) {
  let c;
  try {
    c = await connectWallet(chain, cfg.devAccount, silent, pc);
  } catch (e) {
    state.message = walletError(e);
    return render();
  }
  if (!c) return;
  state.message = "";
  state.wc = c.wc;
  state.account = c.account;
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
  });
  pc = createPublicClient({ chain, transport: http(cfg.rpcUrl) }) as PublicClient;
  dep = { ...cfg.deployment, chainId: Number(cfg.deployment.chainId) };
  $("network").textContent = `${chain.name} · chainId ${cfg.chainId}`;
  const [sym, name, limit] = await Promise.all([
    pc.readContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "symbol" }),
    pc.readContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "name" }),
    pc.readContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "FAUCET_DAILY_LIMIT" }).catch(() => undefined),
  ]);
  state.cash = sym;
  if (limit !== undefined) state.limit = limit;
  document.querySelectorAll(".cash").forEach((e) => (e.textContent = sym));
  $("testToken").textContent = `${sym} (${name}) is a test token. It is not Circle USDC and has no value.`;
  const amount = $<HTMLInputElement>("claimAmount");
  amount.value = plain(state.limit);
  fit(amount);
  amount.oninput = () => (fit(amount), (state.message = ""), render());
  $("maxBtn").onclick = () => {
    if (state.available === undefined) return;
    amount.value = plain(state.available);
    fit(amount);
    render();
  };
  $("connect").onclick = () => void connect(cfg, chain);
  if (!cfg.devAccount) await connect(cfg, chain, true); // a wallet that already allowed this site reconnects by itself
  $("claim").onclick = () => void (state.wc ? claim() : connect(cfg, chain));
  await refresh();
  setInterval(render, 1000);
  setInterval(() => void refresh(), 15_000);
}

void main();
