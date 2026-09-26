// Read-only view of one maker (the maker page): the wallet and its single approval to Aqua, every book (order) with its
// Aqua virtual balances, custody and capital utilization across markets, and the latest fill broken down from its
// receipt alone — what Aqua pulled from the maker's wallet and pushed back per book, and what went into custody.
// Nothing reads old state (public RPCs prune it within minutes). Runs in the browser and, for the tests, in Node.

import { type Address, type Hex, parseEventLogs, type PublicClient } from "viem";
import { aquaAbi, erc20Abi, routerAbi, vaultAbi } from "../../../engine/src/abi.ts";
import type { Deployment } from "../../../engine/src/chain.ts";
import { riskCapital, utilization } from "../../../engine/src/fixedpoint.ts";
import { logsInChunks } from "../../../engine/src/logs.ts";
import { OrderIndex, type RegisteredOrder } from "../../../engine/src/taker.ts";
import type { MarketInfo } from "./app.ts";

export interface Book {
  hash: Hex;
  marketId: number;
  side: number; // 0 Long, 1 Short
  generation: number;
  usdc: bigint; // Aqua virtual balance of the quote token
  sideTokens: bigint; // Aqua virtual balance of the side token
  docked: boolean;
}

export interface Custody {
  marketId: number;
  long: bigint;
  short: bigint;
}

export interface MakerSnapshot {
  block: bigint;
  wallet: bigint; // quote token in the maker's own wallet
  approval: bigint; // the maker's approval to Aqua (pulls use it)
  riskBudget: bigint;
  rcTotal: bigint; // risk capital over the markets not yet settled
  utilization: bigint; // WAD
  books: Book[];
  custody: Custody[];
}

export interface AquaMove {
  kind: "pull" | "push";
  orderHash: Hex;
  token: Address;
  amount: bigint;
}

export interface FillView {
  hash: Hex;
  block: bigint;
  timestamp: bigint;
  orderHash: Hex;
  marketId: number;
  dir: number; // 1 buy Long, 2 sell Long, 3 buy Short, 4 sell Short
  qty: bigint;
  q1: bigint; // from custody (buy) / paired and burned (sell)
  q2: bigint; // freshly minted (buy) / bought into custody (sell)
  taker: Address;
  amountIn: bigint;
  amountOut: bigint;
  moves: AquaMove[]; // the maker's Aqua pulls and pushes in this transaction
}

export const fillSide = (dir: number) => (dir <= 2 ? 0 : 1); // D1 / D2 trade Long, D3 / D4 Short
export const fillIsBuy = (dir: number) => dir === 1 || dir === 3;

/** Everything the page shows about a fill, from its events alone. Aqua moves only the traded book's balances, so
 *  every other book is unchanged by construction. Custody follows the router's hooks: a buy serves Q1 of the side from
 *  custody and keeps the minted pair's other side (Q2); a sell burns Q1 against the other side and keeps Q2 of the
 *  side bought in. Pure, so it is tested on its own. */
export function summarizeFill(f: FillView, usdc: Address) {
  const isUsdc = (m: AquaMove) => m.token.toLowerCase() === usdc.toLowerCase();
  const sum = (kind: AquaMove["kind"]) => f.moves.filter((m) => m.kind === kind && isUsdc(m)).reduce((s, m) => s + m.amount, 0n);
  const bookDelta = new Map<string, bigint>();
  for (const m of f.moves.filter(isUsdc)) {
    const k = m.orderHash.toLowerCase();
    bookDelta.set(k, (bookDelta.get(k) ?? 0n) + (m.kind === "push" ? m.amount : -m.amount));
  }
  const side = fillSide(f.dir);
  const custody = [0n, 0n]; // [Long, Short]
  if (fillIsBuy(f.dir)) {
    custody[side] -= f.q1;
    custody[1 - side] += f.q2;
  } else {
    custody[1 - side] -= f.q1;
    custody[side] += f.q2;
  }
  return {
    pulledUsdc: sum("pull"), // out of the maker's wallet (a buy: exactly the mint Q2)
    pushedUsdc: sum("push"), // into the maker's wallet (a buy: the taker's payment)
    walletChange: sum("push") - sum("pull"),
    bookDelta, // lower-case order hash -> quote-token change of that book
    custodyLong: custody[0],
    custodyShort: custody[1],
  };
}

export class MakerView {
  readonly pc: PublicClient;
  readonly dep: Deployment;
  readonly maker: Address;
  private readonly orders: OrderIndex;
  private nextFillBlock: bigint;
  private lastFill?: { hash: Hex; block: bigint; orderHash: Hex; marketId: number; dir: number; qty: bigint; q1: bigint; q2: bigint };
  private fillView?: FillView; // the last fill's breakdown, read once

  constructor(pc: PublicClient, dep: Deployment, maker: Address) {
    this.pc = pc;
    this.dep = dep;
    this.maker = maker;
    this.orders = new OrderIndex(pc, dep, maker);
    this.nextFillBlock = BigInt(dep.block ?? 0);
  }

