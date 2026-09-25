"""Market scenarios for the S03 contract tests, computed independently with the Python fixed-point port.

For each scenario: market parameters, price points k = 0..N (WAD; "" = invalid point, "missing" = never posted),
the reports the reporter would submit (k, pFair, h0) and the state expected after each (sig2), and the final
accumulator / settlement. The Solidity test posts the points, submits the reports (signed in the test), and must
reproduce every value exactly (U-3 enforces pFair/h0 equality on chain).

Synthetic data only (seeded random walks), not market data.
Run: python vectors/gen_market_scenarios.py
"""
import json
import random
import sys
from decimal import Decimal, localcontext
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "verifier"))

from corrfi_verifier import fixedpoint as fp  # noqa: E402
from corrfi_verifier.fixedpoint import WAD  # noqa: E402

N = 2016
N_MIN = 1996
H_FLOOR = 5 * 10**15
PARAMS = {
    "tenorDays": 7,
    "sA": 25 * 10**14, "sB": 25 * 10**14,                      # 0.0025 -> c*s = 0.01
    "sAB": 5 * 10**12, "sA2": 625 * 10**10, "sB2": 625 * 10**10,  # per-bar moments, rho_hat_0 = 0.8
    "sigmaTable": [4 * 10**16 * (19 - 2 * i) // 20 for i in range(10)],  # PROP-08
    "cH": 15 * 10**16,
    "lambda": 997596132883620259,                              # floor(2^(-1/288) * WAD)
    "sigma0": 8 * 10**14,
}
REPORT_KS = list(range(12, 2005, 12)) + list(range(2005, 2017))   # replay cadence (R §5.1): 167 x 12 + 12 x 1


def _normal(rng: random.Random) -> Decimal:
    """Irwin-Hall approximation of N(0,1) from 12 integer uniforms: exact, platform-independent arithmetic."""
    return Decimal(sum(rng.randrange(1 << 32) for _ in range(12))) / Decimal(1 << 32) - 6


def walk(seed: int, rho: str, sigma: str = "0.0025"):
    """Correlated log-price walks in WAD. Only integer RNG draws and decimal arithmetic (correctly rounded exp and
    sqrt at 50 digits) are used, so the output is byte-identical on every platform (CI checks this)."""
    rng = random.Random(seed)
    with localcontext(prec=50):
        r, sg = Decimal(rho), Decimal(sigma)
        mix = (1 - r * r).sqrt()
        pa, pb = [Decimal(3000)], [Decimal(60000)]
        for _ in range(N):
            z1, z2 = _normal(rng), _normal(rng)
            fat = 8 if rng.randrange(1000) < 2 else 1                 # rare fat tails exercise winsorize
            pa.append(pa[-1] * (sg * z1 * fat).exp())
            pb.append(pb[-1] * (sg * (r * z1 + mix * z2)).exp())
        return [int(x * WAD) for x in pa], [int(x * WAD) for x in pb]


def build(name: str, seed: int, rho: str, invalid: dict, missing: set, report_ks: list):
    """invalid: {k: 'A'|'B'|'AB'} marks price point k invalid for those assets; missing: never posted."""
    pa, pb = walk(seed, rho)
    points = []
    for k in range(N + 1):
        if k in missing:
            points.append({"a": "missing", "b": "missing"})
            continue
        bad = invalid.get(k, "")
        points.append({"a": "" if "A" in bad else str(pa[k]), "b": "" if "B" in bad else str(pb[k])})

    def price(k, asset):
        v = points[k][asset]
        return None if v in ("", "missing") else int(v)

    p = PARAMS
    cs_a, cs_b = 4 * p["sA"], 4 * p["sB"]
    p0 = fp.fair_value(0, 0, 0, 0, N, p["sAB"], p["sA2"], p["sB2"])
    h00 = fp.h0(0, p["sigmaTable"], p["cH"], H_FLOOR)
    sig2 = fp.sigma_bar2_init(p["sigma0"])
    c = va = vb = 0
    n_valid = 0
    processed = 0
    confirmed, p_prev = 0, p0
    reports = []
    for k in range(1, N + 1):
        a0, a1, b0, b1 = price(k - 1, "a"), price(k, "a"), price(k - 1, "b"), price(k, "b")
        if None not in (a0, a1, b0, b1):
            ra = fp.winsorize(fp.log_ratio(a0, a1), cs_a)
            rb = fp.winsorize(fp.log_ratio(b0, b1), cs_b)
            c, va, vb = fp.accumulate(c, va, vb, ra, rb)
            n_valid += 1
        processed = k
        if k in report_ks:
            try:
                pf = fp.fair_value(c, va, vb, k, N, p["sAB"], p["sA2"], p["sB2"])
            except fp.FixedPointError:
                reports.append({"k": k, "reject": "ZeroVariance"})
                continue
            if not 0 < pf < WAD:
                reports.append({"k": k, "reject": "PriceOutOfRange", "pFair": str(pf)})
                continue
            h = fp.h0(fp.tau(k, N), p["sigmaTable"], p["cH"], H_FLOOR)
            sig2 = fp.sigma_bar2_update(sig2, pf - p_prev, k - confirmed, p["lambda"])
            confirmed, p_prev = k, pf
            reports.append({"k": k, "pFair": str(pf), "h0": str(h), "sig2": str(sig2)})
    l, void = fp.long_t(c, va, vb, n_valid, N_MIN)
    ok = [r for r in reports if "reject" not in r]
    return {
        "name": name,
        "points_a": [pt["a"] for pt in points], "points_b": [pt["b"] for pt in points],
        # accepted reports as columns (the forge test parses each column once)
        "reports": {"k": [str(r["k"]) for r in ok], "pFair": [r["pFair"] for r in ok],
                    "h0": [r["h0"] for r in ok], "sig2": [r["sig2"] for r in ok]},
        "rejected": [r for r in reports if "reject" in r],
        "initial": {"pFair": str(p0), "h0": str(h00), "sig2": str(fp.sigma_bar2_init(p["sigma0"]))},
        "final": {"c": str(c), "va": str(va), "vb": str(vb), "nValid": n_valid, "processed": processed,
                  "longT": str(l), "void": void},
    }


def main():
    rng = random.Random(3)
    void_points = sorted(rng.sample(range(2, N - 20, 2), 15))     # 15 non-adjacent price points (R §6.3)
    scenarios = [
        build("normal", 101, "0.75", {40: "A", 41: "B", 700: "AB"}, set(), REPORT_KS),
        build("void", 202, "0.6", {k: "AB" for k in void_points}, set(), REPORT_KS),
        # never-posted points; bars around them only become (invalid) after obsEnd + 48 h. No reports.
        build("grace", 303, "0.7", {}, {100, 2016}, []),
    ]
    out = {"params": {k: ([str(x) for x in v] if isinstance(v, list) else str(v)) for k, v in PARAMS.items()},
           "hFloor": H_FLOOR, "n": N, "nMin": N_MIN, "scenarios": scenarios}
    path = ROOT / "vectors" / "market_scenarios.json"
    path.write_text(json.dumps(out, indent=1) + "\n", encoding="utf-8", newline="\n")
    for s in scenarios:
        print(f"{s['name']}: reports {len(s['reports']['k'])} (rejected {len(s['rejected'])}), final {s['final']}")


if __name__ == "__main__":
    main()
