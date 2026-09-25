// Replay chain (R §4): a fresh, non-fork Anvil with chainId 84532, fixed keys, base fee 0, one transaction per block
// and every block time set explicitly by the caller (R §2.1-1, P2, P10). Nothing here reads the wall clock.
import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import {
  type Account,
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  type Hex,
  type PublicClient,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

export const CHAIN_ID = 84532; // the EIP-712 domain of the reports includes it (R §4.2)
export const MNEMONIC = "test test test test test test test test test test test junk"; // public test keys (R P10)
export const ROLE_INDEX = { owner: 0, reporter: 1, engine: 2, treasury: 3, maker: 4, A: 5, B: 6, C: 7 } as const;
export type Role = keyof typeof ROLE_INDEX;
export const account = (r: Role) => mnemonicToAccount(MNEMONIC, { addressIndex: ROLE_INDEX[r] });

const FOUNDRY_BIN = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".foundry", "bin");
const bin = (name: string) => (process.platform === "win32" ? join(FOUNDRY_BIN, `${name}.exe`) : name);

/** Anvil flags of the replay (recorded in the manifest). The code size limit is never raised (R §4.2, P5). */
export function anvilArgs(port: number, genesis: number): string[] {
  return [
    "--port", String(port), "--chain-id", String(CHAIN_ID), "--timestamp", String(genesis), "--mnemonic", MNEMONIC,
    "--accounts", "10", "--balance", "10000", "--block-base-fee-per-gas", "0", "--gas-price", "0",
    "--gas-limit", "1000000000", "--hardfork", "prague", "--silent",
  ];
}

export interface ReplayChain {
  rpc: string;
  pc: PublicClient;
  call: (method: string, params?: unknown[]) => Promise<unknown>;
  /** Next block time: every transaction is preceded by evm_setNextBlockTimestamp(clock()). */
  setClock: (t: number) => void;
  clock: () => number;
  wallet: (a: Account) => ReturnType<typeof createWalletClient>;
  gasLog: { block: number; gasUsed: bigint; hash: Hex }[];
  stop: () => void;
}

export async function startAnvil(port: number, genesis: number): Promise<{ proc: ChildProcess; rpc: string }> {
  const rpc = `http://127.0.0.1:${port}`;
  const proc = spawn(bin("anvil"), anvilArgs(port, genesis), { stdio: "ignore" });
  for (let i = 0; i < 200; ++i) {
    try {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return { proc, rpc };
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  proc.kill();
  throw new Error("anvil did not start");
}

export function connect(rpc: string, proc?: ChildProcess): ReplayChain {
  let id = 0;
  const call = async (method: string, params: unknown[] = []) => {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    const j = (await r.json()) as { result?: unknown; error?: { message: string; data?: unknown } };
    if (j.error) {
      const e = new Error(`${method}: ${j.error.message}`) as Error & { data?: unknown };
      e.data = j.error.data;
      throw e;
    }
    return j.result;
  };
  let next = 0;
  const gasLog: ReplayChain["gasLog"] = [];
  // Every transaction gets the next block time first; gas is not estimated (an estimate would be evaluated at the
  // previous block's time) but set to a fixed limit, and gas costs nothing (gas price 0).
  const transport = custom({
    async request({ method, params }) {
      if (method === "eth_estimateGas") return "0x1c9c380"; // 30,000,000
      if (method === "eth_sendRawTransaction" || method === "eth_sendTransaction") {
        await call("evm_setNextBlockTimestamp", [next]);
        next += 1;
        const hash = (await call(method, params as unknown[])) as Hex;
        const rc = (await call("eth_getTransactionReceipt", [hash])) as { status: string; gasUsed: string; blockNumber: string } | null;
        if (rc) gasLog.push({ block: Number(rc.blockNumber), gasUsed: BigInt(rc.gasUsed), hash });
        return hash;
      }
      return call(method, params as unknown[]);
    },
  });
  const chain = defineChain({ id: CHAIN_ID, name: "replay", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const pc = createPublicClient({ chain, transport, pollingInterval: 5 }) as PublicClient;
  const wallet = (a: Account) => createWalletClient({ chain, transport, account: a });
  return {
    rpc, pc, call, gasLog,
    setClock: (t: number) => {
      next = t;
    },
    clock: () => next,
    wallet,
    stop: () => proc?.kill(),
  };
}
