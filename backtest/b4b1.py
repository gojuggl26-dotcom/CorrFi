"""B4 (σP,bar smoothing, its initial value, c_O) and B1 (is a per-bar update enough?) — B §4.3, criteria P6-P8.

Information gap D(k, s) = |P*(k, s) - P_fair(k)| for s = 1..6 minutes after t_k (P7):
  s = 1..4: the part of bar k+1 up to t_k + s (1-minute grid), winsorized with the window's c s_i, added to the sums,
            remaining bars N - k - s/5;
  s = 5:    bar k+1 complete (= P_fair(k+1));
  s = 6:    bar k+1 plus the first minute of bar k+2, remaining N - k - 1 - 1/5.
σP,bar² is the EMA of (ΔP_fair)² per bar with λ = 2^(-1/HL); QLIKE = ln σ̂² + ΔP²/σ̂² with σ̂² known before the bar.
h_min(k, s) = h0(τ_k) + c_O σ̄_k sqrt(s/5), h0(τ) = max(0.005, c_h σP(τ)) with the B3 table.
    python -m backtest.b4b1      # writes backtest/results/b4b1.json (needs b2 selection and b3.json)
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from backtest.b3 import H_FLOOR
from backtest.grid import Grid
from backtest.stats import block_indices, ci90, is_eval, sigma_p
from backtest.windows import DATA_END, TENORS, Windows, load

RESULTS = Path(__file__).resolve().parent / "results"
HALF_LIVES = (72, 144, 288, 576)
PROVISIONAL_HL = 288
CO_GRID = (1.5, 2.0, 2.5, 3.0)
S = np.arange(1, 7)
INITIAL_END = 1_756_684_800  # 2025-09-01


def ema_sig2(dp: np.ndarray, lam: float, sig2_0: float) -> np.ndarray:
    """σ² after each report k = 0..N (σ²_0 = the initial value)."""
    out = np.empty(len(dp) + 1)
    out[0] = s = sig2_0
    a = 1 - lam
    for k, x in enumerate(dp, start=1):
        s = lam * s + a * x * x
        out[k] = s
    return out


def qlike(dp: np.ndarray, sig2_before: np.ndarray) -> float:
    return float(np.sum(np.log(sig2_before) + dp * dp / sig2_before))


class Gaps:
    """Per window: P path, ΔP and D(k, s) (k = 0..N-2, s = 1..6)."""

    def __init__(self, W: Windows):
        self.W = W
        self.ga, self.gb = Grid("ETHUSDT"), Grid("BTCUSDT")

    def window(self, i: int, T: int, w: float) -> dict:
        W = self.W
        p = W.path(i, T, w)
        N = p["N"]
        d = int(W.start[i])
        sab, sa2, sb2 = W.forecast(i, T, w)
        P, C, VA, VB = p["P"], p["C"], p["VA"], p["VB"]
        csa, csb = p["csa"], p["csb"]
        m0 = (d - self.ga.t0) // 60
        k = np.arange(N - 1)                         # bars k = 0..N-2
        mk = m0 + 5 * k                              # minute index of t_k
        pa, pb = self.ga.price, self.gb.price
        D = np.full((N - 1, 6), np.nan)

        def partial(base: np.ndarray, minutes: np.ndarray, Cb, VAb, VBb, rem):
            ra = np.log(pa[minutes] / pa[base])
            rb = np.log(pb[minutes] / pb[base])
            ok = np.isfinite(ra) & np.isfinite(rb)
            a = np.clip(np.where(ok, ra, 0.0), -csa, csa)
            b = np.clip(np.where(ok, rb, 0.0), -csb, csb)
            rho = (Cb + a * b + rem * sab) / np.sqrt((VAb + a * a + rem * sa2) * (VBb + b * b + rem * sb2))
            ps = (1 + np.clip(rho, -1, 1)) / 2
            return np.where(ok, ps, np.nan)

        for s in (1, 2, 3, 4):
            ps = partial(mk, mk + s, C[k], VA[k], VB[k], N - k - s / 5)
            D[:, s - 1] = np.abs(ps - P[k])
        D[:, 4] = np.abs(P[k + 1] - P[k])
        ps6 = partial(mk + 5, mk + 6, C[k + 1], VA[k + 1], VB[k + 1], N - k - 1 - 1 / 5)
        D[:, 5] = np.abs(ps6 - P[k])
        return {"P": P, "dP": np.diff(P), "D": D, "N": N, "tau": k / N}


def run(W: Windows, wsel: dict[int, float], b3: dict) -> dict:
    G = Gaps(W)
    ch = b3["ch"]
    out: dict = {"ch": ch, "tenors": {}}
    per_tenor_co: dict[int, float | None] = {}
    cache: dict[int, dict] = {}
    for T in TENORS:
        table = np.array(b3["tenors"][str(T)]["table"])
        idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
        starts = W.start[idx]
        ev = is_eval(starts)
        wins = [G.window(int(i), T, wsel[T]) for i in idx]
        # σ0: median over calibration windows of the std of ΔP over the first 288 bars
        first_day_sd = np.array([np.std(x["dP"][:288]) for x in wins])
        known = starts + T * 86_400 <= INITIAL_END
        sigma0_oos = float(np.median(first_day_sd[known]))
        sigma0_full = float(np.median(first_day_sd))
        # QLIKE per half-life (fixed candidates, evaluation windows; σ0 from the initial calibration set)
        ql = np.zeros((len(HALF_LIVES), len(idx)))
        nbar = np.array([len(x["dP"]) for x in wins])
        for h, hl in enumerate(HALF_LIVES):
            lam = 2 ** (-1 / hl)
            for r, x in enumerate(wins):
                s2 = ema_sig2(x["dP"], lam, sigma0_oos ** 2)
                ql[h, r] = qlike(x["dP"], s2[:-1])
        mean_ql = ql[:, ev].sum(1) / nbar[ev].sum()
        y1 = ~ev
        mean_ql_y1 = ql[:, y1].sum(1) / nbar[y1].sum()      # C5: the same comparison on the first year
        bi = block_indices(int(ev.sum()), T)
        qe, ne = ql[:, ev], nbar[ev]
        boot = qe[:, bi].sum(2) / ne[bi].sum(1)          # half-lives x reps
        hb = int(np.argmin(mean_ql))
        hp = HALF_LIVES.index(PROVISIONAL_HL)
        dlo, dhi = ci90(boot[hb] - boot[hp])
        hl_sel = HALF_LIVES[hb] if not (dlo <= 0 <= dhi) else PROVISIONAL_HL
        lam = 2 ** (-1 / hl_sel)
        # σ̄_k after each report with the selected half-life and the production σ0
        tau_all, D_all, sig_all, ev_all = [], [], [], []
        for r, x in enumerate(wins):
            s2 = ema_sig2(x["dP"], lam, sigma0_full ** 2)
            sig_all.append(np.sqrt(s2[: x["N"] - 1]))
            tau_all.append(x["tau"])
            D_all.append(x["D"])
            ev_all.append(np.full(x["N"] - 1, ev[r]))
        tau = np.concatenate(tau_all)
        Dm = np.concatenate(D_all)
        sig = np.concatenate(sig_all)
        evm = np.concatenate(ev_all)
        h0 = np.maximum(H_FLOOR, ch * sigma_p(tau, table))
        root = np.sqrt(S / 5)[None, :]
        # c_O per tenor: smallest candidate with exceedance <= 1% at every s (evaluation windows)
        exceed = {}
        for co in CO_GRID:
            thr = h0[:, None] + co * sig[:, None] * root
            fr = [float(np.nanmean(Dm[evm, j] > thr[evm, j])) for j in range(6)]
            exceed[str(co)] = fr
        ok = [co for co in CO_GRID if max(exceed[str(co)]) <= 0.01]
        per_tenor_co[T] = ok[0] if ok else None
        z = Dm / (sig[:, None] * root)
        zq = {str(q): [float(np.nanpercentile(z[evm, j], q)) for j in range(6)] for q in (50, 90, 97.5, 99)}
        out["tenors"][str(T)] = {
            "w": wsel[T],
            "sigma0_first_day_sd_median": {"initial_calibration": sigma0_oos, "all_windows": sigma0_full},
            "qlike_mean_oos": mean_ql.tolist(),
            "qlike_mean_year1": mean_ql_y1.tolist(),
            "sigma_bar_quantiles_oos": {str(q): float(np.percentile(sig[evm], q)) for q in (5, 50, 95)},
            "abs_dP_quantiles_oos": {str(q): float(np.nanpercentile(Dm[evm, 4], q)) for q in (50, 95, 99, 99.9)},
            "gap_by_s_median_oos": [float(np.nanmedian(Dm[evm, j])) for j in range(6)],
            "hl_best": HALF_LIVES[hb],
            "hl_diff_vs_288_ci90": [dlo, dhi],
            "hl_selected": hl_sel,
            "lambda_selected": lam,
            "exceed_by_co_oos": exceed,
            "co_min": per_tenor_co[T],
            "standardized_gap_quantiles_oos": zq,
            "samples_oos": int(evm.sum()),
        }
        cache[T] = {"tau": tau, "D": Dm, "sig": sig, "ev": evm, "h0": h0}
    cands = [c for c in per_tenor_co.values()]
    co = None if any(c is None for c in cands) else max(cands)
    out["co_selected"] = co
    out["b4_pass"] = co is not None
    # B1 with the selected values
    b1: dict = {"co": co, "tenors": {}}
    all_a = all_b = True
    for T in TENORS:
        c = cache[T]
        if co is None:
            break
        hmin = c["h0"][:, None] + co * c["sig"][:, None] * np.sqrt(S / 5)[None, :]
        bins = np.minimum((c["tau"] * 10).astype(int), 9)
        cells = []
        for scope, mask in (("oos", c["ev"]), ("full", np.ones_like(c["ev"]))):
            for b in range(10):
                mb = mask & (bins == b)
                for j in range(6):
                    Dv, Hv = c["D"][mb, j], hmin[mb, j]
                    good = np.isfinite(Dv)
                    Dv, Hv = Dv[good], Hv[good]
                    fr = float(np.mean(Dv > Hv))
                    ex = float(np.mean(np.maximum(Dv - Hv, 0)))
                    ratio = ex / float(np.mean(Hv))
                    cells.append({"scope": scope, "bin": b, "s": j + 1, "exceed": fr, "excess_ratio": ratio, "n": int(len(Dv))})
                    if scope == "oos":
                        all_a &= fr <= 0.02
                        all_b &= ratio <= 0.05
        h6 = {}
        for b in range(10):
            mb = c["ev"] & (bins == b)
            h6[str(b)] = {"median": float(np.median(hmin[mb, 5])), "p99": float(np.percentile(hmin[mb, 5], 99))}
        b1["tenors"][str(T)] = {"cells": cells, "hmin_6min": h6,
                                "max_exceed_oos": max(x["exceed"] for x in cells if x["scope"] == "oos"),
                                "max_excess_ratio_oos": max(x["excess_ratio"] for x in cells if x["scope"] == "oos")}
    if co is not None:
        cond_c = all(v["median"] <= 0.01 for v in b1["tenors"]["7"]["hmin_6min"].values())
        b1["a"], b1["b"], b1["c"] = bool(all_a), bool(all_b), bool(cond_c)
        b1["pass"] = bool(all_a and all_b and cond_c)
    else:
        b1["pass"] = False
        b1["reason"] = "B4: no c_O candidate up to 3.0 keeps the exceedance <= 1% (B §5.2: B1 fails)"
    out["b1"] = b1
    return out


def main() -> None:
    b2 = json.loads((RESULTS / "b2.json").read_text(encoding="utf-8"))
    b3 = json.loads((RESULTS / "b3.json").read_text(encoding="utf-8"))
    wsel = {int(k): float(v) for k, v in b3["w"].items()}
    del b2
    res = run(load(), wsel, b3)
    (RESULTS / "b4b1.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8", newline="\n")
    for T in TENORS:
        t = res["tenors"][str(T)]
        print(f"{T:>2}D: σ0 {t['sigma0_first_day_sd_median']}, QLIKE best HL {t['hl_best']} (diff vs 288 CI {np.round(t['hl_diff_vs_288_ci90'], 6).tolist()}) -> {t['hl_selected']}; "
              f"c_O min {t['co_min']}")
        for co, fr in t["exceed_by_co_oos"].items():
            print(f"     c_O {co}: exceed by s " + " ".join(f"{x:.4f}" for x in fr))
        print(f"     z 97.5%: " + " ".join(f"{x:.2f}" for x in t["standardized_gap_quantiles_oos"]["97.5"]) +
              f"   99%: " + " ".join(f"{x:.2f}" for x in t["standardized_gap_quantiles_oos"]["99"]))
    print("c_O selected:", res["co_selected"])
    b1 = res["b1"]
    print("B1:", {k: b1.get(k) for k in ("a", "b", "c", "pass", "reason")})
    for T in TENORS:
        if str(T) in b1["tenors"]:
            t = b1["tenors"][str(T)]
            print(f"  {T:>2}D max exceed {t['max_exceed_oos']:.4f}, max excess ratio {t['max_excess_ratio_oos']:.4f}, "
                  f"h_min(6 min) median by τ bin " + " ".join(f"{v['median']:.4f}" for v in t["hmin_6min"].values()))


if __name__ == "__main__":
    main()
