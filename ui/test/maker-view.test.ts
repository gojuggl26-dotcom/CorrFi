import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { type FillView, summarizeFill } from "../src/core/makerView.ts";

const USDC = "0x00000000000000000000000000000000000000a1" as Address;
const LONG = "0x00000000000000000000000000000000000000b2" as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const U = 10n ** 6n;

/** A buy of 1,000 Long with a fresh mint (Q1 0, Q2 1,000) paying 952: the event order of the router's D1 path. */
function buyWithMint(): FillView {
  return {
    hash: h(1),
    block: 100n,
    orderHash: h(11),
    marketId: 2,
    dir: 1,
    qty: 1_000n * U,
    q1: 0n,
    q2: 1_000n * U,
    taker: "0x00000000000000000000000000000000000000c3",
    amountIn: 952n * U,
    amountOut: 1_000n * U,
    moves: [
      { kind: "pull", orderHash: h(11), token: USDC, amount: 1_000n * U }, // the mint
      { kind: "push", orderHash: h(11), token: LONG, amount: 1_000n * U }, // Long into the book...
      { kind: "pull", orderHash: h(11), token: LONG, amount: 1_000n * U }, // ...and out to the taker
      { kind: "push", orderHash: h(11), token: USDC, amount: 952n * U }, // the taker's payment
    ],
    walletBefore: 1_000_000n * U,
    walletAfter: 1_000_000n * U - 48n * U,
    custodyBefore: { long: 0n, short: 0n },
    custodyAfter: { long: 0n, short: 1_000n * U },
    books: [
      { hash: h(10), marketId: 1, side: 0, before: 55_000n * U, after: 55_000n * U },
      { hash: h(11), marketId: 2, side: 0, before: 55_000n * U, after: 55_000n * U - 48n * U },
      { hash: h(12), marketId: 2, side: 1, before: 55_000n * U, after: 55_000n * U },
    ],
  };
}

test("a buy with a mint: Aqua pulled exactly Q2 in tUSDC, the side token only passed through, one book moved", () => {
  const s = summarizeFill(buyWithMint(), USDC);
  assert.equal(s.pulledUsdc, 1_000n * U); // = Q2
  assert.equal(s.pushedUsdc, 952n * U); // the taker's payment
  assert.equal(s.walletChange, -48n * U); // paid for the pair, paid for the Long: the Short sits in custody
  assert.equal(s.custodyShort, 1_000n * U);
  assert.equal(s.custodyLong, 0n);
  assert.deepEqual(s.changed.map((b) => b.hash), [h(11)]);
  assert.equal(s.unchanged.length, 2);
});

test("the token addresses are compared without case", () => {
  const f = buyWithMint();
  const s = summarizeFill(f, USDC.toUpperCase().replace("0X", "0x") as Address);
  assert.equal(s.pulledUsdc, 1_000n * U);
});
