// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {CorrFiHub} from "../../src/CorrFiHub.sol";
import {CorrFiVault} from "../../src/CorrFiVault.sol";
import {CorrFiToken} from "../../src/CorrFiToken.sol";
import {CorrFiMath} from "../../src/lib/CorrFiMath.sol";
import {MockUSDC} from "./MockUSDC.sol";

/// @notice Shared setup: a hub with a test reporter / price signer and helpers to create a market, post points
///         and sign reports. Market parameters match vectors/gen_market_scenarios.py.
abstract contract CorrFiFixture is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant SIGNER_PK = 0xA11CE;
    uint256 internal constant H_FLOOR = 5e15;
    address internal constant REPORTER = address(0xBEEF);
    address internal constant TREASURY = address(0x7EA5);
    uint256 internal constant T_START = 1_790_000_000; // arbitrary chain time before market creation

    MockUSDC internal usdc;
    CorrFiHub internal hub;
    address internal signer;

    function setUp() public virtual {
        vm.warp(T_START);
        usdc = new MockUSDC();
        signer = vm.addr(SIGNER_PK);
        hub = new CorrFiHub(address(this), address(usdc), H_FLOOR, REPORTER, signer, TREASURY);
    }

    function defaultInput() internal pure returns (CorrFiHub.MarketInput memory p) {
        p.tenorDays = 7;
        p.sA = 25e14;
        p.sB = 25e14;
        p.sAB = 5e12;
        p.sA2 = 625e10;
        p.sB2 = 625e10;
        for (uint256 i; i < 10; ++i) p.sigmaTable[i] = 4e16 * (19 - 2 * i) / 20; // PROP-08
        p.cH = 15e16;
        p.lambda = 997596132883620259;
        p.sigma0 = 8e14;
    }

    function sign(uint8 id, uint32 k, uint256 pFair, uint256 h0) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, hub.reportDigest(id, k, pFair, h0));
        return abi.encodePacked(r, s, v);
    }

    /// Create a market; the initial report is computed with the library here (fixture only — the independent
    /// check of these values is MarketScenarios.t.sol against the Python port).
    function createMarket(CorrFiHub.MarketInput memory p) internal returns (uint8 id) {
        uint256 n = uint256(p.tenorDays) * 288;
        uint256 p0 = CorrFiMath.fairValue(0, 0, 0, 0, n, p.sAB, p.sA2, p.sB2);
        uint256 h00 = CorrFiMath.h0(0, p.sigmaTable, p.cH, H_FLOOR);
        id = hub.marketCount();
        bytes memory sig = sign(id, 0, p0, h00);
        return hub.createMarket(p, p0, h00, sig);
    }

    function obsStart(uint8 id) internal view returns (uint256) {
        return hub.quoteState(id).obsStart;
    }

    function pt(uint256 t, uint256 pa, uint256 pb) internal pure returns (CorrFiHub.PointInput memory) {
        return CorrFiHub.PointInput(uint64(t), uint128(pa), uint128(pb), pa != 0, pb != 0);
    }

    function postOne(uint256 t, uint256 pa, uint256 pb) internal {
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](1);
        ps[0] = pt(t, pa, pb);
        if (block.timestamp < t) vm.warp(t);
        vm.prank(REPORTER);
        hub.postPoints(ps);
    }

    /// The report the price engine would sign for the current accumulator state of market `id` at bar k.
    function honestReport(uint8 id, uint32 k) internal view returns (CorrFiHub.ReportInput memory r) {
        CorrFiHub.Settlement memory s = hub.settlement(id);
        (,, int256 sAB, uint256 sA2, uint256 sB2, uint256[10] memory table, uint256 cH,) = hub.marketParams(id);
        uint256 p = CorrFiMath.fairValue(s.c, s.va, s.vb, k, s.n, sAB, sA2, sB2);
        uint256 h = CorrFiMath.h0(CorrFiMath.tau(k, s.n), table, cH, H_FLOOR);
        r = CorrFiHub.ReportInput(id, k, p, h, sign(id, k, p, h));
    }

    function vaultOf(uint8 id) internal view returns (CorrFiVault) {
        return CorrFiVault(hub.marketVault(id));
    }

    function longOf(uint8 id) internal view returns (CorrFiToken) {
        return vaultOf(id).longToken();
    }

    function shortOf(uint8 id) internal view returns (CorrFiToken) {
        return vaultOf(id).shortToken();
    }
}
