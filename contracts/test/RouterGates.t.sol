// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {Deadline} from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice Trade-time gates T-1..T-4 (M §4.2.2, §5.2.1) and the CorrGuard constraints (M §5.2.3, §6.1).
contract RouterGatesTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;

    function setUp() public override {
        super.setUp();
        usdc.mint(TAKER, 900_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(100_000 * U);
        vm.stopPrank();
    }

    function _expectReject(uint8 reason) internal {
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, reason));
    }

    function _quoteReverts(ISwapVM.Order memory o, bool isBuy, bool exactIn, uint256 amount, uint8 reason) internal {
        bytes memory tt = takerTraits(TAKER, o, isBuy, exactIn, 0, false);
        _expectReject(reason);
        router.quote(o, amount, tt);
    }

    function _bd(ISwapVM.Order memory o, uint8 side, bool isBuy, bool exactIn, uint256 amount)
        internal
        view
        returns (CorrFiLens.Breakdown memory)
    {
        return lens.breakdown(o, mid, side, isBuy, exactIn, amount, 2e15);
    }

    // ------------------------------------------------------------------ T-2 and h_O (M-T2)

    function test_beforeObsStartAgeIsZeroThenStale() public {
        CorrFiLens.Breakdown memory b = _bd(oL, L, true, true, 100 * U);
        assertEq(b.hO, 0, "age 0 before obsStart");
        uint256 s0 = obsStart(mid);
        vm.warp(s0 + 360); // age = Δ + g
        quoteOf(oL, true, true, 100 * U);
        vm.warp(s0 + 361);
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.STALE);
    }

    function test_staleBoundaryAfterReport() public {
        reportThrough(3);
        uint256 tRef = obsStart(mid) + 900;
        ICorrFiHub.Quote memory s = hub.quoteState(mid);
        vm.warp(tRef + 100);
        CorrFiLens.Breakdown memory b = _bd(oL, L, true, true, 100 * U);
        assertEq(b.hO, CorrFiMath.hO(100, s.sig2, 2 * WAD), "h_O at age 100");
        assertEq(b.hmin, s.h0 + b.hO, "h_min = h0 + hM + hO");
        assertEq(b.k, 3);
        assertEq(b.tK, tRef);
        assertEq(b.tNext, tRef + 300);
        assertEq(b.tStop, tRef + 360);
        vm.warp(tRef + 360);
        quoteOf(oL, true, true, 100 * U);
        vm.warp(tRef + 361);
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.STALE);
        // a new report restores trading
        reportThrough(4);
        quoteOf(oL, true, true, 100 * U);
    }

    // ------------------------------------------------------------------ T-1 (M-T1)

    function test_unsyncedUntilReport() public {
        uint256 s0 = obsStart(mid);
        vm.warp(s0 + 300);
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](2);
        ps[0] = pt(s0, 2000e18, 60_000e18);
        ps[1] = pt(s0 + 300, 2001e18, 60_010e18);
        vm.prank(REPORTER);
        hub.postPoints(ps);
        hub.crank(mid, 10); // anyone may accumulate ahead of the report
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.UNSYNCED);
        CorrFiHub.ReportInput memory r = honestReport(mid, 1);
        vm.prank(REPORTER);
        hub.submitReport(r);
        quoteOf(oL, true, true, 100 * U);
    }

    // ------------------------------------------------------------------ T-3 (M-T3) and the Deadline instruction

    function test_expiryBoundary() public {
        uint256 obsEnd = hub.quoteState(mid).obsEnd;
        vm.warp(obsEnd - 1);
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.STALE); // not expired yet (no reports -> T-2)
        vm.warp(obsEnd);
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.EXPIRED); // Deadline passes (<=), T-3 stops
        vm.warp(obsEnd + 1);
        bytes memory tt = takerTraits(TAKER, oL, true, true, 0, false);
        vm.expectRevert(abi.encodeWithSelector(Deadline.DeadlineReached.selector, obsEnd));
        router.quote(oL, 100 * U, tt);
    }

    // ------------------------------------------------------------------ T-4 (M-T4, DEC-02)

    function _postInvalidThrough(uint32 from, uint32 to, bool invalid) internal {
        uint256 s0 = obsStart(mid);
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](to - from + 1);
        for (uint32 i = from; i <= to; ++i) {
            ps[i - from] = invalid && i != 0 ? pt(s0 + uint256(i) * 300, 0, 60_000e18) : pt(s0 + uint256(i) * 300, 2000e18, 60_000e18);
        }
        vm.warp(s0 + uint256(to) * 300);
        vm.prank(REPORTER);
        hub.postPoints(ps);
        hub.crank(mid, type(uint32).max);
        CorrFiHub.ReportInput memory r = honestReport(mid, to);
        vm.prank(REPORTER);
        hub.submitReport(r);
    }

    function test_tooManyInvalidBarsStopsForGood() public {
        _postInvalidThrough(0, 10, true); // bars 1..10 invalid: exactly (N - N_min) / 2
        assertEq(hub.quoteState(mid).invalidBars, 10);
        quoteOf(oL, true, true, 100 * U);
        _postInvalidThrough(11, 11, true); // 11 invalid
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.TOO_MANY_INVALID);
        _postInvalidThrough(12, 16, false); // valid prices again: the stop is not lifted
        assertGt(hub.quoteState(mid).invalidBars, 10);
        _quoteReverts(oL, true, true, 100 * U, CorrFiPricing.TOO_MANY_INVALID);
    }

    // ------------------------------------------------------------------ CorrGuard (M §5.2.3, §6.1)

    function test_quantityBounds() public {
        _quoteReverts(oL, true, false, 1 * U - 1, CorrFiPricing.QTY_TOO_SMALL);
        quoteOf(oL, true, false, 1 * U);
        quoteOf(oL, true, false, 5_000 * U);
        _quoteReverts(oL, true, false, 5_000 * U + 1, CorrFiPricing.QTY_TOO_LARGE);
        _quoteReverts(oL, false, true, 1, CorrFiPricing.ZERO_AMOUNT); // 1 unit of Long receives 0 USDC
    }

    function test_marketCapAndRiskReducingStillAllowed() public {
        for (uint256 i; i < 12; ++i) tradeAs(TAKER, L, true, false, 5_000 * U); // q = -60,000 = -qmax,m
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertEq(ns - nl, 60_000 * U);
        _quoteReverts(oL, true, false, 1 * U, CorrFiPricing.MARKET_CAP);
        // selling Short moves q the same way, but at -qmax α is clipped to 1: the Short bid is 0
        _quoteReverts(oS, false, true, 1_000 * U, CorrFiPricing.ZERO_AMOUNT);
        tradeAs(TAKER, L, false, true, 1_000 * U); // risk-reducing
    }

    function test_groupCapAcrossMarketsAndFinalizedMarketsDropOut() public {
        for (uint256 i; i < 12; ++i) tradeAs(TAKER, L, true, false, 5_000 * U); // market 1: |q| = 60,000
        // market 1 is past obsEnd + 48 h but not finalized yet; a second market opens
        vm.warp(hub.quoteState(mid).obsEnd + 48 hours + 1);
        hub.crank(mid, type(uint32).max);
        uint8 m2 = createMarket(appAInput());
        _approveMaker(MAKER, m2);
        (ISwapVM.Order memory l2,) = openBooks(MAKER, m2, 1, ALLOCATION);
        for (uint256 i; i < 8; ++i) {
            vm.prank(TAKER);
            router.trade(l2, m2, L, true, false, 5_000 * U, type(uint256).max, 0); // market 2: |q| = 40,000
        }
        bytes memory tt = takerTraits(TAKER, l2, true, false, 0, false);
        _expectReject(CorrFiPricing.GROUP_CAP); // 100,001 > q_grp while market 2 alone is far below qmax,m
        router.quote(l2, 1 * U, tt);
        // after settlement market 1 no longer counts (PROP-10)
        vaultOf(mid).finalize();
        router.quote(l2, 1 * U, tt);
    }

    function test_utilizationCapOnlyForRiskIncreasing() public {
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.riskBudget = uint128(10_000 * U); // U = 90% at q = +10,000 (RC = 0.9 q)
        vm.prank(MAKER);
        router.setMakerConfig(c);
        tradeAs(TAKER, L, false, true, 5_000 * U); // q = +5,000, U = 45%
        _quoteReverts(oL, false, true, 5_000 * U, CorrFiPricing.UTILIZATION_CAP); // U_post = 90% >= Umax
        tradeAs(TAKER, L, false, true, 4_000 * U); // q = +9,000, U = 81%
        // the surcharge uses U* before the trade (M §4.4)
        CorrFiLens.Breakdown memory b = _bd(oL, L, false, true, 100 * U);
        uint256 uStar = CorrFiMath.utilization(CorrFiMath.riskCapital(9_000 * int256(U), 9e17), 10_000 * U);
        assertEq(b.uPre, uStar);
        assertEq(b.hU, CorrFiMath.hU(uStar, 2e16, 6e17, 9e17));
        assertGt(b.hU, 0);
        assertEq(b.h, b.hmin + b.hU);
        // risk-reducing is allowed above U_max... and near it
        tradeAs(TAKER, L, true, true, 1_000 * U);
    }

    function test_bookTooThin() public {
        bytes memory tt = takerTraits(TAKER, oL, false, false, 0, false);
        vm.expectRevert(CorrFiCurve.BookTooThin.selector);
        router.quote(oL, 130_000 * U, tt); // beyond the whole β path from q = 0
    }
}
