// Maker operations (M §5.7, §8.3). RPC_URL, DEPLOYMENT, MAKER_KEY.
//   node bin/maker.ts config [config.json]            set maker settings (default: M §8.1 MVP values)
//   node bin/maker.ts open <market> <gen> <allocationUSDC> <approvalUSDC>
//   node bin/maker.ts dock <market> <gen> [long|short|both]
//   node bin/maker.ts topup <market> <gen> <long|short> <amountUSDC>
//   node bin/maker.ts claim <market>
//   node bin/maker.ts monitor [baselineUSDC]      inventory, U, funding, equity and P&L vs the baseline
import { readFileSync } from "node:fs";
import { parseUnits } from "viem";
import { type MakerConfig, MakerOps, MVP_CONFIG } from "../src/maker.ts";
import { logger, setup } from "./common.ts";

const { pc, dep, wallet } = setup();
const ops = new MakerOps(pc, wallet("MAKER_KEY"), dep, logger("maker"));
const [cmd, ...a] = process.argv.slice(2);
const usdc = (s: string) => parseUnits(s, 6);
const json = (x: unknown) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2);

switch (cmd) {
  case "config": {
    const cfg: MakerConfig = a[0]
      ? Object.fromEntries(Object.entries(JSON.parse(readFileSync(a[0], "utf8"))).map(([k, v]) => [k, typeof v === "boolean" ? v : BigInt(v as string)])) as unknown as MakerConfig
      : MVP_CONFIG;
    await ops.setConfig(cfg);
    break;
  }
  case "open": {
    const r = await ops.open(Number(a[0]), Number(a[1]), usdc(a[2]), usdc(a[3]));
    console.log(json({ longHash: r.longHash, shortHash: r.shortHash }));
    break;
  }
  case "dock":
    await ops.dock(Number(a[0]), Number(a[1]), (a[2] as "long" | "short" | "both") ?? "both");
    break;
  case "topup": {
    const { long, short } = await ops.orders(Number(a[0]), Number(a[1]));
    await ops.topUp(a[2] === "short" ? short : long, usdc(a[3]));
    break;
  }
  case "claim":
    await ops.claim(Number(a[0]));
    break;
  case "monitor":
    console.log(json(await ops.monitor(a[0] ? usdc(a[0]) : undefined)));
    break;
  default:
    console.error("usage: maker.ts config|open|dock|topup|claim|monitor ...");
    process.exitCode = 2;
}
