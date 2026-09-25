"""Walk-forward splits, moving-block bootstrap and isotonic regression (B §3, docs/s06/00-criteria.md P1-P3, P5)."""
from __future__ import annotations

from datetime import datetime, timezone

import numpy as np

from backtest.grid import ts

DAY = 86_400
INITIAL_END = ts("2025-09-01")   # windows starting before this are calibration only (12 months, P1)
SEED = 20260926
REPS = 1_000


def month_starts(first: int, last_start: int) -> list[int]:
    """UTC month starts from `first` while a window can still start in that month."""
    out = []
    d = datetime.fromtimestamp(first, tz=timezone.utc)
    t = first
    while t <= last_start:
        out.append(t)
        d = datetime(d.year + (d.month == 12), d.month % 12 + 1, 1, tzinfo=timezone.utc)
        t = int(d.timestamp())
    return out


def eval_months(starts: np.ndarray) -> list[tuple[int, np.ndarray]]:
    """(month start, indices of windows starting in that month) for the evaluation months (P1)."""
    ms = month_starts(INITIAL_END, int(starts.max()))
    out = []
    for a, b in zip(ms, ms[1:] + [2**62]):
        idx = np.where((starts >= a) & (starts < b))[0]
        if len(idx):
            out.append((a, idx))
    return out


def calibration(starts: np.ndarray, T: int, month_start: int) -> np.ndarray:
    """Windows whose result is known at the start of the month: obsEnd = start + T days <= month start (C2)."""
    return np.where(starts + T * DAY <= month_start)[0]


def is_eval(starts: np.ndarray) -> np.ndarray:
    return starts >= INITIAL_END


def block_indices(n: int, block: int, reps: int = REPS, seed: int = SEED) -> np.ndarray:
    """Moving-block bootstrap of a sequence of n consecutive daily windows: reps x n indices (P3)."""
    rng = np.random.default_rng(seed)
    block = max(1, min(block, n))
    k = -(-n // block)
    first = rng.integers(0, n - block + 1, size=(reps, k))
    idx = (first[:, :, None] + np.arange(block)[None, None, :]).reshape(reps, -1)[:, :n]
    return idx


def ci90(x: np.ndarray) -> tuple[float, float]:
    lo, hi = np.percentile(x, [5, 95])
    return float(lo), float(hi)


def rmse(e: np.ndarray, axis=None) -> np.ndarray | float:
    return np.sqrt(np.mean(np.square(e), axis=axis))


def isotonic_nonincreasing(y: np.ndarray, w: np.ndarray) -> np.ndarray:
    """Weighted least-squares fit that does not increase (pool adjacent violators)."""
    vals: list[float] = []
    wts: list[float] = []
    lens: list[int] = []
    for yi, wi in zip(map(float, y), map(float, w)):
        vals.append(yi)
        wts.append(wi)
        lens.append(1)
        while len(vals) > 1 and vals[-2] < vals[-1]:
            v = (vals[-2] * wts[-2] + vals[-1] * wts[-1]) / (wts[-2] + wts[-1])
            wt = wts[-2] + wts[-1]
            ln = lens[-2] + lens[-1]
            vals[-2:], wts[-2:], lens[-2:] = [v], [wt], [ln]
    return np.repeat(vals, lens)


def sigma_p(t: np.ndarray, table: np.ndarray) -> np.ndarray:
    """F9 in float: values at bin midpoints (2i+1)/20, linear in between, first value before the first midpoint,
    linear to 0 at τ = 1."""
    mids = np.concatenate([(2 * np.arange(10) + 1) / 20, [1.0]])
    vals = np.concatenate([table, [0.0]])
    return np.interp(t, mids, vals, left=table[0])
