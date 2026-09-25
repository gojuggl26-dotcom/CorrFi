// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import {Deadline} from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import {RouterFixture} from "./helpers/RouterFixture.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";
import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiRouter} from "../src/CorrFiRouter.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiToken} from "../src/CorrFiToken.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {CorrFiEngine} from "../src/lib/CorrFiEngine.sol";
import {CorrFiCurve} from "../src/lib/CorrFiCurve.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";

/// @notice Everything a market goes through, on three markets of one maker at once (M §7.1, §8.4): trades in all
///         four directions and both transfer orders, reporter bars and reports (with skipped reports and invalid
///         prices), idle time (T-1 / T-2 stops), direct mint / burn, then settlement by one of the three routes
///         (all bars, > 1 % invalid bars, reporter stopped -> obsEnd + 48 h) and redemption, custody claims and
///         the dust sweep. Per trade it checks quote = breakdown = swap, F1 on the executed amounts, A2, A3, S5
///         (DEC-22) and the caps (DEC-23), and "the virtual balance after the hook >= the output" (M §8.4) from the
///         storage writes of the trade.
contract SystemHandler is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant U = 1e6;
    uint256 internal constant MIN_CALLS_BEFORE_SETTLEMENT = 30;
    address internal constant REPORTER = address(0xBEEF);
    address internal constant MAKER = address(0x3A3E);
    address internal constant TAKER = address(0x7A3E);
    address internal constant A1 = address(0xA1);
    address internal constant A2 = address(0xA2);

    SystemInvariantTest internal immutable suite;
    CorrFiHub internal immutable hub;
    CorrFiRouter internal immutable router;
    CorrFiLens internal immutable lens;
    Aqua internal immutable aqua;
    MockUSDC internal immutable usdc;

    uint8[3] public mk;
    ISwapVM.Order[3] internal oL;
    ISwapVM.Order[3] internal oS;

    // reporter state
    uint256 public nextT;
    uint256 internal pA = 2000e18;
    uint256 internal pB = 60_000e18;

    // ghosts
    uint256 public calls;
    bool public settled;
    uint256 public mode; // 0 all bars, 1 > 1 % invalid, 2 reporter stopped
    uint256 public trades;
    uint256 public rejects;
    uint256 public riskIncreasing;
    uint256[19] public reasons;
    uint256[3] public paid;
    uint256[3] public heldAtSettlement;

    constructor(SystemInvariantTest s, uint8[3] memory m, ISwapVM.Order[3] memory l, ISwapVM.Order[3] memory sh) {
        suite = s;
        hub = s.hub_();
        router = s.router_();
        lens = s.lens_();
        aqua = s.aqua_();
        usdc = s.usdc_();
        mk = m;
        for (uint256 i; i < 3; ++i) {
            oL[i] = l[i];
            oS[i] = sh[i];
        }
        nextT = hub.quoteState(m[0]).obsStart;
    }

    // ------------------------------------------------------------------ helpers

    function vaultOf(uint256 i) public view returns (CorrFiVault) {
        return CorrFiVault(hub.marketVault(mk[i]));
    }

    function holders() public pure returns (address[5] memory) {
        return [TAKER, A1, A2, MAKER, TREASURY_];
    }

    address internal constant TREASURY_ = address(0x7EA5);

    function _abs(int256 x) internal pure returns (uint256) {
        return uint256(x >= 0 ? x : -x);
    }

    function _q(uint256 i) internal view returns (int256) {
        CorrFiVault v = vaultOf(i);
        return int256(v.depositLong(MAKER)) - int256(v.depositShort(MAKER));
    }

    function _traits(uint256 i, uint8 side, bool isBuy, bool exactIn, bool first) internal view returns (bytes memory) {
        CorrFiVault v = vaultOf(i);
        address t = side == 0 ? address(v.longToken()) : address(v.shortToken());
        bool usdcIsA = address(usdc) < t;
        TakerTraitsLib.Args memory a;
        a.taker = TAKER;
        a.isExactIn = exactIn;
        a.useTransferFromAndAquaPush = true;
        a.isAToB = isBuy ? usdcIsA : !usdcIsA;
        a.isFirstTransferFromTaker = first;
        return TakerTraitsLib.build(a);
    }

    /// Aqua keeps one mapping `_balances[maker][app][strategyHash][token]` at slot 0 (lib/aqua v1.0.0).
    function aquaSlot(address maker, bytes32 h, address token) public view returns (bytes32 s) {
        s = keccak256(abi.encode(maker, uint256(0)));
        s = keccak256(abi.encode(address(router), s));
        s = keccak256(abi.encode(h, s));
        s = keccak256(abi.encode(token, s));
    }

    // ------------------------------------------------------------------ reporter

    function _nextPoint(uint256 r, bool invalid) internal returns (CorrFiHub.PointInput memory p) {
        int256 ra = int256(r % 4e15) - 2e15; // ±0.2 % per bar
        int256 nb = int256((r >> 64) % 4e15) - 2e15;
        int256 rb = (8 * ra + 6 * nb) / 10; // correlated legs
        pA = uint256(int256(pA) * (1e18 + ra) / 1e18);
        pB = uint256(int256(pB) * (1e18 + rb) / 1e18);
        p = CorrFiHub.PointInput(uint64(nextT), uint128(invalid ? 0 : pA), uint128(pB), !invalid, true);
        nextT += 300;
    }

    function _post(CorrFiHub.PointInput[] memory ps) internal {
        uint256 last = ps[ps.length - 1].t;
        if (block.timestamp < last + 10) vm.warp(last + 10);
        vm.prank(REPORTER);
        hub.postPoints(ps);
    }

    /// Post 1-6 bars, crank and report each market (sometimes skipping a market: T-1 until the next report).
    function advance(uint256 seed) external {
        ++calls;
        if (settled) return;
        uint256 n = 1 + seed % 6;
        CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](n);
        for (uint256 j; j < n; ++j) {
            uint256 r = uint256(keccak256(abi.encode(seed, j)));
            ps[j] = _nextPoint(r, r % 30 == 0); // some invalid bars (T-4 after more than (N - N_min) / 2)
        }
        _post(ps);
        for (uint256 i; i < 3; ++i) {
            uint256 skip = (seed >> (16 + 3 * i)) & 7;
            if (skip == 0) continue; // the reporter skips this market this time (T-2 later)
            hub.crank(mk[i], type(uint32).max);
            if (skip == 1) continue; // accumulated by someone else without a report (T-1)
            ICorrFiHub.Quote memory s = hub.quoteState(mk[i]);
            if (s.processed == s.confirmed) continue;
            CorrFiHub.ReportInput memory rep = suite.report(mk[i], s.processed);
            vm.prank(REPORTER);
            hub.submitReport(rep);
        }
    }

    /// Time passes without the reporter (T-2 after Δ + g).
    function idle(uint256 secs) external {
        ++calls;
        if (settled) return;
        vm.warp(block.timestamp + bound(secs, 1, 400));
    }

    // ------------------------------------------------------------------ vault direct operations

    function mintBurn(uint256 seed, uint256 amount) external {
        ++calls;
        if (settled) return;
        address a = [TAKER, A1, A2][seed % 3];
        CorrFiVault v = vaultOf((seed >> 8) % 3);
        if ((seed >> 16) & 1 == 0) {
            if (block.timestamp >= v.obsEnd()) return;
            vm.prank(a);
            v.mint(bound(amount, 1, 5_000 * U));
        } else {
            uint256 l = v.longToken().balanceOf(a);
            uint256 s = v.shortToken().balanceOf(a);
            uint256 max = l < s ? l : s;
            if (max == 0) return;
            vm.prank(a);
            v.burn(bound(amount, 1, max));
        }
    }

    // ------------------------------------------------------------------ trading

    struct Pre {
        int256 q0;
        uint256 usdcVault;
        uint256 usdcTaker;
        uint256 usdcMaker;
        uint256 supply;
        uint256 alloc; // the order's tokenOut balance in Aqua before the trade
    }

    function trade(uint256 seed, uint256 raw) external {
        ++calls;
        if (settled) return;
        uint256 i = seed % 3;
        uint8 side = uint8((seed >> 8) & 1);
        bool isBuy = (seed >> 9) & 1 == 1;
        bool exactIn = (seed >> 10) & 1 == 1;
        bool first = (seed >> 11) & 1 == 1;
        ISwapVM.Order memory o = side == 0 ? oL[i] : oS[i];
        uint256 amount = bound(raw, 1, 4_200 * U);
        bytes memory tt = _traits(i, side, isBuy, exactIn, first);

        CorrFiLens.Breakdown memory b = lens.breakdownOrder(o, isBuy, exactIn, amount, 0);
        uint256 qi;
        uint256 qo;
        try router.quote(o, amount, tt) returns (uint256 a, uint256 c, bytes32) {
            (qi, qo) = (a, c);
        } catch (bytes memory err) {
            _checkReject(err, b.reason);
            ++rejects;
            return;
        }
        // the taker must hold what it sells (the quote does not look at the taker's wallet)
        if (!isBuy) {
            CorrFiVault v = vaultOf(i);
            address tin = side == 0 ? address(v.longToken()) : address(v.shortToken());
            if (CorrFiToken(tin).balanceOf(TAKER) < qi) return;
        }
        // 論点 36: the breakdown equals the quote
        assertEq(b.reason, CorrFiPricing.OK, "breakdown tradable");
        assertEq(b.amountIn, qi, "breakdown in");
        assertEq(b.amountOut, qo, "breakdown out");

        Pre memory pre = _pre(i, side, isBuy, o);
        vm.recordLogs();
        vm.startStateDiffRecording();
        vm.prank(TAKER);
        (uint256 si, uint256 so,) = router.swap(o, amount, tt);
        Vm.AccountAccess[] memory acc = vm.stopAndReturnStateDiff();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(si, qi, "quote = swap (in)");
        assertEq(so, qo, "quote = swap (out)");
        ++trades;
        _afterTrade(i, side, isBuy, o, pre, si, so, b, logs);
        _hookBalance(o, side, isBuy, so, pre.alloc, acc);
    }

    function _checkReject(bytes memory err, uint8 lensReason) internal {
        bytes4 sel = bytes4(err);
        uint8 reason;
        if (sel == CorrFiEngine.CorrReject.selector) {
            assembly ("memory-safe") {
                reason := mload(add(err, 36))
            }
        } else if (sel == CorrFiCurve.BookTooThin.selector) {
            reason = CorrFiPricing.BOOK_TOO_THIN;
        } else if (sel == Deadline.DeadlineReached.selector) {
            reason = CorrFiPricing.EXPIRED;
        } else {
            // never a Panic, an ERC-20 error or an Aqua error: every refusal is a reason code (M §5.2.3, 論点 36)
            fail("unexpected revert");
        }
        assertEq(lensReason, reason, "breakdown reason = quote revert");
        ++reasons[reason];
    }

    function _pre(uint256 i, uint8 side, bool isBuy, ISwapVM.Order memory o) internal view returns (Pre memory p) {
        CorrFiVault v = vaultOf(i);
        p.q0 = _q(i);
        p.usdcVault = usdc.balanceOf(address(v));
        p.usdcTaker = usdc.balanceOf(TAKER);
        p.usdcMaker = usdc.balanceOf(MAKER);
        p.supply = v.longToken().totalSupply();
        address tokenOut = isBuy ? (side == 0 ? address(v.longToken()) : address(v.shortToken())) : address(usdc);
        (p.alloc,) = aqua.rawBalances(MAKER, address(router), keccak256(abi.encode(o)), tokenOut);
    }

    function _afterTrade(
        uint256 i,
        uint8 side,
        bool isBuy,
        ISwapVM.Order memory o,
        Pre memory pre,
        uint256 si,
        uint256 so,
        CorrFiLens.Breakdown memory b,
        Vm.Log[] memory logs
    ) internal {
        (uint8 dir, uint256 qty, uint256 q1, uint256 q2, uint256 pFair, uint256 h, uint256 hmin) = _event(o, logs);
        uint8 m = mk[i];
        ICorrFiHub.Quote memory s = hub.quoteState(m);
        assertEq(dir, side == 0 ? (isBuy ? 1 : 2) : (isBuy ? 3 : 4), "direction");
        assertEq(qty, isBuy ? so : si, "Q");
        assertEq(q1 + q2, qty, "Q1 + Q2 = Q");
        assertEq(pFair, s.pFair, "P_fair of the trade = the hub's");
        assertEq(q1, b.q1, "breakdown Q1");
        assertEq(q2, b.q2, "breakdown Q2");
        assertEq(hmin, b.hmin, "breakdown h_min");
        assertEq(h, b.h, "breakdown h");
        assertGe(hmin, s.h0, "h_min >= h0");
        assertGe(s.h0, hub.hFloor(), "h0 >= h_floor");
        assertGe(h, hmin, "h >= h_min");
        _f1(dir, qty, isBuy ? si : so, pFair, hmin);

        // A2: q moves by Q (D1 / D4 lower q, D2 / D3 raise it)
        int256 q1Inv = _q(i);
        assertEq(q1Inv, (dir == 1 || dir == 4) ? pre.q0 - int256(qty) : pre.q0 + int256(qty), "A2 dq");
        // A3 and the cash flows: buys mint Q2 (TakerPay + MakerPay = Q2), sells burn Q1 and pay Receive
        CorrFiVault v = vaultOf(i);
        if (isBuy) {
            assertEq(usdc.balanceOf(address(v)), pre.usdcVault + q2, "A3 vault +Q2");
            assertEq(pre.usdcTaker - usdc.balanceOf(TAKER), si, "A3 taker pays Pay");
            assertEq(int256(usdc.balanceOf(MAKER)) - int256(pre.usdcMaker), int256(si) - int256(q2), "A3 maker Pay - Q2");
            assertEq(v.longToken().totalSupply(), pre.supply + q2, "mint Q2");
        } else {
            assertEq(pre.usdcVault - usdc.balanceOf(address(v)), q1, "vault -Q1");
            assertEq(usdc.balanceOf(TAKER) - pre.usdcTaker, so, "taker receives");
            assertEq(int256(usdc.balanceOf(MAKER)) - int256(pre.usdcMaker), int256(q1) - int256(so), "maker Q1 - Receive");
            assertEq(v.longToken().totalSupply(), pre.supply - q1, "burn Q1");
        }
        _s5(i, pre.q0, q1Inv);
    }

    function _event(ISwapVM.Order memory o, Vm.Log[] memory logs)
        internal
        view
        returns (uint8 dir, uint256 qty, uint256 q1, uint256 q2, uint256 pFair, uint256 h, uint256 hmin)
    {
        bytes32 oh = keccak256(abi.encode(o));
        for (uint256 j; j < logs.length; ++j) {
            if (logs[j].emitter == address(router) && logs[j].topics.length > 1
                    && logs[j].topics[0] == CorrFiEngine.CorrSwap.selector && logs[j].topics[1] == oh) {
                return abi.decode(logs[j].data, (uint8, uint256, uint256, uint256, uint256, uint256, uint256));
            }
        }
        revert("no CorrSwap event");
    }

    /// F1 on the executed amounts: the average Long ask is in [min(P + h_min, 1), 1], the Long bid in
    /// [0, max(P - h_min, 0)]; the Short book is the mirror (ask 1 - β, bid 1 - α). Rounding favours the maker.
    function _f1(uint8 dir, uint256 qty, uint256 cash, uint256 p, uint256 hmin) internal pure {
        if (dir == 1 || dir == 3) {
            uint256 fair = dir == 1 ? p : WAD - p;
            uint256 lo = fair + hmin < WAD ? fair + hmin : WAD;
            assertGe(cash * WAD, qty * lo, "F1 ask >= fair + h_min");
            assertLe(cash, qty, "F1 ask <= 1");
        } else {
            uint256 fair = dir == 2 ? p : WAD - p;
            uint256 hi = fair > hmin ? fair - hmin : 0;
            assertLe(cash * WAD, qty * hi, "F1 bid <= fair - h_min");
        }
    }

    /// S5 (DEC-22): a fill that raises the market's RC leaves Σ RC < Umax · RiskBudget; the caps hold on fills that
    /// raise |q| (DEC-23). Computed here from the vaults and the hub, independently of CorrGuard's code path.
    function _s5(uint256 i, int256 q0, int256 q1) internal {
        CorrFiPricing.MakerConfig memory c = router.makerConfig(MAKER);
        uint256 pm = hub.quoteState(mk[i]).pFair;
        uint256 rcTotal;
        uint256 absTotal;
        for (uint256 j; j < 3; ++j) {
            CorrFiVault v = vaultOf(j);
            if (v.finalized()) continue;
            int256 q = _q(j);
            rcTotal += CorrFiMath.riskCapital(q, hub.quoteState(mk[j]).pFair);
            absTotal += _abs(q);
        }
        if (CorrFiMath.riskCapital(q1, pm) > CorrFiMath.riskCapital(q0, pm)) {
            ++riskIncreasing;
            assertLt(rcTotal * WAD, router.U_MAX() * c.riskBudget, "S5");
        }
        if (_abs(q1) > _abs(q0)) {
            assertLe(_abs(q1), c.qMaxMarket, "market cap");
            assertLe(absTotal, c.qGroup, "group cap");
        }
    }

    /// M §8.4: SwapVM's balance sufficiency is replaced by "the order's virtual balance after the hook >= the
    /// output". Read from the storage writes of the trade: the pull of the output finds at least the output in the
    /// order's balance; for a buy that balance was 0 before the trade and the hook put the tokens there; the
    /// order's Long / Short balance ends at 0 (A5).
    function _hookBalance(ISwapVM.Order memory o, uint8 side, bool isBuy, uint256 out, uint256 before, Vm.AccountAccess[] memory acc)
        internal
        view
    {
        bytes32 h = keccak256(abi.encode(o));
        CorrFiVault v;
        for (uint256 i; i < 3; ++i) {
            if (keccak256(abi.encode(oL[i])) == h || keccak256(abi.encode(oS[i])) == h) v = vaultOf(i);
        }
        address token = isBuy ? (side == 0 ? address(v.longToken()) : address(v.shortToken())) : address(usdc);
        bytes32 slot = aquaSlot(MAKER, h, token);
        uint256 mask = type(uint248).max;
        uint256 writes;
        bool pulled;
        uint256 last = before;
        for (uint256 a; a < acc.length; ++a) {
            Vm.StorageAccess[] memory sa = acc[a].storageAccesses;
            for (uint256 k; k < sa.length; ++k) {
                if (sa[k].account != address(aqua) || sa[k].slot != slot || !sa[k].isWrite || sa[k].reverted) continue;
                uint256 prev = uint256(sa[k].previousValue) & mask;
                uint256 next = uint256(sa[k].newValue) & mask;
                assertEq(prev, last, "writes in order");
                if (!pulled && prev >= out && next == prev - out) {
                    pulled = true;
                    if (isBuy) assertGe(writes, 1, "the hook wrote before the pull");
                }
                last = next;
                ++writes;
            }
        }
        assertTrue(pulled, "output pulled from the order's balance");
        if (isBuy) {
            assertEq(before, 0, "order side-token balance 0 before (A5)");
            assertEq(last, 0, "order side-token balance 0 after (A5)");
        }
    }

    // ------------------------------------------------------------------ settlement and after

    /// Terminal: settle every market by one of the three routes, then only claims remain.
    function settle(uint256 seed) external {
        ++calls;
        if (settled || calls < MIN_CALLS_BEFORE_SETTLEMENT) return;
        mode = seed % 3;
        uint256 end = hub.quoteState(mk[2]).obsEnd; // the last market's end
        if (mode == 2) {
            vm.warp(end + 48 hours); // the reporter stopped: unposted bars count as invalid (M §6.2.1)
        } else {
            uint256 n = (end - nextT) / 300 + 1;
            CorrFiHub.PointInput[] memory ps = new CorrFiHub.PointInput[](n);
            for (uint256 j; j < n; ++j) {
                uint256 r = uint256(keccak256(abi.encode(seed, j, "settle")));
                ps[j] = _nextPoint(r, mode == 1 && j % 40 == 7); // mode 1: 2.5 % invalid > N - N_min
            }
            _post(ps);
        }
        for (uint256 i; i < 3; ++i) {
            hub.crank(mk[i], type(uint32).max);
            CorrFiVault v = vaultOf(i);
            v.finalize();
            heldAtSettlement[i] = usdc.balanceOf(address(v));
            if (mode != 0) assertTrue(v.isVoid(), "VOID route");
            assertEq(v.collateral(), v.longToken().totalSupply(), "A1 at settlement");
        }
        settled = true;
    }

    function redeem(uint256 seed, uint256 a, uint256 b) external {
        ++calls;
        if (!settled) return;
        address who = [TAKER, A1, A2][seed % 3];
        uint256 i = (seed >> 8) % 3;
        CorrFiVault v = vaultOf(i);
        uint256 ql = bound(a, 0, v.longToken().balanceOf(who));
        uint256 qs = bound(b, 0, v.shortToken().balanceOf(who));
        if (ql == 0 && qs == 0) return;
        vm.prank(who);
        uint256 got = v.redeem(ql, qs);
        assertEq(got, CorrFiMath.payout(ql, qs, v.longT()), "payout formula");
        paid[i] += got;
    }

    function claim(uint256 i) external {
        ++calls;
        if (!settled) return;
        i %= 3;
        CorrFiVault v = vaultOf(i);
        if (v.depositLong(MAKER) == 0 && v.depositShort(MAKER) == 0) return;
        vm.prank(MAKER);
        paid[i] += v.claimDeposit();
    }

    function sweep(uint256 i) external {
        ++calls;
        if (!settled) return;
        i %= 3;
        paid[i] += vaultOf(i).sweepDust();
    }
}

