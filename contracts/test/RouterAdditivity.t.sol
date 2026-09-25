// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {console2} from "forge-std/console2.sol";
import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";

/// @notice PROP-05 (adopted 2026-09-26), second half: when h_U is recomputed from U* before each trade, splitting a
///         trade is not additive. No equality is assumed; the sign is checked and the size is logged.
///         (The fixed-h half is RouterTest.test_additivityWithFixedSpread.)
contract RouterAdditivityTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;

    function setUp() public override {
        super.setUp();
        usdc.mint(TAKER, 500_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(100_000 * U);
        vm.stopPrank();
    }

    function _budget(uint256 riskBudget) internal {
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.riskBudget = uint128(riskBudget);
        vm.prank(MAKER);
        router.setMakerConfig(c);
    }

    function _hU(bool isBuy, uint256 qty) internal view returns (uint256) {
        CorrFiLens.Breakdown memory b = lens.breakdown(oL, mid, L, isBuy, true, qty, 2e15);
        return b.hU;
    }

    /// Risk-increasing: from q = +12,000 (U* = 54% with a 20,000 budget) the taker sells Long 4,000 at once
    /// (h_U = 0) or as 2,000 + 2,000 (the second piece sees U* = 63%, h_U > 0). The split receives less.
    function test_splitWithRecomputedSurcharge_riskIncreasing() public {
        _budget(20_000 * U);
        for (uint256 i; i < 3; ++i) tradeAs(TAKER, L, false, true, 4_000 * U);
        uint256 snapshot = vm.snapshotState();
        (, uint256 whole) = tradeAs(TAKER, L, false, true, 4_000 * U);
        vm.revertToState(snapshot);
        (, uint256 a) = tradeAs(TAKER, L, false, true, 2_000 * U);
        uint256 hU2 = _hU(false, 2_000 * U);
        (, uint256 b) = tradeAs(TAKER, L, false, true, 2_000 * U);
        assertGt(hU2, 0, "second piece carries a surcharge");
        assertLt(a + b, whole, "split receives less (taker-unfavourable)");
        console2.log("PROP-05 risk-increasing sell 4,000 Long from q=+12,000: whole receive (units)", whole);
        console2.log("  split 2,000 + 2,000 receive (units)", a + b);
        console2.log("  split - whole (units)", -int256(whole - a - b));
        console2.log("  h_U of the second piece (WAD)", hU2);
    }

    /// Risk-reducing where the surcharge binds (α = m + h above the floor P + h_min): budget 1,000, q = +900
    /// (U* = 81%). Buying Long 400 at once uses h_U(81%); as 200 + 200 the second piece sees U* = 72%.
    function test_splitWithRecomputedSurcharge_riskReducing() public {
        _budget(1_000 * U);
        tradeAs(TAKER, L, false, false, 800 * U); // sell Long for 800 USDC: q just under +900
        tradeAs(TAKER, L, false, true, 900 * U - _qNow()); // top up to exactly q = +900
        assertEq(_qNow(), 900 * U);
        uint256 hU1 = _hU(true, 1 * U);
        uint256 snapshot = vm.snapshotState();
        (uint256 whole,) = tradeAs(TAKER, L, true, false, 400 * U);
        vm.revertToState(snapshot);
        (uint256 a,) = tradeAs(TAKER, L, true, false, 200 * U);
        uint256 hU2 = _hU(true, 1 * U);
        (uint256 b,) = tradeAs(TAKER, L, true, false, 200 * U);
        assertLt(hU2, hU1, "surcharge falls as U falls");
        assertLt(a + b, whole, "split pays less");
        console2.log("PROP-05 risk-reducing buy 400 Long from q=+900 (budget 1,000): whole pay (units)", whole);
        console2.log("  split 200 + 200 pay (units)", a + b);
        console2.log("  split - whole (units)", -int256(whole - a - b));
        console2.log("  h_U before the first / second piece (WAD)", hU1, hU2);
    }

    /// Where the maker is heavily long, the ask is floored at P + h_min (m + h < P + h_min), so h_U has no effect:
    /// the split and the whole trade cost the same here (recorded, not assumed elsewhere).
    function test_splitAtTheFloorIsAdditive() public {
        _budget(20_000 * U);
        for (uint256 i; i < 4; ++i) tradeAs(TAKER, L, false, true, 4_000 * U); // q = +16,000, U* = 72%
        uint256 snapshot = vm.snapshotState();
        (uint256 whole,) = tradeAs(TAKER, L, true, false, 4_000 * U);
        vm.revertToState(snapshot);
        (uint256 a,) = tradeAs(TAKER, L, true, false, 2_000 * U);
        (uint256 b,) = tradeAs(TAKER, L, true, false, 2_000 * U);
        assertEq(whole, 3_620 * U, "(P + h_min) Q = 0.905 x 4,000");
        assertEq(a + b, whole);
        console2.log("PROP-05 floor region (q=+16,000, U*=72%): whole = split pay (units)", whole);
    }

    function _qNow() internal view returns (uint256) {
        (uint256 nl, uint256 ns) = custody(MAKER);
        return nl - ns;
    }
}
