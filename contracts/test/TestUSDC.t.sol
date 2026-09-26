// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

contract TestUSDCTest is Test {
    TestUSDC internal t;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    uint256 internal constant LIMIT = 10_000e6;
    uint256 internal constant T0 = 1_789_689_600;

    function setUp() public {
        vm.warp(T0);
        t = new TestUSDC("Test USDC", "tUSDC");
    }

    function _claim(address who, uint256 amount) internal {
        vm.prank(who);
        t.faucet(amount);
    }

    function test_ownerMintsWithoutCap() public {
        t.mint(alice, 1_000_000e6);
        assertEq(t.balanceOf(alice), 1_000_000e6);
    }

    function test_othersCannotMint() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        t.mint(alice, 1);
    }

    function test_freshAddressHasTheFullLimit() public view {
        (uint256 available, uint256 resetsAt) = t.faucetAvailable(alice);
        assertEq(available, LIMIT);
        assertEq(resetsAt, 0);
    }

    function test_partialClaimsUpToTheDailyLimit() public {
        _claim(alice, 2_500e6);
        _claim(alice, 7_000e6);
        assertEq(t.balanceOf(alice), 9_500e6);
        (uint256 available, uint256 resetsAt) = t.faucetAvailable(alice);
        assertEq(available, 500e6);
        assertEq(resetsAt, block.timestamp + 1 days);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.FaucetLimitExceeded.selector, 500e6, block.timestamp + 1 days));
        t.faucet(501e6);

        _claim(alice, 500e6);
        assertEq(t.balanceOf(alice), LIMIT);
    }

    function test_windowResetsAfter24Hours() public {
        // a constant, not block.timestamp: via-IR may re-read TIMESTAMP after vm.warp
        uint256 start = T0;
        _claim(alice, LIMIT);
        vm.warp(start + 1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(TestUSDC.FaucetLimitExceeded.selector, 0, start + 1 days));
        t.faucet(1);

        vm.warp(start + 1 days);
        _claim(alice, LIMIT);
        assertEq(t.balanceOf(alice), 2 * LIMIT);
        (, uint256 resetsAt) = t.faucetAvailable(alice);
        assertEq(resetsAt, start + 2 days);
    }

    function test_zeroAmountReverts() public {
        vm.prank(alice);
        vm.expectRevert(TestUSDC.FaucetZeroAmount.selector);
        t.faucet(0);
    }

    function test_limitIsPerAddress() public {
        _claim(alice, LIMIT);
        _claim(bob, LIMIT);
        assertEq(t.balanceOf(bob), LIMIT);
    }

    function testFuzz_neverMoreThanTheLimitPerWindow(uint96 a, uint96 b) public {
        uint256 x = bound(a, 1, LIMIT);
        uint256 y = bound(b, 1, LIMIT);
        _claim(alice, x);
        vm.prank(alice);
        if (x + y > LIMIT) vm.expectRevert(abi.encodeWithSelector(TestUSDC.FaucetLimitExceeded.selector, LIMIT - x, block.timestamp + 1 days));
        t.faucet(y);
        assertLe(t.balanceOf(alice), LIMIT);
    }
}
