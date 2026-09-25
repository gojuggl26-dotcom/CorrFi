"""Price-point vectors for the TypeScript reporter (engine/src/prices.ts) from the S02 Python implementation.

Each case carries the venues' raw 1-minute bars (decimal strings as delivered) and the WAD price that
data/aquacorr_data/grid.py computes, so the TypeScript test needs no market-data store.

Cases: one full UTC day of the 5-minute grid, grid times of one month where fewer than five venues are valid,
and synthetic edge cases (even count, fewer than three, zero base volume, non-positive quote, exponent strings).

Needs the local store (data/store/1m, not in git); the committed JSON is the reference.
    python vectors/gen_price_points.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data"))

from aquacorr_data import SYMBOLS, VENUES                      # noqa: E402
from aquacorr_data.build import MonthCache, grid_times         # noqa: E402
from aquacorr_data.grid import price_point                     # noqa: E402
from aquacorr_data.store import MinuteBar                      # noqa: E402

STORE = ROOT / "data" / "store" / "1m"
OUT = ROOT / "vectors" / "price_points.json"
DAY = 1_735_689_600          # 2025-01-01 00:00 UTC
SCAN = (1_785_542_400, 1_788_220_800)   # 2026-08 (the month with the most zero-volume minutes)
MAX_SCAN_CASES = 60


def bar_json(b: MinuteBar | None):
    if b is None:
        return None
    return {"openTime": b.open_time, "open": b.open, "high": b.high, "low": b.low, "close": b.close,
            "baseVolume": b.base_volume, "quoteVolume": b.quote_volume}


def case(t: int, lookups: dict[str, MonthCache], note: str) -> dict:
    out = {"t": t, "note": note}
    for asset, sym in zip(("A", "B"), SYMBOLS):
        lk = lookups[sym]
        bars = {v: lk(v, t - 60) for v in VENUES}
        pp = price_point(t, VENUES, lambda v, ot: bars[v])
        out[asset] = {"bars": {v: bar_json(bars[v]) for v in VENUES},
                      "priceWad": None if pp.price_wad is None else str(pp.price_wad),
                      "nValid": pp.n_valid_venues}
    return out


def synthetic() -> list[dict]:
    t = 1_700_000_100 - (1_700_000_100 % 300)

    def b(base: str, quote: str) -> MinuteBar:
        return MinuteBar(t - 60, "1", "1", "1", "1", base, quote)

    sets = {
        "even count (4 venues): mean of the middle two": {"binance": b("2", "5000.1"), "okx": b("1", "2500.3"),
                                                          "bybit": b("3", "7500.9"), "bitget": b("4", "10000.8"),
                                                          "kucoin": None},
        "two venues only: invalid": {"binance": b("1", "3000"), "okx": b("1", "3001"), "bybit": None,
                                     "bitget": None, "kucoin": None},
        "zero base volume counts as missing": {"binance": b("0", "0"), "okx": b("1", "3001"),
                                               "bybit": b("1", "3002"), "bitget": b("1", "3003"),
                                               "kucoin": b("0.000", "0")},
        "non-positive quote counts as missing": {"binance": b("1", "0"), "okx": b("1", "3001"),
                                                 "bybit": b("1", "3002"), "bitget": b("1", "3003"),
                                                 "kucoin": b("1", "3004")},
        "exponent and long decimals": {"binance": b("1e-3", "3.0005"), "okx": b("0.0010000", "3.00049999"),
                                       "bybit": b("1E-3", "3.000500000000000001"), "bitget": b("2e0", "6000.9"),
                                       "kucoin": b("0.001", "3.0004")},
    }
    out = []
    for note, bars in sets.items():
        pp = price_point(t, VENUES, lambda v, ot: bars[v])
        entry = {"bars": {v: bar_json(bars[v]) for v in VENUES},
                 "priceWad": None if pp.price_wad is None else str(pp.price_wad), "nValid": pp.n_valid_venues}
        out.append({"t": t, "note": note, "A": entry, "B": entry})
    return out


def main() -> None:
    lookups = {sym: MonthCache(STORE, sym) for sym in SYMBOLS}
    cases = [case(t, lookups, "full day 2025-01-01") for t in grid_times(DAY, DAY + 86_400, 300)]
    scanned = 0
    for t in grid_times(*SCAN, 300):
        c = case(t, lookups, "2026-08 fewer than five valid venues")
        if c["A"]["nValid"] < 5 or c["B"]["nValid"] < 5:
            cases.append(c)
            scanned += 1
            if scanned >= MAX_SCAN_CASES:
                break
    cases += synthetic()
    OUT.write_text(json.dumps({"source": "data/aquacorr_data/grid.py", "venues": list(VENUES),
                               "cases": cases}, indent=1) + "\n", encoding="utf-8", newline="\n")
    print(f"{OUT.name}: {len(cases)} cases ({scanned} with missing venues)")


if __name__ == "__main__":
    main()
