// eth_getLogs on public RPCs: a refused range is halved and grows back, a rate limit waits with the same range, and the
// latest event is found by searching backwards.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isRateLimit, lastLogBackwards, logsInChunks } from "../src/logs.ts";

const blocks = (from: bigint, to: bigint) => Array.from({ length: Number(to - from + 1n) }, (_, i) => from + BigInt(i));

test("a refused range is halved, then the step grows back after successes", async () => {
  const sizes: bigint[] = [];
  let refused = false;
  const out = await logsInChunks(0n, 9_999n, async (f, t) => {
    if (t - f + 1n > 2_500n && !refused) {
      refused = true;
      throw new Error("query exceeds max block range 2500");
    }
    sizes.push(t - f + 1n);
    return blocks(f, t);
  }, 5_000n, 100n, 3, 1);
  assert.equal(out.length, 10_000);
  assert.deepEqual(sizes.slice(0, 2), [2_500n, 5_000n]); // halved once, then back to the full step
});

test("a rate limit keeps the range and waits; too many in a row throws", async () => {
  let calls = 0;
  const ranges: string[] = [];
  const out = await logsInChunks(0n, 999n, async (f, t) => {
    ranges.push(`${f}-${t}`);
    if (++calls <= 2) throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
    return blocks(f, t);
  }, 1_000n, 100n, 3, 1);
  assert.equal(out.length, 1_000);
  assert.deepEqual(ranges, ["0-999", "0-999", "0-999"]);
  await assert.rejects(
    logsInChunks(0n, 9n, async () => {
      throw new Error("Too Many Requests");
    }, 10n, 1n, 2, 1),
    /Too Many Requests/,
  );
  assert.ok(isRateLimit({ cause: { code: -32005 } }));
  assert.ok(!isRateLimit(new Error("block range too large")));
});

test("the latest event is found searching backwards, without reading the whole history", async () => {
  const asked: string[] = [];
  const events = [120n, 30_050n]; // blocks with an event
  const get = async (f: bigint, t: bigint) => {
    asked.push(`${f}-${t}`);
    return events.filter((b) => b >= f && b <= t);
  };
  assert.equal(await lastLogBackwards(100n, 40_000n, get, 5_000n), 30_050n);
  assert.deepEqual(asked, ["35001-40000", "30001-35000"]);
  assert.equal(await lastLogBackwards(100n, 1_000n, async () => [], 5_000n), undefined);
});

test("a range limit stated in the error is adopted at once and kept", async () => {
  const sizes: bigint[] = [];
  const out = await logsInChunks(0n, 4_999n, async (f, t) => {
    if (t - f + 1n > 1_000n) throw new Error("eth_getLogs is limited to a 1,000 range");
    sizes.push(t - f + 1n);
    return [f];
  }, 5_000n, 100n, 3, 1);
  assert.equal(out.length, 5);
  assert.deepEqual(sizes, [1_000n, 1_000n, 1_000n, 1_000n, 1_000n]);
});
