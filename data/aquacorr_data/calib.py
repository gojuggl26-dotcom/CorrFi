"""Market-creation parameters from data before obsStart (M §2.5.2 p.8, §4.1.1 p.15; R §3.3 p.7-8; PROP-03).

For a cutoff time (a 5-minute boundary; the market's obsStart) and a tenor T:
  - price points on the 5-minute grid up to and including the cutoff (the point at t uses the bar opening at
    t - 60, so every bar used opens before the cutoff: maxBarOpenTime < cutoffExclusive);
  - bar k is valid iff both assets' points at k-1 and k are valid (M §2.5.3); only valid bars are used;
  - returns r = ln(P_k / P_k-1) with the protocol's fixed-point logRatio (Solady lnWad, F1), so that a third party
    reproduces the values bit for bit;
  - s_i = max(1.4826 * MAD(last 30 days), 0.5 * 1.4826 * MAD(last 180 days)), MAD = median |r - median r|
    (a median of an even count is the mean of the middle two), truncated to WAD;
  - r~ = clip(r, -4 s_i, +4 s_i) (F2, c = 4 as in the hub);
  - Σ̂_long over 90 days and Σ̂_recent over the last T days: the non-demeaned per-bar second moments
    mean(r~_A r~_B / WAD), mean(r~_A^2 / WAD), mean(r~_B^2 / WAD) with F3's per-bar truncation and the mean
    truncated toward zero;
  - Σ̂_future = w Σ̂_long + (1 - w) Σ̂_recent (WAD, truncated toward zero), checked like createMarket does
    (positive variances, PSD, diagonal <= (4 s_i)^2 / WAD).
Implementation choices (docs/s05): the MAD uses the valid bars (the same sample for both assets).
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from math import floor
from typing import Callable, Optional, Sequence

WAD = 10**18
BAR = 300
DAY = 86_400
WINSOR_C = 4
MAD_SCALE = Fraction(14826, 10000)


@dataclass(frozen=True)
class Window:
    start: int      # first point time (inclusive)
    end: int        # last point time (inclusive) = cutoff
    bars: int       # valid bars used


def _median(xs: Sequence[int]) -> Fraction:
    s = sorted(xs)
    n = len(s)
    if n == 0:
        raise ValueError("no returns")
    return Fraction(s[n // 2]) if n % 2 else Fraction(s[n // 2 - 1] + s[n // 2], 2)


def mad(xs: Sequence[int]) -> Fraction:
    m = _median(xs)
    return _median_frac([abs(Fraction(x) - m) for x in xs])


def _median_frac(xs: list[Fraction]) -> Fraction:
    s = sorted(xs)
    n = len(s)
    return s[n // 2] if n % 2 else (s[n // 2 - 1] + s[n // 2]) / 2


def _div0(a: int, b: int) -> int:
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b > 0) else -q


PointFn = Callable[[int], tuple[Optional[int], Optional[int]]]   # t -> (P_A WAD or None, P_B WAD or None)


def returns(points: PointFn, first: int, last: int, log_ratio) -> list[tuple[int, int, int]]:
    """(t_k, r_A, r_B) of the valid bars with t_k in (first, last]."""
    out = []
    prev = points(first)
    for t in range(first + BAR, last + 1, BAR):
        cur = points(t)
        if None not in prev and None not in cur:
            out.append((t, log_ratio(prev[0], cur[0]), log_ratio(prev[1], cur[1])))
        prev = cur
    return out


def second_moments(rs: list[tuple[int, int, int]], cs_a: int, cs_b: int, winsorize, accumulate) -> tuple[int, int, int]:
    c = va = vb = 0
    for _, ra, rb in rs:
        c, va, vb = accumulate(c, va, vb, winsorize(ra, cs_a), winsorize(rb, cs_b))
    n = len(rs)
    if n == 0:
        raise ValueError("no valid bars in the window")
    return _div0(c, n), va // n, vb // n


def calibrate(points: PointFn, cutoff: int, tenor_days: int, w: int, fp) -> dict:
    """fp: the fixed-point module (verifier/corrfi_verifier/fixedpoint.py). w in WAD."""
    if cutoff % BAR:
        raise ValueError("cutoff must be a 5-minute boundary")
    if not 0 <= w <= WAD:
        raise ValueError("w must be in [0, WAD]")
    first = cutoff - 180 * DAY
    rs = returns(points, first, cutoff, fp.log_ratio)
    since = lambda days: [r for r in rs if r[0] > cutoff - days * DAY]
    r30, r90, rT = since(30), since(90), since(tenor_days)

    def scale(i: int) -> int:
        s30 = floor(MAD_SCALE * mad([r[i] for r in r30]))
        s_floor = floor(MAD_SCALE * mad([r[i] for r in rs]) / 2)
        return max(s30, s_floor)

    s_a, s_b = scale(1), scale(2)
    cs_a, cs_b = WINSOR_C * s_a, WINSOR_C * s_b
    long_ = second_moments(r90, cs_a, cs_b, fp.winsorize, fp.accumulate)
    recent = second_moments(rT, cs_a, cs_b, fp.winsorize, fp.accumulate)
    s_ab = _div0(w * long_[0] + (WAD - w) * recent[0], WAD)
    s_a2 = (w * long_[1] + (WAD - w) * recent[1]) // WAD
    s_b2 = (w * long_[2] + (WAD - w) * recent[2]) // WAD
    checks = {
        "positive_variances": s_a2 > 0 and s_b2 > 0,
        "psd": s_ab * s_ab <= s_a2 * s_b2,
        "diag_a": s_a2 <= cs_a * cs_a // WAD,
        "diag_b": s_b2 <= cs_b * cs_b // WAD,
    }
    return {
        "cutoffExclusive": cutoff,
        "maxBarOpenTime": cutoff - 60,
        "tenorDays": tenor_days,
        "windows": {
            "scale30": Window(cutoff - 30 * DAY, cutoff, len(r30)).__dict__,
            "scaleFloor180": Window(first, cutoff, len(rs)).__dict__,
            "long90": Window(cutoff - 90 * DAY, cutoff, len(r90)).__dict__,
            "recent": Window(cutoff - tenor_days * DAY, cutoff, len(rT)).__dict__,
        },
        "sA": str(s_a), "sB": str(s_b),
        "sigmaLong": [str(x) for x in long_], "sigmaRecent": [str(x) for x in recent],
        "w": str(w),
        "sAB": str(s_ab), "sA2": str(s_a2), "sB2": str(s_b2),
        "checks": checks,
    }
