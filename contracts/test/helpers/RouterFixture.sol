// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import {CorrFiFixture} from "./CorrFiFixture.sol";
import {CorrFiHub} from "../../src/CorrFiHub.sol";
import {CorrFiRouter} from "../../src/CorrFiRouter.sol";
import {CorrFiLens} from "../../src/CorrFiLens.sol";
import {ICorrFiHub} from "../../src/interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "../../src/lib/CorrFiPricing.sol";

/// @notice Real Aqua (lib/aqua v1.0.0) + the CorrFi SwapVM router + lens on top of the hub fixture; one market with
///         a maker that has registered and shipped both books (M §5.1, §5.7).
abstract contract RouterFixture is CorrFiFixture {
    uint256 internal constant U = 1e6;
    address internal constant MAKER = address(0x3A3E);
    address internal constant TAKER = address(0x7A3E);
    address internal constant WETH = address(0xE7E7); // required by the SwapVM constructor, unused (M §8.2)
    uint256 internal constant ALLOCATION = 65_000 * U; // >= qmax,m + Qmax (M §5.7)
    uint32 internal constant GEN = 1;

    Aqua internal aqua;
    CorrFiRouter internal router;
    CorrFiLens internal lens;
    uint8 internal mid;
    ISwapVM.Order internal oL; // USDC / Long book
    ISwapVM.Order internal oS; // USDC / Short book

    function setUp() public virtual override {
        super.setUp();
        aqua = new Aqua();
        router = new CorrFiRouter(address(aqua), WETH, address(this), ICorrFiHub(address(hub)), protocolParams());
        hub.setRouter(address(router));
        lens = new CorrFiLens(router);
        mid = createMarket(appAInput());

        usdc.mint(MAKER, 200_000 * U);
        _approveMaker(MAKER, mid);
        vm.prank(MAKER);
        router.setMakerConfig(makerCfg());
        (oL, oS) = openBooks(MAKER, mid, GEN, ALLOCATION);

        usdc.mint(TAKER, 100_000 * U);
        _approveTaker(TAKER, mid);
    }

    // ------------------------------------------------------------------ parameters

    /// M §8.1: c_O = 2, g = 60 s, h_U,max = 0.02, U0 = 60%, Umax = 90%.
    function protocolParams() internal pure returns (CorrFiPricing.Params memory) {
        return CorrFiPricing.Params(2 * WAD, 60, 2e16, 6e17, 9e17);
    }

    /// Market whose initial report is P = 0.90, h0 = h_floor = 0.005 (c_h = 0.1 keeps c_h·σP(0) below the floor), so
    /// that M App. A is reproduced before obsStart (age 0 -> h_O = 0).
    function appAInput() internal pure returns (CorrFiHub.MarketInput memory p) {
        p = defaultInput();
        p.cH = 1e17;
    }

    /// M §8.1 maker values with the slope of M App. A given exactly: kq / qmax = 0.2 / 60,000 = 1 / 300,000.
    function makerCfg() internal pure returns (CorrFiPricing.MakerConfig memory) {
        return CorrFiPricing.MakerConfig({
            riskBudget: uint128(100_000 * U),
            qMaxMarket: uint128(60_000 * U),
            qGroup: uint128(100_000 * U),
            qMinTrade: uint128(1 * U),
            qMaxTrade: uint128(5_000 * U),
            kq: 2e17,
            hM: 0,
            active: true
        });
    }

    // ------------------------------------------------------------------ orders

    function sideToken(uint8 m, uint8 side) internal view returns (address) {
        return side == CorrFiPricing.SIDE_LONG ? address(longOf(m)) : address(shortOf(m));
    }

    function canonicalProgram(uint8 m, uint8 side, uint32 gen) internal view returns (bytes memory) {
        return abi.encodePacked(
            uint8(0x20), uint8(5), uint40(hub.quoteState(m).obsEnd), uint8(0xd0), uint8(6), m, side, gen,
            uint8(0xd1), uint8(0), uint8(0xd2), uint8(0)
        );
    }

    function orderArgs(address maker, uint8 m, uint8 side, uint32 gen)
        internal
        view
        returns (MakerTraitsLib.Args memory x)
    {
        address t = sideToken(m, side);
        (x.tokenA, x.tokenB) = address(usdc) < t ? (address(usdc), t) : (t, address(usdc));
        x.maker = maker;
        x.useAquaInsteadOfSignature = true;
        x.hasPreTransferOutHook = true;
        x.hasPostTransferInHook = true;
        x.preTransferOutTarget = address(router);
        x.postTransferInTarget = address(router);
        x.program = canonicalProgram(m, side, gen);
    }

    function buildOrder(address maker, uint8 m, uint8 side, uint32 gen) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(orderArgs(maker, m, side, gen));
    }

    function ship(address maker, ISwapVM.Order memory o, uint8 m, uint8 side, uint256 usdcAmount) internal {
        address[] memory tokens = new address[](2);
        uint256[] memory amounts = new uint256[](2);
        tokens[0] = address(usdc);
        tokens[1] = sideToken(m, side);
        amounts[0] = usdcAmount;
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(o), tokens, amounts);
    }

    function dock(address maker, ISwapVM.Order memory o, uint8 m, uint8 side) internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = sideToken(m, side);
        vm.prank(maker);
        aqua.dock(address(router), keccak256(abi.encode(o)), tokens);
    }

    /// Open a market as a maker (M §5.7): build, register and ship both books.
    function openBooks(address maker, uint8 m, uint32 gen, uint256 allocation)
        internal
        returns (ISwapVM.Order memory l, ISwapVM.Order memory s)
    {
        l = buildOrder(maker, m, CorrFiPricing.SIDE_LONG, gen);
        s = buildOrder(maker, m, CorrFiPricing.SIDE_SHORT, gen);
        vm.prank(maker);
        router.registerCorrPair(l, s);
        ship(maker, l, m, CorrFiPricing.SIDE_LONG, allocation);
        ship(maker, s, m, CorrFiPricing.SIDE_SHORT, allocation);
    }

    function _approveMaker(address maker, uint8 m) internal {
        vm.startPrank(maker);
        usdc.approve(address(aqua), type(uint256).max);
        longOf(m).approve(address(aqua), type(uint256).max); // pass-through only (M §5.1)
        shortOf(m).approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    function _approveTaker(address taker, uint8 m) internal {
        vm.startPrank(taker);
        usdc.approve(address(router), type(uint256).max);
        longOf(m).approve(address(router), type(uint256).max);
        shortOf(m).approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    function bookOf(uint8 side) internal view returns (ISwapVM.Order memory) {
        return side == CorrFiPricing.SIDE_LONG ? oL : oS;
    }

    // ------------------------------------------------------------------ taking

    function takerTraits(
        address taker,
        ISwapVM.Order memory o,
        bool isBuy,
        bool exactIn,
        uint256 limit,
        bool firstTransferFromTaker
    ) internal view returns (bytes memory) {
        address a = address(uint160(uint256(bytes32(_head(o.data)))));
        TakerTraitsLib.Args memory t;
        t.taker = taker;
        t.isExactIn = exactIn;
        t.useTransferFromAndAquaPush = true;
        t.isAToB = isBuy ? a == address(usdc) : a != address(usdc);
        t.isFirstTransferFromTaker = firstTransferFromTaker;
        if (limit != 0) t.threshold = abi.encodePacked(limit);
        return TakerTraitsLib.build(t);
    }

    function _head(bytes memory data) private pure returns (bytes32 w) {
        assembly ("memory-safe") {
            w := shr(96, mload(add(data, 32)))
        }
    }

    function quoteOf(ISwapVM.Order memory o, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) = router.quote(o, amount, takerTraits(TAKER, o, isBuy, exactIn, 0, false));
    }

    function swapAs(
        address taker,
        ISwapVM.Order memory o,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        bool firstTransferFromTaker
    ) internal returns (uint256 amountIn, uint256 amountOut) {
        bytes memory tt = takerTraits(taker, o, isBuy, exactIn, 0, firstTransferFromTaker);
        vm.prank(taker);
        (amountIn, amountOut,) = router.swap(o, amount, tt);
    }

    function tradeAs(address taker, uint8 side, bool isBuy, bool exactIn, uint256 amount)
        internal
        returns (uint256 amountIn, uint256 amountOut)
    {
        ISwapVM.Order memory o = bookOf(side);
        uint256 limit = exactIn ? 0 : type(uint256).max; // no slippage bound (the entry always applies `limit`)
        vm.prank(taker);
        return router.trade(o, mid, side, isBuy, exactIn, amount, limit, 0);
    }

    // ------------------------------------------------------------------ state helpers

    function custody(address maker) internal view returns (uint256 nl, uint256 ns) {
        nl = vaultOf(mid).depositLong(maker);
        ns = vaultOf(mid).depositShort(maker);
    }

    function allocation(ISwapVM.Order memory o, address token) internal view returns (uint256 bal) {
        (bal,) = aqua.rawBalances(o.maker, address(router), keccak256(abi.encode(o)), token);
    }

    /// Post points t0..tk (every point valid) and have bar k reported, at time t_k.
    function reportThrough(uint32 k) internal {
        uint256 s0 = obsStart(mid);
        uint32 from = hub.quoteState(mid).processed;
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](from == 0 ? k + 1 : k - from);
        uint256 j;
        for (uint256 i = from == 0 ? 0 : from + 1; i <= k; ++i) {
            ps[j++] = pt(s0 + i * 300, 2000e18 + (i % 7) * 3e18, 60_000e18 + (i % 5) * 40e18);
        }
        vm.warp(s0 + uint256(k) * 300);
        vm.prank(REPORTER);
        hub.postPoints(ps);
        hub.crank(mid, type(uint32).max);
        CorrFiHub.ReportInput memory r = honestReport(mid, k);
        vm.prank(REPORTER);
        hub.submitReport(r);
    }
}
