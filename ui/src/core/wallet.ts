// Wallet connection for the app pages. With `devAccount` (a local Anvil account, unlocked on the node) transactions
// go through the node. Otherwise the injected wallet (EIP-1193, e.g. MetaMask) is used: it is asked for an account and
// switched to the configured chain (added first when it does not know it); when the user later picks another account
// or chain in the wallet the page reloads, so nothing from the old one is kept.

import { type Address, type Chain, createWalletClient, custom, type Hex, http, type PublicClient, toHex, type WalletClient } from "viem";

type Eip1193 = Parameters<typeof custom>[0] & { on?: (event: string, fn: (arg: unknown) => void) => void };

export const injected = () => (window as unknown as { ethereum?: Eip1193 }).ethereum;

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
  if (theirs?.hash !== ours.hash) {
    throw new Error(`Your wallet's network for chain ${chain.id} reads a different node. Set its RPC URL to ${chain.rpcUrls.default.http[0]} (MetaMask: Settings → Networks).`);
  }
}

/** Connect (asks the wallet; `silent` only uses an account the wallet already allowed and does not switch chains).
 *  With `pc`, the wallet's node is checked to be the one the page reads. */
export async function connectWallet(chain: Chain, devAccount?: Address, silent = false, pc?: PublicClient): Promise<Connected | undefined> {
  if (devAccount) {
    return { wc: createWalletClient({ chain, transport: http(chain.rpcUrls.default.http[0]), account: devAccount }), account: devAccount, wallet: false };
  }
  const eth = injected();
  if (!eth) {
    if (silent) return undefined;
    throw new Error("No wallet found. Install MetaMask (or another browser wallet) and reload.");
  }
  const bare = createWalletClient({ chain, transport: custom(eth) });
  const [account] = silent ? await bare.getAddresses() : await bare.requestAddresses();
  if (!account) return undefined;
  if (silent) {
    if ((await bare.getChainId()) !== chain.id) return undefined;
  } else {
    await onChain(bare, chain);
  }
  if (pc) await sameNode(eth, pc, chain);
  reloadOnChange(eth, chain, account);
  return { wc: createWalletClient({ chain, transport: custom(eth), account }), account, wallet: true };
}

/** Ask the wallet to show a token (EIP-747). Returns false when the wallet declines. */
export async function watchToken(wc: WalletClient, address: Address, symbol: string, decimals: number) {
  return wc.watchAsset({ type: "ERC20", options: { address, symbol, decimals } });
}
