// Writes the UI's config.json from a deployment (the UI serves it from its public directory).
//   node bin/ui-config.ts <deployment.json> <rpcUrl> <defaultMaker> <out.json> [--multicall3 0x...] [--dev-account 0x...]
// --dev-account only for a local Anvil whose accounts are unlocked; testnet users connect their own wallet.
import { readFileSync, writeFileSync } from "node:fs";

const [depPath, rpcUrl, defaultMaker, out] = process.argv.slice(2);
if (!out) throw new Error("usage: ui-config.ts <deployment.json> <rpcUrl> <defaultMaker> <out.json> [--multicall3 addr] [--dev-account addr]");
const opt = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const deployment = JSON.parse(readFileSync(depPath, "utf8"));
const cfg = { chainId: Number(deployment.chainId), rpcUrl, deployment, defaultMaker, multicall3: opt("multicall3"), devAccount: opt("dev-account") };
writeFileSync(out, JSON.stringify(cfg, null, 2) + "\n");
console.log(`${out}: chain ${cfg.chainId}, maker ${defaultMaker}${cfg.multicall3 ? ", multicall3" : ""}`);
