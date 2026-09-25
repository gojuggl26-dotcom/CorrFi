// Pins the protocol build (S07; R §3.5 "コントラクト" row, R V7 / D2, M §8.2.1) in contracts/build-manifest.json:
// the compiler and its settings, the pinned dependency commits, the keccak256 of every compiled source, and per
// contract the creation bytecode hash and the runtime bytecode hash with the immutables masked.
//
// The router and the lens call the external libraries CorrFiEngine / CorrFiOrders (DEC-12). `forge script` deploys
// them through the standard CREATE2 factory with salt 0, so their addresses depend only on their code: the linked
// creation bytecode of the router and the lens is then the same on every chain (Anvil and Base Sepolia), and V7
// compares the deployment transactions' input against `creationLinked` (constructor arguments follow it).
//
//   node scripts/build_manifest.ts [--check]      (after `forge build` in contracts/)
//   node scripts/build_manifest.ts --broadcast <forge run.json>      V7 creation half on a deployment broadcast
//   RPC_URL=... node scripts/build_manifest.ts --deployed <deployments/x.json>   V7 runtime half on the chain
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Hex, getCreate2Address, keccak256 } from "viem";

const root = (p: string) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const CREATE2_FACTORY = "0x4e59b44847b379578588920ca78fbf26c0b4956c"; // forge's default CREATE2 deployer
const SALT = `0x${"00".repeat(32)}` as Hex;

// protocol contracts (deployed on their own, or created by the hub: vault / token implementations) and the
// dependencies deployed from source (Aqua, the test USDC of DEC-13)
const CONTRACTS: [string, string][] = [
  ["src/lib/CorrFiEngine.sol", "CorrFiEngine"],
  ["src/lib/CorrFiOrders.sol", "CorrFiOrders"],
  ["src/CorrFiHub.sol", "CorrFiHub"],
  ["src/CorrFiRouter.sol", "CorrFiRouter"],
  ["src/CorrFiLens.sol", "CorrFiLens"],
  ["src/CorrFiVault.sol", "CorrFiVault"],
  ["src/CorrFiToken.sol", "CorrFiToken"],
  ["src/TestUSDC.sol", "TestUSDC"],
  ["lib/aqua/src/Aqua.sol", "Aqua"],
];
const LIBRARIES = ["CorrFiEngine", "CorrFiOrders"]; // in link order

type Ref = { start: number; length: number };
type Code = { object: string; linkReferences: Record<string, Record<string, Ref[]>>; immutableReferences?: Record<string, Ref[]> };
type Artifact = { bytecode: Code; deployedBytecode: Code; metadata: { compiler: { version: string }; settings: Record<string, unknown>; sources: Record<string, { keccak256: string }> } };

const artifact = (src: string, name: string): Artifact => {
  const file = src.split("/").pop();
  return JSON.parse(readFileSync(root(`contracts/out/${file}/${name}.json`), "utf8"));
};

/** Replace the link placeholders (and, for runtime code, the immutables) in a hex object. */
function patch(code: Code, libs: Record<string, string>, maskImmutables: boolean): Hex {
  let hex = code.object.slice(2);
  for (const [, byName] of Object.entries(code.linkReferences)) {
    for (const [lib, refs] of Object.entries(byName)) {
      const addr = libs[lib];
      if (!addr) throw new Error(`no address for linked library ${lib}`);
      for (const r of refs) hex = hex.slice(0, 2 * r.start) + addr.slice(2).toLowerCase() + hex.slice(2 * (r.start + r.length));
    }
  }
  if (maskImmutables) {
    for (const refs of Object.values(code.immutableReferences ?? {})) {
      for (const r of refs) hex = hex.slice(0, 2 * r.start) + "00".repeat(r.length) + hex.slice(2 * (r.start + r.length));
    }
  }
  if (!/^[0-9a-f]*$/.test(hex)) throw new Error("unlinked placeholder left in the bytecode");
  return `0x${hex}`;
}