  books(): Promise<RegisteredOrder[]> {
    return this.orders.sync();
  }

  private async aquaBalance(o: RegisteredOrder, token: Address, blockNumber?: bigint) {
    const [balance, tokens] = await this.pc.readContract({
      address: this.dep.aqua,
      abi: aquaAbi,
      functionName: "rawBalances",
      args: [this.maker, this.dep.router, o.hash, token],
      blockNumber,
    });
    return { balance, docked: tokens === 255 };
  }

  async snapshot(markets: MarketInfo[]): Promise<MakerSnapshot> {
    const block = await this.pc.getBlockNumber();
    const orders = await this.orders.sync();
    const [wallet, approval, cfg] = await Promise.all([
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.maker] }),
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "allowance", args: [this.maker, this.dep.aqua] }),
      this.pc.readContract({ address: this.dep.router, abi: routerAbi, functionName: "makerConfig", args: [this.maker] }),
    ]);
    const books = await Promise.all(
      orders.map(async (o) => {
        const m = markets.find((x) => x.id === o.marketId);
        const sideToken = o.side === 0 ? m?.longToken : m?.shortToken;
        const [q, s] = await Promise.all([
          this.aquaBalance(o, this.dep.usdc),
          sideToken ? this.aquaBalance(o, sideToken) : Promise.resolve({ balance: 0n, docked: false }),
        ]);
        return { hash: o.hash, marketId: o.marketId, side: o.side, generation: o.generation, usdc: q.balance, sideTokens: s.balance, docked: q.docked };
      }),
    );
    const custody = await Promise.all(
      markets.map(async (m) => {
        const [long, short] = await Promise.all([
          this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositLong", args: [this.maker] }),
          this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositShort", args: [this.maker] }),
        ]);
        return { marketId: m.id, long, short };
      }),
    );
    let rcTotal = 0n;
    for (const c of custody) {
      const m = markets.find((x) => x.id === c.marketId)!;
      if (!m.finalized) rcTotal += riskCapital(c.long - c.short, m.pFair);
    }
    const riskBudget = BigInt(cfg.riskBudget);
    return {
      block,
      wallet,
      approval,
      riskBudget,
      rcTotal,
      utilization: riskBudget > 0n ? utilization(rcTotal, riskBudget) : 0n,
      books: books.sort((a, b) => a.marketId - b.marketId || a.side - b.side),
      custody,
    };
  }

  /** The maker's most recent fill (CorrSwap), broken down from its receipt; undefined before the first one. */
  async latestFill(): Promise<FillView | undefined> {
    const latest = await this.pc.getBlockNumber();
    if (latest >= this.nextFillBlock) {
      const logs = await logsInChunks(this.nextFillBlock, latest, (fromBlock, toBlock) =>
        this.pc.getContractEvents({ address: this.dep.router, abi: routerAbi, eventName: "CorrSwap", args: { maker: this.maker }, fromBlock, toBlock }),
      );
      const l = logs[logs.length - 1];
      if (l) {
        const a = l.args;
        this.lastFill = { hash: l.transactionHash, block: l.blockNumber, orderHash: a.orderHash!, marketId: a.marketId!, dir: a.dir!, qty: a.qty!, q1: a.q1!, q2: a.q2! };
      }
      this.nextFillBlock = latest + 1n;
    }
    const f = this.lastFill;
    if (!f) return undefined;
    if (this.fillView?.hash === f.hash) return this.fillView;
    const receipt = await this.pc.getTransactionReceipt({ hash: f.hash });
    const swapped = parseEventLogs({ abi: routerAbi, logs: receipt.logs, eventName: "Swapped" }).find((e) => e.args.orderHash === f.orderHash);
    // Aqua's events have no indexed fields: decode only the logs Aqua emitted
    const aquaLogs = receipt.logs.filter((l) => l.address.toLowerCase() === this.dep.aqua.toLowerCase());
    const moves: AquaMove[] = parseEventLogs({ abi: aquaAbi, logs: aquaLogs })
      .filter((e) => (e.eventName === "Pulled" || e.eventName === "Pushed") && e.args.maker.toLowerCase() === this.maker.toLowerCase())
      .map((e) => {
        const x = e.args as { strategyHash: Hex; token: Address; amount: bigint };
        return { kind: e.eventName === "Pulled" ? "pull" : "push", orderHash: x.strategyHash, token: x.token, amount: x.amount } as AquaMove;
      });
    const block = await this.pc.getBlock({ blockNumber: f.block });
    this.fillView = {
      ...f,
      timestamp: block.timestamp,
      taker: swapped?.args.taker ?? ("0x" as Address),
      amountIn: swapped?.args.amountIn ?? 0n,
      amountOut: swapped?.args.amountOut ?? 0n,
      moves,
    };
    return this.fillView;
  }
}
