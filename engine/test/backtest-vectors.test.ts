// S06 test vectors (B §3.4, §5.1): P_fair and h0 at representative states of real windows with the proposed w,
// σP table and c_h, from the fixed-point recompute (backtest/fixedpoint.py). Shared with the contracts' tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fairValue, h0, tau } from "../src/fixedpoint.ts";

const cols = JSON.parse(readFileSync(fileURLToPath(new URL("../../vectors/backtest_states.json", import.meta.url)), "utf8")).states as Record<string, string[]>;
const B = (x: string) => BigInt(x);

test("P_fair and h0 at the backtest's representative states equal the Python fixed-point recompute", () => {
  const n = cols.p.length;
  assert.ok(n >= 72);
  for (let i = 0; i < n; ++i) {
    const p = fairValue(B(cols.c[i]), B(cols.va[i]), B(cols.vb[i]), B(cols.nobs[i]), B(cols.n[i]), B(cols.sab[i]), B(cols.sa2[i]), B(cols.sb2[i]));
    assert.equal(p, B(cols.p[i]), `row ${i}`);
    const table = [...Array(10).keys()].map((j) => B(cols[`table${j}`][i]));
    assert.equal(h0(tau(B(cols.nobs[i]), B(cols.n[i])), table, B(cols.ch[i]), B(cols.hfloor[i])), B(cols.h0[i]), `row ${i}`);
  }
});
