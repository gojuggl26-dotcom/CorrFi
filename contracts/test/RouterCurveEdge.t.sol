// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";

/// @notice Regression (review 2026-09-26): with the alpha = 1 cut q1 floored, a maker inventory one unit above it
///         made selling Short (D4) revert with Panic(0x11) in quote / swap / breakdown, and buying Long pay more than
///         1 per token. Here kq = 0.22 puts q1* = -25,909,090,909.09 units (fractional part above one half) inside
///         the reachable inventory; the taker walks the inventory onto q1* and its neighbours.
contract RouterCurveEdgeTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;

    function setUp() public override {
        super.setUp();
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.kq = 22e16;
        c.qMinTrade = 1; // lets the inventory move by single units
        vm.prank(MAKER);
        router.setMakerConfig(c);
        usdc.mint(TAKER, 500_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(50_000 * U);
        vm.stopPrank();
    }

    function _q() internal view returns (int256) {
        (uint256 nl, uint256 ns) = custody(MAKER);
        return int256(nl) - int256(ns);
    }

    function test_inventoryAroundTheAlphaOneCut() public {
        // P = 0.9, h = h_min = 0.005 before obsStart: q1* = (P + h - 1) qmax / kq = -25,909,090,909.09 units
        int256 target = -25_909_090_911; // two units below floor(q1*) - 1
        for (uint256 i; i < 5; ++i) tradeAs(TAKER, L, true, false, 5_000 * U);
        tradeAs(TAKER, L, true, false, uint256(-target) - 25_000 * U);
        assertEq(_q(), target);
        for (uint256 step; step < 5; ++step) {
            // at q = target .. target + 4 (covers floor(q1*), ceil(q1*) and around)
            (uint256 pay,) = quoteOf(oL, true, false, 1_000); // buy 1,000 units of Long
            assertLe(pay, 1_000, "average Long price <= 1");
            // sell Short: near q1 the Long ask is ~1, so the Short bid is ~0 — a reason code (ZERO_AMOUNT), never a Panic
            bytes memory tt = takerTraits(TAKER, oS, false, true, 0, false);
            try router.quote(oS, 1_000, tt) returns (uint256, uint256 recv, bytes32) {
                assertLe(recv, 1_000);
            } catch (bytes memory err) {
                assertEq(bytes4(err), CorrFiEngine.CorrReject.selector, "a reason code, not a Panic");
            }
            CorrFiLens.Breakdown memory b = lens.breakdown(oS, mid, S, false, true, 1_000, 2e15);
            assertTrue(b.reason == 0 || b.reason == CorrFiPricing.ZERO_AMOUNT, "breakdown answers with a reason");
            tradeAs(TAKER, S, true, false, 1); // buy 1 unit of Short (pays >= 1 unit): q + 1
        }
        assertEq(_q(), target + 5);
    }
}
