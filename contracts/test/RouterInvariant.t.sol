// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {CorrFiRouter} from "../src/CorrFiRouter.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice Random trades through the real router (quote first; a trade that quotes must swap identically).
contract RouterHandler is Test {
    CorrFiRouter public immutable r;
    CorrFiVault public immutable v;
    address public immutable usdc;
    address public immutable maker;
    address public immutable taker;
    uint256 public immutable riskBudget;
    ISwapVM.Order internal oL;
    ISwapVM.Order internal oS;
    uint256 public trades;
    uint256 public rejects;

    constructor(
        CorrFiRouter r_,
        CorrFiVault v_,
        address usdc_,
        address maker_,
        address taker_,
        uint256 riskBudget_,
        ISwapVM.Order memory l,
        ISwapVM.Order memory s
    ) {
        r = r_;
        v = v_;
        usdc = usdc_;
        maker = maker_;
        taker = taker_;
        riskBudget = riskBudget_;
        oL = l;
        oS = s;
    }

    function _traits(uint8 side, bool isBuy, bool exactIn, bool first) internal view returns (bytes memory) {
        address t = side == 0 ? address(v.longToken()) : address(v.shortToken());
        bool usdcIsA = usdc < t;
        TakerTraitsLib.Args memory a;
        a.taker = taker;
        a.isExactIn = exactIn;
        a.useTransferFromAndAquaPush = true;
        a.isAToB = isBuy ? usdcIsA : !usdcIsA;
        a.isFirstTransferFromTaker = first;
        return TakerTraitsLib.build(a);
    }

    function _q() internal view returns (int256) {
        return int256(v.depositLong(maker)) - int256(v.depositShort(maker));
    }

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }

    function trade(uint256 seed, uint256 raw) external {
        uint8 side = uint8(seed & 1);
        bool isBuy = (seed >> 1) & 1 == 1;
        bool exactIn = (seed >> 2) & 1 == 1;
        bool first = (seed >> 3) & 1 == 1;
        // up to about 4,000 tokens either way
        uint256 cap = exactIn ? (isBuy ? (side == 0 ? 3_600e6 : 400e6) : 4_000e6) : (isBuy ? 4_000e6 : (side == 0 ? 3_500e6 : 350e6));
        uint256 amount = bound(raw, 1, cap);
        ISwapVM.Order memory o = side == 0 ? oL : oS;
        bytes memory tt = _traits(side, isBuy, exactIn, first);
        int256 q0 = _q();
        try r.quote(o, amount, tt) returns (uint256 qi, uint256 qo, bytes32) {
            vm.prank(taker);
            (uint256 si, uint256 so,) = r.swap(o, amount, tt);
            assertEq(si, qi, "quote = swap (in)");
            assertEq(so, qo, "quote = swap (out)");
            ++trades;
            int256 q1 = _q();
            assertEq(_abs(q1 - q0), isBuy ? so : si, "|dq| = Q");
            if (_abs(q1) > _abs(q0)) {
                // S5: a risk-increasing fill leaves U_post < Umax (single market)
                // P_fair stays 0.90 (no reports are posted in these runs)
                assertLt(CorrFiMath.utilization(CorrFiMath.riskCapital(q1, 9e17), riskBudget), 9e17, "S5");
            }
        } catch {
            ++rejects;
        }
    }
}

