"""R §3: the replay's input files for one week (obsStart = a Monday 00:00 UTC chosen from replay/candidates.csv).

    python data/replay/make_inputs.py --week 2026-06-08 [--out replay/week-2026-06-08]

Writes (all numbers that are protocol values are decimal strings, so no precision is lost; no floats anywhere, so
that the normalized form is the same in Python and TypeScript):
  bars.json       the 2,017 price points k = 0..2016 (R §3.2): time, WAD prices (0 when invalid), validity, venues
  bars_void.json  the same with 15 spaced points invalidated (R §6.3): 30 invalid bars, so n_valid < N_min (VOID)
  calib.json      data/make_calib.py at cutoff = obsStart (R §3.3): data before obsStart only (asserted), w = 0.3
  schedule.json   the scenario S0-S4 (R §5.3), the golden table (§5.3.1), the pacing (App. A) and settlement (§6.1)
  manifest.json   keccak256 of the normalized content of the files above (R §3.5), the pinned build
                  (contracts/build-manifest.json) and the chain facts; Setup and the reference run add their parts.
Normalization: JSON with sorted keys, no whitespace, UTF-8 (canonical()).
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "data"))
sys.path.insert(0, str(ROOT / "verifier"))

from aquacorr_data import SYMBOLS, VENUES  # noqa: E402
from aquacorr_data.build import MonthCache  # noqa: E402
from aquacorr_data.calib import calibrate  # noqa: E402
from aquacorr_data.grid import price_point  # noqa: E402
from corrfi_verifier import fixedpoint as fp  # noqa: E402
from corrfi_verifier.keccak import keccak_hex  # noqa: E402
from make_calib import C_H, LAMBDA, SIGMA0, SIGMA_TABLE, W_DEFAULT, lambda_check  # noqa: E402

N, N_MIN, BAR, TENOR = 2016, 1996, 300, 7
U = 10**6
VOID_POINTS = [60 + 128 * i for i in range(15)]  # spaced, away from the scenario's trade bars


def canonical(obj) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def write(path: Path, obj) -> str:
    path.write_text(json.dumps(obj, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return keccak_hex(canonical(obj))


def schedule() -> dict:
    """R §5.3 (scenario), §5.3.1 (golden table), App. A (pacing, milliseconds), §6.1 (settlement order)."""
    tok = lambda x: str(x * U)
    trades = [
        {"id": "S0a", "k": 0, "actor": "A", "op": "mint", "amount": tok(100)},
        {"id": "S0b", "k": 0, "actor": "B", "op": "trade", "side": "long", "isBuy": True, "exactIn": False,
         "amount": tok(1000), "expect": {"dir": 1, "q1": "0", "q2": tok(1000), "path": "mint"}},
        {"id": "S1", "k": 504, "actor": "B", "op": "trade", "side": "long", "isBuy": False, "exactIn": True,
         "amount": tok(400), "expect": {"dir": 2, "q1": tok(400), "q2": "0", "path": "paired burn"}},
        {"id": "S2", "k": 1008, "actor": "C", "op": "trade", "side": "short", "isBuy": True, "exactIn": False,
         "amount": tok(500), "expect": {"dir": 3, "q1": tok(500), "q2": "0", "path": "from custody"}},
        {"id": "S3a", "k": 1512, "actor": "A", "op": "trade", "side": "short", "isBuy": False, "exactIn": True,
         "amount": tok(50), "expect": {"dir": 4, "q1": "0", "q2": tok(50), "path": "bought into custody"}},
        {"id": "S3b", "k": 1512, "actor": "A", "op": "burn", "amount": tok(50)},
        {"id": "S4", "k": 1920, "actor": "B", "op": "trade", "side": "long", "isBuy": True, "exactIn": True,
         "amount": tok(300), "expect": {"dir": 1, "q1": "0", "q2": "Q4", "path": "mint"}},
    ]
    # after each point of the scenario: q, N_L, N_S, collateral, supply (tokens; "Q4" = the quantity bought in S4)
    golden = [
        {"after": "initial", "q": "0", "nl": "0", "ns": "0", "collateral": "0", "supply": "0"},
        {"after": "S0a", "q": "0", "nl": "0", "ns": "0", "collateral": tok(100), "supply": tok(100)},
        {"after": "S0b", "q": tok(-1000), "nl": "0", "ns": tok(1000), "collateral": tok(1100), "supply": tok(1100)},
        {"after": "S1", "q": tok(-600), "nl": "0", "ns": tok(600), "collateral": tok(700), "supply": tok(700)},
        {"after": "S2", "q": tok(-100), "nl": "0", "ns": tok(100), "collateral": tok(700), "supply": tok(700)},
        {"after": "S3a", "q": tok(-150), "nl": "0", "ns": tok(150), "collateral": tok(700), "supply": tok(700)},
        {"after": "S3b", "q": tok(-150), "nl": "0", "ns": tok(150), "collateral": tok(650), "supply": tok(650)},
        {"after": "S4", "q": f"-{150 * U}-Q4", "nl": "0", "ns": f"{150 * U}+Q4", "collateral": f"{650 * U}+Q4",
         "supply": f"{650 * U}+Q4"},
    ]
    return {
        "note": "R v0.4 §5.3 scenario, §5.3.1 golden table, App. A pacing (ms), §6.1 settlement",
        "actors": {"A": "vault mint / burn and a Short sale", "B": "Long trades", "C": "a Short purchase"},
        "funding": {"maker": str(200_000 * U), "A": str(2_000 * U), "B": str(2_000 * U), "C": str(2_000 * U)},
        "maker": {"allocation": str(55_000 * U), "usdcApproval": str(100_000 * U), "generation": 1,
                  "config": {"riskBudget": str(100_000 * U), "qMaxMarket": str(50_000 * U), "qGroup": str(100_000 * U),
                             "qMinTrade": str(1 * U), "qMaxTrade": str(5_000 * U), "kq": str(10**18 // 6), "hM": "0",
                             "active": True}},
        "toleranceWad": str(2 * 10**15),
        "chain": {"genesisOffset": -3600, "marketCreationOffset": -240, "postDelay": 10, "tradeDelay": 11},
        "pacing": {"scene1Ms": 10_000, "phaseA": {"barsPerStep": 12, "steps": 167, "stepMs": 450, "tradeStepMs": 1_500},
                   "phaseB": {"barsPerStep": 1, "steps": 12, "stepMs": 600},
                   "settlementMs": 5_000, "verificationMs": 5_000,
                   "widen": {"lateMs": 3_000, "barsPerStep": 24}, "shortenPause": {"lateMs": 8_000}},
        "trades": trades,
        "golden": golden,
        "settlement": ["post k = 2016 (obsEnd + 10)", "finalize (obsEnd + 11)", "maker docks both orders",
                       "A, B, C redeem", "maker claims its custody"],
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--week", required=True, help="obsStart date (a Monday), e.g. 2026-06-08")
    ap.add_argument("--store", default=str(ROOT / "data" / "store" / "1m"))
    ap.add_argument("--out")
    a = ap.parse_args()
    t0 = int(datetime.strptime(a.week, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    if datetime.fromtimestamp(t0, timezone.utc).weekday() != 0:
        raise SystemExit("--week must be a Monday")
    out = Path(a.out or ROOT / "replay" / f"week-{a.week}")
    out.mkdir(parents=True, exist_ok=True)
    lambda_check()
    caches = {s: MonthCache(Path(a.store), s, keep=8) for s in SYMBOLS}
    memo: dict[int, tuple] = {}

    def full(t: int):
        if t not in memo:
            memo[t] = tuple(price_point(t, VENUES, caches[s]) for s in SYMBOLS)
        return memo[t]

    # calib.json: data before obsStart only (the point at t uses the bar opening at t - 60)
    c = calibrate(lambda t: tuple(p.price_wad for p in full(t)), t0, TENOR, W_DEFAULT[TENOR], fp)
    if not all(c["checks"].values()):
        raise SystemExit(f"forecast checks failed: {c['checks']}")
    assert c["maxBarOpenTime"] < t0 and c["cutoffExclusive"] == t0, "look-ahead"
    c.update({"sigmaTable": [str(x) for x in SIGMA_TABLE[TENOR]], "cH": str(C_H), "lambda": str(LAMBDA),
              "sigma0": str(SIGMA0[TENOR]), "parameters": "S06 adopted (DEC-19): backtest/results/params.json",
              "obsStart": t0, "tenorDays": TENOR,
              "source": {"store": "data/store/1m", "venues": list(VENUES), "symbols": list(SYMBOLS)}})

    points = []
    for k in range(N + 1):
        pa, pb = full(t0 + k * BAR)
        points.append({"k": k, "t": t0 + k * BAR,
                       "pA": str(pa.price_wad or 0), "pB": str(pb.price_wad or 0),
                       "validA": pa.valid, "validB": pb.valid,
                       "venuesA": pa.n_valid_venues, "venuesB": pb.n_valid_venues})
    header = {"pair": {"A": "ETH/USDT", "B": "BTC/USDT"}, "venues": list(VENUES), "obsStart": t0,
              "barSeconds": BAR, "n": N, "nMin": N_MIN}
    bars = {**header, "points": points}
    void_points = [dict(p) for p in points]
    for k in VOID_POINTS:
        void_points[k].update({"pA": "0", "validA": False})
    bars_void = {**header, "invalidated": VOID_POINTS, "points": void_points}

    # the expected settlement of both files (fixed point, as the chain computes it)
    def settle(pts):
        pa = [int(p["pA"]) if p["validA"] else None for p in pts]
        pb = [int(p["pB"]) if p["validB"] else None for p in pts]
        return fp.settle_from_prices(pa, pb, int(c["sA"]), int(c["sB"]), 4, N_MIN)
    lt, void, *_, n_valid = settle(points)
    lt_v, void_v, *_, n_valid_v = settle(void_points)
    assert not void and void_v and n_valid_v < N_MIN, (void, void_v, n_valid_v)

    hashes = {
        "bars.json": write(out / "bars.json", bars),
        "bars_void.json": write(out / "bars_void.json", bars_void),
        "calib.json": write(out / "calib.json", c),
        "schedule.json": write(out / "schedule.json", schedule()),
    }
    build = json.loads((ROOT / "contracts" / "build-manifest.json").read_text(encoding="utf-8"))
    manifest = {
        "week": {"obsStart": t0, "obsStartIso": datetime.fromtimestamp(t0, timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
                 "tenorDays": TENOR},
        "files": {name: {"keccak256": h} for name, h in hashes.items()},
        "expected": {"longT": str(lt), "nValid": n_valid, "void": void, "voidScenario": {"longT": str(lt_v), "nValid": n_valid_v}},
        "contracts": {"buildManifest": "contracts/build-manifest.json",
                      "buildManifestKeccak256": keccak_hex(canonical(build)),
                      "compiler": build["compiler"], "settings": build["settings"], "foundry": build["foundry"],
                      "creation": {n: v["creationLinked"] for n, v in build["contracts"].items()}},
        "chain": {"chainId": 84532, "baseSepoliaBlockGasLimit": None, "snapshot": None, "anvil": None},
        "reference": None,
    }
    write(out / "manifest.json", manifest)
    print(json.dumps({"out": str(out), "files": hashes, "longT": lt / 10**18, "nValid": n_valid,
                      "void": {"longT": lt_v / 10**18, "nValid": n_valid_v}}, indent=1))


if __name__ == "__main__":
    main()
