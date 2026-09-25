"""S00 check (OI-06): splitting a trade when h_U is recomputed from the pre-trade U* of each trade.

M §4.4 (p.18-19) argues additivity follows from the path integral because h does not depend on Q.
That holds for a *fixed* h. Between two separate trades, U* changes, so h_U changes. This script
builds a concrete state (MVP values, M §8.1 p.39) and compares one trade with the same trade split in two.

Run: python analysis/s00/chk_split_hu.py
"""
from fractions import Fraction as F

from refmath import Curve, UNIT, fmt_units, h_u, rc, units_ceil, units_floor

RISK_BUDGET = F(100_000)
S = F(1, 300_000)                 # kq / qmax = (1/6) / 50,000
HMIN = F(5, 1000)                 # h0 = h_floor, hM = 0, hO ignored
P = {"7D": F(90, 100), "14D": F(90, 100), "28D": F(90, 100)}
# Maker inventories (Long-equivalent net, tokens). |q| <= 50,000 per market, sum <= 100,000.
BASE = {"7D": F(50_000), "28D": F(25_000)}


def utilization(q14: F) -> F:
    total = rc(BASE["7D"], P["7D"]) + rc(BASE["28D"], P["28D"]) + rc(q14, P["14D"])
    return total / RISK_BUDGET


def curve_at(q14: F) -> Curve:
    hU = h_u(utilization(q14))
    return Curve(P["14D"], HMIN + hU, HMIN, S)


def show(label, U, hU):
    print(f"  {label}: U* = {float(U):.4%}, h_U = {float(hU):.6f}")


print("State: 7D q=+50,000, 28D q=+25,000, 14D q0=+1,000, all P_fair = 0.90, RiskBudget 100,000")

print("\n[A] Risk-REDUCING: Taker buys Long 1,000 in 14D (D1, q 1,000 -> 0)")
q0 = F(1000)
c1 = curve_at(q0)
show("single trade", utilization(q0), c1.h - HMIN)
single = units_ceil(c1.integral(c1.alpha, F(0), q0))
c_first = curve_at(q0)
first = units_ceil(c_first.integral(c_first.alpha, F(500), q0))
c_second = curve_at(F(500))
show("2nd half   ", utilization(F(500)), c_second.h - HMIN)
second = units_ceil(c_second.integral(c_second.alpha, F(0), F(500)))
print(f"  Pay single = {fmt_units(single)}, Pay split(500+500) = {fmt_units(first + second)}"
      f"  -> split saves Taker {fmt_units(single - first - second)} USDC")
saving_a = single - first - second

print("\n[B] Risk-INCREASING: Taker sells Long 1,000 in 14D (D2, q 1,000 -> 2,000)")
c1 = curve_at(q0)
single_r = units_floor(c1.integral(c1.beta, q0, F(2000)))
first_r = units_floor(c1.integral(c1.beta, q0, F(1500)))
c_second = curve_at(F(1500))
show("single trade", utilization(q0), c1.h - HMIN)
show("2nd half   ", utilization(F(1500)), c_second.h - HMIN)
second_r = units_floor(c_second.integral(c_second.beta, F(1500), F(2000)))
print(f"  Receive single = {fmt_units(single_r)}, split = {fmt_units(first_r + second_r)}"
      f"  -> split costs Taker {fmt_units(single_r - first_r - second_r)} USDC")

print("\n[C] Same as [A] but with h frozen at the first trade's U* (fixed-h additivity)")
c1 = curve_at(q0)
split_fixed = units_ceil(c1.integral(c1.alpha, F(500), q0)) + units_ceil(c1.integral(c1.alpha, F(0), F(500)))
print(f"  Pay single = {fmt_units(single)}, split with frozen h = {fmt_units(split_fixed)}"
      f" -> diff {fmt_units(split_fixed - single)} (rounding only, Taker-unfavourable)")

# near-side band: with h_U > 0 the near side is NOT pinned at P + h_min for 0 < q < h_U / s (OI-09)
hU = curve_at(q0).h - HMIN
print(f"\nNear-side band (OI-09): alpha is above P+h_min for 0 < q < h_U/s = {float(hU / S):,.1f} tokens")

assert saving_a > 0, "expected splitting a risk-reducing trade to help the Taker in this state"
print("OK")
