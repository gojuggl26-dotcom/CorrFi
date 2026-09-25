"""Walk-forward windows and their fixed parameters (B §3.1, M §2.5.2, §4.1.1).

Windows of T = 7 / 14 / 28 days start every day at 00:00 UTC inside the evaluation period; a window is used only if
it ends by the end of the data. At each start date d, from the data before d only (the same procedure as market
creation, data/aquacorr_data/calib.py, here in float64 for the search — B §3.4):
  - bar k is valid iff the four price points (both assets, k-1 and k) are valid;
  - s_i = max(1.4826 MAD(30 d), 0.5 x 1.4826 MAD(180 d)) of the valid 5-minute log returns;
  - r~ = clip(r, +-4 s_i);
  - Σ̂_long (90 d) and Σ̂_recent (T d): non-demeaned per-bar second moments of r~;
  - alternative (B2): Σ̂_recent as an exponentially weighted average with half-life T/2 days over the 180 days
    before d (weights normalized);
  - B5: the demeaned covariances of the same windows.

    python -m backtest.windows      # builds .cache/backtest/windows.npz
"""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import numpy as np

from backtest.grid import CACHE, Grid, ts

BAR = 300
PER_DAY = 288
TENORS = (7, 14, 28)
C_WIN = 4.0
MAD_SCALE = 1.4826
EVAL_START = ts("2024-09-01")  # target case (B §2.1): two years of evaluation, 180 days of history before it
DATA_END = ts("2026-09-25")    # exclusive end of the local store


@dataclass
class Bars:
    """The 5-minute grid: prices (float64) and log returns of both assets."""

    t0: int
    pa: np.ndarray
    pb: np.ndarray
    ra: np.ndarray  # ra[j] = ln(pa[j] / pa[j-1]); nan when invalid; ra[0] = nan
    rb: np.ndarray
    valid: np.ndarray  # bar j valid (both assets, both points)

    def j(self, t: int) -> int:
        if (t - self.t0) % BAR:
            raise ValueError("not on the 5-minute grid")
        return (t - self.t0) // BAR


def load_bars() -> tuple[Bars, Grid, Grid]:
    ga, gb = Grid("ETHUSDT"), Grid("BTCUSDT")
    if ga.t0 % BAR:
        raise ValueError("grid must start on a 5-minute boundary")
    pa, pb = ga.price[::5].copy(), gb.price[::5].copy()
    ra = np.full_like(pa, np.nan)
    rb = np.full_like(pb, np.nan)
    ra[1:] = np.log(pa[1:] / pa[:-1])
    rb[1:] = np.log(pb[1:] / pb[:-1])
    valid = np.isfinite(ra) & np.isfinite(rb)
    return Bars(ga.t0, pa, pb, ra, rb, valid), ga, gb


def _mad(x: np.ndarray) -> float:
    m = np.median(x)
    return float(np.median(np.abs(x - m)))


def _moments(ra: np.ndarray, rb: np.ndarray, csa: float, csb: float, weights: np.ndarray | None = None):
    a = np.clip(ra, -csa, csa)
    b = np.clip(rb, -csb, csb)
    if weights is None:
        return float(np.mean(a * b)), float(np.mean(a * a)), float(np.mean(b * b))
    w = weights / weights.sum()
    return float(np.sum(w * a * b)), float(np.sum(w * a * a)), float(np.sum(w * b * b))


def _demeaned(ra: np.ndarray, rb: np.ndarray, csa: float, csb: float):
    a = np.clip(ra, -csa, csa)
    b = np.clip(rb, -csb, csb)
    a, b = a - a.mean(), b - b.mean()
    return float(np.mean(a * b)), float(np.mean(a * a)), float(np.mean(b * b))


