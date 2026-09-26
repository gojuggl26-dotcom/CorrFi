// The replay UI's state reducer (src/replay/state.ts): frames in, display state out.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { initialState, reduceDriver, reduceVerifier, showVerdict } from "../src/replay/state.ts";

const step = (tau: number, extra: Record<string, unknown> = {}) => ({
  type: "step", phase: "A", elapsedMs: 1000, chainTime: 1, block: 2, processed: Math.round(tau * 2016), confirmed: 0, tau, invalidBars: 0,
  price: { pFair: "0.900000", bid: "0.890000", ask: "0.910000", h: "0.005000", hmin: "0.005000", rho0: "0.800000", rhoObs: 0.6, weightObs: tau, forecastLine: "0.9" },
  inventory: { q: "-100.00", nl: "0.00", ns: "100.00", u: "0.000100" },
  supply: { long: "700.00", short: "700.00", collateral: "700.00", usdcInVault: "700.00" },
  ...extra,
});

test("preflight, ready and steps build the chart series and the trade log", () => {
  let s = initialState();
  s = reduceDriver(s, { type: "preflight", ready: true, checks: [{ id: "P1", ok: true, detail: "" }] });
  assert.equal(s.status, "preflight");
  s = reduceDriver(s, { type: "ready", week: { obsStart: 1, obsStartIso: "2025-10-13T00:00Z", tenorDays: 7 }, bars: "bars.json", n: 2016, rho0: "0.78", p0: "0.89" });
  assert.equal(s.status, "ready");
  s = reduceDriver(s, step(0.25, { trades: [{ id: "S1", op: "trade", dir: 2 }] }));
  s = reduceDriver(s, step(0.5));
  assert.equal(s.status, "running");
  assert.equal(s.series.length, 2);
  assert.equal(s.series[0].realized, 0.8); // (1 + 0.6) / 2
  assert.deepEqual(s.trades.map((t) => [t.id, t.tau]), [["S1", 0.25]]);
});

test("a failed preflight is shown as failed", () => {
  const s = reduceDriver(initialState(), { type: "preflight", ready: false, checks: [{ id: "P3", ok: false, detail: "hash mismatch" }] });
  assert.equal(s.status, "failed");
});

test("the verdict is revealed only in the verification phase (R §5.1)", () => {
  let s = reduceDriver(initialState(), step(1, { phase: "settlement", longT: "0.926108332093189410", isVoid: false, payouts: { A: "1" }, settlement: [] }));
  assert.equal(s.status, "settled");
  assert.equal(s.longT, 0.9261083320931894);
  s = reduceVerifier(s, { type: "item", item: "V1", ok: true, checked: 2017, failures: 0, detail: "" });
  s = reduceVerifier(s, { type: "summary", pass: true, items: { V1: { pass: true, checked: 2017, failures: [] } }, V2: { longT_hp: "0.9261", diff: "2e-14" } });
  assert.equal(showVerdict(s), false);
  s = reduceDriver(s, { type: "phase", phase: "verification", elapsedMs: 101_600 });
  assert.equal(showVerdict(s), true);
  assert.equal(s.verify.pass, true);
});

test("a failing item stays failed", () => {
  let s = reduceVerifier(initialState(), { type: "item", item: "V4", ok: false, checked: 1, failures: 1, detail: "A1" });
  s = reduceVerifier(s, { type: "item", item: "V4", ok: true, checked: 2, failures: 1, detail: "" });
  assert.equal(s.verify.items.V4?.ok, false);
});
