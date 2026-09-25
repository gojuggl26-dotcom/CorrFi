// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {CorrFiFixture} from "./helpers/CorrFiFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice Whole-market replays against scenarios computed independently by the Python port
///         (vectors/gen_market_scenarios.py). Every accepted report proves on-chain P_fair / h0 == Python's
///         (U-3 requires exact equality); sig2, the accumulator and Long_T are compared wei for wei.
contract MarketScenariosTest is CorrFiFixture {
    string internal json;

    struct Cols {
        string[] pa;
        string[] pb;
        string[] rk;
        string[] rp;
        string[] rh;
        string[] rs;
    }

    function setUp() public override {
        super.setUp();
        json = vm.readFile(string.concat(vm.projectRoot(), "/../vectors/market_scenarios.json"));
    }

    function _key(uint256 s, string memory path) internal pure returns (string memory) {
        return string.concat(".scenarios[", vm.toString(s), "]", path);
    }

    function _cols(uint256 s) internal view returns (Cols memory c) {
        c.pa = vm.parseJsonStringArray(json, _key(s, ".points_a"));
        c.pb = vm.parseJsonStringArray(json, _key(s, ".points_b"));
        if (vm.parseJsonUint(json, _key(s, ".final.processed")) != 0 && _hasReports(s)) {
            c.rk = vm.parseJsonStringArray(json, _key(s, ".reports.k"));
            c.rp = vm.parseJsonStringArray(json, _key(s, ".reports.pFair"));
            c.rh = vm.parseJsonStringArray(json, _key(s, ".reports.h0"));
            c.rs = vm.parseJsonStringArray(json, _key(s, ".reports.sig2"));
        }
    }

    function _hasReports(uint256 s) internal view returns (bool) {
        return bytes(vm.parseJsonString(json, _key(s, ".name"))).length != bytes("grace").length;
    }

    function _isMissing(string memory v) internal pure returns (bool) {
        return keccak256(bytes(v)) == keccak256("missing");
    }

    function _price(string memory v) internal pure returns (uint256) {
        return bytes(v).length == 0 ? 0 : vm.parseUint(v);
    }

    /// Replay scenario `s`; returns the market id after finalize.
    function _replay(uint256 s, bool grace) internal returns (uint8 id) {
        Cols memory c = _cols(s);
        assertEq(vm.parseJsonUint(json, ".params.tenorDays"), 7);
        id = createMarket(defaultInput());
        ICorrFiHub.Quote memory q = hub.quoteState(id);
        assertEq(q.pFair, vm.parseJsonUint(json, _key(s, ".initial.pFair")), "initial pFair");
        assertEq(q.h0, vm.parseJsonUint(json, _key(s, ".initial.h0")), "initial h0");
        assertEq(q.sig2, vm.parseJsonUint(json, _key(s, ".initial.sig2")), "initial sig2");
        uint256 t0 = q.obsStart;
        uint256 next;
        CorrFiHub.PointInput[] memory one = new CorrFiHub.PointInput[](1);
        CorrFiHub.PointInput[] memory none = new CorrFiHub.PointInput[](0);
        CorrFiHub.ReportInput[] memory rep = new CorrFiHub.ReportInput[](1);
        for (uint256 k; k < c.pa.length; ++k) {
            uint256 t = t0 + k * 300;
            vm.warp(t + 10); // the reporter posts ~10 s after t_k (R §5.2)
            if (!_isMissing(c.pa[k])) {
                one[0] = pt(t, _price(c.pa[k]), _price(c.pb[k]));
                vm.prank(REPORTER);
                hub.postPoints(one);
            }
            if (next < c.rk.length && k == vm.parseUint(c.rk[next])) {
                uint256 pf = vm.parseUint(c.rp[next]);
                uint256 h = vm.parseUint(c.rh[next]);
                rep[0] = CorrFiHub.ReportInput(id, uint32(k), pf, h, sign(id, uint32(k), pf, h));
                vm.prank(REPORTER);
                hub.postAndReport(none, rep); // reverts unless the chain recomputes exactly pf and h (U-3)
                q = hub.quoteState(id);
                assertEq(q.confirmed, k);
                assertEq(q.sig2, vm.parseUint(c.rs[next]), "sig2");
                ++next;
            }
        }
        assertEq(next, c.rk.length, "all reports submitted");
        if (grace) vm.warp(q.obsEnd + 48 hours);
        hub.crank(id, 5000);
        ICorrFiHub.Settlement memory st = hub.settlement(id);
        assertEq(st.processed, vm.parseJsonUint(json, _key(s, ".final.processed")));
        assertEq(st.nValid, vm.parseJsonUint(json, _key(s, ".final.nValid")));
        assertEq(st.c, vm.parseJsonInt(json, _key(s, ".final.c")), "C");
        assertEq(st.va, vm.parseJsonUint(json, _key(s, ".final.va")), "VA");
        assertEq(st.vb, vm.parseJsonUint(json, _key(s, ".final.vb")), "VB");
        CorrFiVault v = vaultOf(id);
        v.finalize();
        assertEq(v.longT(), vm.parseJsonUint(json, _key(s, ".final.longT")), "Long_T");
        assertEq(v.isVoid(), vm.parseJsonBool(json, _key(s, ".final.void")));
    }

    function test_scenarioNormal() public {
        _replay(0, false);
    }

    function test_scenarioVoid() public {
        _replay(1, false);
    }

    function test_scenarioGraceExit() public {
        _replay(2, true);
    }

    /// Redemption after a non-VOID settlement: payouts follow M §5.5 exactly, the dust sweep keeps every
    /// outstanding claim payable (DEC-01), and the vault ends with only the true dust.
    function test_redemptionAfterNormalSettlement() public {
        address alice = address(0xA);
        address bob = address(0xB);
        usdc.mint(alice, 1_000e6);
        uint8 id = createMarket(defaultInput());
        CorrFiVault v = vaultOf(id);
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        v.mint(777_123_457); // 777.123457 pairs
        longOf(id).transfer(bob, 333_333_333);
        vm.stopPrank();
        // settle with the normal scenario's prices (all points posted, no reports needed; non-VOID Long_T)
        Cols memory c = _cols(0);
        uint256 t0 = obsStart(id);
        CorrFiHub.PointInput[] memory one = new CorrFiHub.PointInput[](1);
        for (uint256 k; k < c.pa.length; ++k) {
            vm.warp(t0 + k * 300 + 10);
            one[0] = pt(t0 + k * 300, _price(c.pa[k]), _price(c.pb[k]));
            vm.prank(REPORTER);
            hub.postPoints(one);
        }
        hub.crank(id, 5000);
        v.finalize();
        uint256 l = v.longT();
        assertEq(l, vm.parseJsonUint(json, _key(0, ".final.longT")));
        // dust can be swept first; holders are still paid in full
        uint256 swept = v.sweepDust();
        assertEq(swept, 0); // no rounding dust exists until someone redeems
        vm.prank(bob);
        uint256 pb_ = v.redeem(333_333_333, 0);
        assertEq(pb_, 333_333_333 * l / WAD);
        vm.prank(alice);
        uint256 pa_ = v.redeem(777_123_457 - 333_333_333, 777_123_457);
        assertEq(pa_, (777_123_457 - 333_333_333) * l / WAD + 777_123_457 * (WAD - l) / WAD);
        assertLe(pa_ + pb_, 777_123_457); // S1: payouts never exceed collateral
        uint256 dust = usdc.balanceOf(address(v));
        assertLt(dust, 4); // floor rounding of 3 terms
        assertEq(v.sweepDust(), dust);
        assertEq(usdc.balanceOf(TREASURY), dust);
    }
}
