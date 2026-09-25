// Finalize executor (M §5.5, §6.2.1, §8.3): anyone may call it. After obsEnd it accumulates whatever the hub can
// accumulate (every posted bar, and after obsEnd + 48 h the unposted ones as invalid) and calls finalize once all
// N bars are processed. It never cranks before obsEnd: accumulating ahead of the reporter halts trading (T-1).

import type { Hex, PublicClient, WalletClient } from "viem";
import { hubAbi, vaultAbi } from "./abi.ts";
import { type Deployment, readMarket, readPoint } from "./chain.ts";
import { DELTA, FINALIZE_GRACE } from "./market.ts";

export interface FinalizerDeps {
  pc: PublicClient;
  wc: WalletClient;
  dep: Deployment;
  now: () => Promise<number>;
  log: (event: Record<string, unknown>) => void;
  maxCrankPerTx?: number;
}

export interface FinalizeResult {
  cranked: { market: number; to: number }[];
  finalized: number[];
  txs: Hex[];
}

export async function finalizeTick(d: FinalizerDeps): Promise<FinalizeResult> {
  const { pc, wc, dep } = d;
  const maxCrank = d.maxCrankPerTx ?? 144;
  const now = await d.now();
  const res: FinalizeResult = { cranked: [], finalized: [], txs: [] };
  const hFloor = await pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "hFloor" });
  const count = await pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "marketCount" });
  for (let id = 0; id < count; ++id) {
    let m = await readMarket(pc, dep, id, hFloor);
    if (m.finalized || now < m.params.obsEnd) continue;
    const send = async (address: `0x${string}`, abi: typeof hubAbi | typeof vaultAbi, functionName: string, args: unknown[]) => {
      const { request } = await pc.simulateContract({ address, abi, functionName, args, account: wc.account! } as never);
      const hash = await wc.writeContract(request as never);
      const receipt = await pc.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
      d.log({ ev: "tx", fn: functionName, market: id, hash, gasUsed: receipt.gasUsed.toString() });
      res.txs.push(hash);
    };
    // how far the hub can accumulate now: to the first unposted point, or to N once obsEnd + 48 h has passed
    let target = m.params.n;
    if (now < m.params.obsEnd + FINALIZE_GRACE) {
      // bar k + 1 needs both of its points (t_k and t_k+1)
      const posted = async (k: number) => (await readPoint(pc, dep, m.params.obsStart + k * DELTA)).posted;
      target = m.acc.processed;
      if (await posted(target)) while (target < m.params.n && (await posted(target + 1))) ++target;
    }
    const before = m.acc.processed;
    while (m.acc.processed < target) {
      const from = m.acc.processed;
      await send(dep.hub, hubAbi, "crank", [id, Math.min(maxCrank, target - from)]);
      m = await readMarket(pc, dep, id, hFloor);
      if (m.acc.processed === from) throw new Error(`crank of market ${id} did not advance at bar ${from}`);
    }
    if (m.acc.processed > before) res.cranked.push({ market: id, to: m.acc.processed });
    if (m.acc.processed !== m.params.n) continue;
    await send(m.vault, vaultAbi, "finalize", []);
    res.finalized.push(id);
    d.log({ ev: "finalized", market: id });
  }
  return res;
}
