// Local chain for the integration tests: a fresh Anvil, the protocol deployed by contracts/script/Deploy.s.sol, and
// viem clients for the roles. Keys come from Anvil's public test mnemonic (not secrets; never used off Anvil).

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  type HDAccount,
  type HttpTransport,
  type PublicClient,
  type WalletClient,
  bytesToHex,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import type { Deployment } from "../../src/chain.ts";

const TEST_MNEMONIC = "test test test test test test test test test test test junk";
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FOUNDRY_BIN = join(process.env.HOME ?? process.env.USERPROFILE ?? "", ".foundry", "bin");
const bin = (name: string) => (process.platform === "win32" ? join(FOUNDRY_BIN, `${name}.exe`) : name);

export const ROLES = { owner: 0, reporter: 1, engine: 2, treasury: 3, maker: 4, taker: 5, anyone: 6, taker2: 7 } as const;
export type Role = keyof typeof ROLES;

export interface Chain {
  rpc: string;
  pc: PublicClient;
  dep: Deployment;
  account: (r: Role) => HDAccount;
  wallet: (r: Role) => WalletClient<HttpTransport, typeof foundry, HDAccount>;
  now: () => Promise<number>;
  setTime: (t: number) => Promise<void>;
  rpcCall: (method: string, params?: unknown[]) => Promise<unknown>;
  stop: () => void;
}

async function waitRpc(url: string) {
  for (let i = 0; i < 100; ++i) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("anvil did not start");
}

export async function startChain(opts: { genesis: number; port?: number }): Promise<Chain> {
  const port = opts.port ?? 18_545 + Math.floor(Math.random() * 1000);
  const rpc = `http://127.0.0.1:${port}`;
  const anvil: ChildProcess = spawn(bin("anvil"), ["--port", String(port), "--timestamp", String(opts.genesis), "--silent", "--gas-limit", "60000000"], { stdio: "ignore" });
  const stop = () => anvil.kill();
  try {
    await waitRpc(rpc);
    const account = (r: Role) => mnemonicToAccount(TEST_MNEMONIC, { addressIndex: ROLES[r] });
    const key = (r: Role) => bytesToHex(account(r).getHdKey().privateKey!);
    const name = `anvil-test-${port}`;
    mkdirSync(join(ROOT, "deployments"), { recursive: true });
    const deploy = spawnSync(
      bin("forge"),
      ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--broadcast", "--skip-simulation", "-q"],
      {
        cwd: join(ROOT, "contracts"),
        env: {
          ...process.env,
          DEPLOYER_KEY: key("owner"),
          REPORTER: account("reporter").address,
          PRICE_SIGNER: account("engine").address,
          TREASURY: account("treasury").address,
          DEPLOY_NAME: name,
        },
        encoding: "utf8",
      },
    );
    if (deploy.status !== 0) throw new Error(`deploy failed:\n${deploy.stdout}\n${deploy.stderr}`);
    const file = join(ROOT, "deployments", `${name}.json`);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    rmSync(file);
    const dep: Deployment = { ...raw, chainId: Number(raw.chainId), block: Number(raw.block) };
    const transport = http(rpc);
    const pc = createPublicClient({ chain: foundry, transport, pollingInterval: 20 }) as PublicClient;
    const wallet = (r: Role) => createWalletClient({ chain: foundry, transport, account: account(r), pollingInterval: 20 });
    const rpcCall = async (method: string, params: unknown[] = []) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = (await r.json()) as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`);
      return j.result;
    };
    const now = async () => Number((await pc.getBlock({ blockTag: "latest" })).timestamp);
    const setTime = async (t: number) => {
      await rpcCall("evm_setNextBlockTimestamp", [t]);
      await rpcCall("evm_mine");
    };
    return { rpc, pc, dep, account, wallet, now, setTime, rpcCall, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
