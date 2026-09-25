"""S00 check (OI-01, OI-02): sigma_P,bar depends on how bars are grouped into reports, and h_O depends
on the evaluation timestamp.

M §4.2.1 (p.17): after an accepted report,
    sigma^2 <- lambda * sigma^2 + (1 - lambda) * (dP_fair)^2 / dk,
with dk = bars advanced by this report and lambda "equivalent to a 288-bar half-life".
R §5.5 (p.12-13) switches from 12-bar to 24-bar batches when late and says the final state is unchanged.
M §4.4 (p.18): h_O = c_O * sigma_P,bar * sqrt(age / Delta).

Run: python analysis/s00/chk_sigma_bar_batch.py
"""
from decimal import Decimal as D, getcontext

getcontext().prec = 50
LAM = D(2) ** (D(-1) / D(288))   # per-report factor with a 288-report half-life (value not pinned by M)
CO = D(2)
DELTA = D(300)


def ema(sig2: D, dP: D, dk: int) -> D:
    return LAM * sig2 + (1 - LAM) * dP * dP / dk


def h_o(sig2: D, age_s: int) -> D:
    return CO * sig2.sqrt() * (D(age_s) / DELTA).sqrt()


sig0 = D("0.0008") ** 2
print("lambda =", LAM)

print("\n[1] Minimal reproduction: P_fair 0.900 -> 0.901 -> 0.900 (two bars)")
a = ema(ema(sig0, D("0.001"), 1), D("-0.001"), 1)   # one report per bar
b = ema(sig0, D("0.000"), 2)                          # one report for both bars
print("  per-bar reports : sigma_bar =", round(a.sqrt(), 12))
print("  one 2-bar report: sigma_bar =", round(b.sqrt(), 12))
print("  h_O at age 11 s : %.3e vs %.3e USDC/token" % (h_o(a, 11), h_o(b, 11)))
assert a != b

print("\n[2] 24 bars: 2 reports x 12 bars vs 1 report x 24 bars (R §5.5 switch)")
# deterministic synthetic increments (LCG), magnitude ~ 0.0008 per bar
x, incs = 12345, []
for _ in range(24):
    x = (1103515245 * x + 12345) % 2**31
    incs.append((D(x) / D(2**31) - D("0.5")) * D("0.0016"))
p12a, p12b = sum(incs[:12], D(0)), sum(incs[12:], D(0))
s12 = ema(ema(sig0, p12a, 12), p12b, 12)
s24 = ema(sig0, p12a + p12b, 24)
print("  12+12:", round(s12.sqrt(), 12), " 24:", round(s24.sqrt(), 12))
print("  h_O at age 11 s: %.6e vs %.6e -> differs, so trade amounts/state can differ" % (h_o(s12, 11), h_o(s24, 11)))
assert s12 != s24

print("\n[3] Effective decay per bar when one report covers 12 bars (replay phase A)")
print("  production: 1 report / bar -> half-life 288 bars = 1 day")
print("  replay A  : 1 report / 12 bars -> half-life 288 reports = 3,456 bars = 12 days (7D market ends first)")

print("\n[4] quote vs swap timestamp (OI-02): h_O at the post time T+10 vs the trade block T+11")
s = D("0.0008") ** 2
for age in (0, 10, 11, 12, 360):
    print(f"  age {age:>3} s: h_O = {h_o(s, age):.9f} USDC/token")
dh = h_o(s, 11) - h_o(s, 10)
print(f"  h_O(11) - h_O(10) = {dh:.3e} USDC/token -> on 1,000 tokens = {dh * 1000:.6f} USDC (>> 1 unit = 0.000001)")
assert dh * 1000 > D("0.000001")
print("OK")
