// Taker side, shared by the UI and the tests (M §5.6, §5.8): registered orders from the router's events, the quote
// breakdown, and a trade through the router's entry point with the tolerance-derived limit.

import type { Address, BlockTag, Hex, PublicClient, WalletClient } from "viem";
import { parseEventLogs } from "viem";
import { lensAbi, routerAbi } from "./abi.ts";
import type { Deployment } from "./chain.ts";
import type { Order } from "./orders.ts";

/** Reason codes of CorrFiPricing (M §5.8.2 可否) with what the UI shows and whether waiting can clear them. */
export const REASONS: Record<number, { code: string; ja: string; en: string; clears: "report" | "maker" | "amount" | "never" | "-" }> = {
  0: { code: "OK", ja: "取引できます", en: "Tradable", clears: "-" },
  1: { code: "NOT_REGISTERED", ja: "order が登録されていません", en: "Order not registered", clears: "maker" },
  2: { code: "MAKER_INACTIVE", ja: "Maker が停止中です", en: "Maker paused", clears: "maker" },
  3: { code: "UNSYNCED", ja: "停止中：価格の確認待ち（累積が先行）", en: "Halted: waiting for the price report (T-1)", clears: "report" },
  4: { code: "STALE", ja: "停止中：価格更新待ち（最後の確認から 6 分超）", en: "Halted: fair value is stale (T-2)", clears: "report" },
  5: { code: "EXPIRED", ja: "取引期間が終了しました（obsEnd）", en: "Trading closed at obsEnd (T-3)", clears: "never" },
  6: { code: "TOO_MANY_INVALID", ja: "停止中：無効バーが許容数の半分を超えました（再開しません）", en: "Halted: too many invalid bars (T-4, permanent)", clears: "never" },
  7: { code: "LOCKED", ja: "同じ Maker の取引が実行中です（入れ子の取引）", en: "Maker busy (nested trade)", clears: "-" },
  8: { code: "QTY_TOO_SMALL", ja: "数量が下限（1 token）未満です", en: "Quantity below the minimum", clears: "amount" },
  9: { code: "QTY_TOO_LARGE", ja: "数量が 1 回の上限を超えます", en: "Quantity above the per-trade maximum", clears: "amount" },
  10: { code: "MARKET_CAP", ja: "Maker の在庫上限に達します", en: "Maker's market inventory cap", clears: "amount" },
  11: { code: "GROUP_CAP", ja: "Maker の全市場の上限に達します", en: "Maker's group cap", clears: "amount" },
  12: { code: "UTILIZATION_CAP", ja: "Maker の資本使用率の上限に達します", en: "Maker's utilization cap", clears: "amount" },
  13: { code: "ALLOCATION_SHORT", ja: "order の USDC 割当が不足しています", en: "Order's USDC allocation too small", clears: "maker" },
  14: { code: "WALLET_SHORT", ja: "Maker のウォレット残高または承認が不足しています", en: "Maker's wallet or approval too small", clears: "maker" },
  15: { code: "ZERO_AMOUNT", ja: "金額が 0 になります", en: "Amount rounds to zero", clears: "amount" },
  16: { code: "BOOK_TOO_THIN", ja: "板の深さが足りません", en: "Book too thin", clears: "amount" },
  17: { code: "ORDER_INACTIVE", ja: "order が停止中です（dock 済み）", en: "Order docked / not shipped", clears: "maker" },
  18: { code: "UNSUPPORTED_TRANSFER", ja: "この送金方式（Aqua への先入れで、送金を後にする買い）には対応していません", en: "Unsupported transfer mode", clears: "-" },
};

export interface RegisteredOrder {
  hash: Hex;
  maker: Address;
  marketId: number;
  side: number;
  generation: number;
  order: Order;
  block: bigint;
}

export async function registeredOrders(pc: PublicClient, dep: Deployment, maker?: Address): Promise<RegisteredOrder[]> {
  const logs = await pc.getContractEvents({
    address: dep.router,
    abi: routerAbi,
    eventName: "CorrOrderRegistered",
    args: maker ? { maker } : undefined,
    fromBlock: BigInt(dep.block ?? 0),
  });
  return logs.map((l) => ({
    hash: l.args.orderHash!,
    maker: l.args.maker!,
    marketId: l.args.marketId!,
    side: l.args.side!,
    generation: l.args.generation!,
    order: { maker: l.args.order!.maker, traits: l.args.order!.traits, data: l.args.order!.data },
    block: l.blockNumber,
  }));
}

export type Breakdown = Awaited<ReturnType<typeof breakdown>>;

export function breakdown(
  pc: PublicClient,
  dep: Deployment,
  o: Order,
  marketId: number,
  side: number,
  isBuy: boolean,
  exactIn: boolean,
  amount: bigint,
  delta: bigint,
  blockTag: BlockTag = "latest",
) {
  return pc.readContract({
    address: dep.lens,
    abi: lensAbi,
    functionName: "breakdown",
    args: [o, marketId, side, isBuy, exactIn, amount, delta],
    blockTag,
  });
}

export interface Fill {
  hash: Hex;
  block: bigint;
  timestamp: bigint;
  amountIn: bigint;
  amountOut: bigint;
  q1: bigint;
  q2: bigint;
  pFair: bigint;
  h: bigint;
  hmin: bigint;
}

/** Trade through the router's entry (the caller stays the taker). `limit`: min out (exact-in) / max in (exact-out). */
export async function trade(
  pc: PublicClient,
  wc: WalletClient,
  dep: Deployment,
  o: Order,
  marketId: number,
  side: number,
  isBuy: boolean,
  exactIn: boolean,
  amount: bigint,
  limit: bigint,
  deadline = 0,
): Promise<Fill> {
  const { request } = await pc.simulateContract({
    address: dep.router,
    abi: routerAbi,
    functionName: "trade",
    args: [o, marketId, side, isBuy, exactIn, amount, limit, deadline],
    account: wc.account!,
  });
  const hash = await wc.writeContract(request);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`trade reverted in ${hash}`);
  const ev = parseEventLogs({ abi: routerAbi, logs: r.logs });
  const swapped = ev.find((e) => e.eventName === "Swapped");
  const corr = ev.find((e) => e.eventName === "CorrSwap");
  if (!swapped || swapped.eventName !== "Swapped" || !corr || corr.eventName !== "CorrSwap") throw new Error("trade events missing");
  const block = await pc.getBlock({ blockNumber: r.blockNumber });
  return {
    hash,
    block: r.blockNumber,
    timestamp: block.timestamp,
    amountIn: swapped.args.amountIn,
    amountOut: swapped.args.amountOut,
    q1: corr.args.q1,
    q2: corr.args.q2,
    pFair: corr.args.pFair,
    h: corr.args.h,
    hmin: corr.args.hmin,
  };
}
