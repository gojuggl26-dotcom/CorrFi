// S08 end-to-end run on a live deployment (M §1.8 DoD1-2, §8.2.2 step 7, §8.4). RPC_URL, DEPLOYMENT, TAKER_KEY,
// MAKER_ADDRESS; optional E2E_OUT (JSON lines of evidence, default deployments/<chain>-e2e.jsonl).
//   node bin/e2e.ts trades <market> [generation]   vault mint / burn, then the 4 directions through every inventory
//                                                  path (mint, paired burn, served from custody, bought into custody),
//                                                  exact-in and exact-out; each fill is checked against the quote
//                                                  breakdown evaluated on the state before the fill and at its block
//                                                  time (quote = swap, M-DoD2), and the tolerance limit is shown to
//                                                  stop a fill that is worse than quoted
//   node bin/e2e.ts status <market> [generation]   the breakdown reason now (e.g. STALE while the reporter is stopped)
//   node bin/e2e.ts redeem <market>                after finalize: redeem all of the taker's Long / Short
import { appendFileSync } from "node:fs";
import { type Address, type Hex, parseUnits } from "viem";
import { erc20Abi, hubAbi, lensAbi, routerAbi, testUsdcAbi, vaultAbi } from "../src/abi.ts";
import { REASONS, registeredOrders, trade } from "../src/taker.ts";
import { env, setup } from "./common.ts";

const { pc, dep, wallet } = setup();
const taker = wallet("TAKER_KEY");
const me = taker.account.address;
const maker = env("MAKER_ADDRESS") as Address;
const out = process.env.E2E_OUT ?? env("DEPLOYMENT").replace(/\.json$/, "-e2e.jsonl");
const [cmd, marketArg, genArg] = process.argv.slice(2);
const market = Number(marketArg ?? 0);
const generation = Number(genArg ?? 1);
const U = (s: string) => parseUnits(s, 6);
const DELTA_TOL = 2n * 10n ** 15n; // 0.002 USDC per token (M §5.8.3 default)

const record = (e: Record<string, unknown>) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), chainId: dep.chainId, market, ...e }, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(line);
  appendFileSync(out, line + "\n");
};

