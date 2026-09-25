"""Figures and the proposed parameter set (B §5.1) from backtest/results/*.json.
    python -m backtest.report      # writes backtest/results/params.json and backtest/results/fig_*.png
"""
from __future__ import annotations

import json
from decimal import Decimal, getcontext
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

RESULTS = Path(__file__).resolve().parent / "results"
TENORS = (7, 14, 28)
WAD = 10**18


def load(name: str) -> dict:
    return json.loads((RESULTS / f"{name}.json").read_text(encoding="utf-8"))


def lam_wad(hl: int) -> int:
    getcontext().prec = 60
    return int(Decimal(2) ** (Decimal(-1) / Decimal(hl)) * WAD)


def wad(x: float, digits: int) -> int:
    """A decimal value rounded to `digits` places, as an exact WAD integer (no binary floating point)."""
    return int(Decimal(f"{x:.{digits}f}") * WAD)


def params(b2: dict, b3: dict, b4: dict) -> dict:
    """The proposed values for M v0.6 §8.1 and createMarket, with their WAD representation."""
    out = {"note": "S06 proposal; adopted only after the design review (B §5.3)", "tenors": {}}
    for T in TENORS:
        t4 = b4["tenors"][str(T)]
        s0 = t4["sigma0_first_day_sd_median"]["all_windows"]
        s0_round = float(f"{s0:.3g}")
        table = b3["tenors"][str(T)]["table"]
        table_round = [round(v, 6) for v in table]
        out["tenors"][str(T)] = {
            "w": b3["w"][str(T)],
            "w_wad": str(wad(float(b3["w"][str(T)]), 1)),
            "sigma_table": table_round,
            "sigma_table_wad": [str(wad(v, 6)) for v in table_round],
            "half_life_bars": t4["hl_selected"],
            "lambda_wad": str(lam_wad(t4["hl_selected"])),
            "sigma0": s0_round,
            "sigma0_wad": str(int(Decimal(repr(s0_round)) * WAD)),
            "b2_mechanical": {"selected_w": b2["tenors"][str(T)]["selected_w"], "best_oos_w": b2["tenors"][str(T)]["best_oos_w"],
                              "ewma_rule_met": b2["tenors"][str(T)]["ewma"]["adopt"], "ewma_best_w": b2["tenors"][str(T)]["ewma"]["best_w"]},
            "b2_after_c5": b2["c5"][str(T)],
        }
    out["ch"] = b3["ch"]
    out["ch_wad"] = str(wad(b3["ch"], 6))
    out["cO"] = b4["co_selected"]
    out["cO_wad"] = str(wad(b4["co_selected"], 6))
    out["hFloor"] = 0.005
    return out


