// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";

/// @notice M-F1: the ask α stays in [P + h_min, 1] and the bid β in [0, P − h_min] (M §4.3), so any fill's average
///         price does too — after rounding in the maker's favour. The clip at 1 / 0 is the stated exception.
contract CurveBoundsTest is Test {
    uint256 constant WAD = 1e18;

    /// The same bounds at and next to every cut point (review 2026-09-26: with q1 / qss floored, q0 = q1 + 1 gave
    /// alpha > 1 — D1 paid Q + 1 and D4 underflowed). The uniform q0 above almost never lands there.
    function testFuzz_boundsAtCutPoints(
        uint256 pRaw,
        uint256 hminRaw,
        uint256 extraRaw,
        uint256 kqRaw,
        uint8 which,
        int8 dqRaw,
        uint256 qRaw
    ) public pure {
        uint256 p = bound(pRaw, 2e16, 98e16);
        uint256 hmin = bound(hminRaw, 1, 12e15);
        uint256 h = hmin + bound(extraRaw, 0, 2e16);
        uint256 kq = bound(kqRaw, 1e16, 3e17);
        uint256 qmax = 50_000e6;
        CorrFiCurve.Curve memory c = CorrFiCurve.make(p, h, hmin, kq, qmax);
        int256 cut = [c.q1, c.qs, c.qss, c.q0][which % 4];
        int256 q0 = cut + int256(bound(int256(dqRaw), -3, 3));
        uint256 q = bound(qRaw, 1, 5_000e6);
        uint256 payL = CorrFiCurve.payD1(c, q0, q);
        assertLe(payL, q, "alpha <= 1");
        if (p + hmin <= WAD) assertGe(payL * WAD, (p + hmin) * q, "alpha >= P + hmin");
        uint256 recvS = CorrFiCurve.receiveD4(c, q0, q); // must not underflow
        if (p + hmin <= WAD) assertLe(recvS * WAD, (WAD - p - hmin) * q, "Short bid <= 1 - P - hmin");
        uint256 recvL = CorrFiCurve.receiveD2(c, q0, q);
        if (p >= hmin) assertLe(recvL * WAD, (p - hmin) * q, "beta <= P - hmin");
        uint256 payS = CorrFiCurve.payD3(c, q0, q);
        assertLe(payS, q, "Short ask <= 1");
        if (p >= hmin) assertGe(payS * WAD, (WAD - p + hmin) * q, "Short ask >= 1 - P + hmin");
    }

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

    // ---------------------------------------------------------------- inverted cut points (review 2026-09-26 #2)

    function qty(uint256 p, uint256 h, uint256 hmin, uint256 kq, uint256 qmax, int256 q0, uint256 x, uint8 dir)
        external
        pure
        returns (uint256)
    {
        CorrFiCurve.Curve memory c = CorrFiCurve.make(p, h, hmin, kq, qmax);
        if (dir == 1) return CorrFiCurve.qtyD1ExactIn(c, q0, x);
        if (dir == 2) return CorrFiCurve.qtyD2ExactOut(c, q0, x);
        if (dir == 3) return CorrFiCurve.qtyD3ExactIn(c, q0, x);
        return CorrFiCurve.qtyD4ExactOut(c, q0, x);
    }

    /// q1 = 1 > qs = 0 (the linear piece is shorter than one unit). The walk skipped q1, took the wrong branch and
    /// the correction loop ran until out of gas; now the pair is closed and the sell reverts BookTooThin as in the
    /// Python and TypeScript ports.
    function test_invertedCutsReproducer() public {
        (uint256 p, uint256 h, uint256 hmin, uint256 kq) =
            (737018080279891314, 600262631839343899, 9746425217800037, 663423151981851124);
        CorrFiCurve.Curve memory c = CorrFiCurve.make(p, h, hmin, kq, 1);
        assertEq(c.q1, 1);
        assertEq(c.qs, 1, "qs closed up to q1");
        assertLe(c.qss, c.q0);
        vm.expectRevert(CorrFiCurve.BookTooThin.selector);
        this.qty{gas: 5_000_000}(p, h, hmin, kq, 1, 4, 1, 4);
        vm.expectRevert(CorrFiCurve.BookTooThin.selector);
        this.qty{gas: 5_000_000}(p, h, hmin, kq, 1, 4, 1, 2);
        assertEq(this.qty(p, h, hmin, kq, 1, 4, 1, 1), 1);
        assertEq(this.qty(p, h, hmin, kq, 1, 4, 1, 3), 1);
    }

    /// Tiny qmax makes inverted pairs common. Every quantity either reverts BookTooThin within a small gas budget or
    /// is the exact optimum of its direction (smallest Q reaching x / largest Q within x).
    function testFuzz_invertedCutsInverse(
        uint256 pRaw,
        uint256 hRaw,
        uint256 hminRaw,
        uint256 kqRaw,
        uint256 qmaxRaw,
        int256 q0Raw,
        uint256 xRaw,
        uint8 dirRaw
    ) public view {
        uint256 p = bound(pRaw, 0, WAD);
        uint256 hmin = bound(hminRaw, 0, 5e16);
        uint256 h = hmin + bound(hRaw, 0, 7e17);
        uint256 kq = bound(kqRaw, 1e15, WAD);
        uint256 qmax = bound(qmaxRaw, 1, 7);
        int256 q0 = bound(q0Raw, -20, 20);
        uint256 x = bound(xRaw, 1, 10);
        uint8 dir = uint8(bound(dirRaw, 1, 4));
        CorrFiCurve.Curve memory c = CorrFiCurve.make(p, h, hmin, kq, qmax);
        assertLe(c.q1, c.qs);
        assertLe(c.qss, c.q0);
        try this.qty{gas: 2_000_000}(p, h, hmin, kq, qmax, q0, x, dir) returns (uint256 q) {
            if (dir == 1) {
                assertLe(CorrFiCurve.payD1(c, q0, q), x);
                assertGt(CorrFiCurve.payD1(c, q0, q + 1), x);
            } else if (dir == 3) {
                assertLe(CorrFiCurve.payD3(c, q0, q), x);
                assertGt(CorrFiCurve.payD3(c, q0, q + 1), x);
            } else if (dir == 2) {
                assertGe(CorrFiCurve.receiveD2(c, q0, q), x);
                if (q > 0) assertLt(CorrFiCurve.receiveD2(c, q0, q - 1), x);
            } else {
                assertGe(CorrFiCurve.receiveD4(c, q0, q), x);
                if (q > 0) assertLt(CorrFiCurve.receiveD4(c, q0, q - 1), x);
            }
        } catch (bytes memory err) {
            assertEq(bytes4(err), CorrFiCurve.BookTooThin.selector, "only BookTooThin, never out of gas");
        }
    }
}
