// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {CorrFiFixture} from "./helpers/CorrFiFixture.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiToken} from "../src/CorrFiToken.sol";

contract VaultTest is CorrFiFixture {
    address constant ROUTER = address(0x7070); // test stand-in for the S04 router (not the real router)
    address constant MAKER = address(0x3A3E);
    address constant ALICE = address(0xA11);
    uint8 id;
    CorrFiVault v;
    CorrFiToken lng;
    CorrFiToken sht;

    function setUp() public override {
        super.setUp();
        hub.setRouter(ROUTER);
        id = createMarket(defaultInput());
        v = vaultOf(id);
        lng = longOf(id);
        sht = shortOf(id);
        usdc.mint(ALICE, 10_000e6);
        usdc.mint(ROUTER, 10_000e6);
        vm.prank(ALICE);
        usdc.approve(address(v), type(uint256).max);
        vm.startPrank(ROUTER);
        usdc.approve(address(v), type(uint256).max);
        lng.approve(address(v), type(uint256).max);
        sht.approve(address(v), type(uint256).max);
        vm.stopPrank();
    }

    /// Settle via the obsEnd + 48 h exit with no points posted: every bar invalid -> VOID (0.5).
    function _settleVoid() internal {
        vm.warp(hub.quoteState(id).obsEnd + 48 hours);
        hub.crank(id, 5000);
        v.finalize();
    }

    function _a1() internal view {
        assertEq(lng.totalSupply(), sht.totalSupply());
        assertEq(lng.totalSupply(), v.collateral());
        assertEq(usdc.balanceOf(address(v)), v.collateral());
    }

    // ------------------------------------------------------------------ direct operations

    function test_mintBurnKeepA1() public {
        vm.startPrank(ALICE);
        v.mint(1_234_567);
        _a1();
        v.burn(234_567);
        _a1();
        vm.stopPrank();
        assertEq(lng.balanceOf(ALICE), 1_000_000);
        assertEq(sht.balanceOf(ALICE), 1_000_000);
        assertEq(usdc.balanceOf(ALICE), 10_000e6 - 1_000_000);
    }

    function test_mintClosesAtObsEnd() public {
        vm.warp(hub.quoteState(id).obsEnd - 1);
        vm.prank(ALICE);
        v.mint(1);
        vm.warp(hub.quoteState(id).obsEnd);
        vm.prank(ALICE);
        vm.expectRevert(CorrFiVault.MintClosed.selector);
        v.mint(1);
        // burn is still allowed until finalize
        vm.prank(ALICE);
        v.burn(1);
    }

    function test_burnNeedsBothSides() public {
        vm.startPrank(ALICE);
        v.mint(100);
        lng.transfer(address(0xB), 1);
        vm.expectRevert(); // ERC20InsufficientBalance on Long
        v.burn(100);
        vm.stopPrank();
    }

    function test_onlyVaultMintsTokens() public {
        vm.expectRevert(CorrFiToken.OnlyVault.selector);
        lng.mint(address(this), 1);
        vm.expectRevert(CorrFiToken.AlreadyInitialized.selector);
        lng.initialize(address(this), "x", "y");
        vm.expectRevert(CorrFiVault.AlreadyInitialized.selector);
        v.initialize(address(this), 0, address(usdc), address(lng), address(sht), 0);
    }

    function test_finalizeRules() public {
        vm.expectRevert(abi.encodeWithSelector(CorrFiVault.NotReady.selector, 0, 2016));
        v.finalize();
        vm.expectRevert(CorrFiVault.NotFinalized.selector);
        v.redeem(1, 0);
        _settleVoid();
        vm.expectRevert(CorrFiVault.AlreadyFinalized.selector);
        v.finalize();
        vm.prank(ALICE);
        vm.expectRevert(CorrFiVault.AlreadyFinalized.selector);
        v.burn(1);
    }

    function test_redeemVoidPaysHalfEachSide() public {
        vm.prank(ALICE);
        v.mint(1_000_001);
        _settleVoid();
        assertTrue(v.isVoid());
        vm.prank(ALICE);
        uint256 p = v.redeem(1_000_001, 0); // one-sided redemption is allowed
        assertEq(p, 500_000); // floor(1_000_001 * 0.5)
        vm.prank(ALICE);
        assertEq(v.redeem(0, 1_000_001), 500_000);
        assertEq(usdc.balanceOf(address(v)), 1); // true dust
        assertEq(v.sweepDust(), 1);
    }

    // ------------------------------------------------------------------ custody (router only, M §5.4)

    function _routerMintPairs(uint256 q) internal {
        vm.prank(ROUTER);
        v.mint(q); // the router is an ordinary mint caller (M §5.3)
    }

    function test_depositOnlyRouter() public {
        vm.expectRevert(CorrFiVault.OnlyRouter.selector);
        v.depositIn(MAKER, CorrFiVault.Side.Long, 1);
        vm.expectRevert(CorrFiVault.OnlyRouter.selector);
        v.depositOut(MAKER, CorrFiVault.Side.Long, 1, address(this));
    }

    function test_depositLedgerEqualsCustodyA5() public {
        _routerMintPairs(1_000);
        vm.startPrank(ROUTER);
        v.depositIn(MAKER, CorrFiVault.Side.Short, 600); // e.g. D1 mint: Short side into custody
        assertEq(v.depositShort(MAKER), 600);
        assertEq(sht.balanceOf(address(v)), 600);
        vm.expectRevert(CorrFiVault.OppositeDepositNotEmpty.selector); // A2: min(N_L, N_S) = 0
        v.depositIn(MAKER, CorrFiVault.Side.Long, 1);
        v.depositOut(MAKER, CorrFiVault.Side.Short, 600, ALICE);
        assertEq(v.depositShort(MAKER), 0);
        assertEq(sht.balanceOf(ALICE), 600);
        vm.expectRevert(); // underflow: cannot take more than the custody
        v.depositOut(MAKER, CorrFiVault.Side.Short, 1, ALICE);
        v.depositIn(MAKER, CorrFiVault.Side.Long, 1_000); // now the Long side may fill
        vm.stopPrank();
        assertEq(lng.balanceOf(address(v)), v.depositLong(MAKER));
    }

    function test_claimDepositAfterSettlement() public {
        _routerMintPairs(1_000);
        vm.prank(ROUTER);
        v.depositIn(MAKER, CorrFiVault.Side.Short, 999);
        vm.prank(MAKER);
        vm.expectRevert(CorrFiVault.NotFinalized.selector);
        v.claimDeposit();
        _settleVoid();
        vm.prank(ROUTER);
        vm.expectRevert(CorrFiVault.AlreadyFinalized.selector); // no custody moves after settlement
        v.depositOut(MAKER, CorrFiVault.Side.Short, 1, ROUTER);
        vm.prank(MAKER);
        assertEq(v.claimDeposit(), 499); // floor(999 * 0.5)
        assertEq(sht.balanceOf(address(v)), 0);
        vm.prank(MAKER);
        vm.expectRevert(CorrFiVault.ZeroAmount.selector);
        v.claimDeposit();
    }

    // ------------------------------------------------------------------ true dust (DEC-01)

    function test_sweepNeverTouchesOutstandingClaims() public {
        vm.prank(ALICE);
        v.mint(3);
        _routerMintPairs(5);
        vm.prank(ROUTER);
        v.depositIn(MAKER, CorrFiVault.Side.Long, 5);
        usdc.mint(address(v), 7); // a donation is not collateral
        vm.expectRevert(CorrFiVault.NotFinalized.selector);
        v.sweepDust();
        _settleVoid();
        // reserve = ceil(8 * 0.5) + ceil(8 * 0.5) = 8 -> only the donation is swept
        assertEq(v.sweepDust(), 7);
        vm.prank(ALICE);
        assertEq(v.redeem(3, 3), 2); // floor(1.5) + floor(1.5)
        vm.prank(MAKER);
        assertEq(v.claimDeposit(), 2); // floor(5 * 0.5)
        vm.prank(ROUTER);
        assertEq(v.redeem(0, 5), 2);
        assertEq(usdc.balanceOf(address(v)), 2); // everything outstanding was paid in full
        assertEq(v.sweepDust(), 2);
    }
}
