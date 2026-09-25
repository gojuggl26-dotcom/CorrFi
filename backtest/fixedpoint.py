"""B §3.4: recompute the adopted values with the production fixed-point arithmetic and compare (criteria P12).

Everything here is integer (WAD): 5-minute prices from the grid (exact), returns with the protocol's logRatio (Solady
lnWad port), s_i and Σ̂ with the definitions of data/aquacorr_data/calib.py, the per-bar sums with F3 and the fair
value with F7 (verifier/corrfi_verifier/fixedpoint.py = Solidity = TypeScript). The float search results must agree
within 1e-9 on the continuous metrics.
    python -m backtest.fixedpoint      # writes backtest/results/fixedpoint.json and vectors/backtest_states.json
"""
from __future__ import annotations

import json
import sys
from concurrent.futures import ProcessPoolExecutor
from decimal import Decimal, getcontext
from fractions import Fraction
from math import floor
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "verifier"))

from corrfi_verifier import fixedpoint as fp          # noqa: E402

from backtest.grid import CACHE, SPLIT, Grid          # noqa: E402
from backtest.stats import is_eval, sigma_p           # noqa: E402
from backtest.windows import DATA_END, PER_DAY, TENORS, load  # noqa: E402

WAD = 10**18
RESULTS = Path(__file__).resolve().parent / "results"
MAD_SCALE = Fraction(14826, 10000)


def lam_wad(hl: int) -> int:
    getcontext().prec = 60
    return int(Decimal(2) ** (Decimal(-1) / Decimal(hl)) * WAD)


def exact_returns() -> tuple[int, np.ndarray, np.ndarray, np.ndarray]:
    """WAD log returns of the 5-minute grid (int64 is enough: |r| < 0.5 WAD), cached."""
    path = CACHE / "returns_wad.npz"
    if path.exists():
        z = np.load(path)
        return int(z["t0"]), z["ra"], z["rb"], z["valid"]
    ga, gb = Grid("ETHUSDT"), Grid("BTCUSDT")
    hia, loa, va = ga.hi[::5], ga.lo[::5], ga.valid[::5]
    hib, lob, vb = gb.hi[::5], gb.lo[::5], gb.valid[::5]
    n = len(va)
    ra = np.zeros(n, np.int64)
    rb = np.zeros(n, np.int64)
    valid = np.zeros(n, bool)
    pa = [int(h) * SPLIT + int(lo) for h, lo in zip(hia, loa)]
    pb = [int(h) * SPLIT + int(lo) for h, lo in zip(hib, lob)]
    for j in range(1, n):
        if va[j] and va[j - 1] and vb[j] and vb[j - 1]:
            ra[j] = fp.log_ratio(pa[j - 1], pa[j])
            rb[j] = fp.log_ratio(pb[j - 1], pb[j])
            valid[j] = True
    np.savez_compressed(path, t0=ga.t0, ra=ra, rb=rb, valid=valid)
    return ga.t0, ra, rb, valid


