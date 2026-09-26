// Wallet connection for the app pages. With `devAccount` (a local Anvil account, unlocked on the node) transactions
// go through the node. Otherwise a browser wallet is used: it is asked for an account and switched to the configured
// chain (added first when it does not know it); when the user later picks another account or chain in the wallet the
// page reloads, so nothing from the old one is kept.
//
// Which wallet: several extensions share window.ethereum (Phantom, Coinbase, Rabby ... and some also say isMetaMask),
// so wallets are told apart by EIP-6963 announcements. Connect prefers MetaMask and falls back to any wallet; the
// silent reconnect on the next page talks only to the wallet the user connected here — it never wakes another one.

import { type Address, type Chain, createWalletClient, custom, type Hex, http, type PublicClient, toHex, type WalletClient } from "viem";

type Eip1193 = Parameters<typeof custom>[0] & {
  on?: (event: string, fn: (arg: unknown) => void) => void;
  isMetaMask?: boolean;
  providers?: Eip1193[];
  [flag: `is${string}`]: unknown;
};

export const injected = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;

// ---- EIP-6963: each wallet announces itself (rdns such as io.metamask, app.phantom) in answer to a request
interface Announced {
  info: { rdns: string; name: string };
  provider: Eip1193;
}
const announced = new Map<string, Announced>();
if (typeof window !== "undefined") {
  window.addEventListener("eip6963:announceProvider", (e) => {
    const d = (e as CustomEvent<Announced>).detail;
    if (d?.info?.rdns && d.provider) announced.set(d.info.rdns, d);
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}
const METAMASK = ["io.metamask", "io.metamask.flask"];
const LEGACY = "window.ethereum"; // a MetaMask without EIP-6963
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ask wallets to announce, then wait up to `waitMs` (or until `want` has announced). */
async function discover(waitMs: number, want: (rdns: string) => boolean) {
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  const end = Date.now() + waitMs;
  while (Date.now() < end && ![...announced.keys()].some(want)) await sleep(100);
}

/** MetaMask on window.ethereum (or window.ethereum.providers) without EIP-6963 — not a wallet imitating it. */
function legacyMetaMask(): Eip1193 | undefined {
  const eth = injected();
  const all = [eth, ...(eth?.providers ?? [])].filter((x): x is Eip1193 => !!x);
  const imitates = (p: Eip1193) => Object.keys(p).some((k) => /^is(Phantom|Brave|BraveWallet|Coinbase|CoinbaseWallet|Rabby|OKExWallet|Trust|TokenPocket|Exodus|Rainbow)$/.test(k) && !!p[k as `is${string}`]);
  return all.find((p) => p.isMetaMask && !imitates(p));
}

// ---- the wallet the user connected on this site, so the next page reconnects to it (and only to it) without asking
const REMEMBER = "corrfi.walletId";
const rememberedId = (): string | undefined => {
  try {
    return localStorage.getItem(REMEMBER) ?? undefined;
  } catch {
    return undefined;
  }
};
const remember = (id: string | undefined) => {
  try {
    if (id) localStorage.setItem(REMEMBER, id);
    else localStorage.removeItem(REMEMBER);
  } catch {
    /* storage blocked: the user just connects again */
  }
};

/** Connect: MetaMask first, else any announced wallet, else window.ethereum. Silent: only the remembered wallet. */
async function chooseWallet(silent: boolean): Promise<{ id: string; provider: Eip1193 } | undefined> {
  const id = rememberedId();
  if (silent) {
    if (!id) return undefined;
    if (id === LEGACY) {
      await discover(1_500, () => false);
      const mm = legacyMetaMask();
      return mm ? { id, provider: mm } : undefined;
    }
    await discover(1_500, (r) => r === id);
    const a = announced.get(id);
    return a ? { id, provider: a.provider } : undefined;
  }
  await discover(500, (r) => METAMASK.includes(r));
  for (const r of METAMASK) {
    const a = announced.get(r);
    if (a) return { id: r, provider: a.provider };
  }
  const mm = legacyMetaMask();
  if (mm) return { id: LEGACY, provider: mm };
  const first = [...announced.values()][0];
  if (first) return { id: first.info.rdns, provider: first.provider };
  const eth = injected();
  return eth ? { id: LEGACY, provider: eth } : undefined;
}

/** eth_accounts, asked again for up to `waitMs`: right after a page load MetaMask can answer [] before it has restored
 *  the site's permission, which made every page ask to connect again. */
async function accountsSoon(wc: WalletClient, waitMs: number): Promise<Address | undefined> {
  const end = Date.now() + waitMs;
  for (;;) {
    const [a] = await wc.getAddresses().catch(() => [] as Address[]);
    if (a || Date.now() >= end) return a;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export interface Connected {
  wc: WalletClient;
  account: Address;
  /** true for the injected wallet (MetaMask), false for a dev account */
  wallet: boolean;
}

/** An error code anywhere in the cause chain (viem wraps the wallet's EIP-1193 error). */
function codeOf(e: unknown): number | undefined {
  for (let x = e as { code?: unknown; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (typeof x.code === "number") return x.code;
  }
  return undefined;
}

/** A short, user-facing message for a wallet error. */
export function walletError(e: unknown): string {
  if (codeOf(e) === 4001) return "Request rejected in the wallet.";
  return (e as Error).message?.split("\n")[0] ?? String(e);
}

async function onChain(wc: WalletClient, chain: Chain) {
  if ((await wc.getChainId()) === chain.id) return;
  try {
    await wc.switchChain({ id: chain.id });
  } catch (e) {
    if (codeOf(e) !== 4902 && !/unrecognized chain|not been added/i.test(String((e as Error).message))) throw e;
    await wc.addChain({ chain }); // MetaMask offers to switch right after adding
    if ((await wc.getChainId()) !== chain.id) await wc.switchChain({ id: chain.id });
  }
}

function reloadOnChange(eth: Eip1193, chain: Chain, account: Address) {
  eth.on?.("accountsChanged", (a) => {
    const next = (a as Address[])[0];
    if (!next) remember(undefined); // disconnected in the wallet: do not reconnect by ourselves
    if (!next || next.toLowerCase() !== account.toLowerCase()) location.reload();
  });
  eth.on?.("chainChanged", (id) => {
    if (Number(id) !== chain.id) location.reload();
  });
}

/** The wallet sends transactions through its own RPC for this chain id. If that is another node (e.g. an old local
 *  chain on another port), the page would wait for receipts that never come: compare a block hash first. */
async function sameNode(eth: Eip1193, pc: PublicClient, chain: Chain) {
  const n = await pc.getBlockNumber();
  const at = n > 5n ? n - 5n : 0n; // a few blocks back: on a live network the wallet's RPC can trail the page's
  const [ours, theirs] = await Promise.all([
    pc.getBlock({ blockNumber: at }),
    (eth.request({ method: "eth_getBlockByNumber", params: [toHex(at), false] }) as Promise<{ hash?: Hex } | null>).catch(() => null),
  ]);
  // only a hash that differs proves another node; a block the wallet's RPC does not have yet (or an error) proves nothing
  if (theirs?.hash && theirs.hash !== ours.hash) {
    throw new Error(`Your wallet's network for chain ${chain.id} reads a different node. Set its RPC URL to ${chain.rpcUrls.default.http[0]} (MetaMask: Settings → Networks).`);
  }
}

/** Connect (asks the wallet). `silent` never asks and never touches a wallet the user has not connected here: it
 *  reuses the remembered wallet's account (waiting a moment, as MetaMask can answer [] right after a page load) and
 *  gives up if that wallet is on another chain. With `pc`, the wallet's node is checked to be the one the page reads. */
export async function connectWallet(chain: Chain, devAccount?: Address, silent = false, pc?: PublicClient): Promise<Connected | undefined> {
  if (devAccount) {
    return { wc: createWalletClient({ chain, transport: http(chain.rpcUrls.default.http[0]), account: devAccount }), account: devAccount, wallet: false };
  }
  const w = await chooseWallet(silent);
  if (!w) {
    if (silent) return undefined;
    throw new Error("No wallet found. Install MetaMask (or another browser wallet) and reload.");
  }
  const eth = w.provider;
  const bare = createWalletClient({ chain, transport: custom(eth) });
  const account = silent ? await accountsSoon(bare, 3_000) : (await bare.requestAddresses())[0];
  if (!account) return undefined;
  if (silent) {
    if ((await bare.getChainId()) !== chain.id) return undefined;
  } else {
    await onChain(bare, chain);
  }
  if (pc) await sameNode(eth, pc, chain);
  remember(w.id);
  reloadOnChange(eth, chain, account);
  return { wc: createWalletClient({ chain, transport: custom(eth), account }), account, wallet: true };
}

/** Ask the wallet to show a token (EIP-747). Returns false when the wallet declines. */
export async function watchToken(wc: WalletClient, address: Address, symbol: string, decimals: number) {
  return wc.watchAsset({ type: "ERC20", options: { address, symbol, decimals } });
}