def figures(b2: dict, b3: dict, b4: dict, b5: dict, b6: dict | None) -> list[str]:
    files = []
    g = np.array(b2["grid"])
    fig, axes = plt.subplots(1, 3, figsize=(15, 4), sharey=True)
    for ax, T in zip(axes, TENORS):
        t = b2["tenors"][str(T)]
        ax.plot(g, t["oos_rmse"]["recent"], "o-", label="out-of-sample (2025-09..)")
        ax.plot(g, t["year1_rmse"]["recent"], "s--", label="year 1 (2024-09..2025-08)")
        ax.plot(g, t["oos_rmse"]["recent_ewma"], "^:", label="EWMA recent, out-of-sample")
        ax.axvline(t["selected_w"], color="0.6", lw=0.8, ls="--")
        ax.axvline(b2["c5"][str(T)]["w"], color="k", lw=1.0)
        ax.set_title(f"{T}D: RMSE of Long_T - P_fair(0) by w")
        ax.set_xlabel("w")
    axes[0].set_ylabel("RMSE")
    axes[0].legend(fontsize=8)
    fig.tight_layout()
    f = RESULTS / "fig_b2_w.png"
    fig.savefig(f, dpi=110)
    files.append(f.name)
    plt.close(fig)

    fig, ax = plt.subplots(figsize=(7, 4))
    mids = (2 * np.arange(10) + 1) / 20
    for T in TENORS:
        t = b3["tenors"][str(T)]
        ax.plot(mids, t["rmse_full"], "o", label=f"{T}D raw")
        ax.plot(np.append(mids, 1), t["table"] + [0], "-", label=f"{T}D table")
        ax.plot(mids, t["provisional_table"], ":", label=f"{T}D provisional")
    ax.set_xlabel("τ")
    ax.set_ylabel("σP(τ)")
    ax.set_title("B3: forecast-error table")
    ax.legend(fontsize=7, ncol=3)
    fig.tight_layout()
    f = RESULTS / "fig_b3_table.png"
    fig.savefig(f, dpi=110)
    files.append(f.name)
    plt.close(fig)

    fig, axes = plt.subplots(1, 2, figsize=(12, 4))
    s = np.arange(1, 7)
    for T in TENORS:
        t = b4["tenors"][str(T)]
        axes[0].plot(s, t["standardized_gap_quantiles_oos"]["99"], "o-", label=f"{T}D 99%")
        axes[0].plot(s, t["standardized_gap_quantiles_oos"]["97.5"], "s--", label=f"{T}D 97.5%")
        h6 = [v["median"] for v in b4["b1"]["tenors"][str(T)]["hmin_6min"].values()]
        axes[1].plot(mids, h6, "o-", label=f"{T}D h_min(6 min) median")
    axes[0].set_xlabel("s (minutes after t_k)")
    axes[0].set_title("B4: D(s) / (σ̄ sqrt(s/5)) quantiles")
    axes[0].legend(fontsize=7)
    axes[1].axhline(0.01, color="r", lw=0.8)
    axes[1].set_xlabel("τ")
    axes[1].set_title("B1 (c): h_min at 6 minutes")
    axes[1].legend(fontsize=7)
    fig.tight_layout()
    f = RESULTS / "fig_b4_b1.png"
    fig.savefig(f, dpi=110)
    files.append(f.name)
    plt.close(fig)

    if b6:
        names = list(b6["scenarios"])
        fig, axes = plt.subplots(1, 3, figsize=(16, 5), sharey=True)
        for ax, T in zip(axes, TENORS):
            med = [b6["scenarios"][n]["tenors"][str(T)]["pnl_median"] for n in names]
            p5 = [b6["scenarios"][n]["tenors"][str(T)]["pnl_p5"] for n in names]
            y = np.arange(len(names))
            ax.barh(y - 0.2, med, 0.4, label="median")
            ax.barh(y + 0.2, p5, 0.4, label="5th percentile")
            ax.set_yticks(y, names, fontsize=8)
            ax.axvline(0, color="k", lw=0.8)
            ax.set_title(f"B6 (model): maker P&L per window, {T}D")
        axes[0].legend(fontsize=8)
        fig.tight_layout()
        f = RESULTS / "fig_b6_pnl.png"
        fig.savefig(f, dpi=110)
        files.append(f.name)
        plt.close(fig)
    del b5
    return files


def main() -> None:
    b2, b3, b4, b5 = load("b2"), load("b3"), load("b4b1"), load("b5")
    b6 = load("b6") if (RESULTS / "b6.json").exists() else None
    p = params(b2, b3, b4)
    (RESULTS / "params.json").write_text(json.dumps(p, indent=1) + "\n", encoding="utf-8", newline="\n")
    print("params.json:", json.dumps({k: v for k, v in p.items() if k != "tenors"}))
    for T in TENORS:
        t = p["tenors"][str(T)]
        print(f"  {T}D w {t['w']} table {t['sigma_table']} HL {t['half_life_bars']} σ0 {t['sigma0']}")
    print("figures:", figures(b2, b3, b4, b5, b6))


if __name__ == "__main__":
    main()
