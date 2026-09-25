"""Price grids for the backtest (B §2.2): the venue median of the 60-second VWAP at every minute, built with the
production rule (data/aquacorr_data/grid.py: exact rationals, >= 3 valid venues, WAD truncation). The 5-minute grid
is the subset t % 300 == 0 (the reporter's points); the 1-minute grid measures the moves inside a bar (B1, B4).

Cached per symbol in .cache/backtest/grid_<SYMBOL>.npz:
  t0 (first grid time), step 60, hi / lo (WAD = hi * 10^9 + lo, exact), valid, nvenues. Grid times cover
  [start, end] — the point at `end` uses the last stored minute (end - 60).
    python -m backtest.grid [--start 2024-03-01] [--end 2026-09-25]
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data"))

from aquacorr_data import SYMBOLS, VENUES                   # noqa: E402
from aquacorr_data.build import MonthCache                  # noqa: E402
from aquacorr_data.grid import price_point                  # noqa: E402

STORE = ROOT / "data" / "store" / "1m"
CACHE = ROOT / ".cache" / "backtest"
SPLIT = 10**9


def ts(day: str) -> int:
    return int(datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())


def _month_bounds(start: int, end: int) -> list[tuple[int, int]]:
    out, t = [], start
    while t < end:
        d = datetime.fromtimestamp(t, tz=timezone.utc)
        nxt = datetime(d.year + (d.month == 12), d.month % 12 + 1, 1, tzinfo=timezone.utc)
        stop = min(int(nxt.timestamp()), end)
        out.append((t, stop))
        t = stop
    return out


def _chunk(args: tuple[str, int, int]) -> tuple[int, np.ndarray, np.ndarray, np.ndarray, np.ndarray]:
    symbol, start, stop = args
    lookup = MonthCache(STORE, symbol, keep=2)
    n = (stop - start) // 60
    hi = np.zeros(n, np.int64)
    lo = np.zeros(n, np.int64)
    valid = np.zeros(n, bool)
    nv = np.zeros(n, np.int8)
    for i in range(n):
        pp = price_point(start + 60 * i, VENUES, lookup)
        nv[i] = pp.n_valid_venues
        if pp.price_wad is not None:
            hi[i], lo[i] = divmod(pp.price_wad, SPLIT)
            valid[i] = True
    return start, hi, lo, valid, nv


def build(symbol: str, start: int, end: int, workers: int) -> Path:
    jobs = [(symbol, a, b) for a, b in _month_bounds(start, end)]
    with ProcessPoolExecutor(workers) as ex:
        parts = sorted(ex.map(_chunk, jobs), key=lambda x: x[0])
    hi = np.concatenate([p[1] for p in parts])
    lo = np.concatenate([p[2] for p in parts])
    valid = np.concatenate([p[3] for p in parts])
    nv = np.concatenate([p[4] for p in parts])
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / f"grid_{symbol}.npz"
    np.savez_compressed(path, t0=start, step=60, hi=hi, lo=lo, valid=valid, nvenues=nv)
    return path


class Grid:
    """Loaded 1-minute grid of one symbol."""

    def __init__(self, symbol: str):
        z = np.load(CACHE / f"grid_{symbol}.npz")
        self.symbol = symbol
        self.t0 = int(z["t0"])
        self.hi, self.lo, self.valid, self.nvenues = z["hi"], z["lo"], z["valid"], z["nvenues"]
        self.price = np.where(self.valid, self.hi.astype(np.float64) * 1e-9 + self.lo.astype(np.float64) * 1e-18, np.nan)

    def index(self, t: int) -> int:
        if (t - self.t0) % 60:
            raise ValueError("not on the minute grid")
        return (t - self.t0) // 60

    def wad(self, t: int) -> int | None:
        i = self.index(t)
        return int(self.hi[i]) * SPLIT + int(self.lo[i]) if self.valid[i] else None

    @property
    def end(self) -> int:
        return self.t0 + 60 * len(self.valid)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", default="2024-03-01")
    ap.add_argument("--end", default="2026-09-25")
    ap.add_argument("--workers", type=int, default=12)
    a = ap.parse_args()
    for s in SYMBOLS:
        p = build(s, ts(a.start), ts(a.end) + 60, a.workers)
        g = Grid(s)
        print(f"{p.name}: {len(g.valid)} minutes, valid {g.valid.mean():.6f}, venue counts {np.bincount(g.nvenues)}")


if __name__ == "__main__":
    main()
