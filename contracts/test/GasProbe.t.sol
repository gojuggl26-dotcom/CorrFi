// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";

/// @notice Gas of one entry trade and one quote with one market and with three markets of the same maker holding
///         inventory (the exposure loop of M §6.1 reads every market; review S04-14). Numbers are logged.
contract GasProbeTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;

    function _measure(uint8 m, ISwapVM.Order memory o, string memory label) internal {
        bytes memory tt = takerTraits(TAKER, o, true, false, 0, false);
        uint256 g0 = gasleft();
        router.quote(o, 1_000 * U, tt);
        uint256 gq = g0 - gasleft();
        vm.prank(TAKER);
        g0 = gasleft();
        router.trade(o, m, L, true, false, 1_000 * U, type(uint256).max, 0);
        uint256 gt = g0 - gasleft();
        emit log_named_uint(string.concat(label, " quote"), gq);
        emit log_named_uint(string.concat(label, " trade"), gt);
    }

    function test_gasOneAndThreeMarkets() public {
        tradeAs(TAKER, L, true, false, 2_000 * U); // inventory in the first market
        _measure(mid, oL, "1 market:");
        ISwapVM.Order memory last;
        uint8 m;
        for (uint256 i; i < 2; ++i) {
            m = createMarket(appAInput());
            _approveMaker(MAKER, m);
            _approveTaker(TAKER, m);
            (last,) = openBooks(MAKER, m, 1, ALLOCATION);
            vm.prank(TAKER);
            router.trade(last, m, L, true, false, 2_000 * U, type(uint256).max, 0);
        }
        _measure(m, last, "3 markets:");
    }

    /// The reporter's transaction every 5 minutes (M §4.2.1): one price point, then crank + report of 3 markets.
    function test_gasPostAndReportThreeMarkets() public {
        uint8[3] memory ids = [mid, createMarket(appAInput()), createMarket(appAInput())];
        uint256 t0 = obsStart(mid);
        vm.warp(t0 + 300 + 10);
        CorrFiHub.PointInput[] memory first = new CorrFiHub.PointInput[](1);
        first[0] = pt(t0, 2000e18, 60_000e18);
        vm.prank(REPORTER);
        hub.postPoints(first);
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](1);
        ps[0] = pt(t0 + 300, 2004e18, 60_090e18);
        uint256 snap = vm.snapshotState();
        vm.prank(REPORTER);
        hub.postPoints(ps);
        CorrFiHub.ReportInput[] memory rs = new CorrFiHub.ReportInput[](3);
        for (uint256 i; i < 3; ++i) {
            hub.crank(ids[i], 1);
            rs[i] = honestReport(ids[i], 1);
        }
        vm.revertToState(snap);
        vm.prank(REPORTER);
        uint256 g0 = gasleft();
        hub.postAndReport(ps, rs);
        emit log_named_uint("postAndReport, 1 point + 3 reports", g0 - gasleft());
        assertEq(hub.quoteState(ids[2]).confirmed, 1);
    }
}
