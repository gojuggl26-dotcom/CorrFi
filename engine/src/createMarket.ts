// Operator: create a market from calib.json (data/make_calib.py) with the price engine's signed initial report
// (M §4.1.1, §4.2.2 "作成時の一致確認"; the hub recomputes P_fair(τ = 0) and h0 and checks the signature).

import { readFileSync } from "node:fs";
import type { Account, PublicClient, WalletClient } from "viem";
import { hubAbi } from "./abi.ts";
import { type Deployment, signReport } from "./chain.ts";
import { fairValue, h0 } from "./fixedpoint.ts";

export interface MarketInput {
  tenorDays: number;
  sA: bigint;
  sB: bigint;
  sAB: bigint;
  sA2: bigint;
  sB2: bigint;
  sigmaTable: readonly bigint[];
  cH: bigint;
  lambda: bigint;
  sigma0: bigint;
}

export function marketInputFromCalib(path: string): MarketInput {
  const c = JSON.parse(readFileSync(path, "utf8"));
  const b = (x: string) => BigInt(x);
  return {
    tenorDays: Number(c.tenorDays),
    sA: b(c.sA),
    sB: b(c.sB),
    sAB: b(c.sAB),
    sA2: b(c.sA2),
    sB2: b(c.sB2),
    sigmaTable: c.sigmaTable.map(b),
    cH: b(c.cH),
    lambda: b(c.lambda),
    sigma0: b(c.sigma0),
  };
}

export async function createMarket(pc: PublicClient, owner: WalletClient, engine: Account, dep: Deployment, p: MarketInput) {
  const hub = { address: dep.hub, abi: hubAbi } as const;
  const [id, hFloor] = await Promise.all([
    pc.readContract({ ...hub, functionName: "marketCount" }),
    pc.readContract({ ...hub, functionName: "hFloor" }),
  ]);
  const n = BigInt(p.tenorDays * 288);
  const pFair0 = fairValue(0n, 0n, 0n, 0n, n, p.sAB, p.sA2, p.sB2);
  const h00 = h0(0n, p.sigmaTable, p.cH, hFloor);
  const signature = await signReport(engine, dep, { marketId: id, k: 0, pFair: pFair0, h0: h00 });
  const input = { ...p, sigmaTable: p.sigmaTable as unknown as readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint] };
  const { request } = await pc.simulateContract({ ...hub, functionName: "createMarket", args: [input, pFair0, h00, signature], account: owner.account! });
  const hash = await owner.writeContract(request);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`createMarket reverted in ${hash}`);
  return { id, pFair0, h00, hash };
}
