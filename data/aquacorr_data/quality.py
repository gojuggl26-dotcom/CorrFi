"""Data-quality measures of B §2.3 p.4 (the first half of B5).

| measure                              | threshold (B §2.3)      |
|--------------------------------------|-------------------------|
| per-venue acquisition rate (minutes) | >= 99% per venue        |
| valid 5-minute price points (asset)  | >= 99.5%                |
| venue dispersion vs. median          | record, flag outliers   |
| |ln(P_k / P_{k-1})| > 0.5            | 0 bars                  |
| VWAP vs. trades (1 day / quarter)    | < 1 bp  (needs trade data; not here) |

Only measures are computed here; deciding exclusions is a recorded human decision (B §2.3).
"""
from __future__ import annotations

import math
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from decimal import Decimal, localcontext
from fractions import Fraction
from pathlib import Path
from typing import Iterable

from .build import MonthCache, grid_times
from .grid import BAD_QUOTE, MISSING, PricePoint, WAD, ZERO_BASE
from .store import month_key


@dataclass
class VenueAcquisition:
    minutes: int = 0
    valid: int = 0
    reasons: Counter = field(default_factory=Counter)
    vwap_outside_range: int = 0   # quote/base outside [low, high] -> anomaly to report
    by_month: dict = field(default_factory=lambda: defaultdict(Counter))   # month -> Counter(reason/valid)

    @property
    def rate(self) -> float:
        return self.valid / self.minutes if self.minutes else float("nan")


def venue_acquisition(root: Path, symbol: str, venues: tuple[str, ...], t_start: int,
                      t_end: int) -> dict[str, VenueAcquisition]:
    """Share of minutes in [t_start, t_end) where the venue has a bar with base_volume > 0.

    Same validity rule as grid.venue_vwap. The [low, high] check uses exact decimal cross-multiplication
    (low*base <= quote <= high*base) instead of division, which is exact and much faster.
    """
    lookup = MonthCache(root, symbol)
    out = {v: VenueAcquisition() for v in venues}
    with localcontext() as ctx:
        ctx.prec = 80   # products of the venues' decimal strings stay exact at this precision
        for t in grid_times(t_start, t_end, 60):
            month = month_key(t)
            for v in venues:
                acc = out[v]
                acc.minutes += 1
                bar = lookup(v, t)
                if bar is None:
                    why = MISSING
                else:
                    base, quote = Decimal(bar.base_volume), Decimal(bar.quote_volume)
                    why = ZERO_BASE if base <= 0 else BAD_QUOTE if quote <= 0 else None
                if why is not None:
                    acc.reasons[why] += 1
                    acc.by_month[month][why] += 1
                    continue
                acc.valid += 1
                acc.by_month[month]["valid"] += 1
                if not Decimal(bar.low) * base <= quote <= Decimal(bar.high) * base:
                    acc.vwap_outside_range += 1
    return out


DISPERSION_THRESHOLDS = (0.001, 0.005, 0.01)   # |ln(vwap / median)|: 10 bp, 50 bp, 100 bp


@dataclass
class GridQuality:
    points: int = 0
    valid: int = 0
    venue_count_hist: Counter = field(default_factory=Counter)
    jumps_over_half: list = field(default_factory=list)       # (t, ln ratio) with |ln| > 0.5
    max_dispersion: dict = field(default_factory=dict)        # venue -> (max |ln(vwap/median)|, t)
    dispersion_over: dict = field(default_factory=lambda: defaultdict(Counter))  # venue -> {thr: count}
    invalid_times: list = field(default_factory=list)         # grid times with < 3 valid venues

    @property
    def valid_rate(self) -> float:
        return self.valid / self.points if self.points else float("nan")


def grid_quality(points: Iterable[PricePoint]) -> GridQuality:
    q = GridQuality()
    prev = None
    for p in points:
        q.points += 1
        q.venue_count_hist[p.n_valid_venues] += 1
        if not p.valid:
            q.invalid_times.append(p.t)
        if p.valid:
            q.valid += 1
            median = Fraction(p.price_wad, WAD)
            for v, x in p.venue_vwap.items():
                if x is None:
                    continue
                d = abs(math.log(x / median))
                if d > q.max_dispersion.get(v, (-1.0, None))[0]:
                    q.max_dispersion[v] = (d, p.t)
                for thr in DISPERSION_THRESHOLDS:
                    if d > thr:
                        q.dispersion_over[v][thr] += 1
            if prev is not None and prev.valid:
                r = math.log(p.price_wad / prev.price_wad)
                if abs(r) > 0.5:
                    q.jumps_over_half.append((p.t, r))
        prev = p
    return q
