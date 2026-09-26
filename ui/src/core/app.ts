// Chain side of the UI: markets, the default maker's current orders, quotes (lens), execution through the router's
// entry, price-confirmation events, positions and redemption. Runs in the browser and, for the tests, in Node.

import type { Address, PublicClient, WalletClient } from "viem";
import { erc20Abi, hubAbi, vaultAbi, aquaAbi } from "../../../engine/src/abi.ts";
import type { Deployment } from "../../../engine/src/chain.ts";
import { breakdown, type Breakdown, OrderIndex, type RegisteredOrder, trade, type Fill } from "../../../engine/src/taker.ts";
import { explainFill, type QuoteInput } from "./quote.ts";

const WAD = 10n ** 18n;

export interface MarketInfo {
  id: number;
  tenorDays: number;
  obsStart: number;
  obsEnd: number;
  n: number;
  confirmed: number;
  processed: number;
  invalidBars: number;
  pFair: bigint;
  vault: Address;
  longToken: Address;
  shortToken: Address;
  finalized: boolean;
  longT?: bigint;
  isVoid?: boolean;
}

export interface Position {
  marketId: number;
  long: bigint;
  short: bigint;
  /** at the current fair values: Long at P_fair, Short at 1 - P_fair (units) */
  value: bigint;
  /** after settlement: what redeem pays (F6) */
  payout?: bigint;
}

/** A lens breakdown together with the order it was computed for; execution trades against that same order. */
export type Quoted = Breakdown & { order: RegisteredOrder };

export class CorrFiApp {
  readonly pc: PublicClient;
  readonly dep: Deployment;
  readonly maker: Address;
  private readonly orders: OrderIndex;

  constructor(pc: PublicClient, dep: Deployment, maker: Address) {
    this.pc = pc;
    this.dep = dep;
    this.maker = maker;
    this.orders = new OrderIndex(pc, dep, maker);
  }

  async markets(): Promise<MarketInfo[]> {
    const hub = { address: this.dep.hub, abi: hubAbi } as const;
    const count = await this.pc.readContract({ ...hub, functionName: "marketCount" });
    return Promise.all(
      [...Array(count).keys()].map(async (id) => {
        const [q, vault] = await Promise.all([
          this.pc.readContract({ ...hub, functionName: "quoteState", args: [id] }),
          this.pc.readContract({ ...hub, functionName: "marketVault", args: [id] }),
        ]);
        const v = { address: vault, abi: vaultAbi } as const;
        const [longToken, shortToken, finalized] = await Promise.all([
          this.pc.readContract({ ...v, functionName: "longToken" }),
          this.pc.readContract({ ...v, functionName: "shortToken" }),
          this.pc.readContract({ ...v, functionName: "finalized" }),
        ]);
        const m: MarketInfo = {
          id,
          tenorDays: q.n / 288,
          obsStart: Number(q.obsStart),
          obsEnd: Number(q.obsEnd),
          n: q.n,
          confirmed: q.confirmed,
          processed: q.processed,
          invalidBars: q.invalidBars,
          pFair: q.pFair,
          vault,
          longToken,
          shortToken,
          finalized,
        };
        if (finalized) {
          [m.longT, m.isVoid] = await Promise.all([
            this.pc.readContract({ ...v, functionName: "longT" }),
            this.pc.readContract({ ...v, functionName: "isVoid" }),
          ]);
        }
        return m;
      }),
    );
  }

  /** The default maker's newest shipped (not docked) order for a market and side (M §5.6: the operator's maker). */
  async orderFor(marketId: number, side: number): Promise<RegisteredOrder | undefined> {
    const all = (await this.orders.sync()).filter((o) => o.marketId === marketId && o.side === side);
    all.sort((a, b) => b.generation - a.generation);
    for (const o of all) {
      const [, tokens] = await this.pc.readContract({
        address: this.dep.aqua,
        abi: aquaAbi,
        functionName: "rawBalances",
        args: [o.maker, this.dep.router, o.hash, this.dep.usdc],
      });
      if (tokens > 0 && tokens !== 255) return o;
    }
    return all[0];
  }

  async quote(input: QuoteInput): Promise<Quoted> {
    const o = await this.orderFor(input.marketId, input.side);
    if (!o) throw new Error("no order for this market and side");
    const b = await breakdown(this.pc, this.dep, o.order, input.marketId, input.side, input.isBuy, input.exactIn, input.amount, input.delta);
    return { ...b, order: o };
  }

  /** Execute a quote for `input` with its tolerance limit, against the order it was quoted on; returns the fill and
   *  why it differs from the quote, if it does. */
  async execute(wc: WalletClient, input: QuoteInput, quoted: Quoted): Promise<{ fill: Fill; causes: string[] }> {
    if (quoted.reason !== 0 || !quoted.limitDefined) throw new Error("not tradable");
    const o = quoted.order;
    if (o.marketId !== input.marketId || o.side !== input.side) throw new Error("the quote is for another market or side");
    const token = input.isBuy ? this.dep.usdc : await this.sideToken(input.marketId, input.side);
    const need = input.exactIn ? input.amount : quoted.limit;
    const allowance = await this.pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [wc.account!.address, this.dep.router] });
    if (allowance < need) {
      const hash = await wc.writeContract({ address: token, abi: erc20Abi, functionName: "approve", args: [this.dep.router, need], account: wc.account!, chain: wc.chain });
      await this.pc.waitForTransactionReceipt({ hash });
    }
    const fill = await trade(this.pc, wc, this.dep, o.order, input.marketId, input.side, input.isBuy, input.exactIn, input.amount, quoted.limit);
    return { fill, causes: explainFill(quoted, fill) };
  }

  async sideToken(marketId: number, side: number): Promise<Address> {
    const vault = await this.pc.readContract({ address: this.dep.hub, abi: hubAbi, functionName: "marketVault", args: [marketId] });
    return this.pc.readContract({ address: vault, abi: vaultAbi, functionName: side === 0 ? "longToken" : "shortToken" });
  }

  async positions(account: Address, markets?: MarketInfo[]): Promise<Position[]> {
    const ms = markets ?? (await this.markets());
    return Promise.all(
      ms.map(async (m) => {
        const [long, short] = await Promise.all([
          this.pc.readContract({ address: m.longToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
          this.pc.readContract({ address: m.shortToken, abi: erc20Abi, functionName: "balanceOf", args: [account] }),
        ]);
        const p: Position = { marketId: m.id, long, short, value: (long * m.pFair) / WAD + (short * (WAD - m.pFair)) / WAD };
        if (m.finalized && m.longT !== undefined) p.payout = (long * m.longT) / WAD + (short * (WAD - m.longT)) / WAD;
        return p;
      }),
    );
  }

  async redeem(wc: WalletClient, m: MarketInfo, long: bigint, short: bigint) {
    const hash = await wc.writeContract({ address: m.vault, abi: vaultAbi, functionName: "redeem", args: [long, short], account: wc.account!, chain: wc.chain });
    return this.pc.waitForTransactionReceipt({ hash });
  }

  /** ReportAccepted events of one market (polling transport in the browser). */
  watchReports(marketId: number, onReport: (k: number) => void): () => void {
    return this.pc.watchContractEvent({
      address: this.dep.hub,
      abi: hubAbi,
      eventName: "ReportAccepted",
      args: { marketId },
      onLogs: (logs) => {
        for (const l of logs) if (l.args.k !== undefined) onReport(l.args.k);
      },
    });
  }
}
