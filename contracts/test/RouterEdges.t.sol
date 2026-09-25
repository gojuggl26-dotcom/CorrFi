// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";

/// @notice The clip boundaries of the curve through the router (M §7.2 論点 12): near ρ = 1 the Long ask is clipped
///         to 1 (the mint price) and near ρ = -1 the Long bid is 0, so selling Long returns 0 and is refused.
contract RouterEdgesTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;

    uint8 internal mHi; // ρ̂ = 0.998: P_fair ≈ 0.999, P + h_min > 1
    uint8 internal mLo; // ρ̂ = -0.998: P_fair ≈ 0.001 < h_min
    ISwapVM.Order internal hiL;
    ISwapVM.Order internal hiS;
    ISwapVM.Order internal loL;
    ISwapVM.Order internal loS;

    function _market(int256 sAB) internal returns (uint8 m) {
        CorrFiHub.MarketInput memory p = appAInput();
        p.sAB = sAB;
        m = createMarket(p);
        _approveMaker(MAKER, m);
        _approveTaker(TAKER, m);
    }

    function setUp() public override {
        super.setUp();
        mHi = _market(62375e8); // 0.998 * 6.25e12
        mLo = _market(-62375e8);
        (hiL, hiS) = openBooks(MAKER, mHi, GEN, ALLOCATION);
        (loL, loS) = openBooks(MAKER, mLo, GEN, ALLOCATION);
    }

    function _trade(ISwapVM.Order memory o, uint8 m, uint8 side, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        vm.prank(TAKER);
        return router.trade(o, m, side, isBuy, exactIn, amount, exactIn ? 0 : type(uint256).max, 0);
    }

    function test_alphaClippedToOneNearRhoOne() public {
        uint256 p = hub.quoteState(mHi).pFair;
        CorrFiLens.Breakdown memory b = lens.breakdown(hiL, mHi, L, true, false, 1_000 * U, 0);
        assertEq(b.reason, CorrFiPricing.OK);
        assertGe(p + b.hmin, WAD, "P + h_min >= 1");
        // the Long ask is the mint price: 1,000 Long cost exactly 1,000 USDC, never more
        (uint256 pay,) = _trade(hiL, mHi, L, true, false, 1_000 * U);
        assertEq(pay, 1_000 * U);
        assertEq(b.amountIn, pay);
        // buying Long and Short together still costs at least the mint price (F3)
        (uint256 payS,) = _trade(hiS, mHi, S, true, false, 1_000 * U);
        assertGe(pay + payS, 1_000 * U);
        // the Short bid 1 - α is 0 there: selling Short returns 0 and is refused, like the Long bid near ρ = -1
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.ZERO_AMOUNT));
        vm.prank(TAKER);
        router.trade(hiS, mHi, S, false, true, 100 * U, 0, 0);
    }

    function test_betaZeroNearRhoMinusOne() public {
        uint256 p = hub.quoteState(mLo).pFair;
        assertLt(p, 2e15, "P_fair near 0");
        // the Long bid is 0: selling Long would return 0 (SwapVM needs a positive output), so CorrGuard refuses it
        CorrFiLens.Breakdown memory b = lens.breakdown(loL, mLo, L, false, true, 1_000 * U, 0);
        assertEq(b.reason, CorrFiPricing.ZERO_AMOUNT);
        assertLe(p, b.hmin, "P_fair <= h_min");
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.ZERO_AMOUNT));
        vm.prank(TAKER);
        router.trade(loL, mLo, L, false, true, 1_000 * U, 0, 0);
        // the Short ask 1 - β is the mint price
        (uint256 pay,) = _trade(loS, mLo, S, true, false, 1_000 * U);
        assertEq(pay, 1_000 * U);
        // a holder of both sides still exits at 1 through the vault (M §7.2 論点 12)
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mLo)), 1_000 * U);
        vaultOf(mLo).mint(1_000 * U);
        vaultOf(mLo).burn(1_000 * U);
        vm.stopPrank();
    }
}
