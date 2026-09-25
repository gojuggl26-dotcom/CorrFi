// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {SwapVM} from "@1inch/swap-vm/contracts/SwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiRouter} from "../src/CorrFiRouter.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiToken} from "../src/CorrFiToken.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";
import {CorrFiOrders} from "../src/lib/CorrFiOrders.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice Taker contract that re-enters the router from SwapVM's pre-transfer-out callback (M §5.4 lock).
contract ReentrantTaker {
    CorrFiRouter internal immutable router;
    ISwapVM.Order internal other;
    bytes internal otherTraits;
    uint256 internal otherAmount;
    bytes public innerRevert;

    constructor(CorrFiRouter r) {
        router = r;
    }

    function arm(ISwapVM.Order memory o, bytes memory tt, uint256 amount) external {
        other = o;
        otherTraits = tt;
        otherAmount = amount;
    }

    function approve(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok);
    }

    function go(ISwapVM.Order memory o, uint256 amount, bytes memory tt) external {
        router.swap(o, amount, tt);
    }

    function preTransferInCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
    {
        _inner();
    }

    function preTransferOutCallback(address, address, address, address, uint256, uint256, bytes32, bytes calldata)
        external
    {
        _inner();
    }

    function _inner() internal {
        try router.swap(other, otherAmount, otherTraits) {}
        catch (bytes memory err) {
            innerRevert = err;
            assembly ("memory-safe") {
                revert(add(err, 32), mload(err))
            }
        }
    }
}

/// @notice Taker contract that runs two swaps on the same maker x market in one transaction.
contract DoubleTaker {
    function run(CorrFiRouter r, ISwapVM.Order memory o, uint256 amount, bytes memory tt) external {
        r.swap(o, amount, tt);
        r.swap(o, amount, tt);
    }

    function approve(address token, address spender) external {
        (bool ok,) = token.call(abi.encodeWithSignature("approve(address,uint256)", spender, type(uint256).max));
        require(ok);
    }
}

