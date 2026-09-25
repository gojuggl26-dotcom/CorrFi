"""High-precision (50-digit) reference of the settlement and pricing formulas — independent of the fixed-point
implementation (R §7.1 V2: |ΔLong_T| <= 1e-9 against the on-chain value; B §3.4 p.6).

Formulas follow M §2.5 (p.8-9) and §4.1 (p.15-16) directly, with exact ln / sqrt at 50 significant digits and no
integer rounding. Inputs are the same WAD integers that go on chain.
"""
from __future__ import annotations

from decimal import Decimal, localcontext
from typing import Optional, Sequence

PREC = 50
WAD = Decimal(10) ** 18


def _ctx():
    return localcontext(prec=PREC)


def ln_ratio(p_prev: int, p_cur: int) -> Decimal:
    """ln(P_k / P_{k-1}) as a real number (not WAD)."""
    with _ctx():
        return (Decimal(p_cur) / Decimal(p_prev)).ln()


def settle(prices_a: Sequence[Optional[int]], prices_b: Sequence[Optional[int]], s_a: int, s_b: int, c: int,
           n_min: int) -> tuple[Decimal, Decimal, bool, int]:
    """(rho_T, Long_T, void, n_valid) from price points k = 0..N (None = invalid), M §2.5.2-2.5.3, §2.4.

    s_a, s_b are WAD integers (fixed at obsStart); the clip bound is c * s_i.
    """
    with _ctx():
        ca, cb = Decimal(c) * Decimal(s_a) / WAD, Decimal(c) * Decimal(s_b) / WAD
        C = VA = VB = Decimal(0)
        n_valid = 0
        for k in range(1, len(prices_a)):
            pa0, pa1, pb0, pb1 = prices_a[k - 1], prices_a[k], prices_b[k - 1], prices_b[k]
            if None in (pa0, pa1, pb0, pb1):
                continue
            ra = min(max(ln_ratio(pa0, pa1), -ca), ca)
            rb = min(max(ln_ratio(pb0, pb1), -cb), cb)
            C += ra * rb
            VA += ra * ra
            VB += rb * rb
            n_valid += 1
        if n_valid < n_min or VA * VB == 0:
            return Decimal(0), Decimal("0.5"), True, n_valid
        rho = max(min(C / (VA * VB).sqrt(), Decimal(1)), Decimal(-1))
        return rho, (rho + 1) / 2, False, n_valid


def fair_value(c_obs: Decimal, va_obs: Decimal, vb_obs: Decimal, n_obs: int, n: int, s_ab: Decimal, s_a2: Decimal,
               s_b2: Decimal) -> Decimal:
    """P_fair = (1 + rho_hat)/2 with real-valued sums and per-bar forecast moments (M §4.1)."""
    with _ctx():
        n_rem = n - n_obs
        ch = c_obs + n_rem * s_ab
        vah, vbh = va_obs + n_rem * s_a2, vb_obs + n_rem * s_b2
        return (1 + ch / (vah * vbh).sqrt()) / 2


def h_o(age: int, sigma_bar: Decimal, c_o: Decimal, delta: int = 300) -> Decimal:
    """c_O * sigma_P,bar * sqrt(age / Δ) (M §4.4)."""
    with _ctx():
        return c_o * sigma_bar * (Decimal(age) / Decimal(delta)).sqrt()
