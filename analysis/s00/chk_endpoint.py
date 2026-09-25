"""S00 check (OI-05): U-4 (P_fair in (0,1), M §4.2.1 p.17) at the final bar, zero variance, and
the initial report at createMarket.

rho_hat = (C_obs + n_rem*sAB) / sqrt((VA_obs + n_rem*sA2) * (VB_obs + n_rem*sB2)),  P_fair = (1+rho_hat)/2
(M §4.1, p.15). The final report has n_rem = 0, so P_fair = (1 + rho_obs)/2 with no forecast part.

Run: python analysis/s00/chk_endpoint.py
"""
import random
from fractions import Fraction as F
from math import isqrt


def rho_hat_sq_sign(C, VA, VB, n_rem, sAB, sA2, sB2):
    num = C + n_rem * sAB
    den2 = (VA + n_rem * sA2) * (VB + n_rem * sB2)
    return num, den2


print("[1] final report (n_rem = 0) with identical winsorized returns for ETH and BTC")
r = [F(3, 1000), F(-2, 1000), F(1, 1000)]
C = sum(x * x for x in r); VA = VB = C
num, den2 = rho_hat_sq_sign(C, VA, VB, 0, F(0), F(1), F(1))
print("  rho_hat^2 =", num * num / den2, "-> rho_hat = 1 -> P_fair = 1 -> U-4 rejects the report")
assert num * num == den2 and num > 0

print("[2] final report with a constant ETH price (VA = 0): rho_hat = 0/0 (undefined)")
num, den2 = rho_hat_sq_sign(F(0), F(0), F(5), 0, F(0), F(1), F(1))
print("  numerator =", num, ", denominator^2 =", den2, "-> division by zero")
assert den2 == 0

print("[3] createMarket: PSD check sAB^2 <= sA2*sB2 passes with sA2 = 0, sAB = 0,")
print("    but the initial report (n_obs = 0) is 0/0 as well")
sA2, sB2, sAB = F(0), F(1, 10**6), F(0)
assert sAB * sAB <= sA2 * sB2
num, den2 = rho_hat_sq_sign(F(0), F(0), F(0), 2016, sAB, sA2, sB2)
assert den2 == 0

print("[4] n_rem >= 1 with PSD forecast and sA2, sB2 > 0: |rho_hat| <= 1 always (Cauchy-Schwarz).")
print("    Randomised exact check (10,000 states); equality needs obs and forecast perfectly proportional.")
rng = random.Random(7)
for _ in range(10_000):
    ra = [F(rng.randint(-40, 40), 10**4) for _ in range(rng.randint(1, 6))]
    rb = [F(rng.randint(-40, 40), 10**4) for _ in ra]
    C = sum(a * b for a, b in zip(ra, rb)); VA = sum(a * a for a in ra); VB = sum(b * b for b in rb)
    sA2 = F(rng.randint(1, 100), 10**6); sB2 = F(rng.randint(1, 100), 10**6)
    lim = isqrt(int(sA2 * sB2 * 10**12))
    sAB = F(rng.randint(-lim, lim), 10**6)
    assert sAB * sAB <= sA2 * sB2
    n_rem = rng.randint(1, 2016)
    num, den2 = rho_hat_sq_sign(C, VA, VB, n_rem, sAB, sA2, sB2)
    assert den2 > 0 and num * num <= den2
print("  OK: no violation")

print("[5] Which routes finish settlement if the final combined tx reverts (M §3.2 p.11, §5.9 p.27, §6.2.1 p.29):")
print("    BarFeed post (reporter only) + public crank are separate entry points; finalize needs processed = N")
print("    or obsEnd + 48 h. If no bar is posted, the 48 h exit marks the last price point invalid, which")
print("    removes a valid return and can change Long_T (or flip it to VOID) -> not equivalent.")
print("OK")
