"""S00 analysis aid: exact-rational model of the quote curve and fair-value pieces.

Sources: M §4.3 (p.17-18), §4.4 (p.18), §4.5 (p.19), §6.1 (p.28), App. A §9.1 (p.43-44).
Prices are Fractions in USDC per token; inventory q and quantities are in tokens.
USDC / token amounts are rounded to the smallest unit (1e-6) only at the very end,
once per trade, as M §9.1.2 requires ("小区間ごとに丸めない").

This module is for S00 spec checks only. It is NOT the S01 reference implementation
(that one must mirror the contract's WAD integer arithmetic).
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction as F
from math import ceil, floor

UNIT = 10**6  # 1 token = 1 USDC = 1e6 units (M §1.9, p.6)


def clip01(x: F) -> F:
    return min(max(x, F(0)), F(1))


def units_ceil(x: F) -> int:
    return ceil(x * UNIT)


def units_floor(x: F) -> int:
    return floor(x * UNIT)


def fmt_units(n: int) -> str:
    sign = "-" if n < 0 else ""
    n = abs(n)
    return f"{sign}{n // UNIT:,}.{n % UNIT:06d}"


@dataclass(frozen=True)
class Curve:
    """alpha/beta of M §4.3 for a fixed P_fair, h, h_min and per-token slope s = kq/qmax."""

    P: F
    h: F
    hmin: F
    s: F

    def m(self, q: F) -> F:
        return self.P - self.s * q

    def alpha(self, q: F) -> F:  # Maker sells Long (M §4.3)
        return clip01(max(self.m(q) + self.h, self.P + self.hmin))

    def beta(self, q: F) -> F:  # Maker buys Long (M §4.3)
        return clip01(min(self.m(q) - self.h, self.P - self.hmin))

    def _breakpoints(self) -> list[F]:
        P, h, hm, s = self.P, self.h, self.hmin, self.s
        # max/min switch points and the 0 / 1 clip points of the linear pieces (M §9.1.1)
        return [(h - hm) / s, (P + h - 1) / s, (P + h) / s,
                -(h - hm) / s, (P - h) / s, (P - h - 1) / s]

    def integral(self, f, a: F, b: F) -> F:
        """Exact integral of the piecewise-linear f over [a, b] (trapezoid per linear piece)."""
        a, b = F(a), F(b)
        if a > b:
            raise ValueError("a > b")
        pts = sorted({a, b} | {p for p in self._breakpoints() if a < p < b})
        return sum(((v - u) * (f(u) + f(v)) / 2 for u, v in zip(pts, pts[1:])), F(0))


# ---- the four directions (M §4.5 table, p.19; App. A §9.1.2, p.43) ----------------------
# D1 Taker buys Long  : q0 -> q0 - Q, Pay     = ceil(∫_{q0-Q}^{q0} alpha)
# D2 Taker sells Long : q0 -> q0 + Q, Receive = floor(∫_{q0}^{q0+Q} beta)
# D3 Taker buys Short : q0 -> q0 + Q, Pay     = Q - floor(∫ beta)   (= ceil ∫(1-beta))
# D4 Taker sells Short: q0 -> q0 - Q, Receive = Q - ceil(∫ alpha)   (= floor ∫(1-alpha))

def d1_exact_out(c: Curve, q0: F, Q: F) -> int:
    return units_ceil(c.integral(c.alpha, q0 - Q, q0))


def d2_exact_in(c: Curve, q0: F, Q: F) -> int:
    return units_floor(c.integral(c.beta, q0, q0 + Q))


def d1_exact_in(c: Curve, q0: F, X: F, hi_units: int = 10**14) -> int:
    """Largest token quantity (in units) whose exact cost does not exceed X (M §9.1.3: Q = floor(Σx))."""
    lo, hi = 0, hi_units
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if c.integral(c.alpha, q0 - F(mid, UNIT), q0) <= X:
            lo = mid
        else:
            hi = mid - 1
    return lo


def d2_exact_out(c: Curve, q0: F, X: F, hi_units: int = 10**14) -> int:
    """Smallest token quantity (in units) whose exact proceeds reach X (M §9.1.3: Q = ceil(Σx))."""
    lo, hi = 0, hi_units
    if c.integral(c.beta, q0, q0 + F(hi, UNIT)) < X:
        raise ValueError("book too thin (板の深さ不足)")
    while lo < hi:
        mid = (lo + hi) // 2
        if c.integral(c.beta, q0, q0 + F(mid, UNIT)) >= X:
            hi = mid
        else:
            lo = mid + 1
    return lo


# ---- utilization surcharge (M §4.4, p.18; §6.1, p.28) -----------------------------------

def rc(q: F, P: F) -> F:
    """Risk capital of one market's inventory (M §5.4 / §6.1)."""
    return abs(q) * P if q > 0 else abs(q) * (1 - P)


def h_u(U: F, hU_max=F(2, 100), U0=F(60, 100), Umax=F(90, 100)) -> F:
    x = max(U - U0, F(0)) / (Umax - U0)
    return hU_max * x * x
