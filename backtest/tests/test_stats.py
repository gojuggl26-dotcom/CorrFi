"""The walk-forward and bootstrap helpers (docs/s06/00-criteria.md P1-P3, P5)."""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from backtest.grid import ts                                          # noqa: E402
from backtest.stats import (DAY, block_indices, calibration, eval_months, isotonic_nonincreasing,  # noqa: E402
                            sigma_p)


def test_calibration_windows_end_before_the_month():
    starts = np.arange(ts("2025-07-01"), ts("2025-10-05"), DAY)
    m = ts("2025-09-01")
    cal = calibration(starts, 7, m)
    assert starts[cal].max() + 7 * DAY <= m          # obsEnd at or before the month start
    assert ts("2025-08-25") in starts[cal] and ts("2025-08-26") not in starts[cal]


def test_eval_months_cover_the_evaluation_period_only():
    starts = np.arange(ts("2024-09-01"), ts("2025-10-10"), DAY)
    months = eval_months(starts)
    assert [np.datetime64(m, "s").astype("datetime64[D]").astype(str) for m, _ in months] == ["2025-09-01", "2025-10-01"]
    assert all(starts[i].min() >= m for m, i in months)


def test_block_bootstrap_keeps_blocks_consecutive():
    idx = block_indices(100, 7, reps=50, seed=1)
    assert idx.shape == (50, 100)
    assert idx.min() >= 0 and idx.max() < 100
    first_blocks = idx[:, :7]
    assert np.all(np.diff(first_blocks, axis=1) == 1)


def test_isotonic_is_nonincreasing_and_least_squares():
    y = np.array([0.04, 0.05, 0.03, 0.035, 0.02, 0.01])
    w = np.ones_like(y)
    f = isotonic_nonincreasing(y, w)
    assert np.all(np.diff(f) <= 1e-15)
    assert np.allclose(f[:2], 0.045) and np.allclose(f[2:4], 0.0325)
    assert np.allclose(isotonic_nonincreasing(np.array([3.0, 2.0, 1.0]), np.ones(3)), [3, 2, 1])


def test_sigma_p_matches_the_contract_rule():
    table = np.array([0.038, 0.034, 0.030, 0.026, 0.022, 0.018, 0.014, 0.010, 0.006, 0.002])
    assert sigma_p(np.array([0.0, 0.05]), table).tolist() == [0.038, 0.038]
    assert abs(sigma_p(np.array([0.1]), table)[0] - 0.036) < 1e-15
    assert sigma_p(np.array([1.0]), table)[0] == 0.0
    assert abs(sigma_p(np.array([0.975]), table)[0] - 0.001) < 1e-15
