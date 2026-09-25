"""R §3.4: rank the replay week candidates (7-day windows starting Monday 00:00 UTC, the last 52).

    python data/replay/select_week.py [--last 2026-09-14] [--weeks 52] [--out replay/candidates.csv]

For each candidate obsStart T0 it builds, from the local 1-minute store (data/store/1m, the production rules of
M §2.5.1):
  - the calibration from data before T0 only (data/make_calib.py: w = 0.3, R §3.3), hence rho_hat_0 and P_fair(0);
  - the 2,017 price points of the week and the settlement with the protocol's fixed-point functions (C, V_A, V_B,
    n_valid, Long_T), hence rho_T;
  - the data-quality counts (invalid bars, the last 12 bars, points with fewer than 5 / 3 venues).
Conditions (R §3.4): invalid bars <= 5 (n_valid >= 2,011), the last 12 bars all valid, 0.05 <= Long_T <= 0.95.
Eligible weeks are ranked by |rho_T - rho_hat_0| (larger first). The final week is chosen by a person.
"""
from __future__ import annotations

import argparse
import csv
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "verifier"))

from aquacorr_data import SYMBOLS, VENUES  # noqa: E402
from aquacorr_data.build import MonthCache  # noqa: E402
from aquacorr_data.calib import WAD, calibrate  # noqa: E402
from aquacorr_data.grid import price_point  # noqa: E402
from corrfi_verifier import fixedpoint as fp  # noqa: E402
from make_calib import W_DEFAULT  # noqa: E402

N = 2016
N_MIN = 1996
BAR = 300


def mondays(last: datetime, weeks: int) -> list[int]:
    return [int((last - timedelta(weeks=i)).timestamp()) for i in range(weeks)][::-1]


def main() -> None:
    ap = argparse.ArgumentParser()
    today = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    # the last Monday whose 7 days (and the point at obsEnd) are in the past
    default_last = today - timedelta(days=today.weekday()) - timedelta(weeks=1)
    ap.add_argument("--last", default=default_last.strftime("%Y-%m-%d"), help="the latest candidate Monday")
    ap.add_argument("--weeks", type=int, default=52)
    ap.add_argument("--store", default=str(ROOT / "data" / "store" / "1m"))
    ap.add_argument("--out", default=str(ROOT / "replay" / "candidates.csv"))
    a = ap.parse_args()
    last = datetime.strptime(a.last, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    if last.weekday() != 0:
        raise SystemExit("--last must be a Monday")
    caches = {s: MonthCache(Path(a.store), s, keep=8) for s in SYMBOLS}
    memo: dict[int, tuple] = {}

    def point_full(t: int):
        if t not in memo:
            memo[t] = tuple(price_point(t, VENUES, caches[s]) for s in SYMBOLS)
        return memo[t]

    def prices(t: int):
        return tuple(p.price_wad for p in point_full(t))

    rows = []
    for t0 in mondays(last, a.weeks):
        c = calibrate(prices, t0, 7, W_DEFAULT[7], fp)
        s_a, s_b = int(c["sA"]), int(c["sB"])
        s_ab, s_a2, s_b2 = int(c["sAB"]), int(c["sA2"]), int(c["sB2"])
        p0 = fp.fair_value(0, 0, 0, 0, N, s_ab, s_a2, s_b2)
        rho0 = 2 * p0 - WAD
        pts = [point_full(t0 + k * BAR) for k in range(N + 1)]
        pa = [p[0].price_wad for p in pts]
        pb = [p[1].price_wad for p in pts]
        long_t, void, _, _, _, n_valid = fp.settle_from_prices(pa, pb, s_a, s_b, 4, N_MIN)
        rho_t = 2 * long_t - WAD
        bar_ok = [None not in (pa[k - 1], pa[k], pb[k - 1], pb[k]) for k in range(1, N + 1)]
        last12 = all(bar_ok[-12:])
        venues = [min(p[0].n_valid_venues, p[1].n_valid_venues) for p in pts]
        eligible = (N - n_valid) <= 5 and last12 and WAD // 20 <= long_t <= 19 * WAD // 20 and all(c["checks"].values())
        rows.append({
            "obsStart": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "obsStartUnix": t0,
            "rho_hat_0": rho0 / WAD, "pFair0": p0 / WAD,
            "rho_T": rho_t / WAD, "longT": long_t / WAD, "void": void,
            "n_valid": n_valid, "invalid_bars": N - n_valid, "last12_valid": last12,
            "points_below_5_venues": sum(v < 5 for v in venues), "points_below_3_venues": sum(v < 3 for v in venues),
            "gap": abs(rho_t - rho0) / WAD, "eligible": eligible,
        })
        print(f"{rows[-1]['obsStart']}: rho0 {rho0 / WAD:+.4f} rhoT {rho_t / WAD:+.4f} LongT {long_t / WAD:.4f} "
              f"invalid {N - n_valid} last12 {last12} <5v {rows[-1]['points_below_5_venues']} eligible {eligible}", flush=True)
    ranked = sorted((r for r in rows if r["eligible"]), key=lambda r: -r["gap"])
    for i, r in enumerate(ranked, 1):
        r["rank"] = i
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", newline="\n", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["rank", *rows[0].keys()], lineterminator="\n")
        w.writeheader()
        for r in sorted(rows, key=lambda r: (r.get("rank") or 10**9, r["obsStartUnix"])):
            w.writerow({k: (f"{v:.6f}" if isinstance(v, float) else v) for k, v in r.items()} | {"rank": r.get("rank", "")})
    print(f"{out}: {len(rows)} candidates, {len(ranked)} eligible")


if __name__ == "__main__":
    main()
