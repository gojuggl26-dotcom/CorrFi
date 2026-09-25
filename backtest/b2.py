"""B2: the weight w of the forecast part (B §4.1, criteria P2-P4).

Error at τ = 0: e = Long_T - P_fair(0), P_fair(0) = (1 + ŝ_AB / sqrt(ŝ_A2 ŝ_B2)) / 2 with Σ̂_future = w Σ̂_long + (1 - w) Σ̂_recent.
    python -m backtest.b2      # writes backtest/results/b2.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from backtest.stats import block_indices, calibration, ci90, eval_months, is_eval, rmse
from backtest.windows import DATA_END, TENORS, Windows, load

RESULTS = Path(__file__).resolve().parent / "results"
W_GRID = np.round(np.arange(0, 1.0001, 0.1), 1)
PROVISIONAL = {7: 0.3, 14: 0.5, 28: 0.6}   # M §4.1.1 initial values
Y1_END = 1_756_684_800                     # 2025-09-01: windows before it are year 1 (2024-09..2025-08)


def settlements(W: Windows, T: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
    LT = np.array([W.path(int(i), T, 0.5)["LT"] for i in idx])
    return idx, W.start[idx], LT


def p0(W: Windows, idx: np.ndarray, T: int, w: float, recent: str = "recent") -> np.ndarray:
    lg = W.p["long"][idx]
    rc = W.p[f"{recent}_{T}"][idx]
    f = w * lg + (1 - w) * rc
    rho = f[:, 0] / np.sqrt(f[:, 1] * f[:, 2])
    return (1 + np.clip(rho, -1, 1)) / 2


def run(W: Windows) -> dict:
    out: dict = {"grid": W_GRID.tolist(), "tenors": {}}
    for T in TENORS:
        idx, starts, LT = settlements(W, T)
        ev = is_eval(starts)
        n_ev = int(ev.sum())
        err = {v: np.stack([LT - p0(W, idx, T, w, v) for w in W_GRID]) for v in ("recent", "recent_ewma")}
        # fixed-candidate out-of-sample curve (evaluation windows)
        oos = {v: rmse(e[:, ev], axis=1) for v, e in err.items()}
        bias = {v: e[:, ev].mean(axis=1) for v, e in err.items()}
        full = {v: rmse(e, axis=1) for v, e in err.items()}
        y1 = {v: rmse(e[:, starts < Y1_END], axis=1) for v, e in err.items()}
        y2 = {v: rmse(e[:, starts >= Y1_END], axis=1) for v, e in err.items()}
        # walk-forward: re-select each evaluation month from the windows known by then
        wf_err, wf_pick = [], []
        for m, mi in eval_months(starts):
            cal = calibration(starts, T, m)
            j = int(np.argmin(rmse(err["recent"][:, cal], axis=1)))
            wf_pick.append({"month": int(m), "w": float(W_GRID[j]), "calibration_windows": int(len(cal))})
            wf_err.append(err["recent"][j, mi])
        wf_err = np.concatenate(wf_err)
        # bootstrap over the evaluation windows (blocks of T consecutive start days, paired across candidates)
        bi = block_indices(n_ev, T)
        ev_err = {v: e[:, ev] for v, e in err.items()}
        boot = {v: np.sqrt(np.mean(np.square(e[:, bi]), axis=2)) for v, e in ev_err.items()}  # candidates x reps
        jp = int(np.where(W_GRID == PROVISIONAL[T])[0][0])
        j_best = int(np.argmin(oos["recent"]))
        diff = boot["recent"][j_best] - boot["recent"][jp]
        d_lo, d_hi = ci90(diff)
        distinguishable = not (d_lo <= 0 <= d_hi)
        w_sel = float(W_GRID[j_best]) if distinguishable else PROVISIONAL[T]
        j_sel = int(np.where(W_GRID == w_sel)[0][0])
        # EWMA alternative: its best w against the selected standard w
        j_e = int(np.argmin(oos["recent_ewma"]))
        e_diff = boot["recent_ewma"][j_e] - boot["recent"][j_sel]
        e_lo, e_hi = ci90(e_diff)
        improve = 1 - oos["recent_ewma"][j_e] / oos["recent"][j_sel]
        ewma_adopt = bool(improve >= 0.05 and e_hi < 0)
        # full-period re-selection (reported; not adopted if its out-of-sample record is clearly worse)
        j_full = int(np.argmin(full["recent"]))
        f_diff = boot["recent"][j_full] - boot["recent"][j_sel]
        # the forecast checks of market creation on every window
        f_all = np.stack([p for p in (W.p["long"][idx],)])[0]
        psd = []
        for w in W_GRID:
            f = w * W.p["long"][idx] + (1 - w) * W.p[f"recent_{T}"][idx]
            csa2, csb2 = (4 * W.p["sA"][idx]) ** 2, (4 * W.p["sB"][idx]) ** 2
            psd.append(int(np.sum((f[:, 0] ** 2 > f[:, 1] * f[:, 2] * (1 + 1e-12)) | (f[:, 1] > csa2) | (f[:, 2] > csb2))))
        # C5 (B §6: a value that is good in one period only is not adopted). Made concrete after the results were
        # seen (docs/s06/01-results.md): a non-provisional w, or the EWMA variant, is adopted only if it is also no
        # worse than the provisional choice on year 1 (2024-09..2025-08).
        y1s, y1e = y1["recent"], y1["recent_ewma"]
        c5_w = w_sel if (w_sel == PROVISIONAL[T] or y1s[j_sel] <= y1s[jp]) else PROVISIONAL[T]
        j_c5 = int(np.where(W_GRID == c5_w)[0][0])
        c5_ewma = bool(ewma_adopt and y1e[j_e] <= y1s[j_c5])
        out.setdefault("c5", {})[str(T)] = {"w": c5_w, "ewma": c5_ewma,
                                           "year1_rmse_selected": float(y1s[j_sel]), "year1_rmse_provisional": float(y1s[jp]),
                                           "year1_rmse_ewma_best": float(y1e[j_e])}
        out["tenors"][str(T)] = {
            "windows": int(len(idx)),
            "eval_windows": n_ev,
            "oos_rmse": {v: x.tolist() for v, x in oos.items()},
            "oos_bias": {v: x.tolist() for v, x in bias.items()},
            "full_rmse": {v: x.tolist() for v, x in full.items()},
            "year1_rmse": {v: x.tolist() for v, x in y1.items()},
            "year2_rmse": {v: x.tolist() for v, x in y2.items()},
            "oos_rmse_ci90": {v: [ci90(b[j]) for j in range(len(W_GRID))] for v, b in boot.items()},
            "best_oos_w": float(W_GRID[j_best]),
            "diff_best_vs_provisional_ci90": [d_lo, d_hi],
            "distinguishable_from_provisional": distinguishable,
            "selected_w": w_sel,
            "walk_forward": {"picks": wf_pick, "oos_rmse": float(rmse(wf_err)), "oos_bias": float(wf_err.mean())},
            "ewma": {"best_w": float(W_GRID[j_e]), "oos_rmse": float(oos["recent_ewma"][j_e]), "improvement": float(improve),
                     "diff_vs_selected_ci90": [e_lo, e_hi], "adopt": ewma_adopt},
            "full_period_best_w": float(W_GRID[j_full]),
            "full_best_vs_selected_oos_diff_ci90": list(ci90(f_diff)),
            "forecast_check_violations_per_w": psd,
            "LT_mean": float(LT.mean()),
        }
        del f_all
    w = {T: out["tenors"][str(T)]["selected_w"] for T in TENORS}
    out["monotone_w7_w14_w28"] = bool(w[7] <= w[14] <= w[28])
    wc = {T: out["c5"][str(T)]["w"] for T in TENORS}
    out["monotone_after_c5"] = bool(wc[7] <= wc[14] <= wc[28])
    return out


def main() -> None:
    RESULTS.mkdir(exist_ok=True)
    res = run(load())
    (RESULTS / "b2.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8", newline="\n")
    for T in TENORS:
        r = res["tenors"][str(T)]
        print(f"{T:>2}D: best OOS w {r['best_oos_w']} (RMSE {min(r['oos_rmse']['recent']):.4f}), "
              f"provisional {PROVISIONAL[T]} (RMSE {r['oos_rmse']['recent'][int(PROVISIONAL[T] * 10)]:.4f}), "
              f"diff CI {np.round(r['diff_best_vs_provisional_ci90'], 4).tolist()} -> selected w {r['selected_w']}; "
              f"EWMA adopt {r['ewma']['adopt']} ({r['ewma']['improvement']:+.1%}); full-period best {r['full_period_best_w']}; "
              f"walk-forward RMSE {r['walk_forward']['oos_rmse']:.4f}")
    print("w7 <= w14 <= w28:", res["monotone_w7_w14_w28"])
    print("after C5:", res["c5"], "monotone:", res["monotone_after_c5"])


if __name__ == "__main__":
    main()
