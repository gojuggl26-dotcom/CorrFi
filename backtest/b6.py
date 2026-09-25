"""B6 (reference only): maker P&L sensitivity with the order-flow model of DEC-18 (B §4.5, docs/s06/00-criteria.md §4).

Model (assumptions, not observations):
  uninformed takers: Poisson arrivals 1 / 4 / 12 per hour; direction D1-D4 equally likely; size log-normal, median
    500 tokens, log-sd 0.75, clipped to [1, 5,000];
  informed takers: a share π of the arrivals; at arrival s minutes into the bar (s = 1..4) they know P*(k, s) and
    buy 1,000 Long if P* > the ask α(q), sell 1,000 Long if P* < the bid β(q), else do nothing;
  maker: M's quote (m(q) = P - kq q / qmax, α = clip(max(m + h, P + h_min), 0, 1), β = clip(min(m - h, P - h_min), 0, 1)),
    h = h_min + h_U(U*), h_min = h0(τ) + c_O σ̄ sqrt(age / Δ); caps |q| <= qmax, U_post < Umax for risk-increasing
    fills, Q <= 5,000; one market; RiskBudget 100,000.
P&L of a window at Long_T: cash' + q Long_T, where cash' counts a Short held as 1 USDC minus a Long (so mint / burn
and the vault custody drop out); spread income = sum of (trade price - P_fair) in the maker's favour.
    python -m backtest.b6      # writes backtest/results/b6.json
"""
from __future__ import annotations

import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np

from backtest.b3 import H_FLOOR
from backtest.b4b1 import ema_sig2
from backtest.grid import Grid
from backtest.stats import sigma_p
from backtest.windows import DATA_END, TENORS, load

RESULTS = Path(__file__).resolve().parent / "results"
RB = 100_000.0
HU_MAX, U0, UMAX = 0.02, 0.6, 0.9
QMAX_TRADE = 5_000.0
FREQ = {"low": 1.0, "mid": 4.0, "high": 12.0}   # per hour
BASE = {"kq": 1 / 6, "cap": 0.5, "freq": "mid", "informed": 0.10, "ch": None}
SENS = {"kq": (0.10, 0.27), "cap": (0.30, 0.70), "freq": ("low", "high"), "informed": (0.0, 0.30), "ch": (0.10, 0.20)}
SEED = 20260926

_G: dict = {}


def _init() -> None:
    _G["W"] = load()
    _G["ga"], _G["gb"] = Grid("ETHUSDT"), Grid("BTCUSDT")
    _G["b3"] = json.loads((RESULTS / "b3.json").read_text(encoding="utf-8"))
    _G["b4"] = json.loads((RESULTS / "b4b1.json").read_text(encoding="utf-8"))


def _integral(P: float, h: float, hmin: float, s: float, a: float, b: float, alpha: bool) -> float:
    """∫_a^b f(q) dq for the piecewise-linear clipped quote (float, exact cut points)."""
    if alpha:
        lo_c, hi_c = (P + h - 1) / s, (h - hmin) / s          # f = 1 below lo_c, linear, P + hmin above hi_c
        pieces = [(-np.inf, lo_c, lambda u, v: v - u),
                  (lo_c, hi_c, lambda u, v: (P + h) * (v - u) - s * (v * v - u * u) / 2),
                  (hi_c, np.inf, lambda u, v: (P + hmin) * (v - u))]
    else:
        lo_c, hi_c = -(h - hmin) / s, (P - h) / s              # P - hmin below lo_c, linear, 0 above hi_c
        pieces = [(-np.inf, lo_c, lambda u, v: (P - hmin) * (v - u)),
                  (lo_c, hi_c, lambda u, v: (P - h) * (v - u) - s * (v * v - u * u) / 2),
                  (hi_c, np.inf, lambda u, v: 0.0)]
    tot = 0.0
    for x0, x1, f in pieces:
        u, v = max(a, x0), min(b, x1)
        if u < v:
            tot += f(u, v)
    return tot


