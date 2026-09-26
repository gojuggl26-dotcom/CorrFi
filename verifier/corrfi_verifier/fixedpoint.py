"""CorrFi fixed-point arithmetic — Python port (docs/s01/01-fixed-point-spec.md).

Must match the Solidity implementation bit for bit (M §4.2.1 U-3, R §7.1 V3, R §7.3). Section / function numbers
(F1..F18) refer to the spec. Python ints are unbounded, so every place where Solidity would revert on overflow or
on a precondition raises FixedPointError here.
"""
from __future__ import annotations

from math import isqrt

WAD = 10**18
UNIT = 10**6
DELTA = 300               # bar length Δ in seconds

_M256 = 1 << 256
_I256_MIN, _I256_MAX = -(1 << 255), (1 << 255) - 1
_U256_MAX = _M256 - 1


class FixedPointError(ArithmeticError):
    """Raised where the Solidity implementation reverts."""


# ---------------------------------------------------------------------------------------------------------------
# 0. basic operations (OZ Math semantics)

def _u256(x: int) -> int:
    if not 0 <= x <= _U256_MAX:
        raise FixedPointError(f"uint256 out of range: {x}")
    return x


def _i256(x: int) -> int:
    if not _I256_MIN <= x <= _I256_MAX:
        raise FixedPointError(f"int256 out of range: {x}")
    return x


def div0(a: int, b: int) -> int:
    """Signed division truncating toward zero (Solidity int256 '/')."""
    if b == 0:
        raise FixedPointError("division by zero")
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


def floor_div(a: int, b: int) -> int:
    """Signed floor division (used for breakpoints)."""
    if b == 0:
        raise FixedPointError("division by zero")
    return a // b


