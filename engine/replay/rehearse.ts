// S11 rehearsal (R §10.1, §10.3): the demo run unattended N times — START pressed automatically, the Verifier as its
// own process — and the preflight's deliberate failures (AC7). Writes <week>/runs/rehearsal.json.
//   node replay/rehearse.ts <week dir> [--runs 10] [--skip-ac7]
// AC1 START -> verification shown within 120 s (target median 107 +- 3 s); AC2 V1-V8 pass every time; AC3 the final
// state root = the reference; AC5 step p99 <= 300 ms; AC6 every gasUsed < Base Sepolia's block gas limit; AC7 a
// replaced state file and a tampered bars.json stop the demo at the preflight. AC4 (OS clock moved by a day) needs a
// separate machine (MI-09) and is not run here.
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import { account, connect, startAnvil } from "./chain.ts";
import { runReplay } from "./driver.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const week = process.argv[2];
if (!week) throw new Error("usage: rehearse.ts <week dir> [--runs 10] [--skip-ac7]");
const ri = process.argv.indexOf("--runs");
const runs = ri > 0 ? Number(process.argv[ri + 1]) : 10;
const manifest = JSON.parse(readFileSync(join(week, "manifest.json"), "utf8"));
const BASE_SEPOLIA_GAS_LIMIT = BigInt(manifest.chain.baseSepoliaBlockGasLimit?.value ?? "1200000000");
const PORTS = { port: 8545, wsPort: 8787, enginePort: 8788, verifyPort: 8789 };

function verifier(dir: string, bars: string): { proc: ChildProcess; done: Promise<number> } {
  const proc = spawn("python", [join(ROOT, "verifier", "replay_verify.py"), dir, "--bars", bars, "--rpc", `http://127.0.0.1:${PORTS.port}`, "--port", String(PORTS.verifyPort), "--out", join(week, "runs", `verify-last.json`)], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8", VERIFY_LINGER: "8" },
    stdio: "ignore",
  });
  return { proc, done: new Promise((r) => proc.on("exit", (c) => r(c ?? 1))) };
}

const results: Record<string, unknown>[] = [];
mkdirSync(join(week, "runs"), { recursive: true });
for (let i = 1; i <= runs; ++i) {
  const v = verifier(week, "bars.json");
  const r = await runReplay({ weekDir: week, barsFile: "bars.json", reference: false, pacing: true, waitStart: false, ...PORTS });
  const code = await v.done;
  const ver = r.verification as { pass?: boolean } | null;
  const row = {
    run: i, verdictMs: r.timing.verdictMs, totalMs: r.timing.totalMs, stepP99Ms: r.timing.stepP99Ms,
    verifierPass: !!ver?.pass && code === 0, stateRoot: r.stateRoot, sameRoot: r.stateRoot === manifest.reference.stateRoot,
    maxGasUsed: r.gas.maxGasUsed,
  };
  results.push(row);
  console.log(JSON.stringify(row));
}

// AC7: the preflight stops a replaced state and tampered data
const ac7: Record<string, unknown> = {};
if (!process.argv.includes("--skip-ac7")) {
  const tryRun = async (dir: string, label: string) => {
    try {
      await runReplay({ weekDir: dir, barsFile: "bars.json", reference: false, pacing: false, waitStart: false, ...PORTS, verifyPort: undefined });
      ac7[label] = { stopped: false };
    } catch (e) {
      ac7[label] = { stopped: /preflight failed/.test((e as Error).message), error: (e as Error).message.slice(0, 300) };
    }
  };
  // (a) bars.json with one price changed by 1 wei (the manifest keeps the original hash)
  const a = mkdtempSync(join(tmpdir(), "corrfi-ac7a-"));
  cpSync(week, a, { recursive: true });
  const bars = JSON.parse(readFileSync(join(a, "bars.json"), "utf8"));
  bars.points[1000].pA = (BigInt(bars.points[1000].pA) + 1n).toString();
  writeFileSync(join(a, "bars.json"), JSON.stringify(bars, null, 1) + "\n");
  await tryRun(a, "tamperedBars");
  // (b) a state file from a chain that took one more transaction
  const b = mkdtempSync(join(tmpdir(), "corrfi-ac7b-"));
  cpSync(week, b, { recursive: true });
  const calib = JSON.parse(readFileSync(join(week, "calib.json"), "utf8"));
  const { proc, rpc } = await startAnvil(PORTS.port, calib.obsStart - 3600);
  const c = connect(rpc, proc);
  await c.call("anvil_loadState", [readFileSync(join(week, "state.hex"), "utf8").trim()]);
  const latest = await c.pc.getBlock({ blockTag: "latest" });
  c.setClock(Number(latest.timestamp) + 1);
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet(account("A")).sendTransaction({ to: account("B").address, value: 1n, chain: c.wallet(account("A")).chain, account: account("A") }) });
  writeFileSync(join(b, "state.hex"), (await c.call("anvil_dumpState")) as Hex);
  c.stop();
  await tryRun(b, "replacedState");
  rmSync(a, { recursive: true, force: true });
  rmSync(b, { recursive: true, force: true });
}

const verdicts = results.map((r) => r.verdictMs as number).sort((x, y) => x - y);
const totals = results.map((r) => r.totalMs as number).sort((x, y) => x - y);
const median = (xs: number[]) => (xs.length ? xs[Math.floor(xs.length / 2)] : NaN);
const summary = {
  week: manifest.week,
  runs: results.length,
  AC1: { pass: totals.every((t) => t <= 120_000) && Math.abs(median(totals) - 107_000) <= 3_000, medianTotalMs: median(totals), maxTotalMs: totals[totals.length - 1], medianVerdictMs: median(verdicts), note: "totalMs = START to the end of the verification display (R §5.1: 106.6 s); verdictMs = when V1-V8 appear" },
  AC2: { pass: results.every((r) => r.verifierPass) },
  AC3: { pass: results.every((r) => r.sameRoot), reference: manifest.reference.stateRoot },
  AC4: { pass: null, note: "not run: needs a machine whose clock can be moved by a day (MI-09); the local clock is never changed" },
  AC5: { pass: results.every((r) => (r.stepP99Ms as number) <= 300), maxStepP99Ms: Math.max(...results.map((r) => r.stepP99Ms as number)) },
  AC6: { pass: results.every((r) => BigInt(r.maxGasUsed as string) < BASE_SEPOLIA_GAS_LIMIT), maxGasUsed: results.map((r) => r.maxGasUsed)[0], baseSepoliaBlockGasLimit: BASE_SEPOLIA_GAS_LIMIT.toString() },
  AC7: { pass: Object.keys(ac7).length === 2 && Object.values(ac7).every((x) => (x as { stopped: boolean }).stopped), ...ac7 },
  results,
};
writeFileSync(join(week, "runs", "rehearsal.json"), JSON.stringify(summary, null, 1) + "\n");
console.log(JSON.stringify({ ...summary, results: undefined }, null, 1));
