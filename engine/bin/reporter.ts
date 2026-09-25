// Reporter daemon (M §8.3): polls every TICK_SEC seconds; each tick posts whatever grid points are due (t + 10 s)
// with the price engine's reports, backfilling after an outage. Live bars from the five venues' REST APIs.
//   RPC_URL, DEPLOYMENT, REPORTER_KEY (registered reporter), ENGINE_KEY (registered price-engine signer)
//   optional: TICK_SEC (5), POST_DELAY_SEC (10), VENUE_WAIT_SEC (60), MAX_POINTS_PER_TX (48), MAX_CRANK_PER_TX (144), LOG_FILE
import { Reporter } from "../src/reporter.ts";
import { RestSource } from "../src/sources.ts";
import { env, logger, setup, sleep } from "./common.ts";

const { pc, dep, wallet, account } = setup();
const log = logger("reporter");
const reporter = new Reporter(
  { pc, wc: wallet("REPORTER_KEY"), dep, engine: account("ENGINE_KEY"), source: new RestSource(), now: async () => Math.floor(Date.now() / 1000), log },
  {
    postDelaySec: Number(env("POST_DELAY_SEC", "10")),
    venueWaitSec: Number(env("VENUE_WAIT_SEC", "60")),
    maxPointsPerTx: Number(env("MAX_POINTS_PER_TX", "48")),
    maxCrankPerTx: Number(env("MAX_CRANK_PER_TX", "144")),
  },
);
let running = true;
process.on("SIGINT", () => (running = false));
log({ ev: "start", hub: dep.hub, chainId: dep.chainId, reporter: wallet("REPORTER_KEY").account.address, engine: account("ENGINE_KEY").address });
while (running) {
  try {
    await reporter.tick();
  } catch (e) {
    log({ ev: "error", error: (e as Error).message.split("\n")[0] });
  }
  await sleep(Number(env("TICK_SEC", "5")) * 1000);
}
log({ ev: "stop" });