contract RouterInvariantTest is RouterFixture {
    RouterHandler internal handler;

    function setUp() public override {
        super.setUp();
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.riskBudget = uint128(20_000 * U); // U reaches U0 and Umax within a run (RC = 0.9 q for q > 0)
        vm.prank(MAKER);
        router.setMakerConfig(c);
        usdc.mint(TAKER, 5_000_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(300_000 * U);
        vm.stopPrank();
        handler = new RouterHandler(router, vaultOf(mid), address(usdc), MAKER, TAKER, 20_000 * U, oL, oS);
        bytes4[] memory sel = new bytes4[](1);
        sel[0] = RouterHandler.trade.selector;
        targetSelector(StdInvariant.FuzzSelector(address(handler), sel));
        targetContract(address(handler));
    }

    /// A1, A2, A5 and an empty router after any sequence of trades (M §5.4, §6).
    /// forge-config: default.invariant.runs = 64
    /// forge-config: default.invariant.depth = 32
    function invariant_ledger() public view {
        CorrFiVault v = vaultOf(mid);
        assertEq(longOf(mid).totalSupply(), shortOf(mid).totalSupply(), "A1 supply");
        assertEq(longOf(mid).totalSupply(), v.collateral(), "A1 collateral");
        assertEq(usdc.balanceOf(address(v)), v.collateral(), "A1 USDC");
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertTrue(nl == 0 || ns == 0, "A2");
        assertEq(longOf(mid).balanceOf(address(v)), nl, "A5 Long");
        assertEq(shortOf(mid).balanceOf(address(v)), ns, "A5 Short");
        assertEq(allocation(oL, address(longOf(mid))), 0, "order Long");
        assertEq(allocation(oS, address(shortOf(mid))), 0, "order Short");
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(longOf(mid).balanceOf(address(router)), 0, "router Long");
        assertEq(shortOf(mid).balanceOf(address(router)), 0, "router Short");
    }

    function afterInvariant() public view {
        assertGt(handler.trades(), 0, "some trades went through");
    }
}

/// @notice M-F2 (closed loops leave the maker's cash >= 0 at a fixed P_fair) and M-F3 (no static arbitrage between
///         the book and the vault's 1 : 1 mint / burn).
contract RouterFuzzTest is RouterFixture {
    uint8 constant L = CorrFiPricing.SIDE_LONG;
    uint8 constant S = CorrFiPricing.SIDE_SHORT;

    function setUp() public override {
        super.setUp();
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.qMinTrade = 1; // lets the loop close exactly to q = 0
        vm.prank(MAKER);
        router.setMakerConfig(c);
        usdc.mint(TAKER, 5_000_000 * U);
        vm.startPrank(TAKER);
        usdc.approve(address(vaultOf(mid)), type(uint256).max);
        vaultOf(mid).mint(100_000 * U);
        vm.stopPrank();
    }

    function _try(uint8 side, bool isBuy, bool exactIn, uint256 amount) internal returns (bool ok, uint256 ai, uint256 ao) {
        ISwapVM.Order memory o = bookOf(side);
        bytes memory tt = takerTraits(TAKER, o, isBuy, exactIn, 0, false);
        try router.quote(o, amount, tt) returns (uint256, uint256, bytes32) {
            vm.prank(TAKER);
            (ai, ao,) = router.swap(o, amount, tt);
            ok = true;
        } catch {}
    }

    function _randomTrade(uint256 seed) internal {
        uint8 side = uint8(seed & 1);
        bool isBuy = (seed >> 1) & 1 == 1;
        bool exactIn = (seed >> 2) & 1 == 1;
        uint256 cap = exactIn ? (isBuy ? (side == L ? 3_600e6 : 400e6) : 4_000e6) : (isBuy ? 4_000e6 : (side == L ? 3_500e6 : 350e6));
        _try(side, isBuy, exactIn, bound(seed >> 8, 1, cap));
    }

    function _q() internal view returns (int256) {
        (uint256 nl, uint256 ns) = custody(MAKER);
        return int256(nl) - int256(ns);
    }

    /// M-F2 (DEC-09 as the worked example): any sequence closed back to q = 0 leaves the maker's cash >= 0.
    function testFuzz_closedLoopMakerCashNonNegative(uint256 seed) public {
        uint256 m0 = usdc.balanceOf(MAKER);
        for (uint256 i; i < 4; ++i) _randomTrade(uint256(keccak256(abi.encode(seed, i))));
        // close with buys only (their amounts round up, so even 1-unit remainders close)
        for (uint256 guard; guard < 30 && _q() != 0; ++guard) {
            int256 q = _q();
            uint256 step = uint256(q > 0 ? q : -q);
            if (step > 4_000e6) step = 4_000e6;
            (bool ok,,) = q > 0 ? _try(L, true, false, step) : _try(S, true, false, step);
            assertTrue(ok, "closing trade");
        }
        assertEq(_q(), 0);
        (uint256 nl, uint256 ns) = custody(MAKER);
        assertEq(nl + ns, 0);
        assertGe(usdc.balanceOf(MAKER), m0, "F2");
    }

    /// M-F3: buying Long and Short of the same size costs at least the mint price; selling both pays at most the
    /// burn value — at any inventory.
    function testFuzz_noStaticArbitrage(uint256 seed, uint256 rawQ) public {
        _randomTrade(seed);
        uint256 q = bound(rawQ, 1e6, 3_000e6);
        uint256 snapshot = vm.snapshotState();
        (bool ok1, uint256 pay1,) = _try(L, true, false, q);
        (bool ok2, uint256 pay2,) = _try(S, true, false, q);
        if (ok1 && ok2) assertGe(pay1 + pay2, q, "buy both >= mint");
        vm.revertToState(snapshot);
        (bool ok3,, uint256 r1) = _try(L, false, true, q);
        (bool ok4,, uint256 r2) = _try(S, false, true, q);
        if (ok3 && ok4) assertLe(r1 + r2, q, "sell both <= burn");
    }
}
