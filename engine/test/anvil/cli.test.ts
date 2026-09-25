// The operator CLIs against a local Anvil: create-market, maker config / open / topup / monitor / dock, ui-config.
// (The reporter daemon uses the live venue APIs and is exercised through Reporter in reporter.test.ts.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex } from "viem";
import { mockUsdcAbi } from "../../src/abi.ts";
import { type Chain, ROOT, startChain } from "./harness.ts";

const T0 = 1_789_689_600;
let c: Chain;
let dir: string;
let env: Record<string, string>;

const run = (script: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [join(ROOT, "engine", "bin", script), ...args], { env: { ...process.env, ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${script} ${args.join(" ")}\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
};

before(async () => {
  c = await startChain({ genesis: T0 - 3600 });
  await c.setTime(T0 - 240);
  dir = mkdtempSync(join(tmpdir(), "corrfi-cli-"));
  writeFileSync(join(dir, "deployment.json"), JSON.stringify(c.dep));
  const key = (r: Parameters<Chain["account"]>[0]) => bytesToHex(c.account(r).getHdKey().privateKey!);
  env = { RPC_URL: c.rpc, DEPLOYMENT: join(dir, "deployment.json"), OWNER_KEY: key("owner"), ENGINE_KEY: key("engine"), MAKER_KEY: key("maker") };
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ address: c.dep.usdc, abi: mockUsdcAbi, functionName: "mint", args: [c.account("maker").address, 200_000n * 10n ** 6n] }) });
});

after(() => c?.stop());

test("operator and maker CLIs", () => {
  const m = JSON.parse(run("create-market.ts", join(ROOT, "vectors", "calib_7d_20260918.json")));
  assert.equal(m.marketId, 0);
  run("maker.ts", "config");
  const o = JSON.parse(run("maker.ts", "open", "0", "1", "55000", "105000").split("\n").filter((l) => l.startsWith("{") || l.startsWith(" ") || l.startsWith("}")).filter((l) => !l.includes('"component"')).join("\n"));
  assert.match(o.longHash, /^0x[0-9a-f]{64}$/);
  run("maker.ts", "topup", "0", "1", "long", "1000");
  const mon = JSON.parse(run("maker.ts", "monitor"));
  assert.equal(mon.markets[0].orders.length, 2);
  const long = mon.markets[0].orders.find((x: { side: number }) => x.side === 0);
  assert.equal(long.usdcAllocation, String(56_000n * 10n ** 6n));
  assert.deepEqual(mon.warnings, []);
  run("maker.ts", "dock", "0", "1", "short");
  const mon2 = JSON.parse(run("maker.ts", "monitor"));
  assert.ok(mon2.markets[0].orders.find((x: { side: number }) => x.side === 1).docked);
  run("ui-config.ts", join(dir, "deployment.json"), c.rpc, c.account("maker").address, join(dir, "config.json"));
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(cfg.deployment.lens, c.dep.lens);
});
