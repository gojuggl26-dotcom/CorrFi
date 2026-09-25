// Bit-exact agreement with the shared vectors (vectors/fixedpoint.json, vectors/lnwad_bulk.json).
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import * as fp from "../src/fixedpoint.ts";

const root = new URL("../../vectors/", import.meta.url);
const V = JSON.parse(readFileSync(new URL("fixedpoint.json", root), "utf8"));
const B = (s: string): bigint => BigInt(s);
const rows = (section: string): Record<string, string>[] => {
  const cols = V[section] as Record<string, string[]>;
  const keys = Object.keys(cols);
  return cols[keys[0]].map((_, i) => Object.fromEntries(keys.map((k) => [k, cols[k][i]])));
};
const attempt = (f: () => bigint): string => {
  try {
    return f().toString();
  } catch (e) {
    if (e instanceof fp.FixedPointError) return "revert";
    throw e;
  }
};
const TABLE = (V.meta.table as string[]).map(B);

test("lnWad (513 edge/random) and 10,000 bulk", () => {
  for (const r of rows("ln_wad")) assert.equal(fp.lnWad(B(r.x)), B(r.y), r.x);
  const bulk = JSON.parse(readFileSync(new URL("lnwad_bulk.json", root), "utf8"));
  assert.equal(bulk.x.length, 10_000);
  bulk.x.forEach((x: string, i: number) => assert.equal(fp.lnWad(B(x)), B(bulk.y[i]), x));
});

test("logRatio", () => {
  for (const r of rows("log_ratio")) assert.equal(fp.logRatio(B(r.p0), B(r.p1)), B(r.r));
});

test("winsorize + accumulate", () => {
  for (const r of rows("accumulate")) {
    const cs = B(r.cs);
    const got = fp.accumulate(B(r.c), B(r.va), B(r.vb), fp.winsorize(B(r.ra), cs), fp.winsorize(B(r.rb), cs));
    assert.deepEqual(got, [B(r.c2), B(r.va2), B(r.vb2)]);
  }
});

test("rho / longT", () => {
  for (const r of rows("settle")) {
    assert.equal(attempt(() => fp.rho(B(r.c), B(r.va), B(r.vb))), r.rho);
    const [l, isVoid] = fp.longT(B(r.c), B(r.va), B(r.vb), B(r.nv), B(r.nmin));
    assert.equal(l, B(r.l));
    assert.equal(isVoid ? "1" : "0", r.void);
  }
});

test("payout / reserve", () => {
  for (const r of rows("payout")) {
    assert.equal(fp.payout(B(r.ql), B(r.qs), B(r.l)), B(r.pay));
    assert.equal(fp.reserve(B(r.ql), B(r.qs), B(r.l)), B(r.res));
  }
});

test("fairValue", () => {
  for (const r of rows("fair_value")) {
    const got = attempt(() => fp.fairValue(B(r.c), B(r.va), B(r.vb), B(r.nobs), B(r.n), B(r.sab), B(r.sa2), B(r.sb2)));
    assert.equal(got, r.p);
  }
});

test("sigmaP / h0", () => {
  for (const r of rows("sigma_p")) {
    assert.equal(fp.sigmaP(B(r.t), TABLE), B(r.sp));
    assert.equal(fp.h0(B(r.t), TABLE, 15n * 10n ** 16n, 5n * 10n ** 15n), B(r.h0));
  }
});

test("sigmaBar2Update / hO", () => {
  for (const r of rows("sigma_bar")) {
    assert.equal(fp.sigmaBar2Update(B(r.sig2), B(r.dp), B(r.dk), B(r.lam)), B(r.upd));
    assert.equal(fp.hO(B(r.age), B(r.sig2), B(r.co)), B(r.ho));
  }
});

test("riskCapital / utilization / hU", () => {
  for (const r of rows("risk")) {
    const rc = fp.riskCapital(B(r.q), B(r.p));
    assert.equal(rc, B(r.rc));
    assert.ok([1n, 2n, 3n].some((m) => fp.utilization(rc * m, B(r.rb)) === B(r.u)));
    assert.equal(fp.hU(B(r.u), 2n * 10n ** 16n, 6n * 10n ** 17n, 9n * 10n ** 17n), B(r.hu));
  }
});

test("curve: F16-F18 (4 directions, exact-in / exact-out)", () => {
  for (const r of rows("curve")) {
    const c = new fp.Curve(B(r.p), B(r.h), B(r.hmin), B(r.kq), B(r.qmax));
    const q0 = B(r.q0), q = B(r.q), x = B(r.x);
    assert.equal(fp.payD1(c, q0, q), B(r.pay_d1));
    assert.equal(fp.receiveD2(c, q0, q), B(r.receive_d2));
    assert.equal(fp.payD3(c, q0, q), B(r.pay_d3));
    assert.equal(fp.receiveD4(c, q0, q), B(r.receive_d4));
    assert.equal(fp.qtyD1ExactIn(c, q0, x), B(r.qty_d1));
    assert.equal(fp.qtyD3ExactIn(c, q0, x), B(r.qty_d3));
    assert.equal(attempt(() => fp.qtyD2ExactOut(c, q0, x)), r.qty_d2);
    assert.equal(attempt(() => fp.qtyD4ExactOut(c, q0, x)), r.qty_d4);
  }
});

test("sqrt is floor(sqrt(x))", () => {
  for (const x of [0n, 1n, 2n, 3n, 4n, 15n, 16n, 17n, 10n ** 36n - 1n, 10n ** 36n, (1n << 256n) - 1n]) {
    const s = fp.sqrt(x);
    assert.ok(s * s <= x && (s + 1n) * (s + 1n) > x, x.toString());
  }
});
