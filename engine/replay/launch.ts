// Starts the demo (R §10.1 "デモ起動"): the Verifier, the Driver (restores the snapshot, runs the preflight and waits
// for START) and the page server; prints the URL. Ctrl+C stops everything.
//   node replay/launch.ts <week dir> [--bars bars_void.json]
import { type ChildProcess, spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const week = resolve(process.argv[2] ?? join(ROOT, "replay", "week-2025-10-13"));
const bi = process.argv.indexOf("--bars");
const bars = bi > 0 ? process.argv[bi + 1] : "bars.json";
const py = process.platform === "win32" ? "python" : "python3";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

const procs: ChildProcess[] = [];
const run = (name: string, cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) => {
  const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], shell: cmd.endsWith(".cmd") });
  p.stdout?.on("data", (d) => process.stdout.write(`[${name}] ${d}`));
  p.stderr?.on("data", (d) => process.stderr.write(`[${name}] ${d}`));
  p.on("exit", (c) => console.log(`[${name}] exited ${c}`));
  procs.push(p);
};
run("verifier", py, [join(ROOT, "verifier", "replay_verify.py"), week, "--bars", bars, "--timeout", "3600"], ROOT, { PYTHONIOENCODING: "utf-8", VERIFY_LINGER: "3600" });
run("driver", process.execPath, [join(HERE, "driver.ts"), week, "--bars", bars, "--wait-start"], join(ROOT, "engine"));
run("ui", npx, ["vite", "--port", "5173", "--strictPort"], join(ROOT, "ui"));
console.log("open http://localhost:5173/replay.html (1920x1080, full screen); START is enabled at READY");
const stop = () => {
  for (const p of procs) p.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
