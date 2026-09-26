import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address, Hex } from "viem";
import { type FillView, summarizeFill } from "../src/core/makerView.ts";

const USDC = "0x00000000000000000000000000000000000000a1" as Address;
const LONG = "0x00000000000000000000000000000000000000b2" as Address;
const h = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const U = 10n ** 6n;
const base = { hash: h(1), block: 100n, timestamp: 1_789_700_000n, orderHash: h(11), marketId: 1, taker: "0x00000000000000000000000000000000000000c3" as Address };

test("a buy with a mint: Aqua pulled exactly Q2 in tUSDC, the side token only passed through, one book moved", () => {
  const f: FillView = {
    ...base,
    dir: 1,
    qty: 1_000n * U,
    q1: 0n,
    q2: 1_000n * U,
    amountIn: 952n * U,
    amountOut: 1_000n * U,
    moves: [
      { kind: "pull", orderHash: h(11), token: USDC, amount: 1_000n * U }, // the mint
      { kind: "push", orderHash: h(11), token: LONG, amount: 1_000n * U }, // Long into the book...
      { kind: "pull", orderHash: h(11), token: LONG, amount: 1_000n * U }, // ...and out to the taker
      { kind: "push", orderHash: h(11), token: USDC, amount: 952n * U }, // the taker's payment
    ],
  };
  const s = summarizeFill(f, USDC);
  assert.equal(s.pulledUsdc, 1_000n * U); // = Q2
  assert.equal(s.pushedUsdc, 952n * U); // the taker's payment
  assert.equal(s.walletChange, -48n * U); // paid for the pair, paid for the Long: the Short sits in custody
  assert.deepEqual([...s.bookDelta], [[h(11), -48n * U]]);
  assert.equal(s.custodyShort, 1_000n * U);
  assert.equal(s.custodyLong, 0n);
});

test("a sell burned against custody: the maker pays the taker from its wallet and gets the pair's tUSDC back", () => {
  const f: FillView = {
    ...base,
    dir: 2, // sell Long
    qty: 400n * U,
    q1: 400n * U, // paired with custody Short and burned
    q2: 0n,
    amountIn: 400n * U,
    amountOut: 358n * U,
    moves: [
      { kind: "push", orderHash: h(11), token: LONG, amount: 400n * U }, // the taker's Long in
      { kind: "pull", orderHash: h(11), token: LONG, amount: 400n * U }, // to the router, burned
      { kind: "push", orderHash: h(11), token: USDC, amount: 400n * U }, // the burned pair's tUSDC back
      { kind: "pull", orderHash: h(11), token: USDC, amount: 358n * U }, // paid to the taker
    ],
  };
  const s = summarizeFill(f, USDC);
  assert.equal(s.walletChange, 42n * U);
  assert.equal(s.custodyShort, -400n * U);
  assert.equal(s.custodyLong, 0n);
});

test("token addresses and order hashes are compared without case", () => {
  const f: FillView = { ...base, dir: 3, qty: 1n, q1: 0n, q2: 1n, amountIn: 1n, amountOut: 1n, moves: [{ kind: "pull", orderHash: h(11), token: USDC, amount: 1n }] };
  const s = summarizeFill(f, USDC.toUpperCase().replace("0X", "0x") as Address);
  assert.equal(s.pulledUsdc, 1n);
  assert.equal(s.custodyLong, 1n); // a Short buy keeps the pair's Long
});
