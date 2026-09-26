// Maker operations (M §5.4, §5.7, §8.3): settings, opening a market (register and ship both books), stopping by
// dock, topping up an order's USDC allocation by push, resuming with a new generation, claiming the custody after
// settlement, and a monitor of inventory, utilization, allocations and wallet funds. It never computes prices.

import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { aquaAbi, erc20Abi, hubAbi, routerAbi, vaultAbi } from "./abi.ts";
import type { Deployment } from "./chain.ts";
import { logsInChunks } from "./logs.ts";
import { riskCapital, utilization, WAD } from "./fixedpoint.ts";
import { buildOrder, type Order, orderHash, orderStrategy, SIDE_LONG, SIDE_SHORT } from "./orders.ts";

export interface MakerConfig {
  riskBudget: bigint;
  qMaxMarket: bigint;
  qGroup: bigint;
  qMinTrade: bigint;
  qMaxTrade: bigint;
  kq: bigint;
  hM: bigint;
  active: boolean;
}

/** M §8.1 MVP values with kq = 1/6 as the truncated WAD value (the representation is still to be confirmed). */
export const MVP_CONFIG: MakerConfig = {
  riskBudget: 100_000n * 10n ** 6n,
  qMaxMarket: 50_000n * 10n ** 6n,
  qGroup: 100_000n * 10n ** 6n,
  qMinTrade: 1n * 10n ** 6n,
  qMaxTrade: 5_000n * 10n ** 6n,
  kq: WAD / 6n,
  hM: 0n,
  active: true,
};

export class MakerOps {
  private readonly pc: PublicClient;
  private readonly wc: WalletClient;
  private readonly dep: Deployment;
  readonly maker: Address;
  private readonly log: (e: Record<string, unknown>) => void;

  constructor(pc: PublicClient, wc: WalletClient, dep: Deployment, log: (e: Record<string, unknown>) => void = () => {}) {
    this.pc = pc;
    this.wc = wc;
    this.dep = dep;
    this.maker = wc.account!.address;
    this.log = log;
  }

  private async write(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
    const { request } = await this.pc.simulateContract({ address, abi, functionName, args, account: this.wc.account! } as never);
    const hash = await this.wc.writeContract(request as never);
    const r = await this.pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
    this.log({ ev: "tx", fn: functionName, hash, gasUsed: r.gasUsed.toString() });
    return hash;
  }

  async setConfig(c: MakerConfig) {
    return this.write(this.dep.router, routerAbi, "setMakerConfig", [c]);
  }

  async market(id: number) {
    const hub = { address: this.dep.hub, abi: hubAbi } as const;
    const [q, vault] = await Promise.all([
      this.pc.readContract({ ...hub, functionName: "quoteState", args: [id] }),
      this.pc.readContract({ ...hub, functionName: "marketVault", args: [id] }),
    ]);
    const [longToken, shortToken] = await Promise.all([
      this.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longToken" }),
      this.pc.readContract({ address: vault, abi: vaultAbi, functionName: "shortToken" }),
    ]);
    return { id, obsEnd: Number(q.obsEnd), pFair: q.pFair, vault, longToken, shortToken };
  }

  async orders(id: number, generation: number): Promise<{ long: Order; short: Order }> {
    const m = await this.market(id);
    const spec = { maker: this.maker, usdc: this.dep.usdc, router: this.dep.router, obsEnd: m.obsEnd, marketId: id, generation };
    return {
      long: buildOrder({ ...spec, sideToken: m.longToken, side: SIDE_LONG }),
      short: buildOrder({ ...spec, sideToken: m.shortToken, side: SIDE_SHORT }),
    };
  }

