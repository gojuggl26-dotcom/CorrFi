"""B5: auxiliary checks (B §4.4, criteria P9-P11) with the selected values (b3.json, b4b1.json).
    python -m backtest.b5      # writes backtest/results/b5.json
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from backtest.b3 import H_FLOOR
from backtest.b4b1 import ema_sig2
from backtest.stats import is_eval, sigma_p
from backtest.windows import DATA_END, TENORS, Windows, load

RESULTS = Path(__file__).resolve().parent / "results"
TOL = 0.002           # default tolerance δ (M §5.8.3)
C_WIN = 4.0


def epps(W: Windows, since: int, until: int) -> dict:
    b = W.bars
    j0, j1 = b.j(since), b.j(until)
    ra, rb, v = b.ra[j0 + 1:j1 + 1], b.rb[j0 + 1:j1 + 1], b.valid[j0 + 1:j1 + 1]
    out = {}
    for name, n in (("5min", 1), ("1h", 12), ("1d", 288)):
        m = len(ra) // n
        A = ra[: m * n].reshape(m, n)
        B = rb[: m * n].reshape(m, n)
        ok = v[: m * n].reshape(m, n).all(axis=1)
        a, c = A[ok].sum(1), B[ok].sum(1)
        out[name] = {"corr": float(np.corrcoef(a, c)[0, 1]), "n": int(ok.sum())}
    return out


def run(W: Windows, b3: dict, b4: dict) -> dict:
    ch, co = b3["ch"], b4["co_selected"]
    out: dict = {"tolerance": TOL, "tenors": {}}
    for T in TENORS:
        w = float(b3["w"][str(T)])
        table = np.array(b3["tenors"][str(T)]["table"])
        lam = b4["tenors"][str(T)]["lambda_selected"]
        s0 = b4["tenors"][str(T)]["sigma0_first_day_sd_median"]["all_windows"]
        idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
        starts = W.start[idx]
        ev = is_eval(starts)
        N = T * 288
        n_min = -(-N * 99 // 100)
        t4 = (N - n_min) // 2
        void = t4_stop = 0
        t4_tau = []
        clipped = valid_bars = 0
        clip_rate_w = []
        ratio_a, ratio_b = [], []
        LT, ask_pinned = [], []
        manip_max, manip_bound, manip_exceed = [], [], 0
        dp_all, sig_all = [], []
        for i in idx:
            p = W.path(int(i), T, w)
            void += int(p["void"])
            inv = p["invalid"]
            hit = np.where(inv > t4)[0]
            if len(hit):
                t4_stop += 1
                t4_tau.append(float(hit[0] / N))
            jd = p["jd"]
            s = slice(jd + 1, jd + N + 1)
            m = W.bars.valid[s]
            ra, rb = W.bars.ra[s][m], W.bars.rb[s][m]
            csa, csb = p["csa"], p["csb"]
            cl = (np.abs(ra) > csa) | (np.abs(rb) > csb)
            clipped += int(cl.sum())
            valid_bars += int(m.sum())
            clip_rate_w.append(float(cl.mean()) if len(cl) else 0.0)
            ratio_a.append(float(np.std(ra) / W.p["sA"][i]))
            ratio_b.append(float(np.std(rb) / W.p["sB"][i]))
            LT.append(p["LT"])
            tau = np.arange(N) / N
            h0 = np.maximum(H_FLOOR, ch * sigma_p(tau, table))
            ask_pinned.append(float(np.mean(p["P"][:N] + h0 >= 1)))
            # leave-one-out influence of each valid bar on Long_T (P10)
            a = np.clip(ra, -csa, csa)
            b = np.clip(rb, -csb, csb)
            C, VA, VB = p["C"][-1], p["VA"][-1], p["VB"][-1]
            rho = C / np.sqrt(VA * VB)
            loo = (1 + (C - a * b) / np.sqrt((VA - a * a) * (VB - b * b))) / 2
            mx = float(np.max(np.abs(loo - (1 + rho) / 2)))
            bound = C_WIN ** 2 / N * (1 + abs(rho) / 4)
            manip_max.append(mx)
            manip_bound.append(bound)
            manip_exceed += int(mx > bound)
            dp = np.diff(p["P"])
            dp_all.append(np.abs(dp))
            sig_all.append(np.sqrt(ema_sig2(dp, lam, s0 * s0)[:-1]))
        dp_all = np.concatenate(dp_all)
        sig_all = np.concatenate(sig_all)
        # tolerance: 10 s without a bar (only h_O grows: κ_bar = 0, P9) and across a bar confirmation (|ΔP_fair|)
        rng = np.random.default_rng(20260926)
        a_age = rng.uniform(0, 350, size=len(sig_all))
        d10 = co * sig_all * (np.sqrt((a_age + 10) / 300) - np.sqrt(a_age / 300))
        # mean handling: P_fair(0) with non-demeaned vs demeaned forecast (selected w)
        def p0(kind: str) -> np.ndarray:
            lg = W.p["long" if kind == "raw" else "long_dm"][idx]
            rc = W.p[f"recent_{T}" if kind == "raw" else f"recent_dm_{T}"][idx]
            f = w * lg + (1 - w) * rc
            return (1 + np.clip(f[:, 0] / np.sqrt(f[:, 1] * f[:, 2]), -1, 1)) / 2
        dm = p0("raw") - p0("dm")
        LT = np.array(LT)
        out["tenors"][str(T)] = {
            "windows": int(len(idx)),
            "void_rate": void / len(idx),
            "t4_stop_rate": t4_stop / len(idx),
            "t4_stop_tau": t4_tau,
            "winsorize_rate": clipped / valid_bars,
            "winsorize_rate_window_q": {str(q): float(np.percentile(clip_rate_w, q)) for q in (50, 95, 100)},
            "si_stability_A_q": {str(q): float(np.percentile(ratio_a, q)) for q in (5, 50, 95)},
            "si_stability_B_q": {str(q): float(np.percentile(ratio_b, q)) for q in (5, 50, 95)},
            "LT_q": {str(q): float(np.percentile(LT, q)) for q in (0, 5, 25, 50, 75, 95, 100)},
            "ask_pinned_time_share": float(np.mean(ask_pinned)),
            "tolerance_no_bar_10s_exceed": float(np.mean(d10 > TOL)),
            "tolerance_no_bar_10s_max": float(d10.max()),
            "tolerance_bar_cross_exceed": float(np.mean(dp_all > TOL)),
            "tolerance_bar_cross_q999": float(np.percentile(dp_all, 99.9)),
            "manipulation_max_q": {str(q): float(np.percentile(manip_max, q)) for q in (50, 100)},
            "manipulation_bound_min": float(np.min(manip_bound)),
            "manipulation_exceed": manip_exceed,
            "mean_handling_p0_diff_rmse": float(np.sqrt(np.mean(dm ** 2))),
            "mean_handling_p0_diff_max": float(np.max(np.abs(dm))),
        }
    ev_all = W.start[W.start >= 1_756_684_800]
    out["epps"] = {"eval_period": epps(W, 1_756_684_800, 1_790_294_400),
                   "year1": epps(W, 1_725_148_800, 1_756_684_800)}
    del ev_all
    t = out["tenors"]
    out["criteria"] = {
        "void_le_0.5pct": all(t[str(T)]["void_rate"] <= 0.005 for T in TENORS),
        "t4_le_2pct": all(t[str(T)]["t4_stop_rate"] <= 0.02 for T in TENORS),
        "tolerance_no_bar_le_0.1pct": all(t[str(T)]["tolerance_no_bar_10s_exceed"] <= 0.001 for T in TENORS),
        "tolerance_bar_cross_le_5pct": all(t[str(T)]["tolerance_bar_cross_exceed"] <= 0.05 for T in TENORS),
        "winsorize_le_2pct": all(t[str(T)]["winsorize_rate"] <= 0.02 for T in TENORS),
        "manipulation_exceed_0": all(t[str(T)]["manipulation_exceed"] == 0 for T in TENORS),
        "epps_5min_lowest": out["epps"]["eval_period"]["5min"]["corr"] < out["epps"]["eval_period"]["1h"]["corr"]
                             < out["epps"]["eval_period"]["1d"]["corr"],
    }
    return out


def main() -> None:
    b3 = json.loads((RESULTS / "b3.json").read_text(encoding="utf-8"))
    b4 = json.loads((RESULTS / "b4b1.json").read_text(encoding="utf-8"))
    res = run(load(), b3, b4)
    (RESULTS / "b5.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8", newline="\n")
    for T in TENORS:
        t = res["tenors"][str(T)]
        print(f"{T:>2}D void {t['void_rate']:.4f} T-4 {t['t4_stop_rate']:.4f} winsorize {t['winsorize_rate']:.4f} "
              f"tol(10s) {t['tolerance_no_bar_10s_exceed']:.4f} (max {t['tolerance_no_bar_10s_max']:.2e}) "
              f"tol(bar) {t['tolerance_bar_cross_exceed']:.5f} (q99.9 {t['tolerance_bar_cross_q999']:.2e}) "
              f"manip max {t['manipulation_max_q']['100']:.2e} vs bound >= {t['manipulation_bound_min']:.2e} exceed {t['manipulation_exceed']} "
              f"ask pinned {t['ask_pinned_time_share']:.4f} meanΔP0 {t['mean_handling_p0_diff_rmse']:.2e}")
        print(f"     s_i stability A {t['si_stability_A_q']}  B {t['si_stability_B_q']}  LT {t['LT_q']}")
    print("Epps:", res["epps"])
    print("criteria:", res["criteria"])


if __name__ == "__main__":
    main()
