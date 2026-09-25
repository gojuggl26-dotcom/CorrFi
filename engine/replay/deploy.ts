// Deploys the protocol on the replay chain from the Foundry artifacts, in the order and with the constructor argument
// shapes of contracts/script/Deploy.s.sol (M §8.2.2), so that the creation bytecode is the pinned one (V7, R D2).
// The external libraries go through the standard CREATE2 factory with salt 0, as forge does on Base Sepolia.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  type Abi,
  type Account,
  type Address,
  concatHex,
  encodeDeployData,
  getCreate2Address,
  type Hex,
  zeroHash,
} from "viem";
import type { ReplayChain } from "./chain.ts";

const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));
export const CREATE2_FACTORY: Address = "0x4e59b44847b379578588920ca78fbf26c0b4956c";

type Ref = { start: number; length: number };
interface Artifact {
  abi: Abi;
  bytecode: { object: Hex; linkReferences: Record<string, Record<string, Ref[]>> };
}

export function artifact(file: string, name: string): Artifact {
  return JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
}

export function linked(a: Artifact, libs: Record<string, Address>): Hex {
  let hex = a.bytecode.object.slice(2);
  for (const byName of Object.values(a.bytecode.linkReferences)) {
    for (const [lib, refs] of Object.entries(byName)) {
      for (const r of refs) hex = hex.slice(0, 2 * r.start) + libs[lib].slice(2).toLowerCase() + hex.slice(2 * (r.start + r.length));
    }
  }
  return `0x${hex}`;
}

export interface Protocol {
  usdc: Address;
  aqua: Address;
  hub: Address;
  router: Address;
  lens: Address;
  weth: Address;
  libraries: Record<string, Address>;
  creationTxs: { name: string; hash: Hex; input: Hex; type: "CREATE" | "CREATE2" }[];
}

export interface ProtocolParams {
  hFloor: bigint;
  cO: bigint;
  grace: bigint;
  hUMax: bigint;
  u0: bigint;
  uMax: bigint;
}

/** M §8.1 / Deploy.s.sol defaults (c_O = 1.5 from S06, DEC-19). */
export const DEFAULT_PARAMS: ProtocolParams = { hFloor: 5n * 10n ** 15n, cO: 15n * 10n ** 17n, grace: 60n, hUMax: 2n * 10n ** 16n, u0: 6n * 10n ** 17n, uMax: 9n * 10n ** 17n };
const WETH: Address = "0x4200000000000000000000000000000000000006";

export async function deployProtocol(
  c: ReplayChain,
  owner: Account,
  roles: { reporter: Address; engine: Address; treasury: Address },
  usdcName: string,
  usdcSymbol: string,
  prm: ProtocolParams = DEFAULT_PARAMS,
): Promise<Protocol> {
  const w = c.wallet(owner);
  const txs: Protocol["creationTxs"] = [];
  const create = async (name: string, data: Hex): Promise<Address> => {
    const hash = await w.sendTransaction({ account: owner, chain: w.chain, data });
    const r = await c.pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed`);
    txs.push({ name, hash, input: data, type: "CREATE" });
    return r.contractAddress;
  };
  // libraries (CREATE2, salt 0): the addresses depend on the code only
  const libraries: Record<string, Address> = {};
  for (const [file, name] of [["CorrFiEngine.sol", "CorrFiEngine"], ["CorrFiOrders.sol", "CorrFiOrders"]] as const) {
    const init = linked(artifact(file, name), libraries);
    const data = concatHex([zeroHash, init]);
    const hash = await w.sendTransaction({ account: owner, chain: w.chain, to: CREATE2_FACTORY, data });
    const r = await c.pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`library ${name} failed`);
    libraries[name] = getCreate2Address({ from: CREATE2_FACTORY, salt: zeroHash, bytecode: init });
    txs.push({ name, hash, input: data, type: "CREATE2" });
  }
  const dep = (file: string, name: string, args: readonly unknown[]) => {
    const a = artifact(file, name);
    return encodeDeployData({ abi: a.abi, bytecode: linked(a, libraries), args } as never);
  };
  const usdc = await create("TestUSDC", dep("TestUSDC.sol", "TestUSDC", [usdcName, usdcSymbol]));
  const aqua = await create("Aqua", dep("Aqua.sol", "Aqua", []));
  const hub = await create("CorrFiHub", dep("CorrFiHub.sol", "CorrFiHub", [owner.address, usdc, prm.hFloor, roles.reporter, roles.engine, roles.treasury]));
  const router = await create("CorrFiRouter", dep("CorrFiRouter.sol", "CorrFiRouter", [aqua, WETH, owner.address, hub, { cO: prm.cO, grace: prm.grace, hUMax: prm.hUMax, u0: prm.u0, uMax: prm.uMax }]));
  const hubAbi = artifact("CorrFiHub.sol", "CorrFiHub").abi;
  const { request } = await c.pc.simulateContract({ address: hub, abi: hubAbi, functionName: "setRouter", args: [router], account: owner } as never);
  await c.pc.waitForTransactionReceipt({ hash: await w.writeContract(request as never) });
  const lens = await create("CorrFiLens", dep("CorrFiLens.sol", "CorrFiLens", [router]));
  return { usdc, aqua, hub, router, lens, weth: WETH, libraries, creationTxs: txs };
}
