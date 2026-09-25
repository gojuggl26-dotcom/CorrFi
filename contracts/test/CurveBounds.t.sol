// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";

/// @notice M-F1: the ask α stays in [P + h_min, 1] and the bid β in [0, P − h_min] (M §4.3), so any fill's average
///         price does too — after rounding in the maker's favour. The clip at 1 / 0 is the stated exception.
contract CurveBoundsTest is Test {
    uint256 constant WAD = 1e18;

    function testFuzz_averagePricesWithinBounds(
        uint256 pRaw,
        uint256 hminRaw,
        uint256 extraRaw,
        uint256 kqRaw,
        uint256 q0Raw,
        uint256 qRaw
    ) public pure {
        uint256 p = bound(pRaw, 2e16, 98e16);
        uint256 hmin = bound(hminRaw, 5e15, 12e15);
        uint256 h = hmin + bound(extraRaw, 0, 2e16);
        uint256 kq = bound(kqRaw, 1e16, 3e17);
        uint256 qmax = 60_000e6;
        int256 q0 = int256(bound(q0Raw, 0, 2 * qmax)) - int256(qmax);
        uint256 q = bound(qRaw, 1, 5_000e6);
        CorrFiCurve.Curve memory c = CorrFiCurve.make(p, h, hmin, kq, qmax);

        // Long ask (D1) and Short ask (D3 = 1 − β)
        uint256 payL = CorrFiCurve.payD1(c, q0, q);
        assertLe(payL, q, "alpha <= 1");
        if (p + hmin <= WAD) assertGe(payL * WAD, (p + hmin) * q, "alpha >= P + hmin");
        uint256 payS = CorrFiCurve.payD3(c, q0, q);
        assertLe(payS, q, "Short ask <= 1");
        if (p >= hmin) assertGe(payS * WAD, (WAD - p + hmin) * q, "Short ask >= 1 - P + hmin");

        // Long bid (D2) and Short bid (D4 = 1 − α)
        uint256 recvL = CorrFiCurve.receiveD2(c, q0, q);
        if (p >= hmin) assertLe(recvL * WAD, (p - hmin) * q, "beta <= P - hmin");
        uint256 recvS = CorrFiCurve.receiveD4(c, q0, q);
        if (p + hmin <= WAD) assertLe(recvS * WAD, (WAD - p - hmin) * q, "Short bid <= 1 - P - hmin");
    }
}