def _hu(u: float) -> float:
    if u <= U0:
        return 0.0
    x = (u - U0) / (UMAX - U0)
    return HU_MAX * x * x


def _rc(q: float, P: float) -> float:
    return q * P if q > 0 else -q * (1 - P)


def _window(args) -> dict:
    T, i, sc, co = args
    W, ga, gb, b3, b4 = _G["W"], _G["ga"], _G["gb"], _G["b3"], _G["b4"]
    w = float(b3["w"][str(T)])
    table = np.array(b3["tenors"][str(T)]["table"])
    ch = sc["ch"] if sc["ch"] is not None else b3["ch"]
    lam = b4["tenors"][str(T)]["lambda_selected"]
    s0 = b4["tenors"][str(T)]["sigma0_first_day_sd_median"]["all_windows"]
    p = W.path(i, T, w)
    N = p["N"]
    P = p["P"]
    sig = np.sqrt(ema_sig2(np.diff(P), lam, s0 * s0))
    d = int(W.start[i])
    qmax = sc["cap"] * RB * 1.0          # tokens (the market cap as a share of the budget, M §6.1)
    s = sc["kq"] / qmax
    sab, sa2, sb2 = W.forecast(i, T, w)
    rng = np.random.default_rng(SEED + 7919 * i + T)
    rate = FREQ[sc["freq"]] / 3600.0
    n = rng.poisson(rate * N * 300)
    times = np.sort(rng.uniform(0, N * 300, n))
    q = cash = spread = 0.0
    peak, mdd = 0.0, 0.0
    u_hi = 0
    inc_orders = inc_rejects = trades = 0
    m0 = (d - ga.t0) // 60
    for t in times:
        k = min(int(t // 300), N - 1)
        age = t - 300 * k
        Pk = P[k]
        tau = k / N
        hmin = max(H_FLOOR, ch * float(sigma_p(np.array([tau]), table)[0])) + co * sig[k] * np.sqrt(age / 300)
        u_pre = _rc(q, Pk) / RB
        h = hmin + _hu(u_pre)
        u_hi += u_pre > U0
        informed = rng.random() < sc["informed"]
        if informed:
            sm = int(age // 60)
            if sm < 1:
                continue
            mk = m0 + 5 * k
            ra = np.log(ga.price[mk + sm] / ga.price[mk])
            rb = np.log(gb.price[mk + sm] / gb.price[mk])
            if not (np.isfinite(ra) and np.isfinite(rb)):
                continue
            a_ = np.clip(ra, -p["csa"], p["csa"])
            b_ = np.clip(rb, -p["csb"], p["csb"])
            rem = N - k - sm / 5
            rho = (p["C"][k] + a_ * b_ + rem * sab) / np.sqrt((p["VA"][k] + a_ * a_ + rem * sa2) * (p["VB"][k] + b_ * b_ + rem * sb2))
            pstar = (1 + np.clip(rho, -1, 1)) / 2
            ask = min(1.0, max(Pk + h - s * q, Pk + hmin))
            bid = max(0.0, min(Pk - h - s * q, Pk - hmin))
            if pstar > ask:
                side, Q = 1, 1_000.0
            elif pstar < bid:
                side, Q = 2, 1_000.0
            else:
                continue
        else:
            side = int(rng.integers(1, 5))
            Q = float(np.clip(np.exp(np.log(500.0) + 0.75 * rng.standard_normal()), 1.0, QMAX_TRADE))
        dq = -Q if side in (1, 4) else Q
        q1 = q + dq
        if abs(q1) > qmax:
            if abs(q1) > abs(q):
                inc_orders += 1
                inc_rejects += 1
            continue
        if abs(q1) > abs(q):
            inc_orders += 1
            if _rc(q1, Pk) / RB >= UMAX:
                inc_rejects += 1
                continue
        if side == 1:        # taker buys Long: maker receives ∫α over [q - Q, q]
            x = _integral(Pk, h, hmin, s, q - Q, q, True)
            cash += x
            spread += x - Pk * Q
        elif side == 2:      # taker sells Long: maker pays ∫β over [q, q + Q]
            x = _integral(Pk, h, hmin, s, q, q + Q, False)
            cash -= x
            spread += Pk * Q - x
        elif side == 3:      # taker buys Short: maker receives Q - ∫β
            x = Q - _integral(Pk, h, hmin, s, q, q + Q, False)
            cash += x - Q
            spread += x - (1 - Pk) * Q
        else:                # taker sells Short: maker pays Q - ∫α
            x = Q - _integral(Pk, h, hmin, s, q - Q, q, True)
            cash -= x - Q
            spread += (1 - Pk) * Q - x
        q = q1
        trades += 1
        mtm = cash + q * Pk
        peak = max(peak, mtm)
        mdd = max(mdd, peak - mtm)
    LT = p["LT"]
    pnl = cash + q * LT
    return {"pnl": pnl, "spread": spread, "inventory": pnl - spread, "mdd": mdd, "trades": trades,
            "u_hi_share": u_hi / max(1, n), "inc_reject_share": inc_rejects / max(1, inc_orders), "q_end": q}


def scenarios() -> list[tuple[str, dict]]:
    out = [("base", dict(BASE))]
    for key, vals in SENS.items():
        for v in vals:
            sc = dict(BASE)
            sc[key] = v
            out.append((f"{key}={v}", sc))
    return out


def main() -> None:
    b4 = json.loads((RESULTS / "b4b1.json").read_text(encoding="utf-8"))
    co = b4["co_selected"]
    W = load()
    res: dict = {"model": "DEC-18 (assumptions)", "co": co, "scenarios": {}}
    with ProcessPoolExecutor(14, initializer=_init) as ex:
        for name, sc in scenarios():
            res["scenarios"][name] = {"params": sc, "tenors": {}}
            for T in TENORS:
                idx = np.where(W.start + T * 86_400 <= DATA_END)[0]
                rows = list(ex.map(_window, [(T, int(i), sc, co) for i in idx], chunksize=8))
                pnl = np.array([r["pnl"] for r in rows])
                agg = {
                    "windows": len(rows),
                    "pnl_median": float(np.median(pnl)), "pnl_mean": float(pnl.mean()),
                    "pnl_p5": float(np.percentile(pnl, 5)), "pnl_p5_over_budget": float(np.percentile(pnl, 5) / RB),
                    "pnl_negative_share": float(np.mean(pnl < 0)),
                    "spread_median": float(np.median([r["spread"] for r in rows])),
                    "inventory_median": float(np.median([r["inventory"] for r in rows])),
                    "mdd_median": float(np.median([r["mdd"] for r in rows])), "mdd_p95": float(np.percentile([r["mdd"] for r in rows], 95)),
                    "trades_median": float(np.median([r["trades"] for r in rows])),
                    "u_above_60_share": float(np.mean([r["u_hi_share"] for r in rows])),
                    "risk_increasing_rejected_share": float(np.mean([r["inc_reject_share"] for r in rows])),
                }
                res["scenarios"][name]["tenors"][str(T)] = agg
                print(f"{name:<14} {T:>2}D median P&L {agg['pnl_median']:>9.1f}  p5 {agg['pnl_p5']:>10.1f}  "
                      f"spread {agg['spread_median']:>8.1f}  inventory {agg['inventory_median']:>9.1f}  "
                      f"MDD med {agg['mdd_median']:>8.1f}  U>60% {agg['u_above_60_share']:.3f}  rej {agg['risk_increasing_rejected_share']:.3f}", flush=True)
    base = res["scenarios"]["base"]["tenors"]
    res["ch_check_b_base_median_nonnegative"] = {T: base[str(T)]["pnl_median"] >= 0 for T in TENORS}
    (RESULTS / "b6.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8", newline="\n")


if __name__ == "__main__":
    main()
