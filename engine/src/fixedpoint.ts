// CorrFi fixed-point arithmetic — TypeScript port for the price engine (docs/s01/01-fixed-point-spec.md).
// Must match the Solidity implementation bit for bit (M §4.2.1 U-3). BigInt throughout; functions throw
// FixedPointError where Solidity reverts.

export const WAD = 10n ** 18n;
export const UNIT = 10n ** 6n;
export const DELTA = 300n;

const M256 = 1n << 256n;
const I256_MIN = -(1n << 255n);
const I256_MAX = (1n << 255n) - 1n;
const U256_MAX = M256 - 1n;

export class FixedPointError extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// 0. basic operations

function u256(x: bigint): bigint {
  if (x < 0n || x > U256_MAX) throw new FixedPointError(`uint256 out of range: ${x}`);
  return x;
}

function i256(x: bigint): bigint {
  if (x < I256_MIN || x > I256_MAX) throw new FixedPointError(`int256 out of range: ${x}`);
  return x;
}

const abs = (x: bigint): bigint => (x < 0n ? -x : x);

/** Signed division truncating toward zero (BigInt '/' already truncates toward zero). */
export function div0(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new FixedPointError("division by zero");
  return a / b;
}

export function floorDiv(a: bigint, b: bigint): bigint {
  if (b === 0n) throw new FixedPointError("division by zero");
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return -floorDiv(-a, b);
}

export function mulDiv(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new FixedPointError("mulDiv by zero");
  return u256((u256(a) * u256(b)) / d);
}

export function mulDivUp(a: bigint, b: bigint, d: bigint): bigint {
  if (d === 0n) throw new FixedPointError("mulDiv by zero");
  return u256(ceilDiv(u256(a) * u256(b), d));
}

