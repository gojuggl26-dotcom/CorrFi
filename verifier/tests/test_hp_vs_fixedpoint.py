"""Fixed-point settlement (V3 path) vs the 50-digit reference (V2 path) on synthetic price series.

R §7.1 V2 requires |ΔLong_T| <= 1e-9; R §7.2 estimates ~1e-12. Synthetic data only (not market data).
"""
import math
import random
from decimal import Decimal

from corrfi_verifier import fixedpoint as fp
from corrfi_verifier import hp

WAD = fp.WAD


def gbm_pair(rng, n, rho, sigma=0.0025, p0a=3000.0, p0b=60000.0, invalid=0):
    """Two correlated 5-minute log-price walks as WAD integers; `invalid` price points set to None."""
    pa, pb = [int(p0a * WAD)], [int(p0b * WAD)]
    for _ in range(n):
        z1, z2 = rng.gauss(0, 1), rng.gauss(0, 1)
        ea = sigma * z1
        eb = sigma * (rho * z1 + math.sqrt(1 - rho * rho) * z2)
        if rng.random() < 0.001:                       # occasional fat tail -> exercises winsorize
            ea *= 8
        pa.append(max(1, int(pa[-1] * math.exp(ea))))
        pb.append(max(1, int(pb[-1] * math.exp(eb))))
    for k in rng.sample(range(n + 1), invalid):
        (pa if rng.random() < 0.5 else pb)[k] = None
    return pa, pb


def test_long_t_fixed_point_within_v2_tolerance():
    rng = random.Random(11)
    worst = Decimal(0)
    for trial in range(12):
        n = 2016
        pa, pb = gbm_pair(rng, n, rho=rng.uniform(-0.3, 0.95), invalid=trial % 4)
        s_a = s_b = int(0.0025 * WAD)
        l_fp, void_fp, *_ = fp.settle_from_prices(pa, pb, s_a, s_b, 4, 1996)
        rho_hp, l_hp, void_hp, _ = hp.settle(pa, pb, s_a, s_b, 4, 1996)
        assert void_fp == void_hp
        worst = max(worst, abs(Decimal(l_fp) / WAD - l_hp))
    assert worst <= Decimal("1e-9")        # V2 acceptance
    assert worst <= Decimal("1e-12")       # R §7.2 estimate (tighter; documents the measured margin)


def test_void_when_too_many_invalid_points():
    rng = random.Random(12)
    pa, pb = gbm_pair(rng, 2016, rho=0.8, invalid=15)   # R §6.3: 15 non-adjacent points -> <= 1,986 valid
    l_fp, void, *_ , n_valid = fp.settle_from_prices(pa, pb, int(0.0025 * WAD), int(0.0025 * WAD), 4, 1996)
    assert void and l_fp == WAD // 2 and n_valid <= 2016 - 15
