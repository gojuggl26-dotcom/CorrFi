"""B3: the forecast-error table σP(τ) and c_h (B §4.2, criteria P5).

With the B2 weight, every bar k = 0..N-1 of every window gives e = Long_T - P_fair(k), binned by τ = k/N into
[0, 0.1), ..., [0.9, 1). Per bin the RMSE; the production table is the weighted non-increasing isotonic fit of the
all-window RMSE (values at bin midpoints, 0 at τ = 1). c_h = 0.006 / σP,7D(0) clipped to [0.10, 0.30].
    python -m backtest.b3 [--w7 0.3 --w14 0.5 --w28 0.6]     # writes backtest/results/b3.json
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from backtest.stats import block_indices, ci90, is_eval, isotonic_nonincreasing
from backtest.windows import DATA_END, TENORS, Windows, load

RESULTS = Path(__file__).resolve().parent / "results"
PROVISIONAL_P0 = {7: 0.04, 14: 0.035, 28: 0.03}
H_FLOOR = 0.005
Y1_END = 1_756_684_800


def binned_errors(W: Windows, T: int, w: float, recent: str = "recent"):
    """Per window: sum of squared errors and counts per τ bin (windows x 10)."""
    idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
    N = T * 288
    bins = (10 * np.arange(N)) // N
    sse = np.zeros((len(idx), 10))
    cnt = np.zeros((len(idx), 10))
    for r, i in enumerate(idx):
        p = W.path(int(i), T, w, recent)
        e2 = np.square(p["LT"] - p["P"][:N])
        sse[r] = np.bincount(bins, weights=e2, minlength=10)
        cnt[r] = np.bincount(bins, minlength=10)
    return idx, W.start[idx], sse, cnt


def run(W: Windows, wsel: dict[int, float], recent: str = "recent") -> dict:
    out: dict = {"w": {str(k): v for k, v in wsel.items()}, "recent": recent, "tenors": {}}
    for T in TENORS:
        idx, starts, sse, cnt = binned_errors(W, T, wsel[T], recent)
        ev = is_eval(starts)
        full = np.sqrt(sse.sum(0) / cnt.sum(0))
        oos = np.sqrt(sse[ev].sum(0) / cnt[ev].sum(0))
        y1 = np.sqrt(sse[starts < Y1_END].sum(0) / cnt[starts < Y1_END].sum(0))
        table = isotonic_nonincreasing(full, cnt.sum(0))
        bi = block_indices(len(idx), T)
        boot = np.sqrt(sse[bi].sum(1) / cnt[bi].sum(1))  # reps x 10
        out["tenors"][str(T)] = {
            "rmse_full": full.tolist(),
            "rmse_oos": oos.tolist(),
            "rmse_year1": y1.tolist(),
            "rmse_full_ci90": [ci90(boot[:, b]) for b in range(10)],
            "table": table.tolist(),
            "raw_increases": int(np.sum(np.diff(full) > 0)),
            "provisional_p0": PROVISIONAL_P0[T],
            "provisional_table": [PROVISIONAL_P0[T] * (19 - 2 * i) / 20 for i in range(10)],
        }
    s7 = out["tenors"]["7"]["table"][0]
    ch_raw = 0.006 / s7
    ch = float(min(max(ch_raw, 0.10), 0.30))
    out["ch_raw"] = ch_raw
    out["ch"] = ch
    out["h0_tau0"] = {T: max(H_FLOOR, ch * out["tenors"][str(T)]["table"][0]) for T in TENORS}
    out["check_h0_14_28_le_1pct"] = bool(out["h0_tau0"][14] <= 0.01 and out["h0_tau0"][28] <= 0.01)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--w7", type=float, default=0.3)
    ap.add_argument("--w14", type=float, default=0.5)
    ap.add_argument("--w28", type=float, default=0.6)
    ap.add_argument("--recent", default="recent")
    ap.add_argument("--out", default="b3.json")
    a = ap.parse_args()
    res = run(load(), {7: a.w7, 14: a.w14, 28: a.w28}, a.recent)
    RESULTS.mkdir(exist_ok=True)
    (RESULTS / a.out).write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8", newline="\n")
    for T in TENORS:
        t = res["tenors"][str(T)]
        print(f"{T:>2}D raw  " + " ".join(f"{x:.4f}" for x in t["rmse_full"]) + f"   (increases {t['raw_increases']})")
        print(f"    table " + " ".join(f"{x:.4f}" for x in t["table"]) + f"   provisional σP(0) {t['provisional_p0']}")
        print(f"    OOS   " + " ".join(f"{x:.4f}" for x in t["rmse_oos"]))
    print(f"c_h raw {res['ch_raw']:.4f} -> {res['ch']:.4f}; h0(τ=0) {res['h0_tau0']}; 14D/28D <= 1%: {res['check_h0_14_28_le_1pct']}")


if __name__ == "__main__":
    main()