def mul_div(a: int, b: int, d: int) -> int:
    if d == 0:
        raise FixedPointError("mulDiv by zero")
    return _u256(_u256(a) * _u256(b) // d)


def mul_div_up(a: int, b: int, d: int) -> int:
    if d == 0:
        raise FixedPointError("mulDiv by zero")
    return _u256(-(-(_u256(a) * _u256(b)) // d))


def sqrt(x: int) -> int:
    return isqrt(_u256(x))


def ceil_div(a: int, b: int) -> int:
    return -(-a // b)


# ---------------------------------------------------------------------------------------------------------------
# Solady FixedPointMathLib.lnWad, instruction by instruction with EVM 256-bit semantics

def _w(x: int) -> int:
    return x % _M256


def _s(x: int) -> int:
    x %= _M256
    return x - _M256 if x >> 255 else x


def _shl(n: int, x: int) -> int:
    return _w(x << n) if n < 256 else 0


def _shr(n: int, x: int) -> int:
    return _w(x) >> n if n < 256 else 0


def _sar(n: int, x: int) -> int:
    v = _s(x)
    return _w(v >> n) if n < 256 else _w(-1 if v < 0 else 0)


def _byte(i: int, x: int) -> int:
    return (_w(x) >> (8 * (31 - i))) & 0xFF if i < 32 else 0


def _sdiv(a: int, b: int) -> int:
    a, b = _s(a), _s(b)
    if b == 0:
        return 0
    if a == _I256_MIN and b == -1:
        return _w(a)
    return _w(div0(a, b))


def ln_wad(x_in: int) -> int:
    """ln(x / WAD) * WAD, Solady v0.1.26 FixedPointMathLib.lnWad (approximation, monotonically increasing)."""
    x = _w(x_in)
    r = _shl(7, int(0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF < x))
    r |= _shl(6, int(0xFFFFFFFFFFFFFFFF < _shr(r, x)))
    r |= _shl(5, int(0xFFFFFFFF < _shr(r, x)))
    r |= _shl(4, int(0xFFFF < _shr(r, x)))
    r |= _shl(3, int(0xFF < _shr(r, x)))
    if not _s(x) > 0:
        raise FixedPointError("LnWadUndefined")
    r ^= _byte(0x1F & _shr(_shr(r, x), 0x8421084210842108CC6318C6DB6D54BE),
               0xF8F9F9FAF9FDFAFBF9FDFCFDFAFBFCFEF9FAFDFAFCFCFBFEFAFAFCFBFFFFFFFF)
    x = _shr(159, _shl(r, x))

    def mul(a, b): return _w(a * b)
    def add(a, b): return _w(a + b)
    def sub(a, b): return _w(a - b)

    p = sub(_sar(96, mul(add(43456485725739037958740375743393,
            _sar(96, mul(add(24828157081833163892658089445524,
            _sar(96, mul(add(3273285459638523848632254066296,
                x), x))), x))), x)), 11111509109440967052023855526967)
    p = sub(_sar(96, mul(p, x)), 45023709667254063763336534515857)
    p = sub(_sar(96, mul(p, x)), 14706773417378608786704636184526)
    p = sub(mul(p, x), _shl(96, 795164235651350426258249787498))

    q = add(5573035233440673466300451813936, x)
    q = add(71694874799317883764090561454958, _sar(96, mul(x, q)))
    q = add(283447036172924575727196451306956, _sar(96, mul(x, q)))
    q = add(401686690394027663651624208769553, _sar(96, mul(x, q)))
    q = add(204048457590392012362485061816622, _sar(96, mul(x, q)))
    q = add(31853899698501571402653359427138, _sar(96, mul(x, q)))
    q = add(909429971244387300277376558375, _sar(96, mul(x, q)))

    p = _sdiv(p, q)
    p = mul(1677202110996718588342820967067443963516166, p)
    p = add(mul(16597577552685614221487285958193947469193820559219878177908093499208371, sub(159, r)), p)
    p = add(600920179829731861736702779321621459595472258049074101567377883020018308, p)
    return _s(_sar(174, p))


# ---------------------------------------------------------------------------------------------------------------
# 1. settlement statistic

def log_ratio(p_prev: int, p_cur: int) -> int:                        # F1
    if p_prev <= 0 or p_cur <= 0:
        raise FixedPointError("non-positive price")
    x = mul_div(p_cur, WAD, p_prev)
    if x == 0:
        raise FixedPointError("price ratio underflow")
    return ln_wad(_i256(x))


def winsorize(r: int, cs: int) -> int:                                  # F2
    return min(max(r, -cs), cs)


def accumulate(c: int, va: int, vb: int, ra: int, rb: int) -> tuple[int, int, int]:   # F3
    return (_i256(c + div0(_i256(ra * rb), WAD)), _u256(va + ra * ra // WAD), _u256(vb + rb * rb // WAD))


def rho(c: int, va: int, vb: int) -> int:                                # F4
    den = sqrt(_u256(va * vb))
    if den == 0:
        raise FixedPointError("rho undefined (zero variance)")
    r = div0(_i256(c * WAD), den)
    return min(max(r, -WAD), WAD)


def long_t(c: int, va: int, vb: int, n_valid: int, n_min: int) -> tuple[int, bool]:   # F5 -> (L, void)
    if n_valid < n_min or va * vb == 0:
        return WAD // 2, True
    return (rho(c, va, vb) + WAD) // 2, False


def settle_from_prices(prices_a: list, prices_b: list, s_a: int, s_b: int, c: int,
                       n_min: int) -> tuple[int, bool, int, int, int, int]:
    """F1-F5 over price points k = 0..N (None = invalid price point, M §2.5.3).

    Returns (Long_T, void, C, VA, VB, n_valid) exactly as the Accumulator + finalize would compute them.
    """
    ca, cb = c * s_a, c * s_b
    acc_c = va = vb = 0
    n_valid = 0
    for k in range(1, len(prices_a)):
        pa0, pa1, pb0, pb1 = prices_a[k - 1], prices_a[k], prices_b[k - 1], prices_b[k]
        if None in (pa0, pa1, pb0, pb1):
            continue
        ra = winsorize(log_ratio(pa0, pa1), ca)
        rb = winsorize(log_ratio(pb0, pb1), cb)
        acc_c, va, vb = accumulate(acc_c, va, vb, ra, rb)
        n_valid += 1
    l, void = long_t(acc_c, va, vb, n_valid, n_min)
    return l, void, acc_c, va, vb, n_valid


def payout(q_long: int, q_short: int, l: int) -> int:                   # F6
    return mul_div(q_long, l, WAD) + mul_div(q_short, WAD - l, WAD)


def reserve(supply_long: int, supply_short: int, l: int) -> int:        # F6b
    return mul_div_up(supply_long, l, WAD) + mul_div_up(supply_short, WAD - l, WAD)


# ---------------------------------------------------------------------------------------------------------------
# 2. fair value

def fair_value(c: int, va: int, vb: int, n_obs: int, n: int, s_ab: int, s_a2: int, s_b2: int) -> int:   # F7
    if not 0 <= n_obs <= n:
        raise FixedPointError("n_obs out of range")
    n_rem = n - n_obs
    ch = _i256(c + n_rem * s_ab)
    vah = _u256(va + n_rem * s_a2)
    vbh = _u256(vb + n_rem * s_b2)
    return (rho(ch, vah, vbh) + WAD) // 2


def tau(n_obs: int, n: int) -> int:                                      # F8
    if n <= 0:
        raise FixedPointError("division by zero")   # Solidity: Panic 0x12 (review S03-5)
    return n_obs * WAD // n


def sigma_p(t: int, table: list[int]) -> int:                            # F9
    if len(table) != 10:
        raise FixedPointError("table must have 10 values")
    mids = [(2 * i + 1) * WAD // 20 for i in range(10)]
    if t <= mids[0]:
        return table[0]
    for i in range(9):
        if t <= mids[i + 1]:
            return _interp(table[i], table[i + 1], mids[i], mids[i + 1], t)
    if t < WAD:
        return _interp(table[9], 0, mids[9], WAD, t)
    return 0


def _interp(a: int, b: int, x0: int, x1: int, x: int) -> int:
    return a + div0((b - a) * (x - x0), x1 - x0)


def h0(t: int, table: list[int], c_h: int, h_floor: int) -> int:        # F10
    return max(h_floor, mul_div_up(c_h, sigma_p(t, table), WAD))


def sigma_bar2_update(sig2: int, dp: int, dk: int, lam: int) -> int:    # F11
    if dk <= 0:
        raise FixedPointError("dk must be positive")
    if not 0 <= lam <= WAD:
        raise FixedPointError("lambda out of range")   # Solidity: WAD - lam underflows (review S03-5)
    t = (dp * dp // WAD) // dk
    return (lam * sig2 + (WAD - lam) * t) // WAD


def sigma_bar2_init(sigma0: int) -> int:
    return sigma0 * sigma0 // WAD


# ---------------------------------------------------------------------------------------------------------------
# 3. spreads and utilization

def h_o(age: int, sig2: int, c_o: int) -> int:                          # F12
    if age <= 0:
        return 0
    sigma_bar = sqrt(sig2 * WAD)
    root = sqrt(mul_div(age, WAD * WAD, DELTA))
    return mul_div_up(mul_div_up(c_o, sigma_bar, WAD), root, WAD)


def risk_capital(q: int, p: int) -> int:                                 # F13 (per market, unit)
    return mul_div_up(q, p, WAD) if q > 0 else mul_div_up(-q, WAD - p, WAD) if q < 0 else 0


def utilization(total_rc: int, risk_budget: int) -> int:                # F13
    return mul_div_up(total_rc, WAD, risk_budget)


def h_u(u: int, h_u_max: int, u0: int, u_max: int) -> int:              # F14
    if u <= u0:
        return 0
    x = mul_div_up(u - u0, WAD, u_max - u0)
    return mul_div_up(mul_div_up(h_u_max, x, WAD), x, WAD)


# ---------------------------------------------------------------------------------------------------------------
# 4. path integral (F16-F18). q, Q in units; prices in WAD; numerators scaled by 2*qmax (unit*WAD).

class Curve:
    """alpha / beta of M §4.3 for one quote: P, h, hmin (WAD), kq (WAD), qmax (unit)."""

    def __init__(self, p: int, h: int, hmin: int, kq: int, qmax: int):
        if kq <= 0 or qmax <= 0 or h < hmin or hmin < 0:
            raise FixedPointError("bad curve parameters")
        self.p, self.h, self.hmin, self.kq, self.qmax = p, h, hmin, kq, qmax
        self.d = 2 * qmax * WAD
        self.alpha_const_one = p + hmin >= WAD
        # cut points: the clipped (constant) piece is extended — q1 and qss up, qs and q0 down (F16, M-F1)
        self.q1 = -floor_div(-(p + h - WAD) * qmax, kq)
        self.qs = floor_div((h - hmin) * qmax, kq)
        self.beta_const_zero = p - hmin <= 0
        self.qss = -floor_div((h - hmin) * qmax, kq)
        self.q0 = floor_div((p - h) * qmax, kq)
        # rounding can invert a pair when its linear piece is shorter than one unit; the piece is then empty and
        # the branches are unchanged by closing the pair (keeps lo <= hi, as the Solidity walk assumes)
        self.qs = max(self.qs, self.q1)
        self.qss = min(self.qss, self.q0)

    # a branch is (A, slope) meaning A - slope*kq/qmax*q with slope in {0, 1}
    def _alpha_branch(self, q: int):
        if self.alpha_const_one or q < self.q1:
            return WAD, 0
        if q < self.qs:
            return self.p + self.h, 1
        return self.p + self.hmin, 0

    def _beta_branch(self, q: int):
        if self.beta_const_zero or q >= self.q0:
            return 0, 0
        if q < self.qss:
            return self.p - self.hmin, 0
        return self.p - self.h, 1

    def _cuts(self, which: str) -> list[int]:
        if which == "alpha":
            return [] if self.alpha_const_one else [self.q1, self.qs]
        return [] if self.beta_const_zero else [self.qss, self.q0]

    def numer(self, which: str, a: int, b: int) -> int:
        """2*qmax * ∫_a^b f dq  (f = alpha or beta), exact integer, a <= b."""
        if a > b:
            raise FixedPointError("a > b")
        branch = self._alpha_branch if which == "alpha" else self._beta_branch
        pts = [a] + sorted(c for c in self._cuts(which) if a < c < b) + [b]
        total = 0
        for u, v in zip(pts, pts[1:]):
            A, sl = branch(u)
            total += (v - u) * (2 * self.qmax * A - sl * self.kq * (u + v))
        return total


# ---- F17: the four directions ------------------------------------------------------------------------------------

def pay_d1(c: Curve, q0: int, q: int) -> int:           # buy Long, exact-out
    return ceil_div(c.numer("alpha", q0 - q, q0), c.d)


def receive_d2(c: Curve, q0: int, q: int) -> int:       # sell Long, exact-in
    return c.numer("beta", q0, q0 + q) // c.d


def pay_d3(c: Curve, q0: int, q: int) -> int:           # buy Short, exact-out
    return q - c.numer("beta", q0, q0 + q) // c.d


def receive_d4(c: Curve, q0: int, q: int) -> int:       # sell Short, exact-in
    return q - ceil_div(c.numer("alpha", q0 - q, q0), c.d)


# ---- F18: inverse (exact-in buys, exact-out sells) --------------------------------------------------------------

def _pieces(c: Curve, which: str, q0: int, direction: int, complement: bool):
    """Yield (F, sigma, length or None) along the walk from q0; value at step y is (F + sigma*kq*y)/qmax."""
    cuts = c._cuts(which)
    branch = c._alpha_branch if which == "alpha" else c._beta_branch
    pos = q0
    while True:
        if direction < 0:
            below = [x for x in cuts if x < pos]
            nxt = max(below) if below else None
            probe = pos - 1
        else:
            above = [x for x in cuts if x > pos]
            nxt = min(above) if above else None
            probe = pos
        A, sl = branch(probe)
        f_q = c.qmax * A - sl * c.kq * pos              # qmax * f(pos)
        slope = -direction * sl                          # d f / d y has sign -direction*sl (f = A - s q)
        if complement:
            f_q, slope = c.qmax * WAD - f_q, -slope
        yield f_q, slope, (None if nxt is None else abs(nxt - pos))
        if nxt is None:
            return
        pos = nxt


def _piece_numer(F: int, sigma: int, kq: int, y: int) -> int:
    return 2 * F * y + sigma * kq * y * y


def _solve(F: int, sigma: int, kq: int, qmax: int, r: int, buy: bool) -> int:
    if sigma > 0:
        return (isqrt(F * F + kq * r) - F) // kq
    if sigma < 0:
        disc = F * F - kq * r
        if disc < 0:
            raise FixedPointError("book too thin")
        return ceil_div(F - isqrt(disc), kq)
    if F <= 0:
        raise FixedPointError("book too thin")
    return r // (2 * F) if buy else ceil_div(r, 2 * F)


def _walk(c: Curve, which: str, q0: int, direction: int, complement: bool, r: int, buy: bool) -> int:
    done = 0
    for F, sigma, length in _pieces(c, which, q0, direction, complement):
        if length is not None:
            full = _piece_numer(F, sigma, c.kq, length)
            if (full <= r) if buy else (full < r):
                r -= full
                done += length
                continue
        return done + _solve(F, sigma, c.kq, c.qmax, r, buy)
    raise AssertionError("unreachable")


MAX_FIX = 64   # correction steps after the walk; it is exact up to one rounding, so more means no solution


def _fix(q: int, step: int, cond) -> int:
    for _ in range(MAX_FIX):
        if not cond(q):
            return q
        q += step
    if cond(q):
        raise FixedPointError("book too thin")
    return q


def qty_d1_exact_in(c: Curve, q0: int, x: int) -> int:      # buy Long paying x USDC units
    q = _walk(c, "alpha", q0, -1, False, x * c.d, True)
    return _fix(q, -1, lambda q: q > 0 and pay_d1(c, q0, q) > x)


def qty_d3_exact_in(c: Curve, q0: int, x: int) -> int:      # buy Short paying x USDC units
    q = _walk(c, "beta", q0, +1, True, x * c.d, True)
    return _fix(q, -1, lambda q: q > 0 and pay_d3(c, q0, q) > x)


def qty_d2_exact_out(c: Curve, q0: int, x: int) -> int:     # sell Long receiving x USDC units
    q = _walk(c, "beta", q0, +1, False, x * c.d, False)
    q = _fix(q, 1, lambda q: receive_d2(c, q0, q) < x)
    return _fix(q, -1, lambda q: q > 0 and receive_d2(c, q0, q - 1) >= x)


def qty_d4_exact_out(c: Curve, q0: int, x: int) -> int:     # sell Short receiving x USDC units
    q = _walk(c, "alpha", q0, -1, True, x * c.d, False)
    q = _fix(q, 1, lambda q: receive_d4(c, q0, q) < x)
    return _fix(q, -1, lambda q: q > 0 and receive_d4(c, q0, q - 1) >= x)
