// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {Deadline} from "@1inch/swap-vm/contracts/instructions/Controls.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";

/// @notice Quote breakdown (M §5.8.2, 論点 36): amounts = quote = swap at the same block time (PROP-02), and the
///         reason code = the reason quote reverts with, for every trading condition.
contract LensTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;
    uint256 constant DELTA_TOL = 2e15; // δ = 0.002 USDC / token (M §5.8.3)

    function setUp() public override {
        super.setUp();
        usdc.mint(TAKER, 900_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(50_000 * U);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ amounts

    function test_breakdownEqualsQuoteEqualsSwap() public {
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.riskBudget = uint128(7_000 * U); // U* above U0 so that h_U > 0
        vm.prank(MAKER);
        router.setMakerConfig(c);
        reportThrough(2);
        vm.warp(block.timestamp + 137); // h_O > 0
        tradeAs(TAKER, L, false, true, 5_000 * U); // q = +5,000
        for (uint256 i; i < 8; ++i) {
            uint8 side = uint8(i & 1);
            bool isBuy = (i >> 1) & 1 == 1;
            bool exactIn = (i >> 2) & 1 == 1;
            uint256 amount = exactIn ? (isBuy ? (side == L ? 250 * U : 30 * U) : 300 * U) : (isBuy ? 300 * U : (side == L ? 250 * U : 25 * U));
            ISwapVM.Order memory o = bookOf(side);
            uint256 snapshot = vm.snapshotState();
            CorrFiLens.Breakdown memory b = lens.breakdown(o, mid, side, isBuy, exactIn, amount, DELTA_TOL);
            CorrFiLens.Breakdown memory b2 = lens.breakdownOrder(o, isBuy, exactIn, amount, DELTA_TOL);
            (uint256 qi, uint256 qo) = quoteOf(o, isBuy, exactIn, amount);
            (uint256 si, uint256 so) = swapAs(TAKER, o, isBuy, exactIn, amount, false);
            assertEq(b.reason, 0);
            assertGt(b.hO, 0, "h_O");
            assertGt(b.hU, 0, "h_U");
            assertEq(b.amountIn, qi);
            assertEq(b.amountOut, qo);
            assertEq(qi, si);
            assertEq(qo, so);
            assertEq(keccak256(abi.encode(b)), keccak256(abi.encode(b2)), "both input forms agree");
            vm.revertToState(snapshot);
        }
    }

    function test_breakdownPriceAndDeviation() public {
        // M §5.8.1 example: 1,000 USDC of Long at P = 0.90 from a flat maker
        CorrFiLens.Breakdown memory b = lens.breakdown(oL, mid, L, true, true, 1_000 * U, DELTA_TOL);
        assertEq(b.dir, 1);
        assertEq(b.qty, 1_102_732_928);
        assertEq(b.q1, 0);
        assertEq(b.q2, b.qty); // all minted
        assertEq(b.pFair, 9e17);
        assertEq(b.hmin, 5e15);
        assertEq(b.h, 5e15);
        assertEq(b.avgPrice, Math.mulDiv(1_000 * U, WAD, b.qty));
        uint256 pq = Math.mulDiv(9e17, b.qty, WAD);
        assertEq(b.deviation, int256(1_000 * U) - int256(pq));
        assertEq(b.devHmin, Math.mulDiv(5e15, b.qty, WAD));
        assertEq(b.devHU, 0);
        assertEq(b.devSize, b.deviation - int256(b.devHmin));
        assertGt(b.devSize, 0); // inventory slope makes the maker's side dearer
        assertEq(b.inv0, 0);
        assertEq(b.inv1, -int256(b.qty));
        assertEq(b.sideFair, 9e17);

        // a Short buy is measured against the Short's fair value 1 - P_fair = 0.10, not the Long's 0.90
        CorrFiLens.Breakdown memory s = lens.breakdown(oS, mid, S, true, true, 100 * U, DELTA_TOL);
        assertEq(s.dir, 3);
        assertEq(s.pFair, 9e17);
        assertEq(s.sideFair, 1e17);
        uint256 spq = Math.mulDiv(1e17, s.qty, WAD);
        assertEq(s.deviation, int256(100 * U) - int256(spq));
        assertGt(s.deviation, 0);
        assertEq(s.devHmin, Math.mulDiv(5e15, s.qty, WAD));
        assertEq(s.devSize, s.deviation - int256(s.devHmin) - int256(s.devHU));
        assertGe(s.devSize, 0);
        // a Short sell: sideFair·Q − Receive
        CorrFiLens.Breakdown memory ss = lens.breakdown(oS, mid, S, false, true, 1_000 * U, DELTA_TOL);
        assertEq(ss.dir, 4);
        assertEq(ss.deviation, int256(Math.mulDiv(1e17, ss.qty, WAD)) - int256(ss.amountOut));
        assertGt(ss.deviation, 0);
    }

    // ------------------------------------------------------------------ tolerance δ (M §5.8.3)

    function test_toleranceLimits() public {
        for (uint256 i; i < 8; ++i) {
            uint8 side = uint8(i & 1);
            bool isBuy = (i >> 1) & 1 == 1;
            bool exactIn = (i >> 2) & 1 == 1;
            uint256 amount = exactIn ? (isBuy ? (side == L ? 900 * U : 90 * U) : 1_000 * U) : (isBuy ? 1_000 * U : (side == L ? 900 * U : 90 * U));
            ISwapVM.Order memory o = bookOf(side);
            CorrFiLens.Breakdown memory b = lens.breakdown(o, mid, side, isBuy, exactIn, amount, DELTA_TOL);
            uint256 x = isBuy ? b.amountIn : b.amountOut;
            uint256 q = b.qty;
            // p̄ = x / q; buys: min receive ⌊X / (p̄ + δ)⌋, max pay ⌈Q (p̄ + δ)⌉; sells: ⌊Q (p̄ − δ)⌋, ⌈X / (p̄ − δ)⌉
            uint256 expected;
            if (isBuy && exactIn) expected = (x * q * WAD) / (x * WAD + DELTA_TOL * q);
            else if (isBuy) expected = Math.ceilDiv(x * WAD + DELTA_TOL * q, WAD);
            else if (exactIn) expected = (x * WAD - DELTA_TOL * q) / WAD;
            else expected = Math.ceilDiv(x * q * WAD, x * WAD - DELTA_TOL * q);
            assertTrue(b.limitDefined);
            assertEq(b.limit, expected);
            // the limit protects without blocking the quoted trade
            uint256 snapshot = vm.snapshotState();
            vm.prank(TAKER);
            router.trade(o, mid, side, isBuy, exactIn, amount, b.limit, 0);
            vm.revertToState(snapshot);
        }
        // p̄ <= δ for a sell: undefined (OI-17)
        CorrFiLens.Breakdown memory u = lens.breakdown(oS, mid, S, false, true, 1_000 * U, 2e17);
        assertFalse(u.limitDefined);
    }

    // ------------------------------------------------------------------ reason = quote revert reason

    function _quoteReason(ISwapVM.Order memory o, bool isBuy, bool exactIn, uint256 amount) internal returns (uint8) {
        bytes memory tt = takerTraits(TAKER, o, isBuy, exactIn, 0, false);
        try router.quote(o, amount, tt) returns (uint256, uint256, bytes32) {
            return 0;
        } catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            if (sel == CorrFiEngine.CorrReject.selector) {
                uint256 r;
                assembly ("memory-safe") {
                    r := mload(add(err, 36))
                }
                return uint8(r);
            }
            if (sel == CorrFiCurve.BookTooThin.selector) return CorrFiPricing.BOOK_TOO_THIN;
            if (sel == Deadline.DeadlineReached.selector) return CorrFiPricing.EXPIRED;
            if (sel == IAqua.SafeBalancesForTokenNotInActiveStrategy.selector) return CorrFiPricing.ORDER_INACTIVE;
            revert("unmapped quote revert");
        }
    }

    /// Checks one case both ways and restores the state.
    function _check(ISwapVM.Order memory o, uint8 side, bool isBuy, bool exactIn, uint256 amount, uint8 expected) internal {
        uint8 viaQuote = _quoteReason(o, isBuy, exactIn, amount);
        CorrFiLens.Breakdown memory b = lens.breakdownOrder(o, isBuy, exactIn, amount, DELTA_TOL);
        assertEq(viaQuote, expected, "quote reason");
        assertEq(b.reason, expected, "breakdown reason");
        if (expected != CorrFiPricing.NOT_REGISTERED) {
            assertEq(lens.breakdown(o, mid, side, isBuy, exactIn, amount, DELTA_TOL).reason, expected, "entry form");
        }
        // rejected before the curve: no amounts; CorrGuard rejections still show the amounts they were given
        bool preCurve = expected != 0 && expected < CorrFiPricing.QTY_TOO_SMALL || expected >= CorrFiPricing.BOOK_TOO_THIN;
        if (preCurve) {
            assertEq(b.amountIn, 0);
            assertEq(b.amountOut, 0);
        } else if (expected != 0) {
            assertGt(b.amountIn + b.amountOut, 0);
        }
    }

    function test_reasonsMatchQuote() public {
        uint256 snapshot = vm.snapshotState();
        _check(oL, L, true, true, 1_000 * U, 0);

        // NOT_REGISTERED: shipped but never registered
        address mk = address(0x3A41);
        ISwapVM.Order memory stray = buildOrder(mk, mid, L, 5);
        ship(mk, stray, mid, L, 1_000 * U);
        _check(stray, L, true, true, 100 * U, CorrFiPricing.NOT_REGISTERED);
        assertEq(lens.breakdown(oL, mid, S, true, true, 100 * U, DELTA_TOL).reason, CorrFiPricing.NOT_REGISTERED);

        // MAKER_INACTIVE
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.active = false;
        vm.prank(MAKER);
        router.setMakerConfig(c);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.MAKER_INACTIVE);
        vm.revertToState(snapshot);

        // quantities
        _check(oL, L, true, false, 1 * U - 1, CorrFiPricing.QTY_TOO_SMALL);
        _check(oL, L, true, false, 5_000 * U + 1, CorrFiPricing.QTY_TOO_LARGE);
        _check(oL, L, false, true, 1, CorrFiPricing.ZERO_AMOUNT);
        _check(oL, L, false, false, 130_000 * U, CorrFiPricing.BOOK_TOO_THIN);

        // absurd inputs answer with a reason instead of reverting (review 2026-09-26)
        _check(oL, L, true, true, type(uint256).max, CorrFiPricing.BOOK_TOO_THIN);
        _check(oS, S, false, true, 10 ** 30, CorrFiPricing.BOOK_TOO_THIN);
        CorrFiLens.Breakdown memory wide = lens.breakdown(oL, mid, L, true, true, 100 * U, type(uint256).max);
        assertEq(wide.reason, 0);
        assertFalse(wide.limitDefined);

        // gross funds: wallet approval
        vm.prank(MAKER);
        usdc.approve(address(aqua), 10 * U);
        _check(oL, L, true, true, 1_000 * U, CorrFiPricing.WALLET_SHORT);
        vm.revertToState(snapshot);

        // gross funds: allocation (a sell pays Receive out of the order's USDC)
        address thin = address(0x3A42);
        usdc.mint(thin, 50_000 * U);
        _approveMaker(thin, mid);
        vm.prank(thin);
        router.setMakerConfig(makerCfg());
        (ISwapVM.Order memory tl,) = openBooks(thin, mid, 1, 300 * U);
        _check(tl, L, false, true, 1_000 * U, CorrFiPricing.ALLOCATION_SHORT);
        vm.revertToState(snapshot);

        // ORDER_INACTIVE: the Short book is docked
        dock(MAKER, oS, mid, S);
        _check(oS, S, true, true, 50 * U, CorrFiPricing.ORDER_INACTIVE);
        vm.revertToState(snapshot);
    }

    function test_reasonsMatchQuoteForCaps() public {
        uint256 snapshot = vm.snapshotState();
        // MARKET_CAP with small caps
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.qMaxMarket = uint128(6_000 * U);
        c.qGroup = uint128(8_000 * U);
        vm.prank(MAKER);
        router.setMakerConfig(c);
        tradeAs(TAKER, L, true, false, 5_000 * U);
        tradeAs(TAKER, L, true, false, 1_000 * U); // |q| = qmax,m
        _check(oL, L, true, false, 1 * U, CorrFiPricing.MARKET_CAP);

        // GROUP_CAP on a second market
        uint8 m2 = createMarket(appAInput());
        _approveMaker(MAKER, m2);
        (ISwapVM.Order memory l2,) = openBooks(MAKER, m2, 1, ALLOCATION);
        vm.prank(TAKER);
        router.trade(l2, m2, L, true, false, 2_000 * U, type(uint256).max, 0); // Σ|q| = 8,000
        uint8 viaQuote = _quoteReason(l2, true, false, 1 * U);
        assertEq(viaQuote, CorrFiPricing.GROUP_CAP);
        assertEq(lens.breakdownOrder(l2, true, false, 1 * U, DELTA_TOL).reason, CorrFiPricing.GROUP_CAP);
        assertEq(lens.breakdown(l2, m2, L, true, false, 1 * U, DELTA_TOL).reason, CorrFiPricing.GROUP_CAP);
        vm.revertToState(snapshot);

        // UTILIZATION_CAP
        c = makerCfg();
        c.riskBudget = uint128(10_000 * U);
        vm.prank(MAKER);
        router.setMakerConfig(c);
        tradeAs(TAKER, L, false, true, 5_000 * U);
        _check(oL, L, false, true, 5_000 * U, CorrFiPricing.UTILIZATION_CAP);
    }

    function test_reasonsMatchQuoteForGates() public {
        uint256 snapshot = vm.snapshotState();
        uint256 s0 = obsStart(mid);
        // STALE
        vm.warp(s0 + 361);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.STALE);
        vm.revertToState(snapshot);

        // UNSYNCED
        vm.warp(s0 + 300);
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](2);
        ps[0] = pt(s0, 2000e18, 60_000e18);
        ps[1] = pt(s0 + 300, 2001e18, 60_010e18);
        vm.prank(REPORTER);
        hub.postPoints(ps);
        hub.crank(mid, 10);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.UNSYNCED);
        vm.revertToState(snapshot);

        // EXPIRED: T-3 at obsEnd, the Deadline instruction after it
        uint256 obsEnd = hub.quoteState(mid).obsEnd;
        vm.warp(obsEnd);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.EXPIRED);
        vm.warp(obsEnd + 1);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.EXPIRED);
        vm.revertToState(snapshot);

        // TOO_MANY_INVALID
        CorrFiHub.PointInput[] memory bad = new CorrFiHub.PointInput[](12);
        bad[0] = pt(s0, 2000e18, 60_000e18);
        for (uint256 i = 1; i < 12; ++i) bad[i] = pt(s0 + i * 300, 0, 60_000e18);
        vm.warp(s0 + 11 * 300);
        vm.prank(REPORTER);
        hub.postPoints(bad);
        hub.crank(mid, type(uint32).max);
        CorrFiHub.ReportInput memory r = honestReport(mid, 11);
        vm.prank(REPORTER);
        hub.submitReport(r);
        _check(oL, L, true, true, 100 * U, CorrFiPricing.TOO_MANY_INVALID);
    }
}
