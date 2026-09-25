"""Build calib.json for createMarket from the local 1-minute store (data/aquacorr_data/calib.py).

    python data/make_calib.py --cutoff 2026-09-21T00:00Z --tenor 7 --out calib.json

The data-derived part (s_A, s_B, Σ̂_long, Σ̂_recent, Σ̂_future) is computed here. The rest of createMarket's input
is the parameter set adopted from the S06 backtest (DEC-19, backtest/results/params.json): w = 0.3 / 0.5 / 0.6,
the σP(τ) tables, c_h = 0.30, λ = 2^(-1/72) (half-life 72 bars) and σP,bar(0) per tenor.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from decimal import Decimal, getcontext
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "verifier"))

from aquacorr_data import SYMBOLS, VENUES                 # noqa: E402
from aquacorr_data.build import MonthCache                # noqa: E402
from aquacorr_data.calib import WAD, calibrate            # noqa: E402
from aquacorr_data.grid import price_point                # noqa: E402
from corrfi_verifier import fixedpoint as fp              # noqa: E402

W_DEFAULT = {7: 3 * 10**17, 14: 5 * 10**17, 28: 6 * 10**17}           # M §4.1.1, kept by S06 B2 (C5, DEC-20)
# S06 adopted values (DEC-19): σP(τ) at the bin midpoints, c_h, λ (half-life 72 bars), σP,bar(0)
SIGMA_TABLE = {
    7: [19723000000000000, 18479000000000000, 17196000000000000, 15710000000000000, 13996000000000000, 12166000000000000, 10179000000000000, 7959000000000000, 5450000000000000, 2737000000000000],
    14: [19117000000000000, 17820000000000000, 16365000000000000, 14811000000000000, 13116000000000000, 11332000000000000, 9439000000000000, 7340000000000000, 5012000000000000, 2308000000000000],
    28: [19988000000000000, 18513000000000000, 16903000000000000, 15197000000000000, 13385000000000000, 11432000000000000, 9378000000000000, 7167000000000000, 4774000000000000, 2113000000000000],
}
HALF_LIFE = 72
LAMBDA = 990419147466826256                                                   # 2^(-1/72) in WAD
SIGMA0 = {7: 81600000000000, 14: 39900000000000, 28: 20000000000000}
C_H = 300000000000000000


def lambda_check() -> None:
    getcontext().prec = 60
    exact = Decimal(2) ** (Decimal(-1) / Decimal(HALF_LIFE)) * Decimal(WAD)
    assert int(exact) == LAMBDA, (int(exact), LAMBDA)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cutoff", required=True, help="obsStart (5-minute boundary, UTC), e.g. 2026-09-21T00:00Z")
    ap.add_argument("--tenor", type=int, required=True, choices=(7, 14, 28))
    ap.add_argument("--w", type=float, help="override w (default: M §4.1.1 initial value)")
    ap.add_argument("--store", default=str(ROOT / "data" / "store" / "1m"))
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    cutoff = int(datetime.strptime(a.cutoff, "%Y-%m-%dT%H:%MZ").replace(tzinfo=timezone.utc).timestamp())
    lambda_check()
    w = W_DEFAULT[a.tenor] if a.w is None else int(Decimal(str(a.w)) * WAD)
    caches = {s: MonthCache(Path(a.store), s, keep=3) for s in SYMBOLS}

    memo: dict[int, tuple] = {}

    def points(t: int):
        if t not in memo:
            memo[t] = tuple(price_point(t, VENUES, caches[s]).price_wad for s in SYMBOLS)
        return memo[t]

    c = calibrate(points, cutoff, a.tenor, w, fp)
    if not all(c["checks"].values()):
        raise SystemExit(f"forecast checks failed: {c['checks']}")
    c.update({
        "sigmaTable": [str(x) for x in SIGMA_TABLE[a.tenor]],
        "cH": str(C_H), "lambda": str(LAMBDA), "sigma0": str(SIGMA0[a.tenor]),
        "parameters": "S06 adopted (DEC-19): backtest/results/params.json",
        "source": {"store": "data/store/1m", "venues": list(VENUES), "symbols": list(SYMBOLS)},
    })
    Path(a.out).write_text(json.dumps(c, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"{a.out}: sA={c['sA']} sB={c['sB']} sAB={c['sAB']} sA2={c['sA2']} sB2={c['sB2']}")


if __name__ == "__main__":
    main()
