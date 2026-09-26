// Read-only view of one maker (the maker page): the wallet and its single approval to Aqua, every book (order) with its
// Aqua virtual balances, custody and capital utilization across markets, and the latest fill broken down from its
// receipt — what Aqua pulled from the maker's wallet and pushed back, and each book's balance before and after that
// block. Runs in the browser and, for the tests, in Node.

import { type Address, type Hex, parseEventLogs, type PublicClient } from "viem";
import { aquaAbi, erc20Abi, hubAbi, routerAbi, vaultAbi } from "../../../engine/src/abi.ts";
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
  walletBefore: bigint;
  walletAfter: bigint;
  custodyBefore: { long: bigint; short: bigint }; // the maker's custody in the fill's market
  custodyAfter: { long: bigint; short: bigint };
  books: { hash: Hex; marketId: number; side: number; before: bigint; after: bigint }[]; // quote-token balances
}

/** Everything the page shows, derived from a fill: what Aqua took from the maker's wallet for the mint, and which
 *  books moved. Pure, so it is tested on its own. */
export function summarizeFill(f: FillView, usdc: Address) {
  const sum = (kind: AquaMove["kind"]) =>
    f.moves.filter((m) => m.kind === kind && m.token.toLowerCase() === usdc.toLowerCase()).reduce((s, m) => s + m.amount, 0n);
  const changed = f.books.filter((b) => b.after !== b.before);
  return {
    custodyLong: f.custodyAfter.long - f.custodyBefore.long,
    custodyShort: f.custodyAfter.short - f.custodyBefore.short,
    pulledUsdc: sum("pull"), // out of the maker's wallet (a buy: exactly the mint Q2)
    pushedUsdc: sum("push"), // into the maker's wallet (a buy: the taker's payment)
    walletChange: f.walletAfter - f.walletBefore,
    changed,
    unchanged: f.books.filter((b) => b.after === b.before),
  };
}

export class MakerView {
  readonly pc: PublicClient;
  readonly dep: Deployment;
  readonly maker: Address;
  private readonly orders: OrderIndex;
  private nextFillBlock: bigint;
  private lastFill?: { hash: Hex; block: bigint; orderHash: Hex; marketId: number; dir: number; qty: bigint; q1: bigint; q2: bigint };

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
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.maker], blockNumber: block }),
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "allowance", args: [this.maker, this.dep.aqua], blockNumber: block }),
      this.pc.readContract({ address: this.dep.router, abi: routerAbi, functionName: "makerConfig", args: [this.maker], blockNumber: block }),
    ]);
    const books = await Promise.all(
      orders.map(async (o) => {
        const m = markets.find((x) => x.id === o.marketId);
        const sideToken = o.side === 0 ? m?.longToken : m?.shortToken;
        const [q, s] = await Promise.all([
          this.aquaBalance(o, this.dep.usdc, block),
          sideToken ? this.aquaBalance(o, sideToken, block) : Promise.resolve({ balance: 0n, docked: false }),
        ]);
        return { hash: o.hash, marketId: o.marketId, side: o.side, generation: o.generation, usdc: q.balance, sideTokens: s.balance, docked: q.docked };
      }),
    );
    const custody = await Promise.all(
      markets.map(async (m) => {
        const [long, short] = await Promise.all([
          this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositLong", args: [this.maker], blockNumber: block }),
          this.pc.readContract({ address: m.vault, abi: vaultAbi, functionName: "depositShort", args: [this.maker], blockNumber: block }),
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
    const before = f.block - 1n;
    const orders = await this.orders.sync();
    const vault = await this.pc.readContract({ address: this.dep.hub, abi: hubAbi, functionName: "marketVault", args: [f.marketId] });
    const custodyAt = async (blockNumber: bigint) => {
      const [long, short] = await Promise.all([
        this.pc.readContract({ address: vault, abi: vaultAbi, functionName: "depositLong", args: [this.maker], blockNumber }),
        this.pc.readContract({ address: vault, abi: vaultAbi, functionName: "depositShort", args: [this.maker], blockNumber }),
      ]);
      return { long, short };
    };
    const [custodyBefore, custodyAfter, walletBefore, walletAfter, books] = await Promise.all([
      custodyAt(before),
      custodyAt(f.block),
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.maker], blockNumber: before }),
      this.pc.readContract({ address: this.dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [this.maker], blockNumber: f.block }),
      Promise.all(
        orders
          .filter((o) => o.block <= before)
          .map(async (o) => ({
            hash: o.hash,
            marketId: o.marketId,
            side: o.side,
            before: (await this.aquaBalance(o, this.dep.usdc, before)).balance,
            after: (await this.aquaBalance(o, this.dep.usdc, f.block)).balance,
          })),
      ),
    ]);
    return {
      ...f,
      taker: swapped?.args.taker ?? ("0x" as Address),
      amountIn: swapped?.args.amountIn ?? 0n,
      amountOut: swapped?.args.amountOut ?? 0n,
      moves,
      walletBefore,
      walletAfter,
      custodyBefore,
      custodyAfter,
      books: books.sort((a, b) => a.marketId - b.marketId || a.side - b.side),
    };
  }
}