contract RouterTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;

    function setUp() public override {
        super.setUp();
        // the taker also holds Long and Short to sell (direct mint at the vault, M §5.5)
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(20_000 * U);
        vm.stopPrank();
    }

    function _routerEmpty() internal view {
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(longOf(mid).balanceOf(address(router)), 0, "router Long");
        assertEq(shortOf(mid).balanceOf(address(router)), 0, "router Short");
    }

    /// A1 (vault) + A2 + A5 for the single maker.
    function _ledger() internal view {
        CorrFiVault v = vaultOf(mid);
        assertEq(longOf(mid).totalSupply(), shortOf(mid).totalSupply(), "A1 supply");
        assertEq(longOf(mid).totalSupply(), v.collateral(), "A1 collateral");
        assertEq(usdc.balanceOf(address(v)), v.collateral(), "A1 USDC");
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertTrue(nl == 0 || ns == 0, "A2");
        assertEq(longOf(mid).balanceOf(address(v)), nl, "A5 Long custody");
        assertEq(shortOf(mid).balanceOf(address(v)), ns, "A5 Short custody");
        assertEq(allocation(oL, address(longOf(mid))), 0, "A5 order Long");
        assertEq(allocation(oS, address(shortOf(mid))), 0, "A5 order Short");
        _routerEmpty();
    }

    // ------------------------------------------------------------------ M App. A through the router

    function test_appendixA_buyLongExactIn() public {
        uint256 m0 = usdc.balanceOf(MAKER);
        uint256 a0 = allocation(oL, address(usdc));
        uint256 l0 = longOf(mid).balanceOf(TAKER);
        (uint256 qi, uint256 qo) = quoteOf(oL, true, true, 1_000 * U);
        (uint256 ai, uint256 ao) = tradeAs(TAKER, L, true, true, 1_000 * U);
        assertEq(ao, 1_102_732_928, "M 5.8.1: 1,102.732928 Long");
        assertEq(ai, 1_000 * U);
        assertEq(qi, ai);
        assertEq(qo, ao);
        assertEq(longOf(mid).balanceOf(TAKER) - l0, ao);
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertEq(nl, 0);
        assertEq(ns, ao); // all minted: Q1 = 0, Q2 = Q, Short into custody
        assertEq(usdc.balanceOf(MAKER), m0 - ao + ai); // A3: TakerPay + MakerPay = minted
        assertEq(allocation(oL, address(usdc)), a0 - ao + ai);
        _ledger();
    }

    function test_appendixA_roundTrip45() public {
        uint256 m0 = usdc.balanceOf(MAKER);
        (uint256 pay,) = tradeAs(TAKER, L, true, false, 3_000 * U);
        assertEq(pay, 2_730 * U);
        (, uint256 recv) = tradeAs(TAKER, L, false, true, 3_000 * U);
        assertEq(recv, 2_685 * U);
        assertEq(usdc.balanceOf(MAKER) - m0, 45 * U, "DEC-09");
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertEq(nl + ns, 0);
        _ledger();
    }

    function test_appendixA_sellFromFlat() public {
        (, uint256 recv) = quoteOf(oL, false, true, 3_000 * U);
        assertEq(recv, 2_670 * U);
        (uint256 qty,) = quoteOf(oL, false, false, 1_000 * U);
        assertEq(qty, 1_119_652_929);
        (uint256 ai, uint256 ao) = tradeAs(TAKER, L, false, false, 1_000 * U);
        assertEq(ai, 1_119_652_929);
        assertEq(ao, 1_000 * U);
        (uint256 nl,) = custody(MAKER);
        assertEq(nl, ai); // Q1 = 0, all bought into Long custody
        _ledger();
    }

    // ------------------------------------------------------------------ 4 directions x inventory x exact x order

    struct Case {
        uint8 side;
        bool isBuy;
        bool exactIn;
        bool firstFromTaker;
        uint8 inv; // 0 flat, 1 maker holds Long custody, 2 maker holds Short custody
    }

    function test_fourDirectionsGrid() public {
        for (uint256 i; i < 48; ++i) {
            Case memory c = Case(uint8(i & 1), (i >> 1) & 1 == 1, (i >> 2) & 1 == 1, (i >> 3) & 1 == 1, uint8(i >> 4));
            _runCase(c);
        }
    }

    function _setInventory(uint8 inv) internal {
        // small custody so that the test trades (about 1,100 tokens) straddle it: Q1 > 0 and Q2 > 0
        if (inv == 1) tradeAs(TAKER, L, false, false, 500 * U); // taker sells Long -> Long custody
        if (inv == 2) tradeAs(TAKER, L, true, false, 700 * U); // taker buys Long -> Short custody
    }

    function _dir(uint8 side, bool isBuy) internal pure returns (uint8) {
        if (side == 0) return isBuy ? 1 : 2;
        return isBuy ? 3 : 4;
    }

    /// Wiring check: the curve built here from the chain state and the maker settings (h_O = 0 before obsStart).
    function _expected(uint8 dir, bool exactIn, uint256 amount) internal view returns (uint256, uint256) {
        ICorrFiHub.Quote memory s = hub.quoteState(mid);
        (uint256 nl, uint256 ns) = custody(MAKER);
        int256 q0 = int256(nl) - int256(ns);
        CorrFiPricing.MakerConfig memory cfg = makerCfg();
        uint256 hmin = s.h0 + cfg.hM;
        uint256 u = CorrFiMath.utilization(CorrFiMath.riskCapital(q0, s.pFair), cfg.riskBudget);
        uint256 h = hmin + CorrFiMath.hU(u, 2e16, 6e17, 9e17);
        CorrFiCurve.Curve memory c = CorrFiCurve.make(s.pFair, h, hmin, cfg.kq, cfg.qMaxMarket);
        if (dir == 1) return exactIn ? (amount, CorrFiCurve.qtyD1ExactIn(c, q0, amount)) : (CorrFiCurve.payD1(c, q0, amount), amount);
        if (dir == 2) return exactIn ? (amount, CorrFiCurve.receiveD2(c, q0, amount)) : (CorrFiCurve.qtyD2ExactOut(c, q0, amount), amount);
        if (dir == 3) return exactIn ? (amount, CorrFiCurve.qtyD3ExactIn(c, q0, amount)) : (CorrFiCurve.payD3(c, q0, amount), amount);
        return exactIn ? (amount, CorrFiCurve.receiveD4(c, q0, amount)) : (CorrFiCurve.qtyD4ExactOut(c, q0, amount), amount);
    }

    struct Snap {
        uint256 nl;
        uint256 ns;
        uint256 makerUsdc;
        uint256 alloc;
        uint256 takerUsdc;
        uint256 takerSide;
    }

    function _snap(ISwapVM.Order memory o, uint8 side) internal view returns (Snap memory x) {
        (x.nl, x.ns) = custody(MAKER);
        x.makerUsdc = usdc.balanceOf(MAKER);
        x.alloc = allocation(o, address(usdc));
        x.takerUsdc = usdc.balanceOf(TAKER);
        x.takerSide = side == L ? longOf(mid).balanceOf(TAKER) : shortOf(mid).balanceOf(TAKER);
    }

    function _runCase(Case memory c) internal {
        uint256 snapshot = vm.snapshotState();
        _setInventory(c.inv);
        ISwapVM.Order memory o = bookOf(c.side);
        uint8 dir = _dir(c.side, c.isBuy);
        // about 1,000-1,200 tokens either way (Short trades near 0.1 USDC, Long near 0.9)
        uint256 amount = c.exactIn
            ? (c.isBuy ? (c.side == L ? 1_000 * U : 120 * U) : 1_200 * U)
            : (c.isBuy ? 1_200 * U : (c.side == L ? 900 * U : 90 * U));

        (uint256 eIn, uint256 eOut) = _expected(dir, c.exactIn, amount);
        (uint256 qIn, uint256 qOut) = quoteOf(o, c.isBuy, c.exactIn, amount);
        CorrFiLens.Breakdown memory b = lens.breakdown(o, mid, c.side, c.isBuy, c.exactIn, amount, 2e15);
        Snap memory x0 = _snap(o, c.side);
        (uint256 sIn, uint256 sOut) = swapAs(TAKER, o, c.isBuy, c.exactIn, amount, c.firstFromTaker);
        Snap memory x1 = _snap(o, c.side);

        assertEq(b.reason, 0, "tradable");
        assertEq(sIn, eIn, "in = curve");
        assertEq(sOut, eOut, "out = curve");
        assertEq(qIn, sIn, "quote = swap (in)");
        assertEq(qOut, sOut, "quote = swap (out)");
        assertEq(b.amountIn, sIn, "breakdown = swap (in)");
        assertEq(b.amountOut, sOut, "breakdown = swap (out)");

        uint256 qty = c.isBuy ? sOut : sIn;
        // Q1 comes from the custody that is consumed: D1 / D4 Long, D2 / D3 Short (M §5.2.2)
        uint256 have = (dir == 1 || dir == 4) ? x0.nl : x0.ns;
        uint256 q1 = qty < have ? qty : have;
        uint256 q2 = qty - q1;
        assertEq(b.q1, q1, "breakdown Q1");
        assertEq(b.q2, q2, "breakdown Q2");
        if (dir == 1 || dir == 4) {
            assertEq(x1.nl, x0.nl - q1, "Long custody");
            assertEq(x1.ns, x0.ns + q2, "Short custody");
        } else {
            assertEq(x1.ns, x0.ns - q1, "Short custody");
            assertEq(x1.nl, x0.nl + q2, "Long custody");
        }
        if (c.isBuy) {
            // maker funds the mint (Q2) and receives Pay; taker pays and gets Q side tokens
            assertEq(x1.makerUsdc + q2, x0.makerUsdc + sIn, "maker USDC (buy)");
            assertEq(x1.alloc + q2, x0.alloc + sIn, "allocation (buy)");
            assertEq(x0.takerUsdc - x1.takerUsdc, sIn, "taker pays");
            assertEq(x1.takerSide - x0.takerSide, qty, "taker receives");
        } else {
            // maker pays Receive and gets Q1 back from the paired burn; taker gives Q side tokens
            assertEq(x1.makerUsdc + sOut, x0.makerUsdc + q1, "maker USDC (sell)");
            assertEq(x1.alloc + sOut, x0.alloc + q1, "allocation (sell)");
            assertEq(x1.takerUsdc - x0.takerUsdc, sOut, "taker receives");
            assertEq(x0.takerSide - x1.takerSide, qty, "taker gives");
        }
        _ledger();
        vm.revertToState(snapshot);
    }

    /// M-FR11: buying Short Q costs Q minus what selling Long Q pays (Short = 1 - Long), at any inventory.
    function test_mirrorShortIsOneMinusLong() public {
        for (uint8 inv; inv < 3; ++inv) {
            uint256 snapshot = vm.snapshotState();
            _setInventory(inv);
            (uint256 payShort,) = quoteOf(oS, true, false, 1_234 * U);
            (, uint256 recvLong) = quoteOf(oL, false, true, 1_234 * U);
            assertEq(payShort, 1_234 * U - recvLong);
            (, uint256 recvShort) = quoteOf(oS, false, true, 777 * U);
            (uint256 payLong,) = quoteOf(oL, true, false, 777 * U);
            assertEq(recvShort, 777 * U - payLong);
            vm.revertToState(snapshot);
        }
    }

    /// PROP-05 (h fixed): splitting a buy costs at most 1 unit more per extra trade, never less (Taker-unfavourable).
    function test_additivityWithFixedSpread() public {
        uint256 snapshot = vm.snapshotState();
        (uint256 whole,) = tradeAs(TAKER, L, true, false, 3_000 * U);
        vm.revertToState(snapshot);
        (uint256 a,) = tradeAs(TAKER, L, true, false, 1_000 * U);
        (uint256 b,) = tradeAs(TAKER, L, true, false, 2_000 * U);
        assertGe(a + b, whole);
        assertLe(a + b, whole + 1);
    }

    // ------------------------------------------------------------------ entry point (M §5.6)

    function test_entryEqualsSwapAndKeepsTaker() public {
        uint256 snapshot = vm.snapshotState();
        (uint256 ai, uint256 ao) = tradeAs(TAKER, S, true, true, 300 * U);
        uint256 usdcAfter = usdc.balanceOf(TAKER);
        uint256 shortAfter = shortOf(mid).balanceOf(TAKER);
        vm.revertToState(snapshot);
        vm.expectEmit(address(router));
        emit SwapVM.Swapped(
            keccak256(abi.encode(oS)), MAKER, TAKER, address(usdc), address(shortOf(mid)), ai, ao
        );
        (uint256 si, uint256 so) = swapAs(TAKER, oS, true, true, 300 * U, false);
        assertEq(si, ai);
        assertEq(so, ao);
        assertEq(usdc.balanceOf(TAKER), usdcAfter);
        assertEq(shortOf(mid).balanceOf(TAKER), shortAfter);
        _ledger();
    }

    function test_entryTakerIsCaller() public {
        (uint256 qi, uint256 qo) = quoteOf(oL, false, true, 500 * U);
        vm.expectEmit(address(router));
        emit SwapVM.Swapped(keccak256(abi.encode(oL)), MAKER, TAKER, address(longOf(mid)), address(usdc), qi, qo);
        tradeAs(TAKER, L, false, true, 500 * U);
        _routerEmpty();
    }

    function test_entryRejectsMismatch() public {
        ISwapVM.Order memory o = oL;
        vm.prank(TAKER);
        vm.expectRevert(CorrFiOrders.EntryMismatch.selector);
        router.trade(o, mid, S, true, true, 100 * U, 0, 0); // Long book given as Short
        vm.prank(TAKER);
        vm.expectRevert(CorrFiOrders.EntryMismatch.selector);
        router.trade(o, mid + 1, L, true, true, 100 * U, 0, 0);
        ISwapVM.Order memory unregistered = buildOrder(MAKER, mid, L, GEN + 7);
        vm.prank(TAKER);
        vm.expectRevert(CorrFiOrders.EntryMismatch.selector);
        router.trade(unregistered, mid, L, true, true, 100 * U, 0, 0);
    }

    function test_entryLimitAndDeadline() public {
        (, uint256 out) = quoteOf(oL, true, true, 1_000 * U);
        ISwapVM.Order memory o = oL;
        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(TakerTraitsLib.TakerTraitsInsufficientMinOutputAmount.selector, out, out + 1));
        router.trade(o, mid, L, true, true, 1_000 * U, out + 1, 0);
        vm.prank(TAKER);
        vm.expectRevert(TakerTraitsLib.TakerTraitsDeadlineExpired.selector);
        router.trade(o, mid, L, true, true, 1_000 * U, out, uint40(block.timestamp - 1));
        vm.prank(TAKER);
        (, uint256 got) = router.trade(o, mid, L, true, true, 1_000 * U, out, uint40(block.timestamp));
        assertEq(got, out);
    }

    // ------------------------------------------------------------------ hooks and the lock (M §5.3, §5.4)

    function test_hooksOnlySelf() public {
        address lng = address(longOf(mid));
        vm.expectRevert(CorrFiRouter.OnlySelf.selector);
        router.preTransferOut(MAKER, TAKER, address(usdc), lng, 1, 1, bytes32(0), "", "");
        vm.expectRevert(CorrFiRouter.OnlySelf.selector);
        router.postTransferIn(MAKER, TAKER, address(usdc), lng, 1, 1, 0, bytes32(0), "", "");
    }

    function test_lockBlocksReentryOnSameMakerMarket() public {
        ReentrantTaker rt = new ReentrantTaker(router);
        usdc.mint(address(rt), 10_000 * U);
        rt.approve(address(usdc), address(router));
        // outer: buy Long on the Long book; inner (from the pre-transfer-out callback): buy Short on the Short book
        TakerTraitsLib.Args memory inner;
        inner.taker = address(rt);
        inner.isExactIn = true;
        inner.useTransferFromAndAquaPush = true;
        inner.isAToB = _usdcIsA(S);
        rt.arm(oS, TakerTraitsLib.build(inner), 100 * U);
        TakerTraitsLib.Args memory outer;
        outer.taker = address(rt);
        outer.isExactIn = true;
        outer.useTransferFromAndAquaPush = true;
        outer.isAToB = _usdcIsA(L);
        outer.hasPreTransferOutCallback = true;
        bytes memory tt = TakerTraitsLib.build(outer);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.LOCKED));
        rt.go(oL, 100 * U, tt);
    }

    /// Review 2026-09-26 (DEC-15): the taker's pre-transfer-in callback runs after CorrGuard and before the
    /// settlement hooks, so a nested trade on ANOTHER market of the same maker would be checked against stale
    /// inventory (GROUP_CAP / UTILIZATION_CAP). The lock is per maker, so it is rejected.
    function test_lockBlocksNestedTradeOnAnotherMarketOfTheSameMaker() public {
        uint8 m2 = createMarket(appAInput());
        _approveMaker(MAKER, m2);
        (ISwapVM.Order memory l2,) = openBooks(MAKER, m2, 1, ALLOCATION);
        ReentrantTaker rt = new ReentrantTaker(router);
        usdc.mint(address(rt), 10_000 * U);
        rt.approve(address(usdc), address(router));
        TakerTraitsLib.Args memory inner;
        inner.taker = address(rt);
        inner.isExactIn = true;
        inner.useTransferFromAndAquaPush = true;
        inner.isAToB = address(usdc) < sideToken(m2, L);
        rt.arm(l2, TakerTraitsLib.build(inner), 100 * U);
        TakerTraitsLib.Args memory outer;
        outer.taker = address(rt);
        outer.isExactIn = true;
        outer.useTransferFromAndAquaPush = true;
        outer.isFirstTransferFromTaker = true;
        outer.isAToB = _usdcIsA(L);
        outer.hasPreTransferInCallback = true;
        bytes memory tt = TakerTraitsLib.build(outer);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.LOCKED));
        rt.go(oL, 100 * U, tt);
        // sequential trades on both markets are unaffected
        tradeAs(TAKER, L, true, true, 100 * U);
        vm.prank(TAKER);
        router.trade(l2, m2, L, true, true, 100 * U, 0, 0);
    }

    function test_lockReleasedAfterEachSwap() public {
        DoubleTaker d = new DoubleTaker();
        usdc.mint(address(d), 10_000 * U);
        d.approve(address(usdc), address(router));
        bytes memory tt = takerTraits(address(d), oL, true, true, 0, false);
        d.run(router, oL, 100 * U, tt);
        assertGt(longOf(mid).balanceOf(address(d)), 0);
        _ledger();
    }

    function _usdcIsA(uint8 side) internal view returns (bool) {
        return address(usdc) < sideToken(mid, side);
    }

    // ------------------------------------------------------------------ review 2026-09-26: quote = swap cases

    /// The maker's Long / Short approval to Aqua is needed for the pass-through; without it quote used to say
    /// tradable and swap reverted in the ERC-20. Now CorrGuard answers WALLET_SHORT (and so does the breakdown).
    function test_sideTokenApprovalIsCheckedByTheGuard() public {
        CorrFiToken lng = longOf(mid); // resolve first: the lookup's calls would consume the prank
        vm.prank(MAKER);
        lng.approve(address(aqua), 100 * U);
        bytes memory tt = takerTraits(TAKER, oL, true, false, 0, false);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.WALLET_SHORT));
        router.quote(oL, 101 * U, tt); // buy 101 Long: the pull to the taker needs 101
        assertEq(lens.breakdown(oL, mid, L, true, false, 101 * U, 2e15).reason, CorrFiPricing.WALLET_SHORT);
        quoteOf(oL, true, false, 100 * U);
        tradeAs(TAKER, L, true, false, 100 * U);
        assertEq(lng.allowance(MAKER, address(aqua)), 0);
        assertGt(lng.balanceOf(TAKER), 0);
    }

    /// A buy with the taker pushing to Aqua and transfer-out first cannot settle (the mint pulls USDC from the order
    /// before the taker's USDC is counted): quote and swap both answer UNSUPPORTED_TRANSFER. Sells, and buys with
    /// transfer-in first, are unaffected.
    function test_pushModeBuyWithTransferOutFirstIsRejected() public {
        TakerTraitsLib.Args memory a;
        a.taker = TAKER;
        a.isExactIn = true;
        a.isAToB = _usdcIsA(L);
        bytes memory tt = TakerTraitsLib.build(a); // push mode, transfer-out first, buy
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.UNSUPPORTED_TRANSFER));
        router.quote(oL, 100 * U, tt);
        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.UNSUPPORTED_TRANSFER));
        router.swap(oL, 100 * U, tt);
        a.isFirstTransferFromTaker = true;
        router.quote(oL, 100 * U, TakerTraitsLib.build(a));
        a.isFirstTransferFromTaker = false;
        a.isAToB = !_usdcIsA(L); // a sell in push mode
        router.quote(oL, 100 * U, TakerTraitsLib.build(a));
    }

    // ------------------------------------------------------------------ registration (M §5.1)

    function test_registrationRecordsPair() public view {
        CorrFiEngine.OrderInfo memory i = router.orderInfo(keccak256(abi.encode(oL)));
        assertTrue(i.registered);
        assertEq(i.maker, MAKER);
        assertEq(i.marketId, mid);
        assertEq(i.side, L);
        assertEq(i.generation, GEN);
        // the other book of the pair is registered with it (registration is only ever pairwise)
        CorrFiEngine.OrderInfo memory j = router.orderInfo(keccak256(abi.encode(oS)));
        assertTrue(j.registered);
        assertEq(j.side, S);
        assertEq(j.marketId, mid);
        assertEq(j.generation, GEN);
        assertEq(router.hash(oL), keccak256(abi.encode(oL)));
    }

    function _register(MakerTraitsLib.Args memory l, MakerTraitsLib.Args memory s) internal {
        ISwapVM.Order memory lo = MakerTraitsLib.build(l);
        ISwapVM.Order memory so = MakerTraitsLib.build(s);
        vm.prank(l.maker);
        router.registerCorrPair(lo, so);
    }

    function _expectBad(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(CorrFiOrders.BadOrder.selector, code));
    }

    function test_registrationRejectsNonCanonical() public {
        address mk = address(0x3A3F);
        MakerTraitsLib.Args memory l = orderArgs(mk, mid, L, 9);
        MakerTraitsLib.Args memory s = orderArgs(mk, mid, S, 9);

        // 1: the two orders disagree on market / generation
        MakerTraitsLib.Args memory s2 = orderArgs(mk, mid, S, 10);
        _expectBad(1);
        _register(l, s2);

        // 2: registered by someone else
        MakerTraitsLib.Args memory other = orderArgs(address(0xBAD), mid, L, 9);
        _expectBad(2);
        _register(other, s); // pranks as 0xBAD, whose Long order is fine but the Short order is mk's

        // 3: flags (signature mode / extra hook / unwrap / zero-amount / permit2)
        MakerTraitsLib.Args memory f = orderArgs(mk, mid, L, 9);
        f.useAquaInsteadOfSignature = false;
        _expectBad(3);
        _register(f, s);
        f = orderArgs(mk, mid, L, 9);
        f.allowZeroAmountIn = true;
        _expectBad(3);
        _register(f, s);
        f = orderArgs(mk, mid, L, 9);
        f.hasPostTransferOutHook = true;
        _expectBad(3);
        _register(f, s);
        f = orderArgs(mk, mid, L, 9);
        f.shouldUnwrapWeth = true;
        _expectBad(3);
        _register(f, s);

        // 4: receiver is not the maker
        f = orderArgs(mk, mid, L, 9);
        f.receiver = address(0xCAFE);
        _expectBad(4);
        _register(f, s);

        // 5: hook target / data
        f = orderArgs(mk, mid, L, 9);
        f.postTransferInData = hex"01";
        _expectBad(5);
        _register(f, s);

        // 6-8: program
        f = orderArgs(mk, mid, L, 9);
        f.program = bytes.concat(f.program, hex"00");
        _expectBad(6);
        _register(f, s);
        f = orderArgs(mk, mid, L, 9);
        f.program = canonicalProgram(mid, S, 9); // Short program in the Long slot
        _expectBad(7);
        _register(f, s);
        f = orderArgs(mk, mid, L, 9);
        f.program = abi.encodePacked(
            uint8(0x20), uint8(5), uint40(hub.quoteState(mid).obsEnd + 1), uint8(0xd0), uint8(6), mid, L, uint32(9),
            uint8(0xd1), uint8(0), uint8(0xd2), uint8(0)
        );
        _expectBad(8);
        _register(f, s);

        // 9: token pair
        f = orderArgs(mk, mid, L, 9);
        (f.tokenA, f.tokenB) = address(usdc) < address(shortOf(mid))
            ? (address(usdc), address(shortOf(mid)))
            : (address(shortOf(mid)), address(usdc));
        _expectBad(9);
        _register(f, s);

        // unknown market
        f = orderArgs(mk, mid, L, 9);
        f.program = abi.encodePacked(
            uint8(0x20), uint8(5), uint40(1), uint8(0xd0), uint8(6), uint8(9), L, uint32(9), uint8(0xd1), uint8(0),
            uint8(0xd2), uint8(0)
        );
        vm.expectRevert();
        _register(f, s);

        // the canonical pair registers once
        _register(l, s);
        vm.expectRevert(abi.encodeWithSelector(CorrFiOrders.AlreadyRegistered.selector, keccak256(abi.encode(MakerTraitsLib.build(l)))));
        _register(l, s);
    }

    function test_unregisteredOrderCannotTrade() public {
        address mk = address(0x3A3F);
        ISwapVM.Order memory o = buildOrder(mk, mid, L, 9);
        ship(mk, o, mid, L, 0);
        bytes memory tt = takerTraits(TAKER, o, true, true, 0, false);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.NOT_REGISTERED));
        router.quote(o, 100 * U, tt);
    }

    // ------------------------------------------------------------------ maker settings (M §5.4)

    function test_makerConfigValidation() public {
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.kq = 0;
        vm.expectRevert(CorrFiOrders.BadConfig.selector);
        router.setMakerConfig(c);
        c = makerCfg();
        c.qMaxTrade = c.qMinTrade - 1;
        vm.expectRevert(CorrFiOrders.BadConfig.selector);
        router.setMakerConfig(c);
        c = makerCfg();
        c.qGroup = c.qMaxMarket - 1;
        vm.expectRevert(CorrFiOrders.BadConfig.selector);
        router.setMakerConfig(c);
        c = makerCfg();
        c.riskBudget = 0;
        vm.expectRevert(CorrFiOrders.BadConfig.selector);
        router.setMakerConfig(c);
        c = makerCfg();
        c.qGroup = uint128(1e18 + 1); // caps beyond 10^12 tokens would overflow the curve's integers
        vm.expectRevert(CorrFiOrders.BadConfig.selector);
        router.setMakerConfig(c);
    }

    function test_pausedMakerCannotTrade() public {
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.active = false;
        vm.prank(MAKER);
        router.setMakerConfig(c);
        bytes memory tt = takerTraits(TAKER, oL, true, true, 0, false);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.MAKER_INACTIVE));
        router.quote(oL, 100 * U, tt);
        c.active = true;
        vm.prank(MAKER);
        router.setMakerConfig(c);
        quoteOf(oL, true, true, 100 * U);
    }

    // ------------------------------------------------------------------ maker lifecycle (M §5.7)

    function test_dockOneBookOtherKeepsTrading() public {
        tradeAs(TAKER, L, true, true, 1_000 * U); // Short custody
        dock(MAKER, oS, mid, S);
        bytes memory tt = takerTraits(TAKER, oS, true, true, 0, false);
        vm.expectRevert(); // Aqua: the Short book is no longer an active strategy
        router.quote(oS, 100 * U, tt);
        tradeAs(TAKER, L, true, true, 500 * U); // the Long book is independent
        tradeAs(TAKER, L, false, true, 300 * U);
        _ledger();
    }

    function test_resumeWithNewGenerationKeepsCustody() public {
        tradeAs(TAKER, L, true, true, 1_000 * U);
        (uint256 nl0, uint256 ns0) = custody(MAKER);
        dock(MAKER, oL, mid, L);
        dock(MAKER, oS, mid, S);
        (ISwapVM.Order memory l2, ISwapVM.Order memory s2) = openBooks(MAKER, mid, GEN + 1, ALLOCATION);
        (uint256 nl1, uint256 ns1) = custody(MAKER);
        assertEq(nl1, nl0);
        assertEq(ns1, ns0);
        // selling Long back on the new book pairs with the existing Short custody
        vm.prank(TAKER);
        (uint256 qty,) = router.trade(l2, mid, L, false, false, 500 * U, type(uint256).max, 0);
        (, uint256 ns2) = custody(MAKER);
        assertEq(ns2, ns0 - qty);
        assertTrue(router.orderInfo(keccak256(abi.encode(s2))).registered);
        assertEq(router.orderInfo(keccak256(abi.encode(s2))).generation, GEN + 1);
    }

    function test_pushRestoresAllocation() public {
        // a thin allocation: buys need Q2 from the order's USDC
        address mk = address(0x3A40);
        usdc.mint(mk, 200_000 * U);
        _approveMaker(mk, mid);
        vm.prank(mk);
        router.setMakerConfig(makerCfg());
        (ISwapVM.Order memory l,) = openBooks(mk, mid, 1, 500 * U);
        vm.prank(TAKER);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.ALLOCATION_SHORT));
        router.trade(l, mid, L, true, true, 1_000 * U, 0, 0);
        // top up by push without docking (M §5.7)
        vm.prank(mk);
        aqua.push(mk, address(router), keccak256(abi.encode(l)), address(usdc), 5_000 * U);
        vm.prank(TAKER);
        router.trade(l, mid, L, true, true, 1_000 * U, 0, 0);
    }

    function test_grossFundsDistinguishWallet() public {
        // wallet balance too small
        uint256 bal = usdc.balanceOf(MAKER);
        vm.prank(MAKER);
        usdc.transfer(address(0xD00D), bal - 100 * U);
        bytes memory tt = takerTraits(TAKER, oL, true, true, 0, false);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.WALLET_SHORT));
        router.quote(oL, 1_000 * U, tt);
        vm.prank(address(0xD00D));
        usdc.transfer(MAKER, bal - 100 * U);
        // Aqua approval too small
        vm.prank(MAKER);
        usdc.approve(address(aqua), 100 * U);
        vm.expectRevert(abi.encodeWithSelector(CorrFiEngine.CorrReject.selector, CorrFiPricing.WALLET_SHORT));
        router.quote(oL, 1_000 * U, tt);
        vm.prank(MAKER);
        usdc.approve(address(aqua), type(uint256).max);
        quoteOf(oL, true, true, 1_000 * U);
    }
}
