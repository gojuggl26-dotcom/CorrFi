"""Build calib.json for createMarket from the local 1-minute store (data/aquacorr_data/calib.py).

    python data/make_calib.py --cutoff 2026-09-21T00:00Z --tenor 7 --out calib.json

The data-derived part (s_A, s_B, Σ̂_long, Σ̂_recent, Σ̂_future) is computed here. The rest of createMarket's input
comes from the parameter table and is marked provisional until S06 fixes it (PROP-06, PROP-08, OI-10):
w = 0.3 / 0.5 / 0.6, σP(τ) linear from 0.04 / 0.035 / 0.03 at bin midpoints, c_h = 0.15, λ = 2^(-1/288), σ0.
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

W_DEFAULT = {7: 3 * 10**17, 14: 5 * 10**17, 28: 6 * 10**17}           # M §4.1.1 initial values (PROP-06)
SIGMA_P0 = {7: 4 * 10**16, 14: 35 * 10**15, 28: 3 * 10**16}           # M §4.1.3 provisional σP(0)
LAMBDA_288 = 997596132883620259                                       # 2^(-1/288) in WAD (fixtures, S03)
SIGMA0 = 8 * 10**14                                                   # M §4.2.2 typical σP,bar (OI-10)
C_H = 15 * 10**16


def sigma_table(p0: int) -> list[int]:
    """PROP-08: the linear provisional σP(τ) = σP(0)(1 - τ) at the 10 bin midpoints."""
    return [p0 * (19 - 2 * i) // 20 for i in range(10)]


def lambda_check() -> None:
    getcontext().prec = 50
    exact = Decimal(2) ** (Decimal(-1) / Decimal(288)) * Decimal(WAD)
    assert int(exact) == LAMBDA_288, (int(exact), LAMBDA_288)


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
        "sigmaTable": [str(x) for x in sigma_table(SIGMA_P0[a.tenor])],
        "cH": str(C_H), "lambda": str(LAMBDA_288), "sigma0": str(SIGMA0),
        "provisional": ["w (PROP-06)", "sigmaTable (PROP-08)", "cH", "lambda (half-life 288)", "sigma0 (OI-10)"],
        "source": {"store": "data/store/1m", "venues": list(VENUES), "symbols": list(SYMBOLS)},
    })
    Path(a.out).write_text(json.dumps(c, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"{a.out}: sA={c['sA']} sB={c['sB']} sAB={c['sAB']} sA2={c['sA2']} sB2={c['sB2']}")


if __name__ == "__main__":
    main()
