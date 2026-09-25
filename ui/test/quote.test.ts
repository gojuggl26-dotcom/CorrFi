import { test } from "node:test";
import assert from "node:assert/strict";
import { type BreakdownLike, DELTA_DEFAULT, explainFill, QuoteController, type QuoteInput } from "../src/core/quote.ts";

/** A fake clock and timer queue (milliseconds). */
function fakeTime(start = 0) {
  let now = start;
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let id = 0;
  return {
    nowMs: () => now,
    setTimer: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn, id: ++id });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers = timers.filter((t) => t.id !== h);
    },
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await new Promise((r) => setImmediate(r));
      }
      now = end;
    },
  };
}

const T_K = 1_789_700_000n; // time of the last confirmed bar k
function bd(over: Partial<BreakdownLike> = {}): BreakdownLike {
  return {
    reason: 0, amountIn: 1_000_000_000n, amountOut: 1_100_000_000n, qty: 1_100_000_000n, limit: 1_097_000_000n, limitDefined: true,
    pFair: 9n * 10n ** 17n, hmin: 5n * 10n ** 15n, h: 5n * 10n ** 15n, hU: 0n, inv0: 0n,
    k: 10, tK: T_K, tNext: T_K + 300n, tStop: T_K + 360n, evaluatedAt: T_K + 20n, ...over,
  };
}
const INPUT: QuoteInput = { marketId: 0, side: 0, isBuy: true, exactIn: true, amount: 1_000_000_000n, delta: DELTA_DEFAULT };

function setup(answers: BreakdownLike[]) {
  const t = fakeTime(1_000_000);
  const calls: number[] = [];
  const c = new QuoteController<BreakdownLike>({
    fetch: async () => {
      calls.push(t.nowMs());
      return answers[Math.min(calls.length - 1, answers.length - 1)];
    },
    nowMs: t.nowMs,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    onChange: () => {},
  });
  return { t, c, calls };
}

test("input changes are debounced (0.3 s) and quotes refresh every 10 s", async () => {
  const { t, c, calls } = setup([bd()]);
  c.setInput(INPUT);
  await t.advance(100);
  c.setInput({ ...INPUT, amount: 2n });
  await t.advance(299);
  assert.equal(calls.length, 0);
  await t.advance(1);
  assert.equal(calls.length, 1);
  await t.advance(10_000);
  assert.equal(calls.length, 2);
  c.setRefreshSec(5);
  await t.advance(5_000);
  assert.equal(calls.length, 3);
  assert.throws(() => c.setRefreshSec(4));
  assert.throws(() => c.setRefreshSec(16));
  assert.throws(() => c.setInput({ ...INPUT, delta: 4n * 10n ** 14n }), /0.0005-0.01/);
});

test("countdowns run in chain time: next fair value at t_k+1 + 10 s, then 'waiting'; warning 60 s before the stop", async () => {
  const { t, c } = setup([bd()]);
  c.setInput(INPUT);
  await t.advance(300);
  let v = c.view();
  assert.equal(v.chainNow, Number(T_K) + 20);
  assert.equal(v.nextFairValueInSec, 290); // (t_k + 300 + 10) - (t_k + 20)
  assert.equal(v.stopInSec, 340);
  assert.equal(v.stopWarning, false);
  assert.ok(v.canExecute);
  // 4:50 later (no new report; the automatic re-quotes keep returning the same k — the fake answers do not age)
  c.stop();
  await t.advance(290_000);
  v = c.view();
  assert.equal(v.nextFairValueInSec, undefined);
  assert.equal(v.waitingForPrice, true);
  assert.equal(v.stopInSec, 50);
  assert.equal(v.stopWarning, true);
});

test("the local clock offset does not matter: chain time comes from the quote's evaluation time", async () => {
  const { t, c } = setup([bd({ evaluatedAt: T_K + 100n })]);
  c.setInput(INPUT);
  await t.advance(300);
  await t.advance(7_000);
  assert.equal(c.chainNow(), Number(T_K) + 107);
});

test("stopped: execution disabled with the reason; a report clears T-2, T-4 stays", async () => {
  const stale = bd({ reason: 4 });
  const ok = bd({ k: 11, tK: T_K + 300n, tNext: T_K + 600n, tStop: T_K + 660n, evaluatedAt: T_K + 312n });
  const { t, c, calls } = setup([stale, ok]);
  c.setInput(INPUT);
  await t.advance(300);
  let v = c.view();
  assert.equal(v.canExecute, false);
  assert.equal(v.reason, 4);
  assert.equal(v.clears, "report");
  assert.match(v.reasonText!, /価格更新待ち/);
  c.onReport(11); // ReportAccepted -> immediate re-quote
  await t.advance(0);
  assert.equal(calls.length, 2);
  v = c.view();
  assert.equal(v.canExecute, true);

  const s4 = setup([bd({ reason: 6 }), bd({ reason: 6, k: 11 })]);
  s4.c.setInput(INPUT);
  await s4.t.advance(300);
  s4.c.onReport(11);
  await s4.t.advance(0);
  assert.equal(s4.c.view().canExecute, false);
  assert.equal(s4.c.view().clears, "never");
});

test("before executing: re-quote if older than 3 s or a new bar was confirmed, and flag changed amounts", async () => {
  const { t, c, calls } = setup([bd(), bd(), bd({ amountOut: 1_099_000_000n })]);
  c.setInput(INPUT);
  await t.advance(300);
  let r = await c.beforeExecute();
  assert.deepEqual([r.requoted, r.proceed], [false, true]);
  await t.advance(3_001);
  r = await c.beforeExecute();
  assert.deepEqual([r.requoted, r.changed, r.proceed], [true, false, true]);
  assert.equal(calls.length, 2);
  c.latestConfirmedK = 11; // a ReportAccepted seen (without its re-quote yet)
  r = await c.beforeExecute();
  assert.deepEqual([r.requoted, r.changed, r.proceed], [true, true, false]);
  assert.equal(r.after!.amountOut, 1_099_000_000n);
});

test("fill vs quote: new bar, elapsed time, inventory", () => {
  const q = bd();
  const same = { amountIn: q.amountIn, amountOut: q.amountOut, pFair: q.pFair, hmin: q.hmin, h: q.h };
  assert.deepEqual(explainFill(q, same), []);
  assert.deepEqual(explainFill(q, { ...same, amountOut: 1n, pFair: q.pFair + 1n }), ["new-bar"]);
  assert.deepEqual(explainFill(q, { ...same, amountOut: 1n, hmin: q.hmin + 1n, h: q.h + 1n }), ["elapsed-time"]);
  assert.deepEqual(explainFill(q, { ...same, amountOut: 1n, h: q.h + 7n }), ["inventory"]);
  assert.deepEqual(explainFill(q, { ...same, amountOut: 1n }), ["inventory"]);
});
