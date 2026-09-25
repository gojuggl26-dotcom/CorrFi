"""Pagination tests for the venue adapters against simulated endpoints.

Each simulator reproduces the measured semantics in docs/s02/01-venue-api-survey.md (inclusive / exclusive
bounds, page size, order, time unit, column order). The dataset has gaps, so time-driven paging is exercised.
"""
from urllib.parse import parse_qs, urlparse

import pytest

from aquacorr_data.venues import ADAPTERS, VenueError

START = 1_709_251_200            # 2024-03-01 00:00 UTC
END = START + 5_000 * 60         # 5,000 minutes (several pages everywhere)
NOW = END + 3600
GAPS = set(range(START + 600 * 60, START + 800 * 60, 60)) | {START + 60, END - 60}
TIMES = [t for t in range(START - 400 * 60, END + 400 * 60, 60) if t not in GAPS]


def row(t):
    """price p, base b, quote q per minute (strings); q/b = p exactly."""
    i = (t - START) // 60
    p, b = str(3000 + i % 7), str(1 + i % 3)
    return p, b, str(int(p) * int(b))


def params(url):
    return {k: v[0] for k, v in parse_qs(urlparse(url).query).items()}


def sim_binance(url):
    q = params(url)
    lo, hi, lim = int(q["startTime"]) // 1000, int(q["endTime"]) // 1000, int(q["limit"])
    sel = [t for t in TIMES if lo <= t <= hi][:lim]
    return [[t * 1000, *(row(t)[0],) * 4, row(t)[1], t * 1000 + 59_999, row(t)[2], 1, "0", "0", "0"]
            for t in sel]


def sim_okx(url):
    q = params(url)
    before, lim = int(q["after"]) // 1000, int(q["limit"])
    sel = sorted((t for t in TIMES if t < before), reverse=True)[:lim]
    return {"code": "0", "data": [[str(t * 1000), *(row(t)[0],) * 4, row(t)[1], row(t)[2], row(t)[2], "1"]
                                  for t in sel]}


def sim_bybit(url):
    q = params(url)
    assert q["category"] == "spot"
    lo, hi, lim = int(q["start"]) // 1000, int(q["end"]) // 1000, int(q["limit"])
    sel = sorted((t for t in TIMES if lo <= t <= hi), reverse=True)[:lim]
    return {"retCode": 0, "result": {"list": [[str(t * 1000), *(row(t)[0],) * 4, row(t)[1], row(t)[2]]
                                              for t in sel]}}


def sim_bitget(url):
    q = params(url)
    before, lim = int(q["endTime"]) // 1000, int(q["limit"])
    assert lim <= 200
    sel = [t for t in TIMES if t < before][-lim:]
    return {"code": "00000", "data": [[str(t * 1000), *(row(t)[0],) * 4, row(t)[1], row(t)[2], row(t)[2]]
                                      for t in sel]}


def sim_kucoin(url):
    q = params(url)
    lo, hi = int(q["startAt"]), int(q["endAt"])
    sel = sorted((t for t in TIMES if lo <= t < hi), reverse=True)
    assert len(sel) <= 1500
    # time, open, close, high, low, volume, turnover -- give distinct o/c/h/l to test the column order
    return {"code": "200000", "data": [[str(t), "1", "2", "9", "0.5", row(t)[1], row(t)[2]] for t in sel]}


SIMS = {"binance": sim_binance, "okx": sim_okx, "bybit": sim_bybit, "bitget": sim_bitget, "kucoin": sim_kucoin}


@pytest.mark.parametrize("venue", sorted(SIMS))
def test_returns_exactly_the_window(venue):
    calls = []

    def get_json(url):
        calls.append(url)
        return SIMS[venue](url)

    bars = ADAPTERS[venue].fetch(get_json, "ETHUSDT", START, END, NOW)
    got = sorted(b.open_time for b in bars)
    assert got == [t for t in TIMES if START <= t < END]
    assert len(set(got)) == len(got)
    for b in bars:
        p, base, quote = row(b.open_time)
        assert (b.base_volume, b.quote_volume) == (base, quote)
    assert len(calls) > 1   # paginated


def test_kucoin_column_order():
    bars = ADAPTERS["kucoin"].fetch(sim_kucoin, "ETHUSDT", START, START + 120, NOW)
    b = bars[0]
    assert (b.open, b.high, b.low, b.close) == ("1", "9", "0.5", "2")


@pytest.mark.parametrize("venue", sorted(SIMS))
def test_unclosed_bars_are_dropped(venue):
    now = START + 10 * 60 + 30            # the 00:10 bar is still open
    bars = ADAPTERS[venue].fetch(SIMS[venue], "ETHUSDT", START, START + 20 * 60, now)
    assert max(b.open_time for b in bars) == START + 9 * 60


def test_api_error_raises():
    with pytest.raises(VenueError):
        ADAPTERS["okx"].fetch(lambda url: {"code": "50011", "msg": "rate limit"}, "ETHUSDT", START, END, NOW)


def test_symbol_mapping():
    assert ADAPTERS["okx"].symbol("BTCUSDT") == "BTC-USDT"
    assert ADAPTERS["kucoin"].symbol("ETHUSDT") == "ETH-USDT"
    assert ADAPTERS["binance"].symbol("ETHUSDT") == "ETHUSDT"