def _median2(x: np.ndarray) -> int:
    """2 x median of an int64 array (exact; even count -> sum of the middle two)."""
    n = len(x)
    s = np.partition(x, [(n - 1) // 2, n // 2])
    return int(s[(n - 1) // 2]) + int(s[n // 2])


def mad(x: np.ndarray) -> Fraction:
    m2 = _median2(x)                              # 2m
    dev2 = np.abs(2 * x - m2)                     # 2|x - m|, exact in int64 (|x| < 5e17)
    return Fraction(_median2(dev2), 4)


def _moments(a: list[int], b: list[int], cs_a: int, cs_b: int) -> tuple[int, int, int]:
    c = va = vb = 0
    for x, y in zip(a, b):
        x = max(-cs_a, min(cs_a, x))
        y = max(-cs_b, min(cs_b, y))
        c, va, vb = fp.accumulate(c, va, vb, x, y)
    n = len(a)
    return fp.div0(c, n), va // n, vb // n


_R: dict = {}


def _init() -> None:
    t0, ra, rb, valid = exact_returns()
    _R.update(t0=t0, ra=ra, rb=rb, valid=valid)


def window_params(args) -> dict:
    """calib.py for one start date and tenor, from the cached exact returns (s_i, Σ̂_long, Σ̂_recent)."""
    d, T, w_wad = args
    t0, ra, rb, valid = _R["t0"], _R["ra"], _R["rb"], _R["valid"]
    jd = (d - t0) // 300
    def sl(days):
        s = slice(jd - days * PER_DAY + 1, jd + 1)
        m = valid[s]
        return ra[s][m], rb[s][m]
    a30, b30 = sl(30)
    a180, b180 = sl(180)
    s_a = max(floor(MAD_SCALE * mad(a30)), floor(MAD_SCALE * mad(a180) / 2))
    s_b = max(floor(MAD_SCALE * mad(b30)), floor(MAD_SCALE * mad(b180) / 2))
    cs_a, cs_b = 4 * s_a, 4 * s_b
    a90, b90 = sl(90)
    aT, bT = sl(T)
    lg = _moments(a90.tolist(), b90.tolist(), cs_a, cs_b)
    rc = _moments(aT.tolist(), bT.tolist(), cs_a, cs_b)
    sab = fp.div0(w_wad * lg[0] + (WAD - w_wad) * rc[0], WAD)
    sa2 = (w_wad * lg[1] + (WAD - w_wad) * rc[1]) // WAD
    sb2 = (w_wad * lg[2] + (WAD - w_wad) * rc[2]) // WAD
    # the window's path: F3 sums and F7 fair value per bar
    N = T * PER_DAY
    s = slice(jd + 1, jd + N + 1)
    wa, wb, wv = ra[s].tolist(), rb[s].tolist(), valid[s].tolist()
    c = va = vb = 0
    nvalid = 0
    P = [fp.fair_value(0, 0, 0, 0, N, sab, sa2, sb2)]
    marks = {0, N // 4, N // 2, 3 * N // 4, N - 1, N}
    sums = {0: (0, 0, 0)}
    for k in range(N):
        if wv[k]:
            x = max(-cs_a, min(cs_a, wa[k]))
            y = max(-cs_b, min(cs_b, wb[k]))
            c, va, vb = fp.accumulate(c, va, vb, x, y)
            nvalid += 1
        P.append(fp.fair_value(c, va, vb, k + 1, N, sab, sa2, sb2))
        if k + 1 in marks:
            sums[k + 1] = (c, va, vb)
    n_min = -(-N * 99 // 100)
    LT, void = fp.long_t(c, va, vb, nvalid, n_min)
    return {"d": d, "T": T, "sA": s_a, "sB": s_b, "sAB": sab, "sA2": sa2, "sB2": sb2, "P": P, "LT": LT,
            "void": void, "c": c, "va": va, "vb": vb, "sums": sums}


def main() -> None:
    b3 = json.loads((RESULTS / "b3.json").read_text(encoding="utf-8"))
    b4 = json.loads((RESULTS / "b4b1.json").read_text(encoding="utf-8"))
    W = load()
    exact_returns()
    out: dict = {"tenors": {}}
    states: list[dict] = []
    prm = json.loads((RESULTS / "params.json").read_text(encoding="utf-8"))
    ch_wad = int(prm["ch_wad"])
    with ProcessPoolExecutor(14, initializer=_init) as ex:
        for T in TENORS:
            w = float(b3["w"][str(T)])
            w_wad = int(round(w * WAD))
            idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
            starts = W.start[idx]
            ev = is_eval(starts)
            rows = list(ex.map(window_params, [(int(d), T, w_wad) for d in starts], chunksize=4))
            N = T * PER_DAY
            bins = (10 * np.arange(N)) // N
            # float counterparts
            f_P0 = np.array([W.path(int(i), T, w)["P"][0] for i in idx])
            f_LT = np.array([W.path(int(i), T, w)["LT"] for i in idx])
            x_P0 = np.array([r["P"][0] for r in rows], dtype=object)
            x_LT = np.array([r["LT"] for r in rows], dtype=object)
            to_f = lambda a: np.array([Fraction(int(v), WAD) for v in a], dtype=object)
            # B2 metric: RMSE of Long_T - P(0) on the evaluation windows (exact rationals -> float at the end)
            e_x = to_f(x_LT) - to_f(x_P0)
            rmse_x = float(np.sqrt(float(sum(v * v for v in e_x[ev]) / int(ev.sum()))))
            rmse_f = float(np.sqrt(np.mean((f_LT - f_P0)[ev] ** 2)))
            # B3 metric: per-bin RMSE over all windows
            sse_x = np.zeros(10)
            sse_f = np.zeros(10)
            cnt = np.zeros(10)
            max_dp = 0.0
            for r, i in zip(rows, idx):
                Px = np.array(r["P"][:N], dtype=np.float64) / WAD
                Pf = W.path(int(i), T, w)["P"][:N]
                LTx = r["LT"] / WAD
                sse_x += np.bincount(bins, weights=(LTx - Px) ** 2, minlength=10)
                sse_f += np.bincount(bins, weights=(W.path(int(i), T, w)["LT"] - Pf) ** 2, minlength=10)
                cnt += np.bincount(bins, minlength=10)
                max_dp = max(max_dp, float(np.max(np.abs(Px - Pf))))
            tab_x, tab_f = np.sqrt(sse_x / cnt), np.sqrt(sse_f / cnt)
            out["tenors"][str(T)] = {
                "b2_rmse_fixed": rmse_x, "b2_rmse_float": rmse_f, "b2_diff": abs(rmse_x - rmse_f),
                "b3_table_raw_fixed": tab_x.tolist(), "b3_table_raw_float": tab_f.tolist(),
                "b3_max_diff": float(np.max(np.abs(tab_x - tab_f))),
                "max_abs_P_diff": max_dp,
                "LT_max_abs_diff": float(np.max(np.abs(np.array([int(v) for v in x_LT], dtype=np.float64) / WAD - f_LT))),
                "sA_float_vs_fixed_max_rel": float(np.max(np.abs(np.array([r["sA"] for r in rows], dtype=np.float64) / WAD / W.p["sA"][idx] - 1))),
            }
            # test vectors: a few windows at k = 0, N/4, N/2, 3N/4, N-1, N with the adopted values
            table_wad = [int(x) for x in prm["tenors"][str(T)]["sigma_table_wad"]]  # the adopted exact values
            for r in rows[:: max(1, len(rows) // 4)][:4]:
                for k in (0, N // 4, N // 2, 3 * N // 4, N - 1, N):
                    c_k, va_k, vb_k = r["sums"][k]
                    row = {"tenor": T, "start": r["d"], "nobs": k, "n": N, "c": c_k, "va": va_k, "vb": vb_k,
                           "sab": r["sAB"], "sa2": r["sA2"], "sb2": r["sB2"], "p": r["P"][k],
                           "ch": ch_wad, "hfloor": 5 * 10**15, "h0": fp.h0(fp.tau(k, N), table_wad, ch_wad, 5 * 10**15)}
                    row.update({f"table{j}": v for j, v in enumerate(table_wad)})
                    states.append(row)
            print(f"{T:>2}D: B2 RMSE fixed {rmse_x:.12f} float {rmse_f:.12f} diff {abs(rmse_x - rmse_f):.2e}; "
                  f"B3 table max diff {out['tenors'][str(T)]['b3_max_diff']:.2e}; max |P diff| {max_dp:.2e}; "
                  f"Long_T max diff {out['tenors'][str(T)]['LT_max_abs_diff']:.2e}", flush=True)
    out["all_within_1e-9"] = all(v["b2_diff"] <= 1e-9 and v["b3_max_diff"] <= 1e-9 for v in out["tenors"].values())
    (RESULTS / "fixedpoint.json").write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
    cols = {k: [str(r[k]) for r in states] for k in states[0]}
    text = json.dumps({"source": "backtest/fixedpoint.py (S06): adopted w, sigmaP table, c_h on real windows", "states": cols}, indent=1)
    (ROOT / "vectors" / "backtest_states.json").write_text(text + chr(10), encoding="utf-8", newline=chr(10))
    print("all within 1e-9:", out["all_within_1e-9"], "| test vectors:", len(states))
    del b4


if __name__ == "__main__":
    main()
