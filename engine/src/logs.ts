// Log queries that work on public RPCs; no Node imports, so the browser UI can use it too.

/** Logs over [from, to] in chunks: RPCs cap the block range of eth_getLogs, so a refused chunk is halved (down to
 *  `minStep`, then the error is thrown). `get` fetches one inclusive range. */
export async function logsInChunks<T>(
  from: bigint,
  to: bigint,
  get: (from: bigint, to: bigint) => Promise<T[]>,
  step = 5_000n,
  minStep = 100n,
): Promise<T[]> {
  const res: T[] = [];
  while (from <= to) {
    const end = from + step - 1n > to ? to : from + step - 1n;
    try {
      res.push(...(await get(from, end)));
      from = end + 1n;
    } catch (e) {
      if (step <= minStep) throw e;
      step /= 2n;
    }
  }
  return res;
}
