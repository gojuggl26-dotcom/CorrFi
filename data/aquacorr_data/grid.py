"""Price points from 1-minute bars (M §2.5.1 p.8, R §3.1 p.7, B §2.2 p.4).

For a grid time t (a 5-minute boundary for the settlement grid, any minute for the 1-minute grid):
  - venue v is valid at t iff its 1-minute bar with open_time = t - 60 exists and base_volume > 0;
    its VWAP over [t-60, t) is quote_volume / base_volume (R §3.1 p.7);
  - the asset price is valid iff >= 3 venues are valid; it is their median, and with an even count
    the mean of the middle two; it is converted to WAD by truncation (M §2.5.1 p.8, R §3.1.1 p.7).

Arithmetic is exact (Fractions built from the venue's decimal strings), so the WAD result does not depend
on a working precision. R §3.1.2 asks for >= 50 significant digits; exact rationals satisfy that strictly.

Implementation decision (S02, recorded in docs/s02): a bar with base_volume > 0 but quote_volume <= 0 would
give a non-positive VWAP, which BarFeed cannot accept (M §6.2.1 p.29, prices are positive); such a venue is
treated as invalid for that minute and reported as an anomaly.
"""
from __future__ import annotations

from dataclasses import dataclass
from fractions import Fraction
from math import floor
from typing import Callable, Mapping, Optional

from . import MIN_VALID_VENUES, VWAP_SECONDS
from .store import MinuteBar

WAD = 10**18

# Reasons a venue is invalid at a grid time (used by the quality report)
MISSING = "missing"
ZERO_BASE = "zero_base_volume"
BAD_QUOTE = "non_positive_quote_volume"


def venue_vwap(bar: Optional[MinuteBar]) -> tuple[Optional[Fraction], Optional[str]]:
    """(VWAP, None) if the venue is valid, else (None, reason)."""
    if bar is None:
        return None, MISSING
    base = Fraction(bar.base_volume)
    if base <= 0:
        return None, ZERO_BASE
    quote = Fraction(bar.quote_volume)
    if quote <= 0:
        return None, BAD_QUOTE
    return quote / base, None


def median(values: list[Fraction]) -> Fraction:
    if not values:
        raise ValueError("median of empty list")
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2


def to_wad(x: Fraction) -> int:
    """Truncate a positive price to WAD (R §3.1.2 p.7: '10^18 倍して切り捨てた整数')."""
    if x <= 0:
        raise ValueError("price must be positive")
    return floor(x * WAD)


@dataclass(frozen=True)
class PricePoint:
    t: int                         # grid time (seconds, UTC)
    price_wad: Optional[int]       # None when invalid
    n_valid_venues: int
    venue_vwap: Mapping[str, Optional[Fraction]]
    venue_reason: Mapping[str, Optional[str]]

    @property
    def valid(self) -> bool:
        return self.price_wad is not None


BarLookup = Callable[[str, int], Optional[MinuteBar]]   # (venue, open_time) -> bar or None


def price_point(t: int, venues: tuple[str, ...], lookup: BarLookup) -> PricePoint:
    if t % 60 != 0:
        raise ValueError("grid time must be on a minute boundary")
    vwaps: dict[str, Optional[Fraction]] = {}
    reasons: dict[str, Optional[str]] = {}
    for v in venues:
        vwaps[v], reasons[v] = venue_vwap(lookup(v, t - VWAP_SECONDS))
    valid = [x for x in vwaps.values() if x is not None]
    price = to_wad(median(valid)) if len(valid) >= MIN_VALID_VENUES else None
    return PricePoint(t, price, len(valid), vwaps, reasons)


def return_valid(eth_prev: PricePoint, eth: PricePoint, btc_prev: PricePoint, btc: PricePoint) -> bool:
    """Bar k is valid iff the four price points P_A,k-1, P_A,k, P_B,k-1, P_B,k are valid (M §2.5.3 p.8)."""
    return eth_prev.valid and eth.valid and btc_prev.valid and btc.valid
