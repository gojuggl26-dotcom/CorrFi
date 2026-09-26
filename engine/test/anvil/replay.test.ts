// The 7D replay (R §4-§7) end to end, without pacing: Setup is deterministic (the snapshot hash in the manifest),
// the replay ends in the reference state root with the reference Long_T and payouts (V8), and the independent Python
// Verifier passes V1-V8.
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { keccak256 } from "viem";
import { runReplay } from "../../replay/driver.ts";
import { runSetup } from "../../replay/setup.ts";
import { ROOT } from "./harness.ts";

const week = join(ROOT, "replay", "week-2025-10-13");
const manifest = JSON.parse(readFileSync(join(week, "manifest.json"), "utf8"));
const base = 20_000 + Math.floor(Math.random() * 20_000);

test("Setup reproduces the saved snapshot", async () => {
  const { chain, state } = await runSetup(week, base);
  chain.stop();
  assert.equal(keccak256(state), manifest.chain.snapshot.keccak256);
});

test("the replay ends in the reference state and the Verifier passes V1-V8", async () => {
  const ports = { port: base + 1, wsPort: base + 2, enginePort: base + 3, verifyPort: base + 4 };
  const py = process.platform === "win32" ? "python" : "python3";
  const verifier = spawn(py, [join(ROOT, "verifier", "replay_verify.py"), week, "--rpc", `http://127.0.0.1:${ports.port}`, "--port", String(ports.verifyPort), "--out", join(ROOT, "replay", "week-2025-10-13", "runs", "verify-ci.json")], {
    env: { ...process.env, PYTHONIOENCODING: "utf-8", VERIFY_LINGER: "2" },
    stdio: "ignore",
  });
  const exit = new Promise<number>((r) => verifier.on("exit", (c) => r(c ?? 1)));
  const r = await runReplay({ weekDir: week, barsFile: "bars.json", reference: false, pacing: false, waitStart: false, ...ports });
  assert.equal(r.stateRoot, manifest.reference.stateRoot, "V8 state root");
  assert.equal(r.longT, manifest.reference.longT);
  assert.deepEqual(r.payouts, manifest.reference.payouts);
  assert.equal(r.trades.filter((t) => (t as { op: string }).op === "trade").every((t) => (t as { quoteEqualsFill: boolean }).quoteEqualsFill), true);
  const v = r.verification as { pass: boolean; items: Record<string, { pass: boolean }> };
  assert.equal(v?.pass, true, JSON.stringify(v?.items));
  assert.equal(await exit, 0);
});
