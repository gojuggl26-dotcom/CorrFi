"""calib.py on synthetic price series whose MAD and second moments are known (M §2.5.2, §4.1.1; R §3.3)."""
from __future__ import annotations

import sys
from fractions import Fraction
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "verifier"))

from aquacorr_data.calib import BAR, DAY, WAD, calibrate, mad   # noqa: E402
from corrfi_verifier import fixedpoint as fp                     # noqa: E402

CUTOFF = 1_789_689_600


def test_mad_definition():
    assert mad([1, 2, 3, 4, 100]) == 1                 # median 3, deviations 2,1,0,1,97 -> 1
    assert mad([1, 2, 3, 4]) == Fraction(1)            # median 2.5, deviations 1.5,.5,.5,1.5 -> 1
    assert mad([-5, 5, -5, 5]) == 5


def _alternating(up_a: int, dn_a: int, up_b: int, dn_b: int):
    """Prices that alternate between two levels, so every return is ln(up/dn) or its negative."""
    def points(t: int):
        k = (t - (CUTOFF - 180 * DAY)) // BAR
        return (up_a if k % 2 else dn_a, up_b if k % 2 else dn_b)
    return points


def _mixed():
    """A alternates every bar (+r_A, -r_A, ...); B holds two bars per level (0, +r_B, 0, -r_B, ...): uncorrelated."""
    def points(t: int):
        k = (t - (CUTOFF - 180 * DAY)) // BAR
        return (2002 * WAD if k % 2 else 2000 * WAD, 60_030 * WAD if (k // 2) % 2 else 60_000 * WAD)
    return points


def test_scale_and_moments_on_a_known_series():
    c = calibrate(_mixed(), CUTOFF, 7, 3 * 10**17, fp)
    ra = fp.log_ratio(2000 * WAD, 2002 * WAD)            # +r ; the down move gives -r (lnWad is odd up to rounding)
    rb = fp.log_ratio(60_000 * WAD, 60_030 * WAD)
    assert abs(ra + fp.log_ratio(2002 * WAD, 2000 * WAD)) <= 2
    # A's returns alternate +r / -r: median (even count) ~ 0, MAD = r
    assert abs(int(c["sA"]) - int(Fraction(14826, 10000) * ra)) <= 2
    # B's returns are 0, +r, 0, -r: median 0, |deviations| half 0 and half r -> MAD = r / 2
    assert abs(int(c["sB"]) - int(Fraction(14826, 10000) * rb / 2)) <= 2
    assert c["checks"] == {"positive_variances": True, "psd": True, "diag_a": True, "diag_b": True}
    # no clipping (4 s > r): per-bar second moments r_A^2 / WAD and r_B^2 / (2 WAD); A and B uncorrelated
    assert abs(int(c["sA2"]) - ra * ra // WAD) <= ra // 10**6 + 1
    assert abs(int(c["sB2"]) - rb * rb // (2 * WAD)) <= rb // 10**6 + 1
    assert abs(int(c["sAB"])) <= int(c["sA2"]) // 1000
    w = c["windows"]
    assert (w["scale30"]["bars"], w["long90"]["bars"], w["recent"]["bars"], w["scaleFloor180"]["bars"]) == (8640, 25920, 2016, 51840)


def test_perfectly_comoving_series_is_flagged_not_emitted():
    """rho = 1 makes the per-bar truncations break sAB^2 <= sA2 sB2; createMarket would reject it (and P_fair = 1
    anyway), so make_calib refuses to write such a calib."""
    c = calibrate(_alternating(2002 * WAD, 2000 * WAD, 60_030 * WAD, 60_000 * WAD), CUTOFF, 7, 3 * 10**17, fp)
    assert c["checks"]["psd"] is False


def test_invalid_points_drop_both_adjacent_bars():
    base = _alternating(2002 * WAD, 2000 * WAD, 60_030 * WAD, 60_000 * WAD)
    hole = CUTOFF - 3 * DAY

    def pts(t: int):
        return (None, None) if t == hole else base(t)

    c = calibrate(pts, CUTOFF, 7, 3 * 10**17, fp)
    assert c["windows"]["recent"]["bars"] == 2016 - 2


def test_scale_floor_from_180_days_applies_when_the_last_30_days_are_calm():
    calm_since = CUTOFF - 30 * DAY
    wild = _alternating(2020 * WAD, 2000 * WAD, 60_300 * WAD, 60_000 * WAD)
    calm = _alternating(2000 * WAD + 10**15, 2000 * WAD, 60_000 * WAD + 10**15, 60_000 * WAD)

    def pts(t: int):
        return calm(t) if t > calm_since else wild(t)

    c = calibrate(pts, CUTOFF, 7, 3 * 10**17, fp)
    r_wild = fp.log_ratio(2000 * WAD, 2020 * WAD)
    # 30-day MAD is tiny; the floor 0.5 x 1.4826 x MAD(180 d) = 0.5 x 1.4826 x r_wild (5/6 of the sample is wild)
    assert abs(int(c["sA"]) - int(Fraction(7413, 10000) * r_wild)) <= 2


def test_bad_inputs():
    pts = _alternating(2002 * WAD, 2000 * WAD, 60_030 * WAD, 60_000 * WAD)
    with pytest.raises(ValueError):
        calibrate(pts, CUTOFF + 1, 7, 3 * 10**17, fp)
    with pytest.raises(ValueError):
        calibrate(pts, CUTOFF, 7, WAD + 1, fp)
