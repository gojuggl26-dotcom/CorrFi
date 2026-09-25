"""Independent settlement of one market from the 1-minute store (used by the S05 lifecycle integration test).

Price points k = 0..N come from data/aquacorr_data/grid.py (not from the reporter); the settlement is computed
twice: with the fixed-point port F1-F5 (must equal the vault bit for bit) and with the 50-digit reference
(|difference| <= 1e-9 expected, R V2).

    python verifier/settle_market.py --obs-start 1789689600 --tenor 7 --sA ... --sB ...
Prints one JSON line.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "verifier"))

from aquacorr_data import SYMBOLS, VENUES                 # noqa: E402
from aquacorr_data.build import MonthCache                # noqa: E402
from aquacorr_data.grid import price_point                # noqa: E402
from corrfi_verifier import fixedpoint as fp, hp          # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--obs-start", type=int, required=True)
    ap.add_argument("--tenor", type=int, required=True)
    ap.add_argument("--sA", type=int, required=True)
    ap.add_argument("--sB", type=int, required=True)
    ap.add_argument("--store", default=str(ROOT / "data" / "store" / "1m"))
    a = ap.parse_args()
    n = a.tenor * 288
    n_min = (n * 99 + 99) // 100
    caches = {s: MonthCache(Path(a.store), s) for s in SYMBOLS}
    pa, pb = [], []
    for k in range(n + 1):
        t = a.obs_start + k * 300
        pa.append(price_point(t, VENUES, caches[SYMBOLS[0]]).price_wad)
        pb.append(price_point(t, VENUES, caches[SYMBOLS[1]]).price_wad)
    long_t, void, c, va, vb, n_valid = fp.settle_from_prices(pa, pb, a.sA, a.sB, 4, n_min)
    rho_hp, long_hp, void_hp, n_valid_hp = hp.settle(pa, pb, a.sA, a.sB, 4, n_min)
    print(json.dumps({"longT": str(long_t), "void": void, "c": str(c), "va": str(va), "vb": str(vb),
                      "nValid": n_valid, "longT_hp": str(long_hp), "void_hp": void_hp, "nValid_hp": n_valid_hp}))


if __name__ == "__main__":
    main()
