"""Generate shared fixed-point test vectors (docs/s01/01-fixed-point-spec.md §5) from the Python port.

Output: vectors/fixedpoint.json — every value is a decimal string; "revert" marks an expected revert.
The Solidity (forge) and TypeScript (node --test) suites read this file and must match exactly.
Deterministic: fixed seeds; rerunning produces identical bytes.

Run: python vectors/gen_fixedpoint.py
"""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "verifier"))

from corrfi_verifier import fixedpoint as fp  # noqa: E402
from corrfi_verifier.fixedpoint import UNIT, WAD  # noqa: E402

N_RANDOM = 250
TABLE = [4 * 10**16 * (19 - 2 * i) // 20 for i in range(10)]   # PROP-08 provisional 7D table


def cols(rows: list[dict]) -> dict:
    keys = rows[0].keys()
    return {k: [str(r[k]) for r in rows] for k in keys}


def attempt(f, *a):
    try:
        return f(*a)
    except fp.FixedPointError:
        return "revert"


def main():
    rng = random.Random(20260925)
    out = {"meta": {"spec": "docs/s01/01-fixed-point-spec.md", "table": [str(v) for v in TABLE],
                    "generator": "vectors/gen_fixedpoint.py"}}

    xs = [1, 2, 3, 999, 10**9, WAD // 2, WAD - 1, WAD, WAD + 1, 2 * WAD, 10**30, 2**200, 2**255 - 1]
    xs += [rng.randrange(WAD // 2, 2 * WAD) for _ in range(N_RANDOM)]
    xs += [rng.randrange(1, 2 ** rng.randrange(1, 255)) for _ in range(N_RANDOM)]
    out["ln_wad"] = cols([{"x": x, "y": fp.ln_wad(x)} for x in xs])

    rows = []
    for _ in range(N_RANDOM):
        p0 = rng.randrange(10**20, 10**23)
        p1 = p0 * rng.randrange(6 * 10**8, 16 * 10**8) // 10**9
        rows.append({"p0": p0, "p1": p1, "r": fp.log_ratio(p0, p1)})
    out["log_ratio"] = cols(rows)

    rows = []
    for i in range(N_RANDOM):
        va, vb = rng.randrange(0, 10**18), rng.randrange(0, 10**18)
        bound = fp.sqrt(va * vb)
        c = rng.randrange(-bound - 2, bound + 3) if i % 10 else rng.choice([bound + 5, -bound - 5])  # some clamps
        nv, nmin = rng.choice([(1996, 1996), (1995, 1996), (2016, 1996)])
        l, void = fp.long_t(c, va, vb, nv, nmin)
        rows.append({"c": c, "va": va, "vb": vb, "nv": nv, "nmin": nmin, "rho": attempt(fp.rho, c, va, vb),
                     "l": l, "void": int(void)})
    out["settle"] = cols(rows)

    rows = []
    for _ in range(N_RANDOM):
        l = rng.choice([0, WAD, WAD // 2, rng.randrange(0, WAD + 1)])
        ql, qs = rng.randrange(0, 10**13), rng.randrange(0, 10**13)
        rows.append({"ql": ql, "qs": qs, "l": l, "pay": fp.payout(ql, qs, l), "res": fp.reserve(ql, qs, l)})
    out["payout"] = cols(rows)

    rows = []
    for i in range(N_RANDOM):
        n = rng.choice([2016, 4032, 8064])
        n_obs = [0, n, rng.randrange(0, n + 1)][i % 3]
        sa2, sb2 = rng.randrange(10**10, 10**13), rng.randrange(10**10, 10**13)
        sab = rng.randrange(-fp.sqrt(sa2 * sb2), fp.sqrt(sa2 * sb2) + 1)
        c, va, vb = 0, 0, 0
        for _ in range(rng.randrange(0, 50)):
            ra, rb = rng.randrange(-10**16, 10**16), rng.randrange(-10**16, 10**16)
            c, va, vb = fp.accumulate(c, va, vb, ra, rb)
        rows.append({"c": c, "va": va, "vb": vb, "nobs": n_obs, "n": n, "sab": sab, "sa2": sa2, "sb2": sb2,
                     "p": attempt(fp.fair_value, c, va, vb, n_obs, n, sab, sa2, sb2)})
    out["fair_value"] = cols(rows)

    rows = []
    for _ in range(N_RANDOM // 5):
        c, va, vb = rng.randrange(-10**17, 10**17), rng.randrange(0, 10**18), rng.randrange(0, 10**18)
        ra, rb = rng.randrange(-10**17, 10**17), rng.randrange(-10**17, 10**17)
        cs = rng.randrange(10**15, 10**17)
        wa, wb = fp.winsorize(ra, cs), fp.winsorize(rb, cs)
        c2, va2, vb2 = fp.accumulate(c, va, vb, wa, wb)
        rows.append({"c": c, "va": va, "vb": vb, "ra": ra, "rb": rb, "cs": cs, "c2": c2, "va2": va2, "vb2": vb2})
    out["accumulate"] = cols(rows)

    ts = [0, 1, WAD // 20, WAD // 20 + 1, WAD // 2, 19 * WAD // 20, 19 * WAD // 20 + 1, WAD - 1, WAD, WAD + 1]
    ts += [rng.randrange(0, WAD + 1) for _ in range(N_RANDOM)]
    rows = [{"t": t, "sp": fp.sigma_p(t, TABLE), "h0": fp.h0(t, TABLE, 15 * 10**16, 5 * 10**15)} for t in ts]
    out["sigma_p"] = cols(rows)

    rows = []
    for _ in range(N_RANDOM):
        sig2 = rng.randrange(0, 10**14)
        dp = rng.randrange(-10**16, 10**16)
        dk = rng.randrange(1, 25)
        lam = rng.choice([997596132883620259, rng.randrange(9 * 10**17, WAD)])
        age = rng.choice([0, 1, 10, 11, 360, rng.randrange(0, 400)])
        co = rng.choice([2 * WAD, 15 * 10**17, rng.randrange(0, 4 * WAD)])
        rows.append({"sig2": sig2, "dp": dp, "dk": dk, "lam": lam, "upd": fp.sigma_bar2_update(sig2, dp, dk, lam),
                     "age": age, "co": co, "ho": fp.h_o(age, sig2, co)})
    out["sigma_bar"] = cols(rows)

    rows = []
    for _ in range(N_RANDOM):
        q = rng.randrange(-5 * 10**10, 5 * 10**10)
        p = rng.randrange(0, WAD + 1)
        rc = fp.risk_capital(q, p)
        rb = rng.randrange(10**9, 10**12)
        u = fp.utilization(rc * rng.randrange(1, 4), rb)
        rows.append({"q": q, "p": p, "rc": rc, "rb": rb, "u": u,
                     "hu": fp.h_u(u, 2 * 10**16, 6 * 10**17, 9 * 10**17)})
    out["risk"] = cols(rows)

    rows = []
    for i in range(N_RANDOM + 50):
        p = rng.choice([rng.randrange(2 * 10**16, 98 * 10**16), rng.randrange(0, 10**16), WAD - rng.randrange(0, 10**16)])
        hmin = rng.randrange(0, 12 * 10**15)
        h = hmin + rng.choice([0, rng.randrange(0, 2 * 10**16)])
        kq = rng.choice([WAD // 6, 2 * 10**17, rng.randrange(10**16, 3 * 10**17)])
        qmax = rng.choice([50_000, 15_000, 60_000]) * UNIT
        c = fp.Curve(p, h, hmin, kq, qmax)
        q0 = rng.randrange(-60_000 * UNIT, 60_000 * UNIT)
        q = rng.randrange(1, 5_000 * UNIT)
        x = rng.randrange(1, 3_000 * UNIT)
        rows.append({"p": p, "h": h, "hmin": hmin, "kq": kq, "qmax": qmax, "q0": q0, "q": q, "x": x,
                     "pay_d1": fp.pay_d1(c, q0, q), "receive_d2": fp.receive_d2(c, q0, q),
                     "pay_d3": fp.pay_d3(c, q0, q), "receive_d4": fp.receive_d4(c, q0, q),
                     "qty_d1": fp.qty_d1_exact_in(c, q0, x), "qty_d3": fp.qty_d3_exact_in(c, q0, x),
                     "qty_d2": attempt(fp.qty_d2_exact_out, c, q0, x),
                     "qty_d4": attempt(fp.qty_d4_exact_out, c, q0, x)})
    out["curve"] = cols(rows)

    path = ROOT / "vectors" / "fixedpoint.json"
    path.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.relative_to(ROOT).as_posix()}: " +
          ", ".join(f"{k} {len(next(iter(v.values())))}" for k, v in out.items() if k != "meta"))

    # R §7.3: lnWad port vs Solady on >= 10^4 random inputs (half price ratios, half across the whole domain)
    bulk_rng = random.Random(7)
    xs = [bulk_rng.randrange(WAD // 2, 2 * WAD) for _ in range(5000)]
    xs += [bulk_rng.randrange(1, 2 ** bulk_rng.randrange(1, 256)) for _ in range(5000)]
    xs = [min(x, 2**255 - 1) for x in xs]
    bulk = ROOT / "vectors" / "lnwad_bulk.json"
    bulk.write_text(json.dumps(cols([{"x": x, "y": fp.ln_wad(x)} for x in xs])) + "\n", encoding="utf-8",
                    newline="\n")
    print(f"wrote {bulk.relative_to(ROOT).as_posix()}: {len(xs)} cases")


if __name__ == "__main__":
    main()