export function sqrt(x: bigint): bigint {
  u256(x);
  if (x < 2n) return x;
  // Newton iteration from a power-of-two upper bound; converges to floor(sqrt(x))
  let z = 1n << BigInt((x.toString(2).length + 1) >> 1);
  for (;;) {
    const y = (z + x / z) >> 1n;
    if (y >= z) return z;
    z = y;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Solady FixedPointMathLib.lnWad with EVM 256-bit semantics

const w = (x: bigint): bigint => ((x % M256) + M256) % M256;
const sgn = (x: bigint): bigint => {
  const v = w(x);
  return v >> 255n ? v - M256 : v;
};
const shl = (n: bigint, x: bigint): bigint => (n < 256n ? w(x << n) : 0n);
const shr = (n: bigint, x: bigint): bigint => (n < 256n ? w(x) >> n : 0n);
const sar = (n: bigint, x: bigint): bigint => {
  const v = sgn(x);
  return n < 256n ? w(v >> n) : w(v < 0n ? -1n : 0n);
};
const byteAt = (i: bigint, x: bigint): bigint => (i < 32n ? (w(x) >> (8n * (31n - i))) & 0xffn : 0n);
const mul = (a: bigint, b: bigint): bigint => w(a * b);
const add = (a: bigint, b: bigint): bigint => w(a + b);
const sub = (a: bigint, b: bigint): bigint => w(a - b);
const sdiv = (a: bigint, b: bigint): bigint => {
  const x = sgn(a);
  const y = sgn(b);
  if (y === 0n) return 0n;
  if (x === I256_MIN && y === -1n) return w(x);
  return w(x / y);
};
const lt = (a: bigint, b: bigint): bigint => (w(a) < w(b) ? 1n : 0n);

/** ln(x / WAD) * WAD — Solady v0.1.26 lnWad, instruction by instruction. */
export function lnWad(xIn: bigint): bigint {
  let x = w(xIn);
  let r = shl(7n, lt(0xffffffffffffffffffffffffffffffffn, x));
  r |= shl(6n, lt(0xffffffffffffffffn, shr(r, x)));
  r |= shl(5n, lt(0xffffffffn, shr(r, x)));
  r |= shl(4n, lt(0xffffn, shr(r, x)));
  r |= shl(3n, lt(0xffn, shr(r, x)));
  if (!(sgn(x) > 0n)) throw new FixedPointError("LnWadUndefined");
  r ^= byteAt(
    0x1fn & shr(shr(r, x), 0x8421084210842108cc6318c6db6d54ben),
    0xf8f9f9faf9fdfafbf9fdfcfdfafbfcfef9fafdfafcfcfbfefafafcfbffffffffn,
  );
  x = shr(159n, shl(r, x));

  let p = sub(
    sar(96n, mul(add(43456485725739037958740375743393n,
      sar(96n, mul(add(24828157081833163892658089445524n,
        sar(96n, mul(add(3273285459638523848632254066296n, x), x))), x))), x)),
    11111509109440967052023855526967n,
  );
  p = sub(sar(96n, mul(p, x)), 45023709667254063763336534515857n);
  p = sub(sar(96n, mul(p, x)), 14706773417378608786704636184526n);
  p = sub(mul(p, x), shl(96n, 795164235651350426258249787498n));

  let q = add(5573035233440673466300451813936n, x);
  q = add(71694874799317883764090561454958n, sar(96n, mul(x, q)));
  q = add(283447036172924575727196451306956n, sar(96n, mul(x, q)));
  q = add(401686690394027663651624208769553n, sar(96n, mul(x, q)));
  q = add(204048457590392012362485061816622n, sar(96n, mul(x, q)));
  q = add(31853899698501571402653359427138n, sar(96n, mul(x, q)));
  q = add(909429971244387300277376558375n, sar(96n, mul(x, q)));

  p = sdiv(p, q);
  p = mul(1677202110996718588342820967067443963516166n, p);
  p = add(mul(16597577552685614221487285958193947469193820559219878177908093499208371n, sub(159n, r)), p);
  p = add(600920179829731861736702779321621459595472258049074101567377883020018308n, p);
  return sgn(sar(174n, p));
}

// ---------------------------------------------------------------------------------------------------------------
// 1. settlement statistic

export function logRatio(pPrev: bigint, pCur: bigint): bigint {                 // F1
  if (pPrev <= 0n || pCur <= 0n) throw new FixedPointError("non-positive price");
  const x = mulDiv(pCur, WAD, pPrev);
  if (x === 0n) throw new FixedPointError("price ratio underflow");
  return lnWad(i256(x));
}

export function winsorize(r: bigint, cs: bigint): bigint {                      // F2
  return r > cs ? cs : r < -cs ? -cs : r;
}

export function accumulate(c: bigint, va: bigint, vb: bigint, ra: bigint, rb: bigint): [bigint, bigint, bigint] {
  return [i256(c + div0(i256(ra * rb), WAD)), u256(va + (ra * ra) / WAD), u256(vb + (rb * rb) / WAD)];  // F3
}

export function rho(c: bigint, va: bigint, vb: bigint): bigint {                // F4
  const den = sqrt(u256(va * vb));
  if (den === 0n) throw new FixedPointError("rho undefined (zero variance)");
  const r = div0(i256(c * WAD), den);
  return r > WAD ? WAD : r < -WAD ? -WAD : r;
}

export function longT(c: bigint, va: bigint, vb: bigint, nValid: bigint, nMin: bigint): [bigint, boolean] {  // F5
  if (nValid < nMin || va * vb === 0n) return [WAD / 2n, true];
  return [(rho(c, va, vb) + WAD) / 2n, false];
}

export function payout(qL: bigint, qS: bigint, l: bigint): bigint {             // F6
  return mulDiv(qL, l, WAD) + mulDiv(qS, WAD - l, WAD);
}

export function reserve(supplyL: bigint, supplyS: bigint, l: bigint): bigint {  // F6b
  return mulDivUp(supplyL, l, WAD) + mulDivUp(supplyS, WAD - l, WAD);
}

// ---------------------------------------------------------------------------------------------------------------
// 2. fair value

export function fairValue(c: bigint, va: bigint, vb: bigint, nObs: bigint, n: bigint,                // F7
  sAB: bigint, sA2: bigint, sB2: bigint): bigint {
  if (nObs < 0n || nObs > n) throw new FixedPointError("nObs out of range");
  const nRem = n - nObs;
  return (rho(i256(c + nRem * sAB), u256(va + nRem * sA2), u256(vb + nRem * sB2)) + WAD) / 2n;
}

export function tau(nObs: bigint, n: bigint): bigint {                          // F8
  if (n <= 0n) throw new FixedPointError("division by zero"); // Solidity: Panic 0x12 (review S03-5)
  return (nObs * WAD) / n;
}

const interp = (a: bigint, b: bigint, x0: bigint, x1: bigint, x: bigint): bigint =>
  a + div0((b - a) * (x - x0), x1 - x0);

export function sigmaP(t: bigint, table: readonly bigint[]): bigint {           // F9
  if (table.length !== 10) throw new FixedPointError("table must have 10 values");
  const mid = (i: number): bigint => (BigInt(2 * i + 1) * WAD) / 20n;
  if (t <= mid(0)) return table[0];
  for (let i = 0; i < 9; i++) if (t <= mid(i + 1)) return interp(table[i], table[i + 1], mid(i), mid(i + 1), t);
  if (t < WAD) return interp(table[9], 0n, mid(9), WAD, t);
  return 0n;
}

export function h0(t: bigint, table: readonly bigint[], cH: bigint, hFloor: bigint): bigint {       // F10
  const x = mulDivUp(cH, sigmaP(t, table), WAD);
  return x > hFloor ? x : hFloor;
}

export function sigmaBar2Update(sig2: bigint, dp: bigint, dk: bigint, lam: bigint): bigint {      // F11
  if (dk <= 0n) throw new FixedPointError("dk must be positive");
  if (lam < 0n || lam > WAD) throw new FixedPointError("lambda out of range"); // Solidity: WAD - lam underflows
  const t = (dp * dp) / WAD / dk;
  return (lam * sig2 + (WAD - lam) * t) / WAD;
}

export function sigmaBar2Init(sigma0: bigint): bigint {
  return (sigma0 * sigma0) / WAD;
}

// ---------------------------------------------------------------------------------------------------------------
// 3. spreads and utilization

export function hO(age: bigint, sig2: bigint, cO: bigint): bigint {             // F12
  if (age <= 0n) return 0n;
  const sigmaBar = sqrt(sig2 * WAD);
  const root = sqrt(mulDiv(age, WAD * WAD, DELTA));
  return mulDivUp(mulDivUp(cO, sigmaBar, WAD), root, WAD);
}

export function riskCapital(q: bigint, p: bigint): bigint {                     // F13
  if (q > 0n) return mulDivUp(q, p, WAD);
  if (q < 0n) return mulDivUp(-q, WAD - p, WAD);
  return 0n;
}

export function utilization(totalRc: bigint, riskBudget: bigint): bigint {      // F13
  return mulDivUp(totalRc, WAD, riskBudget);
}

export function hU(u: bigint, hUMax: bigint, u0: bigint, uMax: bigint): bigint { // F14
  if (u <= u0) return 0n;
  const x = mulDivUp(u - u0, WAD, uMax - u0);
  return mulDivUp(mulDivUp(hUMax, x, WAD), x, WAD);
}

// ---------------------------------------------------------------------------------------------------------------
// 4. path integral (F16-F18)

type Branch = [bigint, bigint]; // (A, slope in {0,1}) : value = A - slope * kq * q / qmax

export class Curve {
  readonly p: bigint;
  readonly h: bigint;
  readonly hmin: bigint;
  readonly kq: bigint;
  readonly qmax: bigint;
  readonly d: bigint;
  readonly alphaConstOne: boolean;
  readonly betaConstZero: boolean;
  readonly q1: bigint;
  readonly qs: bigint;
  readonly qss: bigint;
  readonly q0: bigint;

  constructor(p: bigint, h: bigint, hmin: bigint, kq: bigint, qmax: bigint) {
    if (kq <= 0n || qmax <= 0n || h < hmin || hmin < 0n) throw new FixedPointError("bad curve parameters");
    this.p = p;
    this.h = h;
    this.hmin = hmin;
    this.kq = kq;
    this.qmax = qmax;
    this.d = 2n * qmax * WAD;
    this.alphaConstOne = p + hmin >= WAD;
    // cut points: the clipped (constant) piece is extended — q1 and qss up, qs and q0 down (F16, M-F1)
    this.q1 = ceilDiv((p + h - WAD) * qmax, kq);
    this.qs = floorDiv((h - hmin) * qmax, kq);
    this.betaConstZero = p - hmin <= 0n;
    this.qss = ceilDiv(-(h - hmin) * qmax, kq);
    this.q0 = floorDiv((p - h) * qmax, kq);
  }

  branch(alpha: boolean, q: bigint): Branch {
    if (alpha) {
      if (this.alphaConstOne || q < this.q1) return [WAD, 0n];
      if (q < this.qs) return [this.p + this.h, 1n];
      return [this.p + this.hmin, 0n];
    }
    if (this.betaConstZero || q >= this.q0) return [0n, 0n];
    if (q < this.qss) return [this.p - this.hmin, 0n];
    return [this.p - this.h, 1n];
  }

  cuts(alpha: boolean): bigint[] {
    if (alpha) return this.alphaConstOne ? [] : [this.q1, this.qs];
    return this.betaConstZero ? [] : [this.qss, this.q0];
  }

  /** 2*qmax * ∫_a^b f dq, exact. */
  numer(alpha: boolean, a: bigint, b: bigint): bigint {
    if (a > b) throw new FixedPointError("a > b");
    const inner = this.cuts(alpha).filter((c) => a < c && c < b).sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
    const pts = [a, ...inner, b];
    let total = 0n;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [A, sl] = this.branch(alpha, pts[i]);
      total += (pts[i + 1] - pts[i]) * (2n * this.qmax * A - sl * this.kq * (pts[i] + pts[i + 1]));
    }
    return total;
  }
}

export const payD1 = (c: Curve, q0: bigint, q: bigint): bigint => ceilDiv(c.numer(true, q0 - q, q0), c.d);
export const receiveD2 = (c: Curve, q0: bigint, q: bigint): bigint => floorDiv(c.numer(false, q0, q0 + q), c.d);
export const payD3 = (c: Curve, q0: bigint, q: bigint): bigint => q - floorDiv(c.numer(false, q0, q0 + q), c.d);
export const receiveD4 = (c: Curve, q0: bigint, q: bigint): bigint => q - ceilDiv(c.numer(true, q0 - q, q0), c.d);

function solve(f: bigint, sigma: bigint, kq: bigint, r: bigint, buy: boolean): bigint {
  if (sigma > 0n) return floorDiv(sqrt(f * f + kq * r) - f, kq);
  if (sigma < 0n) {
    const disc = f * f - kq * r;
    if (disc < 0n) throw new FixedPointError("book too thin");
    return ceilDiv(f - sqrt(disc), kq);
  }
  if (f <= 0n) throw new FixedPointError("book too thin");
  return buy ? floorDiv(r, 2n * f) : ceilDiv(r, 2n * f);
}

function walk(c: Curve, alpha: boolean, q0: bigint, dir: bigint, complement: boolean, x: bigint, buy: boolean): bigint {
  let r = x * c.d;
  let pos = q0;
  let done = 0n;
  const cuts = c.cuts(alpha);
  for (;;) {
    const beyond = cuts.filter((k) => (dir < 0n ? k < pos : k > pos));
    const nxt = beyond.length === 0 ? null
      : beyond.reduce((m, k) => (dir < 0n ? (k > m ? k : m) : (k < m ? k : m)));
    const [A, sl] = c.branch(alpha, dir < 0n ? pos - 1n : pos);
    let f = c.qmax * A - sl * c.kq * pos;
    let sigma = -dir * sl;
    if (complement) {
      f = c.qmax * WAD - f;
      sigma = -sigma;
    }
    if (nxt !== null) {
      const len = abs(nxt - pos);
      const full = 2n * f * len + sigma * c.kq * len * len;
      if (buy ? full <= r : full < r) {
        r -= full;
        done += len;
        pos = nxt;
        continue;
      }
    }
    return done + solve(f, sigma, c.kq, r, buy);
  }
}

export function qtyD1ExactIn(c: Curve, q0: bigint, x: bigint): bigint {
  let q = walk(c, true, q0, -1n, false, x, true);
  while (q > 0n && payD1(c, q0, q) > x) q -= 1n;
  return q;
}

export function qtyD3ExactIn(c: Curve, q0: bigint, x: bigint): bigint {
  let q = walk(c, false, q0, 1n, true, x, true);
  while (q > 0n && payD3(c, q0, q) > x) q -= 1n;
  return q;
}

export function qtyD2ExactOut(c: Curve, q0: bigint, x: bigint): bigint {
  let q = walk(c, false, q0, 1n, false, x, false);
  while (receiveD2(c, q0, q) < x) q += 1n;
  while (q > 0n && receiveD2(c, q0, q - 1n) >= x) q -= 1n;
  return q;
}

export function qtyD4ExactOut(c: Curve, q0: bigint, x: bigint): bigint {
  let q = walk(c, true, q0, -1n, true, x, false);
  while (receiveD4(c, q0, q) < x) q += 1n;
  while (q > 0n && receiveD4(c, q0, q - 1n) >= x) q -= 1n;
  return q;
}
