"""Tests for price points (M §2.5.1 p.8, R §3.1 p.7). Fixtures are synthetic, not market data."""
from fractions import Fraction

import pytest

from aquacorr_data.grid import (BAD_QUOTE, MISSING, WAD, ZERO_BASE, median, price_point, return_valid,
                                to_wad, venue_vwap)
from aquacorr_data.store import MinuteBar

T = 1_700_000_100  # a 5-minute boundary (divisible by 300)
VENUES = ("binance", "okx", "bybit", "bitget", "kucoin")


def bar(open_time, base, quote, lo="1", hi="99999"):
    return MinuteBar(open_time, "0", hi, lo, "0", base, quote)


def lookup_from(table):
    return lambda venue, open_time: table.get((venue, open_time))


def test_grid_time_fixture_is_boundary():
    assert T % 300 == 0


def test_vwap_is_quote_over_base_exactly():
    v, why = venue_vwap(bar(T - 60, "2.5", "5000.125"))
    assert why is None and v == Fraction("5000.125") / Fraction("2.5")


@pytest.mark.parametrize("b,reason", [(None, MISSING), (bar(T - 60, "0", "0"), ZERO_BASE),
                                      (bar(T - 60, "0.000", "12"), ZERO_BASE),
                                      (bar(T - 60, "1", "0"), BAD_QUOTE)])
def test_invalid_venue_reasons(b, reason):
    assert venue_vwap(b) == (None, reason)


def test_uses_bar_opening_at_t_minus_60_only():
    table = {(v, T - 60): bar(T - 60, "1", "100") for v in VENUES[:3]}
    # bars opening exactly at t belong to the next window and must be ignored
    table.update({(v, T): bar(T, "1", "999") for v in VENUES})
    p = price_point(T, VENUES, lookup_from(table))
    assert p.price_wad == 100 * WAD and p.n_valid_venues == 3


def test_fewer_than_three_valid_venues_is_invalid():
    table = {(v, T - 60): bar(T - 60, "1", "100") for v in VENUES[:2]}
    table[(VENUES[2], T - 60)] = bar(T - 60, "0", "0")
    p = price_point(T, VENUES, lookup_from(table))
    assert not p.valid and p.n_valid_venues == 2
    assert p.venue_reason["bitget"] == MISSING and p.venue_reason["bybit"] == ZERO_BASE


def test_odd_median():
    prices = {"binance": "101", "okx": "99", "bybit": "100", "bitget": "250", "kucoin": "1"}
    table = {(v, T - 60): bar(T - 60, "1", p) for v, p in prices.items()}
    assert price_point(T, VENUES, lookup_from(table)).price_wad == 100 * WAD


def test_even_median_is_mean_of_middle_two_then_truncated():
    # four valid venues: 100, 100.1, 100.2, 300 -> (100.1 + 100.2) / 2 = 100.15
    prices = {"binance": "100", "okx": "100.1", "bybit": "100.2", "kucoin": "300"}
    table = {(v, T - 60): bar(T - 60, "1", p) for v, p in prices.items()}
    p = price_point(T, VENUES, lookup_from(table))
    assert p.n_valid_venues == 4 and p.price_wad == 100_150_000_000_000_000_000


def test_wad_truncates_not_rounds():
    assert to_wad(Fraction(2, 3)) == 666_666_666_666_666_666
    assert median([Fraction(1), Fraction(2)]) == Fraction(3, 2)


def test_vwap_with_many_digits_is_exact():
    # 1/3 style VWAP: quote 1000 / base 3 -> 333.333... truncated at 18 decimals
    table = {(v, T - 60): bar(T - 60, "3", "1000") for v in VENUES}
    assert price_point(T, VENUES, lookup_from(table)).price_wad == 333_333_333_333_333_333_333


def test_return_validity_needs_all_four_points():
    ok = price_point(T, VENUES, lookup_from({(v, T - 60): bar(T - 60, "1", "1") for v in VENUES}))
    bad = price_point(T, VENUES, lookup_from({}))
    assert return_valid(ok, ok, ok, ok)
    for i in range(4):
        pts = [ok, ok, ok, ok]
        pts[i] = bad
        assert not return_valid(*pts)
