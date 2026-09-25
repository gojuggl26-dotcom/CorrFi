// Live dry run on a local Anvil that follows the wall clock (not Base Sepolia): the reporter with the venues' live
// REST data posts real grid points at t + 10 s and has its reports accepted. The market's parameters come from the
// calib fixture (only the mechanics are exercised). Prints each bar's delay after t and the venue errors.
//   node scripts/live_dryrun.ts [minutes=15] [log.jsonl]
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { hubAbi, testUsdcAbi } from "../src/abi.ts";
import { createMarket, marketInputFromCalib } from "../src/createMarket.ts";
import { MakerOps, MVP_CONFIG } from "../src/maker.ts";
import { Reporter } from "../src/reporter.ts";
import { RestSource } from "../src/sources.ts";
import { ROOT, startChain } from "../test/anvil/harness.ts";

const minutes = Number(process.argv[2] ?? 15);
const logFile = process.argv[3];
const events: Record<string, unknown>[] = [];
const log = (e: Record<string, unknown>) => {
  const x = { at: Math.floor(Date.now() / 1000), ...e };
  events.push(x);
  if (logFile) appendFileSync(logFile, JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)) + "\n");
};
const c = await startChain({ genesis: Math.floor(Date.now() / 1000) });
try {
  await c.rpcCall("evm_setAutomine", [true]);
  await c.rpcCall("evm_setIntervalMining", [2]); // blocks every 2 s, like Base
  const { id } = await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
  await c.pc.waitForTransactionReceipt({ hash: await c.wallet("owner").writeContract({ address: c.dep.usdc, abi: testUsdcAbi, functionName: "mint", args: [c.account("maker").address, 200_000n * 10n ** 6n] }) });
  const maker = new MakerOps(c.pc, c.wallet("maker"), c.dep);
  await maker.setConfig(MVP_CONFIG);
  await maker.open(id, 1, 55_000n * 10n ** 6n, 105_000n * 10n ** 6n);
  const q0 = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "quoteState", args: [id] });
  log({ ev: "market", obsStart: Number(q0.obsStart) });
  const reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new RestSource(), now: async () => Math.floor(Date.now() / 1000), log });
  const end = Date.now() + minutes * 60_000;
  while (Date.now() < end) {
    try {
      const r = await reporter.tick();
      if (r.posted.length) log({ ev: "posted", points: r.posted, delaySec: r.posted.map((t) => r.now - t), reports: r.reports.map((x) => x.k) });
    } catch (e) {
      log({ ev: "error", error: (e as Error).message.split("\n")[0] });
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  const q = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "quoteState", args: [id] });
  const posted = events.filter((e) => e.ev === "posted");
  console.log(JSON.stringify({ confirmed: q.confirmed, processed: q.processed, invalidBars: q.invalidBars, pFair: q.pFair.toString(), posted: posted.map((e) => [e.points, e.delaySec]), venueErrors: events.filter((e) => e.ev === "venue_error").length, errors: events.filter((e) => e.ev === "error") }));
} finally {
  c.stop();
}
