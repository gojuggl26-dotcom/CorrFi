// Keeps the reporter and the finalizer running on this PC for the S08 observation period (DEC-26).
//   ENV_FILE=<keys file outside the repo> DEPLOYMENT=... node bin/supervise.ts
// Reads KEY=VALUE lines from ENV_FILE itself, so no key ever appears on a command line or in a log. Each child is
// restarted after it exits (backoff up to 60 s). Logs go to LOG_DIR (default: ~/.corrfi/<deployment name>/logs):
// supervisor.jsonl records every start and exit (the downtime record), reporter.jsonl / finalizer.jsonl are the bots'
// own logs (LOG_FILE). Stop it by ending this process; the children end with it.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const envFile = process.env.ENV_FILE;
const deployment = process.env.DEPLOYMENT;
if (!envFile || !deployment) throw new Error("ENV_FILE and DEPLOYMENT are required");
const vars: Record<string, string> = {};
for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (m) vars[m[1]] = m[2];
}
const name = basename(deployment).replace(/\.json$/, "");
const logDir = process.env.LOG_DIR ?? join(homedir(), ".corrfi", name, "logs");
mkdirSync(logDir, { recursive: true });
const engineDir = fileURLToPath(new URL("..", import.meta.url));
const log = (e: Record<string, unknown>) => appendFileSync(join(logDir, "supervisor.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...e }) + "\n");

const common = { ...process.env, RPC_URL: vars.RPC_URL, DEPLOYMENT: deployment };
const bots = [
  { name: "reporter", script: "bin/reporter.ts", env: { REPORTER_KEY: vars.REPORTER_KEY, ENGINE_KEY: vars.PRICE_SIGNER_KEY } },
  { name: "finalizer", script: "bin/finalizer.ts", env: { FINALIZER_KEY: vars.DEPLOYER_KEY } },
];

const children = new Set<ReturnType<typeof spawn>>();
let stopping = false;

function run(bot: (typeof bots)[number], delay = 1_000) {
  if (stopping) return;
  const child = spawn(process.execPath, [bot.script], {
    cwd: engineDir,
    env: { ...common, ...bot.env, LOG_FILE: join(logDir, `${bot.name}.jsonl`) },
    stdio: ["ignore", "ignore", "pipe"],
  });
  children.add(child);
  const started = Date.now();
  log({ ev: "start", bot: bot.name, pid: child.pid });
  child.stderr?.on("data", (d) => appendFileSync(join(logDir, `${bot.name}.stderr.log`), d));
  child.on("exit", (code, signal) => {
    children.delete(child);
    log({ ev: "exit", bot: bot.name, code, signal, ranSeconds: Math.round((Date.now() - started) / 1000) });
    const next = Date.now() - started > 60_000 ? 1_000 : Math.min(delay * 2, 60_000);
    setTimeout(() => run(bot, next), next);
  });
}

log({ ev: "supervisor_start", deployment, pid: process.pid });
for (const b of bots) run(b);
const stop = (sig: string) => {
  stopping = true;
  log({ ev: "supervisor_stop", signal: sig });
  for (const c of children) c.kill();
  setTimeout(() => process.exit(0), 500);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
