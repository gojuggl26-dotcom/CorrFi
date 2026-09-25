// Shared CLI setup: RPC and deployment from the environment, keys from the environment only (never printed).
//   RPC_URL, DEPLOYMENT (path to deployments/<chainId>.json)
import { appendFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, type Hex, http, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { type Deployment, loadDeployment } from "../src/chain.ts";

export function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === "") throw new Error(`environment variable ${name} is required`);
  return v;
}

export function setup() {
  const rpc = env("RPC_URL");
  const dep: Deployment = loadDeployment(env("DEPLOYMENT"));
  const chain = defineChain({ id: dep.chainId, name: `chain ${dep.chainId}`, nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } });
  const transport = http(rpc);
  const pc = createPublicClient({ chain, transport, pollingInterval: 1_000 }) as PublicClient;
  const wallet = (keyVar: string) => createWalletClient({ chain, transport, account: privateKeyToAccount(env(keyVar) as Hex) });
  const account = (keyVar: string) => privateKeyToAccount(env(keyVar) as Hex);
  return { rpc, dep, chain, pc, wallet, account };
}

/** JSON lines to stdout and, if LOG_FILE is set, appended to that file (bigints as strings). */
export function logger(component: string) {
  const file = process.env.LOG_FILE;
  return (e: Record<string, unknown>) => {
    const line = JSON.stringify({ ts: new Date().toISOString(), component, ...e }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
    console.log(line);
    if (file) appendFileSync(file, line + "\n");
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
