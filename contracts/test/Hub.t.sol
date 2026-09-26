// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {CorrFiFixture} from "./helpers/CorrFiFixture.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

contract HubTest is CorrFiFixture {
    uint256 constant PA = 3000e18;
    uint256 constant PB = 60000e18;

    // ------------------------------------------------------------------ market creation (M §2.2, §4.1.1, §4.2.2)

    function test_createMarketFixesGridAndCounts() public {
        vm.warp(T_START + 60); // T_START is not on the 5-minute grid
        uint8 id = createMarket(defaultInput());
        ICorrFiHub.Quote memory q = hub.quoteState(id);
        assertEq(q.obsStart % 300, 0);
        assertGe(q.obsStart, block.timestamp);
        assertLt(q.obsStart, block.timestamp + 300);
        assertEq(q.obsEnd, q.obsStart + 7 days);
        assertEq(q.n, 2016);
        assertEq(q.nMin, 1996);
        assertEq(q.confirmed, 0);
        assertEq(q.processed, 0);
        assertEq(q.sig2, CorrFiMath.sigmaBar2Init(8e14));
        // tau = 0 price is forecast only: rho_hat = 5e12 / 6.25e12 = 0.8 -> P = 0.9; h0 = max(0.005, 0.15*0.038)
        assertEq(q.pFair, 9e17);
        assertEq(q.h0, 57e14);
    }

    /// DEC-31: the token names and symbols carry the asset pair.
    function test_tokenNamesShowThePair() public {
        uint8 id = createMarket(defaultInput());
        CorrFiVault v = CorrFiVault(hub.marketVault(id));
        assertEq(v.longToken().name(), "CorrFi ETH/BTC 7D #0 Long");
        assertEq(v.longToken().symbol(), "ETHBTC-L");
        assertEq(v.shortToken().name(), "CorrFi ETH/BTC 7D #0 Short");
        assertEq(v.shortToken().symbol(), "ETHBTC-S");
    }

    function test_nMinPerTenor() public {
        CorrFiHub.MarketInput memory p = defaultInput();
        p.tenorDays = 14;
        assertEq(hub.quoteState(createMarket(p)).nMin, 3992);
        p.tenorDays = 28;
        assertEq(hub.quoteState(createMarket(p)).nMin, 7984);
        p.tenorDays = 30;
        vm.expectRevert(CorrFiHub.BadTenor.selector);
        hub.createMarket(p, 0, 0, "");
    }

    function test_createMarketRejectsBadForecast() public {
        CorrFiHub.MarketInput memory p = defaultInput();
        p.sAB = 7e12; // |rho| > 1 -> not PSD
        vm.expectRevert(CorrFiHub.BadForecast.selector);
        hub.createMarket(p, 0, 0, "");
        p = defaultInput();
        p.sA2 = 0; // zero forecast variance (PROP-04 / NV-M-03)
        p.sAB = 0;
        vm.expectRevert(CorrFiHub.BadForecast.selector);
        hub.createMarket(p, 0, 0, "");
        p = defaultInput();
        p.sB2 = 1e14 + 1; // > (c s_B)^2 / WAD = (1e16)^2 / 1e18 = 1e14
        vm.expectRevert(CorrFiHub.BadForecast.selector);
        hub.createMarket(p, 0, 0, "");
    }

    function test_createMarketChecksInitialReport() public {
        CorrFiHub.MarketInput memory p = defaultInput();
        bytes memory good = sign(0, 0, 9e17, 57e14);
        bytes memory off = sign(0, 0, 9e17 + 1, 57e14);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.RecomputeMismatch.selector, 9e17, 57e14));
        hub.createMarket(p, 9e17 + 1, 57e14, off);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0xB0B, hub.reportDigest(0, 0, 9e17, 57e14));
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.BadSigner.selector, vm.addr(0xB0B)));
        hub.createMarket(p, 9e17, 57e14, abi.encodePacked(r, s, v));
        hub.createMarket(p, 9e17, 57e14, good);
    }

    function test_onlyOwnerAdmin() public {
        vm.startPrank(address(0xBAD));
        vm.expectRevert();
        hub.createMarket(defaultInput(), 0, 0, "");
        vm.expectRevert();
        hub.setReporter(address(1));
        vm.stopPrank();
        hub.setRouter(address(0x1234));
        vm.expectRevert(CorrFiHub.RouterAlreadySet.selector);
        hub.setRouter(address(0x5678));
    }

    // ------------------------------------------------------------------ BarFeed rules (M §6.2.1)

    function test_postRules() public {
        uint256 t = (T_START / 300 + 1) * 300;
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](1);
        ps[0] = pt(t, PA, PB);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.FromTheFuture.selector, t));
        hub.postPoints(ps);
        vm.warp(t);
        vm.expectRevert(CorrFiHub.NotReporter.selector);
        hub.postPoints(ps);
        ps[0] = pt(t + 1, PA, PB);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.OffGrid.selector, t + 1));
        hub.postPoints(ps);
        ps[0] = CorrFiHub.PointInput(uint64(t), uint128(PA), 5, true, false); // invalid asset must carry price 0
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.BadPrice.selector, t));
        hub.postPoints(ps);
        postOne(t, PA, 0); // B invalid is allowed
        vm.prank(REPORTER);
        ps[0] = pt(t, PA, PB);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.AlreadyPosted.selector, t));
        hub.postPoints(ps);
    }

    /// t = 0 has no previous grid point: refused as off the grid, not with an arithmetic Panic (review S03-6).
    function test_pointAtTimeZeroIsOffGrid() public {
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](1);
        ps[0] = pt(0, PA, PB);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.OffGrid.selector, 0));
        hub.postPoints(ps);
    }

    function test_implausibleReturnRejectedBothDirections() public {
        uint256 t = (T_START / 300 + 10) * 300;
        vm.warp(t + 600);
        postOne(t, PA, PB);
        // next point: ln(1.7) = 0.53 > 0.5
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](1);
        ps[0] = pt(t + 300, PA * 17 / 10, PB);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.ImplausibleReturn.selector, t + 300));
        hub.postPoints(ps);
        // backfilling the previous point is checked against the later one too (OI-14)
        ps[0] = pt(t - 300, PA, PB * 6 / 10); // ln(1/0.6) = 0.51
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.ImplausibleReturn.selector, t - 300));
        hub.postPoints(ps);
        postOne(t + 300, PA * 16 / 10, PB); // ln(1.6) = 0.47 is fine
    }

    // ------------------------------------------------------------------ crank (M §6.2.1, PROP-09)

    function _postRange(uint8 id, uint256 fromK, uint256 toK) internal {
        uint256 t0 = obsStart(id);
        for (uint256 k = fromK; k <= toK; ++k) {
            postOne(t0 + k * 300, PA + k * 1e17, PB - k * 1e18);
        }
    }

    function test_crankStopsAtMissingPointThenGraceTreatsItInvalid() public {
        uint8 id = createMarket(defaultInput());
        _postRange(id, 0, 9);
        _postRange(id, 11, 20); // point 10 missing
        assertEq(hub.crank(id, 1000), 9); // bars 1..9
        vm.warp(hub.quoteState(id).obsEnd + 48 hours - 1);
        assertEq(hub.crank(id, 1000), 9); // still waiting for backfill
        vm.warp(hub.quoteState(id).obsEnd + 48 hours);
        uint32 processed = hub.crank(id, 5000);
        assertEq(processed, 2016); // everything else unposted -> invalid
        ICorrFiHub.Settlement memory s = hub.settlement(id);
        // valid bars: 1..9 and 12..20 (bars 10, 11 need point 10)
        assertEq(s.nValid, 18);
        assertEq(hub.quoteState(id).invalidBars, 2016 - 18);
    }

    function test_crankRespectsMaxBarsAndAnyoneCanCall() public {
        uint8 id = createMarket(defaultInput());
        _postRange(id, 0, 30);
        vm.prank(address(0xCAFE));
        assertEq(hub.crank(id, 7), 7);
        assertEq(hub.crank(id, 7), 14);
        // T-1 state: accumulated ahead of the confirmed price
        ICorrFiHub.Quote memory q = hub.quoteState(id);
        assertEq(q.processed, 14);
        assertEq(q.confirmed, 0);
    }

    /// Review S03-2: a third party that cranks between the reporter's backfill transactions cannot make the report
    /// fail, because postAndReport cranks every posted bar in its own transaction: its k does not depend on who
    /// cranked before. (submitReport after a partial crank can be front-run; the reporter bot never uses it.)
    function test_thirdPartyCrankDuringBackfillCannotBreakPostAndReport() public {
        uint8 id = createMarket(defaultInput());
        vm.warp(obsStart(id) + 40 * 300 + 10);
        vm.startPrank(REPORTER);
        hub.postPoints(_pointsBatch(id, 0, 20));
        hub.postPoints(_pointsBatch(id, 21, 40));
        vm.stopPrank();
        hub.crank(id, 10); // the reporter's partial crank
        // the engine signs k = 40 from the posted points
        uint256 snap = vm.snapshotState();
        hub.crank(id, type(uint32).max);
        CorrFiHub.ReportInput[] memory rs = new CorrFiHub.ReportInput[](1);
        rs[0] = honestReport(id, 40);
        vm.revertToState(snap);
        vm.prank(address(0xCAFE));
        hub.crank(id, 17); // a third party gets in first
        CorrFiHub.PointInput[] memory none = new CorrFiHub.PointInput[](0);
        vm.prank(REPORTER);
        hub.postAndReport(none, rs);
        assertEq(hub.quoteState(id).confirmed, 40);
        assertEq(hub.quoteState(id).processed, 40);
    }

    // ------------------------------------------------------------------ reports U-1..U-4 (M §4.2.1)

    function _pointsBatch(uint8 id, uint256 fromK, uint256 toK) internal view returns (CorrFiHub.PointInput[] memory ps) {
        uint256 t0 = obsStart(id);
        ps = new CorrFiHub.PointInput[](toK - fromK + 1);
        for (uint256 k = fromK; k <= toK; ++k) ps[k - fromK] = pt(t0 + k * 300, PA + k * 3e17, PB + k * 2e18);
    }

    function test_postAndReportAtomicAndUpdatesState() public {
        uint8 id = createMarket(defaultInput());
        uint256 t0 = obsStart(id);
        vm.warp(t0 + 12 * 300 + 10);
        CorrFiHub.PointInput[] memory first = _pointsBatch(id, 0, 0);
        vm.prank(REPORTER);
        hub.postPoints(first);
        CorrFiHub.PointInput[] memory ps = _pointsBatch(id, 1, 12);
        // build the honest report on a snapshot, then apply it in one transaction
        uint256 snap = vm.snapshotState();
        vm.prank(REPORTER);
        hub.postPoints(ps);
        hub.crank(id, 100);
        CorrFiHub.ReportInput memory r = honestReport(id, 12);
        vm.revertToState(snap);

        CorrFiHub.ReportInput[] memory rs = new CorrFiHub.ReportInput[](1);
        rs[0] = r;
        uint256 sig2Before = hub.quoteState(id).sig2;
        vm.prank(REPORTER);
        hub.postAndReport(ps, rs);
        ICorrFiHub.Quote memory q = hub.quoteState(id);
        assertEq(q.confirmed, 12);
        assertEq(q.processed, 12);
        assertEq(q.pFair, r.pFair);
        assertEq(q.h0, r.h0);
        uint256 lam = 997596132883620259;
        assertEq(q.sig2, CorrFiMath.sigmaBar2Update(sig2Before, int256(r.pFair) - int256(9e17), 12, lam));
    }

    function _copy(CorrFiHub.ReportInput memory a) internal pure returns (CorrFiHub.ReportInput memory) {
        return CorrFiHub.ReportInput(a.marketId, a.k, a.pFair, a.h0, a.signature);
    }

    function _violation(CorrFiHub.ReportInput memory r, bytes memory err) internal {
        uint8 id = r.marketId;
        CorrFiHub.PointInput[] memory ps = _pointsBatch(id, 1, 12);
        CorrFiHub.ReportInput[] memory rs = new CorrFiHub.ReportInput[](1);
        rs[0] = r;
        vm.prank(REPORTER);
        vm.expectRevert(err);
        hub.postAndReport(ps, rs);
        // atomic: neither the points nor the accumulation were kept
        assertFalse(hub.point(obsStart(id) + 300).posted);
        assertEq(hub.quoteState(id).processed, 0);
    }

    function test_reportViolationsRevertEverything() public {
        uint8 id = createMarket(defaultInput());
        uint256 t0 = obsStart(id);
        vm.warp(t0 + 12 * 300 + 10);
        CorrFiHub.PointInput[] memory first = _pointsBatch(id, 0, 0);
        vm.prank(REPORTER);
        hub.postPoints(first);
        uint256 snap = vm.snapshotState();
        CorrFiHub.PointInput[] memory batch = _pointsBatch(id, 1, 12);
        vm.prank(REPORTER);
        hub.postPoints(batch);
        hub.crank(id, 100);
        CorrFiHub.ReportInput memory good = honestReport(id, 12);
        vm.revertToState(snap);

        // U-1: wrong key
        CorrFiHub.ReportInput memory r = _copy(good);
        (uint8 v, bytes32 rr, bytes32 ss) = vm.sign(0xB0B, hub.reportDigest(id, 12, good.pFair, good.h0));
        r.signature = abi.encodePacked(rr, ss, v);
        _violation(r, abi.encodeWithSelector(CorrFiHub.BadSigner.selector, vm.addr(0xB0B)));
        // U-2: k does not match the accumulated bars
        r = _copy(good);
        r.k = 11;
        r.signature = sign(id, 11, good.pFair, good.h0);
        _violation(r, abi.encodeWithSelector(CorrFiHub.BarMismatch.selector, 11, 12, 0));
        // U-3: value differs from the on-chain recomputation by 1 wei
        r = _copy(good);
        r.pFair = good.pFair + 1;
        r.signature = sign(id, 12, r.pFair, good.h0);
        _violation(r, abi.encodeWithSelector(CorrFiHub.RecomputeMismatch.selector, good.pFair, good.h0));
        r = _copy(good);
        r.h0 = good.h0 - 1;
        r.signature = sign(id, 12, good.pFair, r.h0);
        _violation(r, abi.encodeWithSelector(CorrFiHub.RecomputeMismatch.selector, good.pFair, good.h0));
    }

    function test_replayAndRollbackRejected() public {
        uint8 id = createMarket(defaultInput());
        uint256 t0 = obsStart(id);
        vm.warp(t0 + 24 * 300 + 10);
        CorrFiHub.PointInput[] memory batch = _pointsBatch(id, 0, 12);
        vm.prank(REPORTER);
        hub.postPoints(batch);
        hub.crank(id, 100);
        CorrFiHub.ReportInput memory r12 = honestReport(id, 12);
        vm.prank(REPORTER);
        hub.submitReport(r12);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.BarMismatch.selector, 12, 12, 12));
        hub.submitReport(r12); // replay
        // a report for another market is bound to its id by the signature (U-1)
        uint8 id2 = createMarket(defaultInput());
        CorrFiHub.ReportInput memory x = r12;
        x.marketId = id2;
        vm.prank(REPORTER);
        vm.expectRevert();
        hub.submitReport(x);
    }

    function test_reportForPointZeroRejected() public {
        uint8 id = createMarket(defaultInput());
        CorrFiHub.PointInput[] memory first = _pointsBatch(id, 0, 0);
        vm.warp(obsStart(id) + 10);
        vm.prank(REPORTER);
        hub.postPoints(first);
        CorrFiHub.ReportInput memory r = CorrFiHub.ReportInput(id, 0, 9e17, 57e14, sign(id, 0, 9e17, 57e14));
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.BarMismatch.selector, 0, 0, 0));
        hub.submitReport(r);
    }

    // ------------------------------------------------------------------ maturity endpoint (OI-05, PROP-04)

    function test_finalReportOutOfRangeFallsBackToPostAndCrank() public {
        uint8 id = createMarket(defaultInput());
        uint256 t0 = obsStart(id);
        // identical returns for ETH and BTC -> rho_T = 1 -> P = 1 at k = N: U-4 must reject the final report
        uint256 pa = PA;
        uint256 pb = PB;
        vm.warp(t0 + 2016 * 300 + 10);
        vm.startPrank(REPORTER);
        for (uint256 k; k <= 2016; ++k) {
            uint256 f = k % 2 == 0 ? 1001 : 999;
            if (k > 0) {
                pa = pa * f / 1000;
                pb = pb * f / 1000;
            }
            CorrFiHub.PointInput[] memory one = new CorrFiHub.PointInput[](1);
            one[0] = pt(t0 + k * 300, pa, pb);
            hub.postPoints(one);
        }
        vm.stopPrank();
        // compute the final state on a snapshot to build the (out-of-range) final report
        uint256 snap = vm.snapshotState();
        hub.crank(id, 2016);
        CorrFiHub.Settlement memory s = hub.settlement(id);
        (,, int256 sAB, uint256 sA2, uint256 sB2,,,) = hub.marketParams(id);
        uint256 p = CorrFiMath.fairValue(s.c, s.va, s.vb, 2016, 2016, sAB, sA2, sB2);
        assertEq(p, WAD);
        vm.revertToState(snap);
        // crank + final report through the combined entry: U-4 rejects and the whole call is rolled back
        CorrFiHub.ReportInput[] memory rs = new CorrFiHub.ReportInput[](1);
        rs[0] = CorrFiHub.ReportInput(id, 2016, p, H_FLOOR, sign(id, 2016, p, H_FLOOR));
        CorrFiHub.PointInput[] memory none = new CorrFiHub.PointInput[](0);
        vm.prank(REPORTER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiHub.PriceOutOfRange.selector, WAD));
        hub.postAndReport(none, rs);
        assertEq(hub.quoteState(id).processed, 0); // the crank inside the reverted call was rolled back
        // fallback (PROP-04): crank without a report, then settle
        hub.crank(id, 2016);
        vaultOf(id).finalize();
        assertEq(vaultOf(id).longT(), WAD);
        assertFalse(vaultOf(id).isVoid());
    }

    function test_zeroVarianceFinalReportRevertsAndSettlesVoid() public {
        uint8 id = createMarket(defaultInput());
        uint256 t0 = obsStart(id);
        vm.warp(t0 + 2016 * 300 + 10);
        vm.startPrank(REPORTER);
        for (uint256 k; k <= 2016; ++k) {
            CorrFiHub.PointInput[] memory one = new CorrFiHub.PointInput[](1);
            one[0] = pt(t0 + k * 300, PA, PB); // constant prices: VA = VB = 0
            hub.postPoints(one);
        }
        vm.stopPrank();
        hub.crank(id, 2016);
        CorrFiHub.ReportInput memory fin = CorrFiHub.ReportInput(id, 2016, 1, 1, sign(id, 2016, 1, 1));
        vm.prank(REPORTER);
        vm.expectRevert(CorrFiMath.ZeroVariance.selector);
        hub.submitReport(fin);
        vaultOf(id).finalize();
        assertTrue(vaultOf(id).isVoid());
        assertEq(vaultOf(id).longT(), WAD / 2);
    }
}
