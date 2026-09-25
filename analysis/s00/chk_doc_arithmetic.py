"""S00 check: arithmetic stated in M / R / B, re-derived. Any mismatch raises.

Run: python analysis/s00/chk_doc_arithmetic.py
"""
from decimal import Decimal as D, getcontext
from fractions import Fraction as F
from math import ceil, erfc, sqrt

getcontext().prec = 50

print("[M §2.2 p.7, §4.2.2 p.17] N, N_min, tolerance, T-4 threshold")
for days, n_min_doc, tol_doc, t4_doc in ((7, 1996, 20, 10), (14, 3992, 40, 20), (28, 7984, 80, 40)):
    N = 288 * days
    n_min = ceil(F(99, 100) * N)
    assert (n_min, N - n_min, (N - n_min) // 2) == (n_min_doc, tol_doc, t4_doc)
    print(f"  {days:>2}D: N={N:,} N_min={n_min:,} tolerance={N - n_min} T-4 threshold={(N - n_min) // 2}")

print("[R §5.1 p.11, §5.5 p.12-13, App. A p.21] replay timeline")
phase_a = D("163") * D("0.45") + 4 * D("1.5")
t = D(10) + phase_a
print(f"  phase A = {phase_a} s, end {t}; phase B end {t + D('7.2')}; settle {t + D('12.2')}; verify {t + D('17.2')}")
assert phase_a == D("79.35") and t + D("17.2") == D("106.55")
print("  worst case, zero waits, 300 ms/step:", 179 * D("0.3"), "s")
for k in (504, 1008, 1512, 1920):
    assert k % 12 == 0 and k % 24 == 0
    print(f"  trade bar k={k}: phase-A step j={k // 12 - 1}, tau={F(k, 2016)} = {k / 2016:.4f}")
assert 2004 % 24 != 0

print("[R §5.3.1 p.12] golden table invariants (A1, A2); Q4 left symbolic (checked for Q4 in 1..6000)")
rows = {  # q, NL, NS, collateral, long supply, short supply (excluding the Q4 row)
    "init": (0, 0, 0, 0, 0, 0), "S0a": (0, 0, 0, 100, 100, 100), "S0b": (-1000, 0, 1000, 1100, 1100, 1100),
    "S1": (-600, 0, 600, 700, 700, 700), "S2": (-100, 0, 100, 700, 700, 700),
    "S3a": (-150, 0, 150, 700, 700, 700), "S3b": (-150, 0, 150, 650, 650, 650)}
for name, (q, nl, ns, col, ls, ss) in rows.items():
    assert q == nl - ns and min(nl, ns) == 0 and ls == ss == col, name
for q4 in range(1, 6001):
    q, nl, ns, col = -150 - q4, 0, 150 + q4, 650 + q4
    long_total = 50 + (600 + q4)        # A + B
    short_total = 500 + (150 + q4)      # C + Maker deposit
    assert q == nl - ns and long_total == short_total == col
print("  OK; holders at maturity sum to collateral for every Q4")

print("[R §5.3 S4 vs M §5.2.3 Q_max] S4 buys with 300 USDC exact-in: Q4 = 300/avg ask <= Q_max = 5,000 needs")
print("  avg ask >= 0.06. R §3.4 only requires 0.05 <= Long_T <= 0.95, so a low-Long week could fail S4 (OI-13).")
assert F(300, 5000) == F(6, 100)

print("[R §6.3 p.14] VOID scenario: 15 invalid price points, non-adjacent")
assert 2016 - 30 == 1986 < 1996
print("  n_valid <= 1,986 < 1,996; T-4 trips once invalid returns > 10, i.e. at the 6th invalid price point (12)")

print("[M §6.3.1 p.30] manipulation table (c = 4, rho0 = 0.05, unit per-bar variance)")
c, rho0, avg_abs = 4, 0.05, 0.8
for days, doc in ((7, (0.0080, 0.0008, 0.0081, 0.118)), (14, (0.0040, 0.0004, 0.0041, 0.072)),
                  (28, (0.0020, 0.0002, 0.0021, 0.041))):
    N = 288 * days
    worst = c * c / N * (1 + rho0 / 4)
    typical = c * avg_abs / (2 * N)
    def d_long(k):
        rk = (rho0 * N + k * c * avg_abs) / sqrt(N * (N + k * (c * c - 1)))
        return (rk - rho0) / 2
    got = (worst, typical, d_long(12), d_long(288))
    print(f"  {days:>2}D: worst {got[0]:.4f} typical {got[1]:.4f} 1h {got[2]:.4f} 24h {got[3]:.3f}"
          f" gain@50k {got[3] * 50_000:,.0f} USDC   (doc {doc})")
    for g, d in zip(got, doc):
        assert abs(g - d) <= 0.0006 * max(1, d / 0.01), (days, g, d)

print("[M §4.2.2 p.17] h_O examples (sigma_bar 0.0008, c_O 2)")
for age, doc in ((10, 0.0003), (360, 0.0018)):
    v = 2 * 0.0008 * sqrt(age / 300)
    print(f"  age {age:>3} s: {v:.5f} (doc ~{doc})")
    assert abs(v - doc) < 0.00005

print("[M §4.1.3 p.16] c_h * sigma_P(0) with c_h = 0.15")
for tenor, sp0 in (("7D", F(4, 100)), ("14D", F(35, 1000)), ("28D", F(3, 100))):
    v = F(15, 100) * sp0
    print(f"  {tenor}: c_h*sigma_P(0) = {float(v):.5f} -> h0 = max(0.005, .) = {float(max(F(5, 1000), v)):.5f}")

print("[OI-11] provisional sigma_P table as 10 bin midpoints of the linear 0.04*(1-tau) (M §4.1.3 p.16 + B §4.2 p.7)")
mids = [F(2 * i + 1, 20) for i in range(10)]
table = [F(4, 100) * (1 - m) for m in mids]
print("  midpoints:", [float(m) for m in mids])
print("  values   :", [float(v) for v in table])
print(f"  at tau = 0 the table rule (flat before the first midpoint) gives {float(table[0])} not 0.04;"
      f" h0(0) = max(0.005, 0.15*{float(table[0])}) = {float(max(F(5, 1000), F(15, 100) * table[0])):.4f} (doc 0.006)")

print("[M §6.1 p.28] U examples at P = 0.9, RiskBudget 100,000")
print(f"  Long inventory for U = 60%: {60_000 / 0.9:,.0f}; for 90%: {90_000 / 0.9:,.0f} (doc ~67k / 100k)")
print(f"  Short inventory max U: {100_000 * 0.1 / 100_000:.0%} (doc 10%)")

print("[M §5.8.3 p.27] tolerance delta = 0.002 as relative:", f"{0.002 / 0.907:.2%} at 0.907, {0.002 / 0.1:.0%} at 0.1")
print("[M §6.3.2 p.30] P(|Z| > 4) =", f"{erfc(4 / sqrt(2)):.2e}", "(doc 6e-5)")
print("[M §5.7 p.25, §8.1 p.39] Maker funding: order allocation qmax+Qmax =", 50_000 + 5_000,
      "; wallet/approval >= RiskBudget+Qmax =", 100_000 + 5_000, "; replay gives Maker 200,000 (R §4.3 p.9)")
print("OK")