def build(bars: Bars) -> dict[str, np.ndarray]:
    starts = np.arange(EVAL_START, DATA_END - 7 * 86_400 + 1, 86_400)
    out: dict[str, list] = {k: [] for k in ("start", "sA", "sB", "long", "long_dm")}
    for T in TENORS:
        for k in ("recent", "recent_ewma", "recent_dm"):
            out[f"{k}_{T}"] = []
    for d in starts:
        jd = bars.j(int(d))
        sl = lambda days: slice(jd - days * PER_DAY + 1, jd + 1)  # bars with t in (d - days, d]
        def valid_returns(days: int):
            s = sl(days)
            m = bars.valid[s]
            return bars.ra[s][m], bars.rb[s][m]
        a30, b30 = valid_returns(30)
        a180, b180 = valid_returns(180)
        sA = max(MAD_SCALE * _mad(a30), 0.5 * MAD_SCALE * _mad(a180))
        sB = max(MAD_SCALE * _mad(b30), 0.5 * MAD_SCALE * _mad(b180))
        csa, csb = C_WIN * sA, C_WIN * sB
        a90, b90 = valid_returns(90)
        out["start"].append(int(d))
        out["sA"].append(sA)
        out["sB"].append(sB)
        out["long"].append(_moments(a90, b90, csa, csb))
        out["long_dm"].append(_demeaned(a90, b90, csa, csb))
        # EWMA over the 180 days before d (age in bars of each valid return)
        s180 = sl(180)
        m180 = bars.valid[s180]
        age = (jd - np.arange(s180.start, s180.stop))[m180]
        for T in TENORS:
            aT, bT = valid_returns(T)
            out[f"recent_{T}"].append(_moments(aT, bT, csa, csb))
            out[f"recent_dm_{T}"].append(_demeaned(aT, bT, csa, csb))
            hl = T / 2 * PER_DAY
            out[f"recent_ewma_{T}"].append(_moments(a180, b180, csa, csb, weights=0.5 ** (age / hl)))
    return {k: np.asarray(v) for k, v in out.items()}


class Windows:
    """Fixed parameters per start date and the per-bar fair value path of a window (float64)."""

    def __init__(self, bars: Bars, params: dict[str, np.ndarray]):
        self.bars = bars
        self.p = params
        self.start = params["start"]

    def starts(self, T: int) -> np.ndarray:
        """Start dates whose window of T days ends by the end of the data."""
        return self.start[self.start + T * 86_400 <= DATA_END]

    def forecast(self, i: int, T: int, w: float, recent: str = "recent") -> tuple[float, float, float]:
        lg = self.p["long"][i]
        rc = self.p[f"{recent}_{T}"][i]
        return tuple(w * lg[c] + (1 - w) * rc[c] for c in range(3))  # type: ignore[return-value]

    def path(self, i: int, T: int, w: float, recent: str = "recent") -> dict[str, np.ndarray | float]:
        """P_fair(k) for k = 0..N (hub formula, κ_bar = 0), the cumulative sums, and the settlement Long_T."""
        N = T * PER_DAY
        n_min = -(-N * 99 // 100)
        d = int(self.start[i])
        jd = self.bars.j(d)
        s = slice(jd + 1, jd + N + 1)  # bar k = 1..N is 5-min index jd + k
        m = self.bars.valid[s]
        csa, csb = C_WIN * self.p["sA"][i], C_WIN * self.p["sB"][i]
        a = np.where(m, np.clip(self.bars.ra[s], -csa, csa), 0.0)
        b = np.where(m, np.clip(self.bars.rb[s], -csb, csb), 0.0)
        C = np.concatenate([[0.0], np.cumsum(a * b)])
        VA = np.concatenate([[0.0], np.cumsum(a * a)])
        VB = np.concatenate([[0.0], np.cumsum(b * b)])
        nvalid = np.concatenate([[0], np.cumsum(m)])
        sab, sa2, sb2 = self.forecast(i, T, w, recent)
        rem = N - np.arange(N + 1)
        rho = (C + rem * sab) / np.sqrt((VA + rem * sa2) * (VB + rem * sb2))
        P = (1 + np.clip(rho, -1, 1)) / 2
        void = nvalid[-1] < n_min or VA[-1] == 0 or VB[-1] == 0
        LT = 0.5 if void else float(P[-1])
        return {"P": P, "C": C, "VA": VA, "VB": VB, "nvalid": nvalid, "LT": LT, "void": void,
                "invalid": np.arange(N + 1) - nvalid, "N": N, "Nmin": n_min, "csa": csa, "csb": csb, "jd": jd}


def load() -> Windows:
    bars, _, _ = load_bars()
    z = np.load(CACHE / "windows.npz", allow_pickle=False)
    return Windows(bars, {k: z[k] for k in z.files})


def main() -> None:
    bars, _, _ = load_bars()
    params = build(bars)
    np.savez_compressed(CACHE / "windows.npz", **params)
    print(f"windows.npz: {len(params['start'])} start dates "
          f"({np.datetime64(int(params['start'][0]), 's')} .. {np.datetime64(int(params['start'][-1]), 's')})")
    for T in TENORS:
        n = int((params["start"] + T * 86_400 <= DATA_END).sum())
        print(f"  {T:>2}D windows: {n}")


if __name__ == "__main__":
    main()
