"""Tests of the Python fixed-point port against exact / 50-digit references (docs/s01/01-fixed-point-spec.md)."""
import random
from decimal import Decimal, getcontext
from fractions import Fraction

import pytest

import refmath  # S00 exact-rational curve model
from corrfi_verifier import fixedpoint as fp
from corrfi_verifier.fixedpoint import WAD, Curve

getcontext().prec = 60
U = fp.UNIT


# ---- lnWad ----------------------------------------------------------------------------------------------------

def ln_exact_wad(x: int) -> Decimal:
    return (Decimal(x) / Decimal(WAD)).ln() * Decimal(WAD)


@pytest.mark.parametrize("x", [1, 2, 10**9, WAD - 1, WAD, WAD + 1, 2 * WAD, 10**30, 2**255 - 1])
def test_ln_wad_edges_close_to_exact(x):
    assert abs(Decimal(fp.ln_wad(x)) - ln_exact_wad(x)) < 2


def test_ln_wad_random_error_and_monotone():
    rng = random.Random(1)
    worst = Decimal(0)
    xs = sorted(rng.randrange(WAD // 2, 2 * WAD) for _ in range(3000))   # price ratios within |ln| <= ~0.7
    prev = None
    for x in xs:
        y = fp.ln_wad(x)
        worst = max(worst, abs(Decimal(y) - ln_exact_wad(x)))
        if prev is not None:
            assert y >= prev          # monotone (Solady's documented property)
        prev = y
    assert worst < 2                  # |error| < 2 wei (measured bound; recorded in the S01 report)


def test_ln_wad_rejects_non_positive():
    for x in (0, -1):
        with pytest.raises(fp.FixedPointError):
            fp.ln_wad(x)


def test_errors_where_solidity_reverts():
    # review S03-5: every Solidity revert is a FixedPointError (the vector generators record them as "revert")
    with pytest.raises(fp.FixedPointError):
        fp.tau(0, 0)
    with pytest.raises(fp.FixedPointError):
        fp.sigma_bar2_update(10**12, 10**15, 1, WAD + 1)
    assert fp.sigma_bar2_update(10**12, 10**15, 1, WAD) == 10**12


# ---- settlement statistic -------------------------------------------------------------------------------------

def test_signed_division_truncates_toward_zero():
    assert fp.div0(-7, 2) == -3 and fp.div0(7, -2) == -3 and fp.div0(-7, -2) == 3
    assert fp.floor_div(-7, 2) == -4


def test_rho_and_long_t_close_to_high_precision():
    rng = random.Random(2)
    worst = 0.0
    for _ in range(300):
        c = va = vb = 0
        for _ in range(rng.randint(5, 200)):
            ra = fp.winsorize(rng.randint(-10**16, 10**16), 8 * 10**15)
            rb = fp.winsorize(ra // 2 + rng.randint(-5 * 10**15, 5 * 10**15), 8 * 10**15)
            c, va, vb = fp.accumulate(c, va, vb, ra, rb)
        l, void = fp.long_t(c, va, vb, 1, 1)
        exact = (Decimal(c) / (Decimal(va) * Decimal(vb)).sqrt() + 1) / 2
        worst = max(worst, abs(float(Decimal(l) / WAD - exact)))
    assert worst < 1e-12        # R §7.2 expects ~1e-12; V2 tolerance is 1e-9


def test_void_rules():
    assert fp.long_t(5, 0, 7, 10, 1) == (WAD // 2, True)
    assert fp.long_t(5, 3, 7, 0, 1) == (WAD // 2, True)


def test_payout_never_exceeds_reserve_or_collateral():
    rng = random.Random(3)
    for _ in range(2000):
        l = rng.randrange(0, WAD + 1)
        holders = [(rng.randrange(0, 10**12), rng.randrange(0, 10**12)) for _ in range(5)]
        sl, ss = sum(h[0] for h in holders), sum(h[1] for h in holders)
        paid = sum(fp.payout(a, b, l) for a, b in holders)
        assert paid <= fp.reserve(sl, ss, l)
        if sl == ss:
            assert paid <= sl      # A4 / S1: collateral = supply before settlement


# ---- fair value, table, spreads ------------------------------------------------------------------------------

def test_fair_value_uses_forecast_only_at_tau0():
    # nObs = 0: rho = sAB / sqrt(sA2 sB2)
    p = fp.fair_value(0, 0, 0, 0, 2016, 6 * 10**11, 10**12, 10**12)
    assert p == (WAD * 6 // 10 + WAD) // 2


def test_sigma_p_interpolation_matches_exact():
    table = [4 * 10**16 * (19 - 2 * i) // 20 for i in range(10)]    # PROP-08 provisional 7D table
    assert table[0] == 38 * 10**15 and table[9] == 2 * 10**15
    for t in [0, 1, 5 * 10**16, 5 * 10**16 + 1, 10**17, 5 * 10**17, 95 * 10**16, 97 * 10**16, WAD - 1, WAD]:
        got = fp.sigma_p(t, table)
        exact = max(Fraction(0), min(Fraction(38, 1000), Fraction(4, 100) * (1 - Fraction(t, WAD))))
        assert abs(Fraction(got, WAD) - exact) <= Fraction(1, WAD)


def test_h0_provisional_7d_at_tau0():
    table = [4 * 10**16 * (19 - 2 * i) // 20 for i in range(10)]
    assert fp.h0(0, table, 15 * 10**16, 5 * 10**15) == 57 * 10**14       # 0.0057 (OI-11)


def test_h_o_matches_doc_example():
    sig2 = fp.sigma_bar2_init(8 * 10**14)                                # sigma_bar = 0.0008
    assert abs(fp.h_o(10, sig2, 2 * WAD) - 292_119_000_000_000) < 10**9  # 0.000292119 (S00 check)
    assert fp.h_o(0, sig2, 2 * WAD) == 0


def test_h_u_curve():
    assert fp.h_u(6 * 10**17, 2 * 10**16, 6 * 10**17, 9 * 10**17) == 0
    assert fp.h_u(9 * 10**17, 2 * 10**16, 6 * 10**17, 9 * 10**17) == 2 * 10**16


# ---- path integral -------------------------------------------------------------------------------------------

# M App. A with a slope of exactly 1/300,000 per token: kq = 0.2, qmax = 60,000 tokens
APP_A = Curve(p=9 * 10**17, h=5 * 10**15, hmin=5 * 10**15, kq=2 * 10**17, qmax=60_000 * U)


def test_appendix_a_examples_exact():
    assert fp.pay_d1(APP_A, 0, 3000 * U) == 2730 * U
    assert fp.qty_d1_exact_in(APP_A, 0, 1000 * U) == 1_102_732_928
    assert fp.receive_d2(APP_A, 0, 3000 * U) == 2670 * U
    assert fp.qty_d2_exact_out(APP_A, 0, 1000 * U) == 1_119_652_929
    assert fp.pay_d1(APP_A, 0, 3000 * U) - fp.receive_d2(APP_A, -3000 * U, 3000 * U) == 45 * U   # DEC-09


def random_curve(rng):
    p = rng.randrange(2 * 10**16, 98 * 10**16)
    hmin = rng.randrange(5 * 10**15, 12 * 10**15)
    h = hmin + rng.choice([0, rng.randrange(0, 2 * 10**16)])
    kq = rng.choice([WAD // 6, 2 * 10**17, rng.randrange(10**16, 3 * 10**17)])
    return Curve(p, h, hmin, kq, rng.choice([50_000, 15_000, 60_000]) * U)


def exact(c: Curve):
    return refmath.Curve(Fraction(c.p, WAD), Fraction(c.h, WAD), Fraction(c.hmin, WAD),
                         Fraction(c.kq, WAD) / Fraction(c.qmax, U))


def test_integral_matches_exact_rational_model():
    rng = random.Random(4)
    mismatches = 0
    for _ in range(1500):
        c = random_curve(rng)
        e = exact(c)
        q0 = rng.randrange(-60_000 * U, 60_000 * U)
        q = rng.randrange(1, 5000 * U)
        got = (fp.pay_d1(c, q0, q), fp.receive_d2(c, q0, q))
        want = (refmath.units_ceil(e.integral(e.alpha, Fraction(q0 - q, U), Fraction(q0, U))),
                refmath.units_floor(e.integral(e.beta, Fraction(q0, U), Fraction(q0 + q, U))))
        if got != want:
            mismatches += 1
            assert all(abs(g - w) <= 1 for g, w in zip(got, want))
    assert mismatches <= 2      # only breakpoint rounding (spec F16) can move a result, by at most 1 unit


def test_directions_are_mirrors_and_taker_unfavourable():
    rng = random.Random(5)
    for _ in range(500):
        c = random_curve(rng)
        q0, q = rng.randrange(-50_000 * U, 50_000 * U), rng.randrange(1, 5000 * U)
        # buying Short costs Q - (what selling Long receives); selling Short receives Q - (buying Long cost)
        assert fp.pay_d3(c, q0, q) == q - fp.receive_d2(c, q0, q)
        assert fp.receive_d4(c, q0, q) == q - fp.pay_d1(c, q0, q)
        # F3: book vs vault — Long + Short from the book cost at least Q (mint price), selling both yields <= Q
        assert fp.pay_d1(c, q0, q) + fp.pay_d3(c, q0 - q, q) >= q


@pytest.mark.parametrize("seed", range(4))
def test_inverse_is_exact_extremum(seed):
    rng = random.Random(100 + seed)
    for _ in range(300):
        c = random_curve(rng)
        q0 = rng.randrange(-40_000 * U, 40_000 * U)
        x = rng.randrange(1 * U, 3000 * U)
        q = fp.qty_d1_exact_in(c, q0, x)
        assert fp.pay_d1(c, q0, q) <= x < fp.pay_d1(c, q0, q + 1)
        q = fp.qty_d3_exact_in(c, q0, x)
        assert fp.pay_d3(c, q0, q) <= x < fp.pay_d3(c, q0, q + 1)
        try:
            q = fp.qty_d2_exact_out(c, q0, x)
            assert fp.receive_d2(c, q0, q) >= x > fp.receive_d2(c, q0, q - 1)
        except fp.FixedPointError:
            assert fp.receive_d2(c, q0, 10**15) < x            # really too thin
        try:
            q = fp.qty_d4_exact_out(c, q0, x)
            assert fp.receive_d4(c, q0, q) >= x > fp.receive_d4(c, q0, q - 1)
        except fp.FixedPointError:
            assert fp.receive_d4(c, q0, 10**15) < x