async function send(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[]): Promise<Hex> {
  const { request } = await pc.simulateContract({ address, abi, functionName, args, account: taker.account } as never);
  const hash = await taker.writeContract(request as never);
  const r = await pc.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted in ${hash}`);
  return hash;
}

async function books() {
  const regs = (await registeredOrders(pc, dep, maker)).filter((r) => r.marketId === market && r.generation === generation);
  const long = regs.find((r) => r.side === 0);
  const short = regs.find((r) => r.side === 1);
  if (!long || !short) throw new Error(`no registered books for market ${market} generation ${generation}`);
  return { long: long.order, short: short.order };
}

const vaultOf = () => pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "marketVault", args: [market] });

async function custody(vault: Address) {
  const [nl, ns] = await Promise.all([
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "depositLong", args: [maker] }),
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "depositShort", args: [maker] }),
  ]);
  return { nl, ns, q: nl - ns };
}

async function trades() {
  const { long, short } = await books();
  const vault = await vaultOf();
  const [lt, st] = await Promise.all([
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "longToken" }),
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "shortToken" }),
  ]);
  // funding and approvals (test token, DEC-13)
  const bal = await pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  if (bal < U("5000")) record({ step: "mint tUSDC", tx: await send(dep.usdc, testUsdcAbi, "mint", [me, U("10000")]) });
  for (const [token, spender] of [[dep.usdc, dep.router], [dep.usdc, vault], [lt, dep.router], [st, dep.router]] as const) {
    const a = await pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [me, spender] });
    if (a < U("1000000")) await send(token, erc20Abi, "approve", [spender, 2n ** 255n]);
  }
  // vault: direct mint and burn (M §5.5)
  record({ step: "vault mint 500", tx: await send(vault, vaultAbi, "mint", [U("500")]) });
  record({ step: "vault burn 200", tx: await send(vault, vaultAbi, "burn", [U("200")]) });

  // [label, side (0 Long / 1 Short), isBuy, exactIn, amount, expected inventory path]
  const plan: [string, number, boolean, boolean, string, string][] = [
    ["D1 exact-out 100 Long", 0, true, false, "100", "mint (no custody)"],
    ["D2 exact-in 40 Long", 0, false, true, "40", "paired burn with Short custody"],
    ["D3 exact-out 50 Short", 1, true, false, "50", "served from Short custody"],
    ["D4 exact-in 30 Short", 1, false, true, "30", "bought into Short custody"],
    ["D2 exact-in 100 Long", 0, false, true, "100", "paired burn, then Long bought into custody"],
    ["D4 exact-in 30 Short", 1, false, true, "30", "paired burn with Long custody"],
    ["D1 exact-in 20 USDC", 0, true, true, "20", "served from Long custody"],
    ["D3 exact-in 10 USDC", 1, true, true, "10", "mint (no Short custody)"],
    ["D2 exact-out 5 USDC", 0, false, false, "5", "sell Long for an exact USDC amount"],
    ["D4 exact-out 2 USDC", 1, false, false, "2", "sell Short for an exact USDC amount"],
  ];
  let ok = 0;
  for (const [label, side, isBuy, exactIn, amt, path] of plan) {
    const o = side === 0 ? long : short;
    const amount = U(amt);
    const before = await custody(vault);
    const b = await pc.readContract({ address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [o, market, side, isBuy, exactIn, amount, DELTA_TOL] });
    if (b.reason !== 0) {
      record({ step: label, refused: REASONS[b.reason]?.code ?? b.reason });
      continue;
    }
    // the tolerance protects the taker: a limit one unit tighter than the quote is refused by the entry
    const tight = exactIn ? b.amountOut + 1n : b.amountIn - 1n; // min out + 1 / max in - 1
    let tightRefused = false;
    try {
      await pc.simulateContract({ address: dep.router, abi: routerAbi, functionName: "trade", args: [o, market, side, isBuy, exactIn, amount, tight, 0], account: taker.account });
    } catch {
      tightRefused = true;
    }
    const fill = await trade(pc, taker, dep, o, market, side, isBuy, exactIn, amount, b.limit);
    // the quote on the state before the fill, at the fill's block time (same evaluation time: PROP-02)
    const block = await pc.getBlock({ blockNumber: fill.block });
    const same = await pc.readContract({
      address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [o, market, side, isBuy, exactIn, amount, DELTA_TOL],
      blockNumber: fill.block - 1n, blockOverrides: { time: block.timestamp, number: fill.block },
    });
    const after = await custody(vault);
    const qty = isBuy ? fill.amountOut : fill.amountIn;
    const match = same.amountIn === fill.amountIn && same.amountOut === fill.amountOut && same.q1 === fill.q1 && same.q2 === fill.q2;
    const dq = after.q - before.q;
    const a2 = (after.nl === 0n || after.ns === 0n) && dq === ((side === 0) === isBuy ? -qty : qty);
    if (match && a2 && tightRefused) ok += 1;
    record({
      step: label, path, tx: fill.hash, block: fill.block, amountIn: fill.amountIn, amountOut: fill.amountOut, q1: fill.q1, q2: fill.q2,
      pFair: fill.pFair, h: fill.h, hmin: fill.hmin, quoteThen: [b.amountIn, b.amountOut], quoteAtFillTime: [same.amountIn, same.amountOut],
      quoteEqualsSwap: match, tightLimitRefused: tightRefused, custodyBefore: before, custodyAfter: after, a2,
    });
  }
  record({ step: "summary", fills: plan.length, passed: ok });
  if (ok !== plan.length) process.exitCode = 1;
}

async function status() {
  const { long } = await books();
  const b = await pc.readContract({ address: dep.lens, abi: lensAbi, functionName: "breakdown", args: [long, market, 0, true, false, U("1"), DELTA_TOL] });
  const blk = await pc.getBlock({ blockTag: "latest" });
  record({ step: "status", block: blk.number, time: blk.timestamp, reason: REASONS[b.reason]?.code ?? b.reason, k: b.k, tStop: b.tStop, hO: b.hO });
}

async function redeem() {
  const vault = await vaultOf();
  const [lt, st] = await Promise.all([
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "longToken" }),
    pc.readContract({ address: vault, abi: vaultAbi, functionName: "shortToken" }),
  ]);
  const [ql, qs] = await Promise.all([
    pc.readContract({ address: lt, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
    pc.readContract({ address: st, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
  ]);
  const before = await pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  const tx = await send(vault, vaultAbi, "redeem", [ql, qs]);
  const after = await pc.readContract({ address: dep.usdc, abi: erc20Abi, functionName: "balanceOf", args: [me] });
  const longT = await pc.readContract({ address: vault, abi: vaultAbi, functionName: "longT" });
  record({ step: "redeem", tx, long: ql, short: qs, longT, payout: after - before });
}

if (cmd === "trades") await trades();
else if (cmd === "status") await status();
else if (cmd === "redeem") await redeem();
else {
  console.error("usage: e2e.ts trades|status|redeem <market> [generation]");
  process.exitCode = 2;
}