function build(): Record<string, unknown> {
  const arts = Object.fromEntries(CONTRACTS.map(([s, n]) => [n, artifact(s, n)]));
  // the libraries' CREATE2 addresses (linking a library's own references first)
  const libs: Record<string, string> = {};
  for (const l of LIBRARIES) {
    libs[l] = getCreate2Address({ from: CREATE2_FACTORY, salt: SALT, bytecode: patch(arts[l].bytecode, libs, false) });
  }
  // one compiler configuration for every contract
  const settingsOf = (a: Artifact) => {
    const { compilationTarget: _t, libraries: _l, ...rest } = a.metadata.settings;
    return rest;
  };
  const settings = settingsOf(arts.CorrFiHub);
  const compiler = arts.CorrFiHub.metadata.compiler.version;
  const sources: Record<string, string> = {};
  const contracts: Record<string, unknown> = {};
  for (const [src, n] of CONTRACTS) {
    const a = arts[n];
    if (a.metadata.compiler.version !== compiler || JSON.stringify(settingsOf(a)) !== JSON.stringify(settings)) {
      throw new Error(`${n} was compiled with other settings`);
    }
    for (const [p, s] of Object.entries(a.metadata.sources)) sources[p] = s.keccak256;
    const linked = patch(a.bytecode, libs, false);
    const links = Object.values(a.bytecode.linkReferences).flatMap((b) => Object.keys(b));
    contracts[n] = {
      source: src,
      creationLinked: keccak256(linked),
      creationSize: (linked.length - 2) / 2,
      ...(links.length ? { links: Object.fromEntries(links.map((l) => [l, libs[l]])) } : {}),
      runtimeMasked: keccak256(patch(a.deployedBytecode, libs, true)),
      runtimeSize: (a.deployedBytecode.object.length - 2) / 2,
    };
  }
  const submodules = Object.fromEntries(
    execFileSync("git", ["-C", root(""), "submodule", "status"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().replace(/^[-+U]/, "").split(/\s+/))
      .map(([commit, path]) => [path, commit]),
  );
  return {
    note: "generated by engine/scripts/build_manifest.ts after `forge build`; CI rebuilds and compares (--check)",
    compiler,
    settings,
    foundry: "v1.8.3",
    submodules,
    libraryDeployment: { factory: CREATE2_FACTORY, salt: SALT, addresses: libs },
    contracts,
    sources: Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/** V7 on a forge broadcast: every deployment's input starts with the pinned creation bytecode (then the
 *  constructor arguments); CREATE2 library deployments carry the salt first. */
function checkBroadcast(path: string, manifest: { contracts: Record<string, { creationLinked: Hex; creationSize: number }> }) {
  type Tx = { contractName: string; transactionType: string; transaction: { input: Hex } };
  const txs: Tx[] = JSON.parse(readFileSync(path, "utf8")).transactions;
  let bad = 0;
  let seen = 0;
  for (const t of txs) {
    const c = manifest.contracts[t.contractName];
    if (!c || !t.transactionType.startsWith("CREATE")) continue;
    const body = t.transactionType === "CREATE2" ? `0x${t.transaction.input.slice(66)}` : t.transaction.input;
    const ok = keccak256(`0x${body.slice(2, 2 + 2 * c.creationSize)}`) === c.creationLinked;
    console.log(`${ok ? "ok  " : "FAIL"} ${t.contractName} (${t.transactionType})`);
    bad += ok ? 0 : 1;
    seen += 1;
  }
  if (bad || !seen) process.exitCode = 1;
}

/** V7 runtime half on a live chain (RPC_URL): the deployed code with the immutables masked (positions from the
 *  compiler output) has the pinned runtime hash. The vault / token implementations are read from the hub. */
async function checkDeployed(depPath: string, manifest: { contracts: Record<string, { runtimeMasked: Hex }>; libraryDeployment: { addresses: Record<string, string> } }) {
  const { createPublicClient, http, parseAbi } = await import("viem");
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("RPC_URL is required");
  const pc = createPublicClient({ transport: http(rpc) });
  const d = JSON.parse(readFileSync(depPath, "utf8"));
  const hubAbi = parseAbi(["function vaultImplementation() view returns (address)", "function tokenImplementation() view returns (address)"]);
  const at: Record<string, string> = {
    CorrFiHub: d.hub, CorrFiRouter: d.router, CorrFiLens: d.lens, Aqua: d.aqua, TestUSDC: d.usdc,
    CorrFiVault: await pc.readContract({ address: d.hub, abi: hubAbi, functionName: "vaultImplementation" }),
    CorrFiToken: await pc.readContract({ address: d.hub, abi: hubAbi, functionName: "tokenImplementation" }),
    ...manifest.libraryDeployment.addresses,
  };
  let bad = 0;
  for (const [src, n] of CONTRACTS) {
    const addr = at[n];
    if (!addr) continue;
    const code = await pc.getCode({ address: addr as Hex });
    if (!code || code === "0x") {
      console.log(`FAIL ${n} ${addr}: no code`);
      bad += 1;
      continue;
    }
    const a = artifact(src, n);
    const masked = patch({ object: code, linkReferences: {}, immutableReferences: a.deployedBytecode.immutableReferences }, {}, true);
    const ok = keccak256(masked) === manifest.contracts[n].runtimeMasked;
    console.log(`${ok ? "ok  " : "FAIL"} ${n} ${addr}`);
    bad += ok ? 0 : 1;
  }
  if (bad) process.exitCode = 1;
}

// exit through process.exitCode: process.exit() with open HTTP handles aborts Node on Windows
const target = root("contracts/build-manifest.json");
const bi = process.argv.indexOf("--broadcast");
const di = process.argv.indexOf("--deployed");
if (bi > 0) {
  checkBroadcast(process.argv[bi + 1], JSON.parse(readFileSync(target, "utf8")));
} else if (di > 0) {
  await checkDeployed(process.argv[di + 1], JSON.parse(readFileSync(target, "utf8")));
} else if (process.argv.includes("--check")) {
  const text = `${JSON.stringify(build(), null, 1)}\n`;
  const cur = readFileSync(target, "utf8");
  if (cur !== text) {
    const a = JSON.parse(cur);
    const b = JSON.parse(text);
    for (const k of Object.keys(b)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) console.error(`differs: ${k}`);
    console.error("contracts/build-manifest.json does not match this build");
    process.exitCode = 1;
  } else {
    console.log("contracts/build-manifest.json matches this build");
  }
} else {
  const text = `${JSON.stringify(build(), null, 1)}\n`;
  writeFileSync(target, text);
  console.log(`contracts/build-manifest.json: ${Object.keys(JSON.parse(text).contracts).length} contracts`);
}
