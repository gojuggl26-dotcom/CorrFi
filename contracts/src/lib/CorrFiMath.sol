// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

/// @title CorrFiMath
/// @notice Fixed-point functions F1-F15 of docs/s01/01-fixed-point-spec.md. The TypeScript price engine and the
///         Python verifier implement the same definitions bit for bit (M §4.2.1 U-3, R §7.1 V3).
library CorrFiMath {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    uint256 internal constant DELTA = 300; // bar length Δ (seconds)

    error NonPositivePrice();
    error PriceRatioUnderflow();
    error ZeroVariance();

    // ---------------------------------------------------------------- settlement statistic (M §2.5)

    /// F1: ln(pCur / pPrev) in WAD, via Solady lnWad.
    function logRatio(uint256 pPrev, uint256 pCur) internal pure returns (int256) {
        if (pPrev == 0 || pCur == 0) revert NonPositivePrice();
        uint256 x = Math.mulDiv(pCur, WAD, pPrev);
        if (x == 0) revert PriceRatioUnderflow();
        return FixedPointMathLib.lnWad(int256(x));
    }

    /// F2: clip(r, -cs, +cs) with cs = c * s_i.
    function winsorize(int256 r, int256 cs) internal pure returns (int256) {
        return r > cs ? cs : r < -cs ? -cs : r;
    }

    /// F3: add one valid bar to the running sums (signed products truncate toward zero).
    function accumulate(int256 c, uint256 va, uint256 vb, int256 ra, int256 rb)
        internal
        pure
        returns (int256, uint256, uint256)
    {
        return (c + (ra * rb) / IWAD, va + uint256(ra * ra) / WAD, vb + uint256(rb * rb) / WAD);
    }

    /// F4: C / sqrt(VA VB) in WAD, clamped to [-WAD, WAD].
    function rho(int256 c, uint256 va, uint256 vb) internal pure returns (int256 r) {
        uint256 den = Math.sqrt(va * vb);
        if (den == 0) revert ZeroVariance();
        r = (c * IWAD) / int256(den);
        if (r > IWAD) r = IWAD;
        else if (r < -IWAD) r = -IWAD;
    }

    /// F5: settlement value of Long; VOID (0.5) if too few valid bars or zero variance.
    function longT(int256 c, uint256 va, uint256 vb, uint256 nValid, uint256 nMin)
        internal
        pure
        returns (uint256 l, bool isVoid)
    {
        if (nValid < nMin || va == 0 || vb == 0) return (WAD / 2, true);
        return (uint256(rho(c, va, vb) + IWAD) / 2, false);
    }

    /// F6: payout in units for Long qL and Short qS at settlement value l.
    function payout(uint256 qL, uint256 qS, uint256 l) internal pure returns (uint256) {
        return Math.mulDiv(qL, l, WAD) + Math.mulDiv(qS, WAD - l, WAD);
    }

    /// F6b: USDC that must stay in the vault for all outstanding tokens (true-dust sweep, DEC-01).
    function reserve(uint256 supplyL, uint256 supplyS, uint256 l) internal pure returns (uint256) {
        return Math.mulDiv(supplyL, l, WAD, Math.Rounding.Ceil) + Math.mulDiv(supplyS, WAD - l, WAD, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------- fair value (M §4.1-4.2)

    /// F7: P_fair = (1 + rho_hat) / 2 with the forecast covariance for the remaining bars.
    function fairValue(
        int256 c,
        uint256 va,
        uint256 vb,
        uint256 nObs,
        uint256 n,
        int256 sAB,
        uint256 sA2,
        uint256 sB2
    ) internal pure returns (uint256) {
        uint256 nRem = n - nObs;
        return uint256(rho(c + int256(nRem) * sAB, va + nRem * sA2, vb + nRem * sB2) + IWAD) / 2;
    }

    /// F8
    function tau(uint256 nObs, uint256 n) internal pure returns (uint256) {
        return nObs * WAD / n;
    }

    /// F9: forecast-error table (10 bins, values at bin midpoints, linear in between, 0 at tau = 1).
    function sigmaP(uint256 t, uint256[10] memory v) internal pure returns (uint256) {
        uint256 mid0 = WAD / 20;
        if (t <= mid0) return v[0];
        for (uint256 i; i < 9; ++i) {
            uint256 m1 = (2 * i + 3) * WAD / 20;
            if (t <= m1) return _interp(v[i], v[i + 1], (2 * i + 1) * WAD / 20, m1, t);
        }
        if (t < WAD) return _interp(v[9], 0, 19 * WAD / 20, WAD, t);
        return 0;
    }

    function _interp(uint256 a, uint256 b, uint256 x0, uint256 x1, uint256 x) private pure returns (uint256) {
        return uint256(int256(a) + ((int256(b) - int256(a)) * int256(x - x0)) / int256(x1 - x0));
    }

    /// F10
    function h0(uint256 t, uint256[10] memory v, uint256 cH, uint256 hFloor) internal pure returns (uint256) {
        uint256 x = Math.mulDiv(cH, sigmaP(t, v), WAD, Math.Rounding.Ceil);
        return x > hFloor ? x : hFloor;
    }

    /// F11: sigma_P,bar^2 EMA after a report that advanced dk bars and moved P_fair by dp.
    function sigmaBar2Update(uint256 sig2, int256 dp, uint256 dk, uint256 lam) internal pure returns (uint256) {
        uint256 t = (uint256(dp * dp) / WAD) / dk;
        return (lam * sig2 + (WAD - lam) * t) / WAD;
    }

    function sigmaBar2Init(uint256 sigma0) internal pure returns (uint256) {
        return sigma0 * sigma0 / WAD;
    }

    // ---------------------------------------------------------------- spreads and utilization (M §4.4, §6.1)

    /// F12: freshness surcharge c_O * sigma_bar * sqrt(age / Δ).
    function hO(uint256 age, uint256 sig2, uint256 cO) internal pure returns (uint256) {
        if (age == 0) return 0;
        uint256 sigmaBar = Math.sqrt(sig2 * WAD);
        uint256 root = Math.sqrt(Math.mulDiv(age, WAD * WAD, DELTA));
        return Math.mulDiv(Math.mulDiv(cO, sigmaBar, WAD, Math.Rounding.Ceil), root, WAD, Math.Rounding.Ceil);
    }

    /// F13: risk capital of one market's inventory (units).
    function riskCapital(int256 q, uint256 p) internal pure returns (uint256) {
        if (q > 0) return Math.mulDiv(uint256(q), p, WAD, Math.Rounding.Ceil);
        if (q < 0) return Math.mulDiv(uint256(-q), WAD - p, WAD, Math.Rounding.Ceil);
        return 0;
    }

    /// F13
    function utilization(uint256 totalRc, uint256 riskBudget) internal pure returns (uint256) {
        return Math.mulDiv(totalRc, WAD, riskBudget, Math.Rounding.Ceil);
    }

    /// F14: utilization surcharge (no cap, as in M §4.4).
    function hU(uint256 u, uint256 hUMax, uint256 u0, uint256 uMax) internal pure returns (uint256) {
        if (u <= u0) return 0;
        uint256 x = Math.mulDiv(u - u0, WAD, uMax - u0, Math.Rounding.Ceil);
        return Math.mulDiv(Math.mulDiv(hUMax, x, WAD, Math.Rounding.Ceil), x, WAD, Math.Rounding.Ceil);
    }
}
