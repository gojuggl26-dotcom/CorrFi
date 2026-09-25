// R §4.3 Setup: a fresh Anvil (non-fork, chainId 84532, genesis T0 - 3600), the protocol deployed as on Base Sepolia,
// the 7D market created at T0 - 240 from calib.json, the maker's two orders opened and the takers funded; then the
// state is saved. Deterministic: fixed keys, fixed block times (one per transaction), gas price 0.
//   node replay/setup.ts <week dir> [--port 8545]     writes <week>/state.hex, <week>/addresses.json, manifest.chain
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, type Hex, keccak256 } from "viem";
import { erc20Abi, hubAbi, testUsdcAbi, vaultAbi } from "../src/abi.ts";
import type { Deployment } from "../src/chain.ts";
import { createMarket, marketInputFromCalib } from "../src/createMarket.ts";
import { type MakerConfig, MakerOps } from "../src/maker.ts";
import { canonicalHash } from "./canonical.ts";
import { account, anvilArgs, connect, type ReplayChain, startAnvil } from "./chain.ts";
import { deployProtocol, type Protocol } from "./deploy.ts";

export interface Addresses {
  chainId: number;
  protocol: Omit<Protocol, "creationTxs">;
  multicall3: Address;
  market: { id: number; vault: Address; longToken: Address; shortToken: Address; obsStart: number; obsEnd: number };
  orders: { long: unknown; short: unknown; longHash: Hex; shortHash: Hex; generation: number };
  accounts: Record<string, Address>;
  creationTxs: Protocol["creationTxs"];
}

export async function runSetup(weekDir: string, port: number): Promise<{ chain: ReplayChain; addresses: Addresses; state: Hex }> {
  const calibPath = join(weekDir, "calib.json");
  const calib = JSON.parse(readFileSync(calibPath, "utf8"));
  const sched = JSON.parse(readFileSync(join(weekDir, "schedule.json"), "utf8"));
  const t0: number = calib.obsStart;
  const genesis = t0 + sched.chain.genesisOffset;
  const { proc, rpc } = await startAnvil(port, genesis);
  const c = connect(rpc, proc);
  const owner = account("owner");
  const A = { owner: owner.address, reporter: account("reporter").address, engine: account("engine").address, treasury: account("treasury").address, maker: account("maker").address, A: account("A").address, B: account("B").address, C: account("C").address };

  // 1. T0 - 3599: Multicall3 at the standard address (anvil_setCode), then the protocol (R §4.3 steps 1-2)
  const mc = JSON.parse(readFileSync(new URL("./multicall3.json", import.meta.url), "utf8"));
  await c.call("anvil_setCode", [mc.address, mc.code]);
  c.setClock(genesis + 1);
  const p = await deployProtocol(c, owner, { reporter: A.reporter, engine: A.engine, treasury: A.treasury }, "USDC (replay)", "USDC.r");
  const dep: Deployment = { chainId: 84532, usdc: p.usdc, aqua: p.aqua, hub: p.hub, router: p.router, lens: p.lens, weth: p.weth };

  // 3. T0 - 240: the 7D market; obsStart = T0 (the next 5-minute boundary)
  if (c.clock() > t0 + sched.chain.marketCreationOffset) throw new Error("setup ran past T0 - 240");
  c.setClock(t0 + sched.chain.marketCreationOffset);
  const m = await createMarket(c.pc, c.wallet(owner), account("engine"), dep, marketInputFromCalib(calibPath));
  const q = await c.pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "quoteState", args: [m.id] });
  if (Number(q.obsStart) !== t0) throw new Error(`obsStart ${q.obsStart} != T0 ${t0}`);
  const vault = await c.pc.readContract({ address: dep.hub, abi: hubAbi, functionName: "marketVault", args: [m.id] });
  const [longToken, shortToken] = await Promise.all([
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longToken" }),
    c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "shortToken" }),
  ]);

  // 4. funding (the test token's open mint)
  const mint = async (to: Address, amount: bigint) => {
    const { request } = await c.pc.simulateContract({ address: dep.usdc, abi: testUsdcAbi, functionName: "mint", args: [to, amount], account: owner });
    await c.pc.waitForTransactionReceipt({ hash: await c.wallet(owner).writeContract(request) });
  };
  await mint(A.maker, BigInt(sched.funding.maker));
  for (const t of ["A", "B", "C"] as const) await mint(A[t], BigInt(sched.funding[t]));

  // 5. maker: settings, approvals, both orders registered and shipped (M §5.7)
  const ops = new MakerOps(c.pc, c.wallet(account("maker")), dep);
  const cfg = Object.fromEntries(Object.entries(sched.maker.config).map(([k, v]) => [k, typeof v === "boolean" ? v : BigInt(v as string)])) as unknown as MakerConfig;
  await ops.setConfig(cfg);
  const books = await ops.open(m.id, sched.maker.generation, BigInt(sched.maker.allocation), BigInt(sched.maker.usdcApproval));

  // 6. takers: approvals to the router (the entry) and the vault (direct mint / burn)
  for (const t of ["A", "B", "C"] as const) {
    const w = c.wallet(account(t));
    for (const [token, spender] of [[dep.usdc, dep.router], [dep.usdc, vault], [longToken, dep.router], [shortToken, dep.router]] as const) {
      const { request } = await c.pc.simulateContract({ address: token, abi: erc20Abi, functionName: "approve", args: [spender, 2n ** 255n], account: account(t) });
      await c.pc.waitForTransactionReceipt({ hash: await w.writeContract(request) });
    }
  }
  if (c.clock() > t0 - 200) throw new Error("setup ran past T0 - 200");

  // 7. save the state
  const state = (await c.call("anvil_dumpState")) as Hex;
  const addresses: Addresses = {
    chainId: 84532,
    protocol: { usdc: p.usdc, aqua: p.aqua, hub: p.hub, router: p.router, lens: p.lens, weth: p.weth, libraries: p.libraries },
    multicall3: mc.address,
    market: { id: m.id, vault, longToken, shortToken, obsStart: Number(q.obsStart), obsEnd: Number(q.obsEnd) },
    orders: { long: books.long, short: books.short, longHash: books.longHash, shortHash: books.shortHash, generation: sched.maker.generation },
    accounts: A,
    creationTxs: p.creationTxs,
  };
  return { chain: c, addresses, state };
}

const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1);

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}` || process.argv[1]?.endsWith("setup.ts")) {
  const weekDir = process.argv[2];
  if (!weekDir) throw new Error("usage: setup.ts <week dir> [--port 8545]");
  const pi = process.argv.indexOf("--port");
  const port = pi > 0 ? Number(process.argv[pi + 1]) : 8545;
  const { chain, addresses, state } = await runSetup(weekDir, port);
  writeFileSync(join(weekDir, "state.hex"), state);
  writeFileSync(join(weekDir, "addresses.json"), json(addresses) + "\n");
  const manifestPath = join(weekDir, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const calib = JSON.parse(readFileSync(join(weekDir, "calib.json"), "utf8"));
  manifest.chain = {
    ...manifest.chain,
    snapshot: { file: "state.hex", keccak256: keccak256(state), latestBlock: Number(await chain.pc.getBlockNumber()) },
    anvil: { args: anvilArgs(0, calib.obsStart - 3600).slice(2) }, // without --port
    addressesKeccak256: canonicalHash(JSON.parse(json(addresses))),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 1) + "\n");
  console.log(json({ weekDir, snapshot: manifest.chain.snapshot, addresses: addresses.protocol, market: addresses.market, setupGas: chain.gasLog.reduce((s, g) => s + g.gasUsed, 0n) }));
  chain.stop();
}
