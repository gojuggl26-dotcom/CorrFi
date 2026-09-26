// Log queries that work on public RPCs; no Node imports, so the browser UI can use it too.

/** A rate limit (HTTP 429 or the provider's wording), as opposed to a refused block range. */
export function isRateLimit(e: unknown): boolean {
  for (let x = e as { status?: unknown; code?: unknown; message?: unknown; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    if (x.status === 429 || x.code === 429 || x.code === -32005) return true;
    if (typeof x.message === "string" && /\b429\b|rate.?limit|too many requests/i.test(x.message)) return true;
  }
  return false;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The block range an RPC says it accepts, when its error names it ("eth_getLogs is limited to a 1,000 range"). */
export function statedRange(e: unknown): bigint | undefined {
  for (let x = e as { message?: unknown; details?: unknown; cause?: unknown } | undefined; x; x = x.cause as typeof x) {
    for (const t of [x.message, x.details]) {
      const m = typeof t === "string" ? /limited to (?:a )?([\d,]+)(?:[ -]block)? range/i.exec(t) : null;
      if (m) return BigInt(m[1].replace(/,/g, ""));
    }
  }
  return undefined;
}

/** Logs over [from, to] in chunks: RPCs cap the block range of eth_getLogs, so a refused chunk is halved (down to
 *  `minStep`, then the error is thrown) and the step grows back after each success. A rate limit keeps the step and
 *  waits instead (`retries` times, pausing `backoffMs`, 2 × `backoffMs`, ...). `get` fetches one inclusive range. */
export async function logsInChunks<T>(
  from: bigint,
  to: bigint,
  get: (from: bigint, to: bigint) => Promise<T[]>,
  step = 1_000n, // Base's public RPC accepts 1,000 blocks (2026-09-26)
  minStep = 100n,
  retries = 5,
  backoffMs = 1_000,
): Promise<T[]> {
  const res: T[] = [];
  let max = step;
  let limited = 0;
  while (from <= to) {
    const end = from + step - 1n > to ? to : from + step - 1n;
    try {
      res.push(...(await get(from, end)));
      from = end + 1n;
      limited = 0;
      if (step < max) step = step * 2n > max ? max : step * 2n;
    } catch (e) {
      if (isRateLimit(e)) {
        if (++limited > retries) throw e;
        await pause(backoffMs * 2 ** (limited - 1));
        continue;
      }
      const stated = statedRange(e);
      if (stated !== undefined && stated >= minStep && stated < step) {
        step = max = stated; // the RPC told us its limit: never ask for more again
        continue;
      }
      if (step <= minStep) throw e;
      step /= 2n;
    }
  }
  return res;
}

/** The last match at or before `to`, searching backwards from `to` in windows of `step` down to `from`: finding the
 *  latest event stays cheap however long ago `from` is. */
export async function lastLogBackwards<T>(
  from: bigint,
  to: bigint,
  get: (from: bigint, to: bigint) => Promise<T[]>,
  step = 1_000n,
): Promise<T | undefined> {
  for (let end = to; end >= from; end -= step) {
    const start = end - step + 1n > from ? end - step + 1n : from;
    const logs = await logsInChunks(start, end, get, step);
    if (logs.length) return logs[logs.length - 1];
    if (start === from) break;
  }
  return undefined;
}