  private async approveMax(token: Address, spender: Address, min: bigint) {
    const cur = await this.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [this.maker, spender] });
    if (cur < min) await this.write(token, erc20Abi, "approve", [spender, min]);
  }

  /** Open (M §5.7): approvals, register both books, ship each with `allocation` USDC and 0 side tokens. */
  async open(id: number, generation: number, allocation: bigint, usdcApproval: bigint) {
    const m = await this.market(id);
    const { long, short } = await this.orders(id, generation);
    await this.approveMax(this.dep.usdc, this.dep.aqua, usdcApproval);
    await this.approveMax(m.longToken, this.dep.aqua, 2n ** 255n); // pass-through only (M §5.1)
    await this.approveMax(m.shortToken, this.dep.aqua, 2n ** 255n);
    await this.write(this.dep.router, routerAbi, "registerCorrPair", [long, short]);
    for (const [o, token] of [[long, m.longToken], [short, m.shortToken]] as const) {
      await this.write(this.dep.aqua, aquaAbi, "ship", [this.dep.router, orderStrategy(o), [this.dep.usdc, token], [allocation, 0n]]);
    }
    return { long, short, longHash: orderHash(long), shortHash: orderHash(short) };
  }

  /** Stop by docking both books (either one alone also works; the other keeps running). */
  async dock(id: number, generation: number, which: "both" | "long" | "short" = "both") {
    const m = await this.market(id);
    const { long, short } = await this.orders(id, generation);
    if (which !== "short") await this.write(this.dep.aqua, aquaAbi, "dock", [this.dep.router, orderHash(long), [this.dep.usdc, m.longToken]]);
    if (which !== "long") await this.write(this.dep.aqua, aquaAbi, "dock", [this.dep.router, orderHash(short), [this.dep.usdc, m.shortToken]]);
  }

  /** Top up an order's USDC allocation without docking (M §5.7). Aqua's push takes the USDC with transferFrom and so
   *  consumes the maker's approval; it is raised by the same amount first, keeping the working approval intact. */
  async topUp(order: Order, amount: bigint) {
    const cur = await this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "allowance", args: [this.maker, this.dep.aqua] });
    await this.write(this.dep.usdc, erc20Abi, "approve", [this.dep.aqua, cur + amount]);
    return this.write(this.dep.aqua, aquaAbi, "push", [this.maker, this.dep.router, orderHash(order), this.dep.usdc, amount]);
  }

  async claim(id: number) {
    const m = await this.market(id);
    return this.write(m.vault, vaultAbi, "claimDeposit", []);
  }

  /** Inventory, utilization, funding and equity of every market. `baseline` (USDC units) gives the P&L:
   *  equity = wallet USDC + custody valued at each side's fair value (Long at P_fair, Short at 1 - P_fair; after
   *  settlement at Long_T), P&L = equity - baseline. Aqua allocations are virtual and not counted (M §5.7). */
  async monitor(baseline?: bigint): Promise<MakerReport> {
    const cfg = await this.pc.readContract({ address: this.dep.router, abi: routerAbi, functionName: "makerConfig", args: [this.maker] });
    const logs = await logsInChunks(BigInt(this.dep.block ?? 0), await this.pc.getBlockNumber(), (fromBlock, toBlock) =>
      this.pc.getContractEvents({ address: this.dep.router, abi: routerAbi, eventName: "CorrOrderRegistered", args: { maker: this.maker }, fromBlock, toBlock }),
    );
    const count = await this.pc.readContract({ address: this.dep.hub, abi: hubAbi, functionName: "marketCount" });
    const markets: MakerReport["markets"] = [];
    let rcTotal = 0n;
    for (let id = 0; id < count; ++id) {
      const m = await this.market(id);
      const [nl, ns, finalized] = await Promise.all([
        this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositLong", args: [this.maker] }),
        this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositShort", args: [this.maker] }),
        this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "finalized" }),
      ]);
      const q = nl - ns;
      const rc = finalized ? 0n : riskCapital(q, m.pFair);
      rcTotal += rc;
      const mark = finalized ? await this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "longT" }) : m.pFair;
      const custodyValue = (nl * mark) / WAD + (ns * (WAD - mark)) / WAD;
      const orders = [];
      for (const l of logs.filter((x) => x.args.marketId === id)) {
        const token = l.args.side === SIDE_LONG ? m.longToken : m.shortToken;
        const [[usdcBal, tokens], [sideBal]] = await Promise.all([
          this.pc.readContract({ address: this.dep.aqua, abi: aquaAbi, functionName: "rawBalances", args: [this.maker, this.dep.router, l.args.orderHash!, this.dep.usdc] }),
          this.pc.readContract({ address: this.dep.aqua, abi: aquaAbi, functionName: "rawBalances", args: [this.maker, this.dep.router, l.args.orderHash!, token] }),
        ]);
        orders.push({ hash: l.args.orderHash!, side: l.args.side!, generation: l.args.generation!, usdcAllocation: usdcBal, sideTokenBalance: sideBal, docked: tokens === 255, shipped: tokens > 0 && tokens !== 255 });
      }
      markets.push({ id, nl, ns, q, rc, finalized, pFair: m.pFair, custodyValue, orders });
    }
    const [wallet, allowance] = await Promise.all([
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.maker] }),
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "allowance", args: [this.maker, this.dep.aqua] }),
    ]);
    const u = cfg.riskBudget > 0n ? utilization(rcTotal, cfg.riskBudget) : 0n;
    const warnings: string[] = [];
    const need = cfg.riskBudget + cfg.qMaxTrade; // M §5.7: wallet and approval >= RiskBudget + Qmax
    if (wallet < need) warnings.push(`wallet USDC ${wallet} < RiskBudget + Qmax ${need}`);
    if (allowance < need) warnings.push(`USDC approval to Aqua ${allowance} < RiskBudget + Qmax ${need}`);
    for (const mk of markets) {
      for (const o of mk.orders) {
        if (o.shipped && o.usdcAllocation < cfg.qMaxMarket + cfg.qMaxTrade) {
          warnings.push(`market ${mk.id} order ${o.hash.slice(0, 10)}: allocation ${o.usdcAllocation} < qmax + Qmax`);
        }
        if (o.shipped && o.sideTokenBalance !== 0n) warnings.push(`market ${mk.id} order ${o.hash.slice(0, 10)}: side-token balance ${o.sideTokenBalance} != 0 (A5)`);
      }
      if (mk.nl !== 0n && mk.ns !== 0n) warnings.push(`market ${mk.id}: both custodies non-zero (A2)`);
    }
    if (u >= 9n * 10n ** 17n) warnings.push(`utilization ${u} >= Umax`);
    const equity = wallet + markets.reduce((a, x) => a + x.custodyValue, 0n);
    const pnl = baseline === undefined ? undefined : equity - baseline;
    return { maker: this.maker, config: cfg, wallet, allowance, rcTotal, utilization: u, equity, pnl, markets, warnings };
  }
}

export interface MakerReport {
  maker: Address;
  config: MakerConfig;
  wallet: bigint;
  allowance: bigint;
  rcTotal: bigint;
  utilization: bigint;
  equity: bigint;
  pnl?: bigint;
  markets: {
    id: number;
    nl: bigint;
    ns: bigint;
    q: bigint;
    rc: bigint;
    finalized: boolean;
    pFair: bigint;
    custodyValue: bigint;
    orders: { hash: Hex; side: number; generation: number; usdcAllocation: bigint; sideTokenBalance: bigint; docked: boolean; shipped: boolean }[];
  }[];
  warnings: string[];
}
