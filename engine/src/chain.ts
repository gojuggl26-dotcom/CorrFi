// Chain access shared by the reporter, the finalizer, the maker tool and the UI: deployment addresses, reads of the
// hub's market state, and the EIP-712 report signature (M §4.2.1: domain = hub address + chain id).

import { readFileSync } from "node:fs";
import type { Account, Address, Hex, PublicClient } from "viem";
import { hubAbi, vaultAbi } from "./abi.ts";
import type { AccState, ChainPoint, MarketParams, Report } from "./market.ts";

export interface Deployment {
  chainId: number;
  usdc: Address;
  aqua: Address;
  hub: Address;
  router: Address;
  lens: Address;
  weth: Address;
  block?: number;
}

export function loadDeployment(path: string): Deployment {
  const d = JSON.parse(readFileSync(path, "utf8"));
  return { ...d, chainId: Number(d.chainId) };
}

/** Everything the reporter needs about one market, read in one go. */
export interface MarketView {
  params: MarketParams;
  acc: AccState;
  confirmed: number;
  pFair: bigint;
  vault: Address;
  finalized: boolean;
}

export async function readMarket(pc: PublicClient, dep: Deployment, id: number, hFloor: bigint): Promise<MarketView> {
  const hub = { address: dep.hub, abi: hubAbi } as const;
  const [q, s, p, vault] = await Promise.all([
    pc.readContract({ ...hub, functionName: "quoteState", args: [id] }),
    pc.readContract({ ...hub, functionName: "settlement", args: [id] }),
    pc.readContract({ ...hub, functionName: "marketParams", args: [id] }),
    pc.readContract({ ...hub, functionName: "marketVault", args: [id] }),
  ]);
  const finalized = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "finalized" });
  const [csA, csB, sAB, sA2, sB2, table, cH, lambda] = p;
  return {
    params: {
      id,
      obsStart: Number(q.obsStart),
      obsEnd: Number(q.obsEnd),
      n: q.n,
      nMin: q.nMin,
      csA,
      csB,
      sAB,
      sA2,
      sB2,
      sigmaTable: table,
      cH,
      lambda,
      hFloor,
    },
    acc: { processed: s.processed, nValid: s.nValid, c: s.c, va: s.va, vb: s.vb },
    confirmed: q.confirmed,
    pFair: q.pFair,
    vault,
    finalized,
  };
}

export async function readPoint(pc: PublicClient, dep: Deployment, t: number): Promise<ChainPoint> {
  const p = await pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "point", args: [BigInt(t)] });
  return { pA: p.pA, pB: p.pB, posted: p.posted, validA: p.validA, validB: p.validB };
}

export const REPORT_TYPES = {
  Report: [
    { name: "marketId", type: "uint8" },
    { name: "k", type: "uint32" },
    { name: "pFair", type: "uint256" },
    { name: "h0", type: "uint256" },
  ],
} as const;

/** EIP-712 signature of a report with the price engine's key (U-1). */
export async function signReport(account: Account, dep: Deployment, r: Report): Promise<Hex> {
  if (!account.signTypedData) throw new Error("the price-engine account cannot sign typed data");
  return account.signTypedData({
    domain: { name: "CorrFi", version: "1", chainId: dep.chainId, verifyingContract: dep.hub },
    types: REPORT_TYPES,
    primaryType: "Report",
    message: { marketId: r.marketId, k: r.k, pFair: r.pFair, h0: r.h0 },
  });
}