contract SystemInvariantTest is RouterFixture {
    SystemHandler internal handler;
    uint8[3] internal mk;

    // accessors for the handler
    function hub_() external view returns (CorrFiHub) {
        return hub;
    }

    function router_() external view returns (CorrFiRouter) {
        return router;
    }

    function lens_() external view returns (CorrFiLens) {
        return lens;
    }

    function aqua_() external view returns (Aqua) {
        return aqua;
    }

    function usdc_() external view returns (MockUSDC) {
        return usdc;
    }

    function report(uint8 id, uint32 k) external view returns (CorrFiHub.ReportInput memory) {
        return honestReport(id, k);
    }

    function setUp() public override {
        super.setUp(); // market mid, maker books, taker approvals
        CorrFiPricing.MakerConfig memory c = makerCfg();
        c.riskBudget = uint128(10_000 * U); // U_max binds at about 10,000 Long in stock
        c.qMaxMarket = uint128(12_000 * U);
        c.qGroup = uint128(20_000 * U); // the group cap binds before three market caps do
        c.qMaxTrade = uint128(4_000 * U);
        vm.prank(MAKER);
        router.setMakerConfig(c);

        ISwapVM.Order[3] memory l;
        ISwapVM.Order[3] memory s;
        mk[0] = mid;
        (l[0], s[0]) = (oL, oS);
        for (uint256 i = 1; i < 3; ++i) {
            vm.warp(block.timestamp + 300); // three 7D markets whose grids are 5 minutes apart
            mk[i] = createMarket(appAInput());
            _approveMaker(MAKER, mk[i]);
            _approveTaker(TAKER, mk[i]);
            (l[i], s[i]) = openBooks(MAKER, mk[i], GEN, ALLOCATION);
        }
        address[3] memory actors = [TAKER, address(0xA1), address(0xA2)];
        for (uint256 a; a < 3; ++a) {
            usdc.mint(actors[a], 2_000_000 * U);
            for (uint256 i; i < 3; ++i) {
                vm.startPrank(actors[a]);
                usdc.approve(address(vaultOf(mk[i])), type(uint256).max);
                vaultOf(mk[i]).mint(50_000 * U); // Long and Short to sell
                vm.stopPrank();
            }
        }
        handler = new SystemHandler(this, mk, l, s);
        // the Aqua slot formula used by the hook-balance check reads what rawBalances reads
        (uint248 bal,) = aqua.rawBalances(MAKER, address(router), keccak256(abi.encode(oL)), address(usdc));
        bytes32 raw = vm.load(address(aqua), handler.aquaSlot(MAKER, keccak256(abi.encode(oL)), address(usdc)));
        assertEq(uint256(raw) & type(uint248).max, bal);

        bytes4[] memory sel = new bytes4[](8);
        sel[0] = SystemHandler.trade.selector;
        sel[1] = SystemHandler.advance.selector;
        sel[2] = SystemHandler.idle.selector;
        sel[3] = SystemHandler.mintBurn.selector;
        sel[4] = SystemHandler.settle.selector;
        sel[5] = SystemHandler.redeem.selector;
        sel[6] = SystemHandler.claim.selector;
        sel[7] = SystemHandler.sweep.selector;
        targetSelector(StdInvariant.FuzzSelector(address(handler), sel));
        targetContract(address(handler));
    }

    /// A1 before settlement; A2, A5 and nothing left in the router, the lens or the maker's wallet at all times;
    /// S1 / A4 after settlement, before and after redemptions, custody claims and the dust sweep (M §7.1).
    /// forge-config: default.invariant.runs = 24
    /// forge-config: default.invariant.depth = 60
    function invariant_system() public view {
        for (uint256 i; i < 3; ++i) {
            CorrFiVault v = vaultOf(mk[i]);
            CorrFiToken lng = v.longToken();
            CorrFiToken sht = v.shortToken();
            uint256 nl = v.depositLong(MAKER);
            uint256 ns = v.depositShort(MAKER);
            assertTrue(nl == 0 || ns == 0, "A2");
            assertEq(lng.balanceOf(address(v)), nl, "A5 Long");
            assertEq(sht.balanceOf(address(v)), ns, "A5 Short");
            (ISwapVM.Order memory l, ISwapVM.Order memory s) = (_order(i, 0), _order(i, 1));
            assertEq(allocation(l, address(lng)), 0, "order Long");
            assertEq(allocation(s, address(sht)), 0, "order Short");
            address[3] memory idle = [address(router), address(lens), MAKER];
            for (uint256 a; a < 3; ++a) {
                assertEq(lng.balanceOf(idle[a]), 0, "no idle Long");
                assertEq(sht.balanceOf(idle[a]), 0, "no idle Short");
            }
            if (!v.finalized()) {
                assertEq(lng.totalSupply(), sht.totalSupply(), "A1 supplies");
                assertEq(lng.totalSupply(), v.collateral(), "A1 collateral");
                assertEq(usdc.balanceOf(address(v)), v.collateral(), "A1 USDC");
            } else {
                uint256 lt = v.longT();
                uint256 owed = CorrFiMath.payout(nl, ns, lt);
                address[5] memory hs = handler.holders();
                for (uint256 a; a < 5; ++a) owed += CorrFiMath.payout(lng.balanceOf(hs[a]), sht.balanceOf(hs[a]), lt);
                assertGe(usdc.balanceOf(address(v)), owed, "S1: every holder can still redeem");
                assertGe(usdc.balanceOf(address(v)), CorrFiMath.payout(lng.totalSupply(), sht.totalSupply(), lt), "A4");
                assertLe(handler.paid(i), handler.heldAtSettlement(i), "no more paid than held");
            }
        }
        assertEq(usdc.balanceOf(address(router)), 0, "router USDC");
        assertEq(usdc.balanceOf(address(lens)), 0, "lens USDC");
    }

    function _order(uint256 i, uint8 side) internal view returns (ISwapVM.Order memory) {
        return side == 0 ? buildOrder(MAKER, mk[i], 0, GEN) : buildOrder(MAKER, mk[i], 1, GEN);
    }

    /// The same handler driven by fixed seeds through each settlement route, so that the campaign above is known to
    /// reach trades, refusals, settlement and redemption (the fuzzer's choice of calls is random).
    function _script(uint256 route) internal {
        for (uint256 j; j < 160; ++j) {
            uint256 r = uint256(keccak256(abi.encode(route, j)));
            uint256 pick = j < 120 ? r % 4 : 4 + r % 4;
            if (pick == 0 || pick == 3) handler.trade(r >> 8, r >> 128);
            else if (pick == 1) handler.advance(r >> 8);
            else if (pick == 2) handler.idle(r % 3 == 0 ? r >> 8 : 5);
            else if (pick == 4) handler.settle(route);
            else if (pick == 5) handler.redeem(r >> 8, r >> 64, r >> 128);
            else if (pick == 6) handler.claim(r >> 8);
            else handler.sweep(r >> 8);
            if (j % 20 == 0) handler.mintBurn(r >> 16, r >> 96);
            invariant_system();
        }
        emit log_named_uint("route", route);
        emit log_named_uint("trades", handler.trades());
        emit log_named_uint("refusals", handler.rejects());
        emit log_named_uint("risk-increasing fills", handler.riskIncreasing());
        for (uint8 k = 1; k < 19; ++k) {
            if (handler.reasons(k) != 0) emit log_named_uint(string.concat("  reason ", vm.toString(k)), handler.reasons(k));
        }
        assertTrue(handler.settled(), "settled");
        assertEq(handler.mode(), route);
        assertGt(handler.trades(), 15, "trades");
        assertGt(handler.rejects(), 0, "refusals");
        assertGt(handler.riskIncreasing(), 0, "risk-increasing fills");
        assertGt(handler.paid(0) + handler.paid(1) + handler.paid(2), 0, "redemptions");
    }

    function test_scriptedLifecycleAllBars() public {
        _script(0);
        for (uint256 i; i < 3; ++i) assertFalse(vaultOf(mk[i]).isVoid(), "normal settlement");
    }

    function test_scriptedLifecycleInvalidBars() public {
        _script(1);
    }

    function test_scriptedLifecycleReporterStopped() public {
        _script(2);
    }
}
