// Finalize executor on a local Anvil (M §5.5, §6.2.1, PROP-09): never cranks before obsEnd; between obsEnd and
// obsEnd + 48 h it accumulates only posted bars and does not finalize; after 48 h unposted bars count as invalid and
// the market settles VOID (0.5) — the reporter-outage exit.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { hubAbi, vaultAbi } from "../../src/abi.ts";
import { createMarket, marketInputFromCalib } from "../../src/createMarket.ts";
import { finalizeTick } from "../../src/finalizer.ts";
import { Reporter } from "../../src/reporter.ts";
import { FixtureSource } from "./fixtureSource.ts";
import { type Chain, ROOT, startChain } from "./harness.ts";

const T0 = 1_789_689_600;
let c: Chain;

before(async () => {
  c = await startChain({ genesis: T0 - 3600 });
  await c.setTime(T0 - 240);
  await createMarket(c.pc, c.wallet("owner"), c.account("engine"), c.dep, marketInputFromCalib(join(ROOT, "vectors", "calib_7d_20260918.json")));
});

after(() => c?.stop());

const deps = () => ({ pc: c.pc, wc: c.wallet("anyone"), dep: c.dep, now: c.now, log: () => {} });
const settlement = () => c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "settlement", args: [0] });

test("the reporter-outage exit: VOID after obsEnd + 48 h", async () => {
  // the reporter ran for the first 10 bars, then stopped
  const reporter = new Reporter({ pc: c.pc, wc: c.wallet("reporter"), dep: c.dep, engine: c.account("engine"), source: new FixtureSource(), now: c.now, log: () => {} });
  await c.setTime(T0 + 10 * 300 + 10);
  await reporter.tick();
  assert.equal((await settlement()).processed, 10);

  await c.setTime(T0 + 3 * 86_400);
  let r = await finalizeTick(deps());
  assert.deepEqual(r, { cranked: [], finalized: [], txs: [] }, "nothing before obsEnd");

  const obsEnd = T0 + 7 * 86_400;
  await c.setTime(obsEnd + 3600);
  r = await finalizeTick(deps());
  assert.equal(r.finalized.length, 0, "not before the 48 h exit while bars are missing");
  assert.equal((await settlement()).processed, 10);

  await c.setTime(obsEnd + 48 * 3600);
  r = await finalizeTick(deps());
  assert.deepEqual(r.finalized, [0]);
  const s = await settlement();
  assert.equal(s.processed, 2016);
  assert.equal(s.nValid, 10);
  const vault = await c.pc.readContract({ address: c.dep.hub, abi: hubAbi, functionName: "marketVault", args: [0] });
  assert.equal(await c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "isVoid" }), true);
  assert.equal(await c.pc.readContract({ address: vault, abi: vaultAbi, functionName: "longT" }), 5n * 10n ** 17n);
  assert.deepEqual(await finalizeTick(deps()), { cranked: [], finalized: [], txs: [] }, "idempotent");
});
