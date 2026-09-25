// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice S06 test vectors (B §3.4, §5.1): P_fair and h0 at representative states of real windows with the proposed
///         w, σP table and c_h (backtest/fixedpoint.py). The same file is checked by the TypeScript engine.
contract BacktestVectorsTest is Test {
    string internal json;

    function setUp() public {
        json = vm.readFile(string.concat(vm.projectRoot(), "/../vectors/backtest_states.json"));
    }

    function _u(string memory key) internal view returns (uint256[] memory out) {
        string[] memory s = vm.parseJsonStringArray(json, string.concat(".states.", key));
        out = new uint256[](s.length);
        for (uint256 i; i < s.length; ++i) out[i] = vm.parseUint(s[i]);
    }

    function _i(string memory key) internal view returns (int256[] memory out) {
        string[] memory s = vm.parseJsonStringArray(json, string.concat(".states.", key));
        out = new int256[](s.length);
        for (uint256 i; i < s.length; ++i) out[i] = vm.parseInt(s[i]);
    }

    function test_fairValueAndH0AtBacktestStates() public view {
        int256[] memory c = _i("c");
        uint256[] memory va = _u("va");
        uint256[] memory vb = _u("vb");
        uint256[] memory nobs = _u("nobs");
        uint256[] memory n = _u("n");
        int256[] memory sab = _i("sab");
        uint256[] memory sa2 = _u("sa2");
        uint256[] memory sb2 = _u("sb2");
        uint256[] memory p = _u("p");
        uint256[] memory ch = _u("ch");
        uint256[] memory hf = _u("hfloor");
        uint256[] memory h0 = _u("h0");
        uint256[10][] memory tables = new uint256[10][](p.length);
        for (uint256 j; j < 10; ++j) {
            uint256[] memory col = _u(string.concat("table", vm.toString(j)));
            for (uint256 i; i < p.length; ++i) tables[i][j] = col[i];
        }
        assertGe(p.length, 72);
        for (uint256 i; i < p.length; ++i) {
            assertEq(CorrFiMath.fairValue(c[i], va[i], vb[i], nobs[i], n[i], sab[i], sa2[i], sb2[i]), p[i]);
            assertEq(CorrFiMath.h0(CorrFiMath.tau(nobs[i], n[i]), tables[i], ch[i], hf[i]), h0[i]);
        }
    }
}
