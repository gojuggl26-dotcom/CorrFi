"""S00 check: M App. A numeric examples (p.43-44), M §4.5.1 (p.19), M §5.8.1 (p.25), and the
round-trip PnL question (open issue OI-03).

Run: python analysis/s00/chk_appendix_a.py
"""
from decimal import Decimal, getcontext
from fractions import Fraction as F

from refmath import (UNIT, Curve, d1_exact_in, d1_exact_out, d2_exact_in, d2_exact_out,
                     fmt_units, units_ceil, units_floor)

getcontext().prec = 50

P = F(90, 100)
H = HMIN = F(5, 1000)          # h = h_min = 0.005 USDC/token (hM = 0, hO negligible)
S = F(1, 6) / 50_000           # s = kq / qmax = (1/6) / 50,000 = 1/300,000
c = Curve(P, H, HMIN, S)
assert S == F(1, 300_000)

print("== M §4.5.1 (p.19) / App. A D1 exact-out Q=3,000 from q0=0 ==")
pay = d1_exact_out(c, F(0), F(3000))
print("Pay =", fmt_units(pay), "USDC; avg =", F(pay, UNIT) / 3000, "; edge vs P*Q =",
      fmt_units(pay - int(P * 3000 * UNIT)))
assert pay == 2730 * UNIT

print("\n== App. A D1 exact-in X=1,000 from q0=0 (also M §5.8.1 p.25) ==")
q_units = d1_exact_in(c, F(0), F(1000))
print("Q =", fmt_units(q_units), "Long (doc: 1,102.732928)")
avg = Decimal(1000) / (Decimal(q_units) / UNIT)
print("avg price =", round(avg, 6), "(doc: 0.906838)")
x_exact = 300000 * (-Decimal("0.905") + (Decimal("0.905") ** 2 + Decimal(2) * 1000 / 300000).sqrt())
print("closed form x =", round(x_exact, 10), "(doc: 1102.7329283...)")
leftover = F(1000) - c.integral(c.alpha, -F(q_units, UNIT), F(0))
print("leftover kept by Maker side =", float(leftover), "USDC (doc: ~0.0000003)")
assert q_units == 1_102_732_928

print("\n== App. A D2 exact-in Q=3,000 from q0=0 ==")
rec = d2_exact_in(c, F(0), F(3000))
print("Receive =", fmt_units(rec), "USDC (doc: 2,670)")
assert rec == 2670 * UNIT

print("\n== App. A D2 exact-out X=1,000 from q0=0 ==")
q2 = d2_exact_out(c, F(0), F(1000))
x2 = 300000 * (Decimal("0.895") - (Decimal("0.895") ** 2 - Decimal(2) * 1000 / 300000).sqrt())
print("Q =", fmt_units(q2), "Long (doc: 1,119.652929); closed form x =", round(x2, 10))
assert q2 == 1_119_652_929

print("\n== Round trip (OI-03): the doc's 60 USDC vs the same-path round trip ==")
buy = d1_exact_out(c, F(0), F(3000))                 # q: 0 -> -3,000
sell_back = d2_exact_in(c, F(-3000), F(3000))        # q: -3,000 -> 0 (same path back)
sell_other = d2_exact_in(c, F(0), F(3000))           # q: 0 -> +3,000 (the doc's 2,670)
print("buy 3,000 (0 -> -3,000)         Pay     =", fmt_units(buy))
print("sell 3,000 back (-3,000 -> 0)    Receive =", fmt_units(sell_back),
      "  -> Maker round-trip PnL =", fmt_units(buy - sell_back))
print("sell 3,000 from 0 (0 -> +3,000)  Receive =", fmt_units(sell_other),
      "  -> 2,730 - 2,670 =", fmt_units(buy - sell_other), "(doc's 60, different paths)")
print("F2 lower bound 2*hmin*Q =", 2 * HMIN * 3000, "USDC")
exact_rt = c.integral(lambda q: c.alpha(q) - c.beta(q), F(-3000), F(0))
print("∫_{-3000}^{0} (alpha - beta) dq =", exact_rt, "USDC (F2, M §7.1 p.32)")
assert buy - sell_back == 45 * UNIT and exact_rt == 45
assert buy - sell_other == 60 * UNIT

print("\n== Fixed-h additivity of the path integral (M §4.5 consistency (2), p.19) ==")
for split in (F(1500), F(1_234_567_891, UNIT), F(1, UNIT)):
    a = c.integral(c.alpha, -split, F(0))
    b = c.integral(c.alpha, F(-3000), -split)
    whole = c.integral(c.alpha, F(-3000), F(0))
    assert a + b == whole  # exact additivity before rounding
    two = units_ceil(a) + units_ceil(b)
    one = units_ceil(whole)
    print(f"split at {float(split):>14,.6f}: exact sum equal; ceil(a)+ceil(b) - ceil(a+b) = {two - one} unit(s)")
    assert 0 <= two - one <= 1
print("OK")
