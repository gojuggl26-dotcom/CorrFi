// Finalize executor daemon (M §8.3): anyone may run it. RPC_URL, DEPLOYMENT, FINALIZER_KEY; optional TICK_SEC (60).
import { finalizeTick } from "../src/finalizer.ts";
import { env, logger, setup, sleep } from "./common.ts";

const { pc, dep, wallet } = setup();
const log = logger("finalizer");
const wc = wallet("FINALIZER_KEY");
let running = true;
process.on("SIGINT", () => (running = false));
while (running) {
  try {
    const r = await finalizeTick({ pc, wc, dep, now: async () => Math.floor(Date.now() / 1000), log });
    if (r.txs.length) log({ ev: "tick", ...r });
  } catch (e) {
    log({ ev: "error", error: (e as Error).message.split("\n")[0] });
  }
  await sleep(Number(env("TICK_SEC", "60")) * 1000);
}
