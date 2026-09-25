// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license Uses 1inch SwapVM code (MakerTraitsLib) — "Powered by SwapVM — © Degensoft Ltd 2025"
///                 (SwapVM-1.1 §3.1C).
/// @custom:changes 2026-09-26 (CorrFi): read-only quote breakdown of the CorrFi router.

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";

import {ICorrFiHub} from "./interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "./lib/CorrFiPricing.sol";
import {CorrFiCurve} from "./lib/CorrFiCurve.sol";
import {CorrFiEngine} from "./lib/CorrFiEngine.sol";
import {CorrFiRouter} from "./CorrFiRouter.sol";

/// @title CorrFiLens
/// @notice Read-only quote breakdown (M §5.8.2), split from the router for size (M §8.2.1 (a)). It never reverts on
///         a trading condition: it returns the reason code that quote would revert with. Amounts come from the same
///         linked CorrFiEngine stages that the router's opcodes run (論点 36), evaluated at the current block time.
contract CorrFiLens {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant DELTA = 300;

    struct Breakdown {
        uint8 reason; // 0 = tradable, else a CorrFiPricing reason code
        uint8 dir; // 1 buy Long, 2 sell Long, 3 buy Short, 4 sell Short
        // quantities (units)
        uint256 amountIn;
        uint256 amountOut;
        uint256 qty; // Q, token units
        uint256 limit; // with tolerance δ: min receive (exact-in) or max pay / max sell (exact-out)
        bool limitDefined; // false for sells when p̄ ≤ δ (OI-17)
        // prices (WAD per token of the traded side). pFair is the market's P_fair (the Long value); sideFair is the
        // fair value of the traded token (Long: P_fair, Short: 1 - P_fair). The deviation is taken from sideFair
        // (units; buy Pay − sideFair·Q, sell sideFair·Q − Receive)
        uint256 avgPrice;
        uint256 pFair;
        uint256 sideFair;
        int256 deviation;
        int256 deviationRate; // WAD, deviation / (sideFair·Q)
        uint256 devHmin; // h_min·Q
        uint256 devHU; // h_U·Q
        int256 devSize; // the rest: inventory slope
        // spreads (WAD)
        uint256 h0;
        uint256 hM;
        uint256 hO;
        uint256 hU;
        uint256 hmin;
        uint256 h;
        // custody and mint / burn
        uint256 q1; // buy: from custody; sell: paired with the opposite custody and burned
        uint256 q2; // buy: freshly minted; sell: bought into custody
        int256 inv0;
        int256 inv1;
        uint256 uPre;
        uint256 uPost;
        // validity (chain time)
        uint32 k; // price-confirmed bars
        uint64 tK; // time of bar k
        uint64 tNext; // scheduled time of bar k + 1
        uint64 tStop; // t_k + Δ + g: trading stops unless bar k + 1 is confirmed
        uint64 evaluatedAt;
    }

    CorrFiRouter public immutable ROUTER;
    ICorrFiHub public immutable HUB;
    address public immutable USDC;
    address public immutable AQUA;

    constructor(CorrFiRouter router) {
        ROUTER = router;
        HUB = router.HUB();
        USDC = router.USDC();
        AQUA = address(router.AQUA());
    }

    /// Same specification as the entry (M §5.6): market, side, direction, exact-in / exact-out, amount, tolerance
    /// δ (WAD per token), plus the order content.
    function breakdown(
        ISwapVM.Order calldata order,
        uint8 marketId,
        uint8 side,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint256 delta
    ) external view returns (Breakdown memory b) {
        bytes32 h = ROUTER.hash(order);
        CorrFiEngine.OrderInfo memory info = ROUTER.orderInfo(h);
        if (!info.registered || info.marketId != marketId || info.side != side) {
            b.reason = CorrFiPricing.NOT_REGISTERED; // the entry reverts EntryMismatch
            b.evaluatedAt = uint64(block.timestamp);
            return b;
        }
        return _evaluate(order, h, isBuy, exactIn, amount, delta);
    }

    /// The order given directly (as the standard swap / quote).
    function breakdownOrder(ISwapVM.Order calldata order, bool isBuy, bool exactIn, uint256 amount, uint256 delta)
        external
        view
        returns (Breakdown memory)
    {
        return _evaluate(order, ROUTER.hash(order), isBuy, exactIn, amount, delta);
    }

    /// Stage 2 behind an external call so that BookTooThin can be caught (self-call only in practice; view).
    function curveStage(
        CorrFiEngine.Env memory e,
        bytes32 orderHash,
        CorrFiPricing.Trade memory t,
        CorrFiPricing.MakerConfig memory cfg,
        CorrFiPricing.Result memory r
    ) external view returns (CorrFiPricing.Result memory) {
        return CorrFiEngine.stageCurve(e, orderHash, t, cfg, r);
    }

    // ------------------------------------------------------------------ evaluation in quote order

    function _evaluate(
        ISwapVM.Order calldata order,
        bytes32 h,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint256 delta
    ) internal view returns (Breakdown memory b) {
        b.evaluatedAt = uint64(block.timestamp);
        CorrFiEngine.OrderInfo memory info = ROUTER.orderInfo(h);
        // 1. quote reads the order's Aqua balances first
        if (MakerTraitsLib.useAquaInsteadOfSignature(order.traits) && !_aquaActive(order, h, isBuy)) {
            b.reason = CorrFiPricing.ORDER_INACTIVE;
            return b;
        }
        // 2. the program's Deadline (obsEnd) runs before CorrReport
        if (_pastDeadline(order)) {
            b.reason = CorrFiPricing.EXPIRED;
            return b;
        }
        // 3. CorrReport: registration
        if (!info.registered || info.maker != order.maker || ROUTER.pairMask(info.maker, info.marketId, info.generation) != 3) {
            b.reason = CorrFiPricing.NOT_REGISTERED;
            return b;
        }
        _validity(b, info.marketId);
        CorrFiEngine.Env memory e = CorrFiEngine.Env(HUB, USDC, AQUA, address(ROUTER), ROUTER.params());
        CorrFiPricing.Trade memory t = CorrFiPricing.Trade(order.maker, info.marketId, info.side, isBuy, exactIn, amount);
        CorrFiPricing.MakerConfig memory cfg = ROUTER.makerConfig(order.maker);
        b.dir = CorrFiPricing.direction(t);
        // CorrReport: maker settings, T-1..T-4
        CorrFiPricing.Result memory r = CorrFiEngine.stageReport(e, h, t, cfg);
        _spreads(b, r);
        if (r.reason != CorrFiPricing.OK) {
            b.reason = r.reason;
            return b;
        }
        // CorrCurve
        try this.curveStage(e, h, t, cfg, r) returns (CorrFiPricing.Result memory r2) {
            r = r2;
        } catch (bytes memory err) {
            if (bytes4(err) != CorrFiCurve.BookTooThin.selector) {
                assembly ("memory-safe") {
                    revert(add(err, 32), mload(err))
                }
            }
            b.reason = CorrFiPricing.BOOK_TOO_THIN;
            return b;
        }
        // CorrGuard
        r = CorrFiEngine.stagePost(e, h, t, cfg, r);
        b.reason = r.reason;
        _spreads(b, r);
        _amounts(b, r, isBuy, exactIn, delta);
    }

    function _aquaActive(ISwapVM.Order calldata order, bytes32 h, bool isBuy) internal view returns (bool) {
        (address a, address c) = MakerTraitsLib.tokens(order.traits, order.data);
        bool aIsUsdc = a == USDC;
        bool aIn = isBuy ? aIsUsdc : !aIsUsdc; // tokenIn is USDC for buys (the entry's isAToB)
        (address tokenIn, address tokenOut) = aIn ? (a, c) : (c, a);
        try IAqua(AQUA).safeBalances(order.maker, address(ROUTER), h, tokenIn, tokenOut) {
            return true;
        } catch {
            return false;
        }
    }

    function _pastDeadline(ISwapVM.Order calldata order) internal view returns (bool) {
        bytes calldata p = MakerTraitsLib.program(order.traits, order.data);
        if (p.length < 7 || uint8(p[0]) != 0x20 || uint8(p[1]) != 5) return false;
        return block.timestamp > uint40(bytes5(p[2:7]));
    }

    function _validity(Breakdown memory b, uint8 marketId) internal view {
        ICorrFiHub.Quote memory s = HUB.quoteState(marketId);
        b.k = s.confirmed;
        b.tK = s.obsStart + uint64(s.confirmed) * uint64(DELTA);
        b.tNext = b.tK + uint64(DELTA);
        b.tStop = b.tNext + uint64(ROUTER.GRACE());
    }

    function _spreads(Breakdown memory b, CorrFiPricing.Result memory r) internal pure {
        b.pFair = r.pFair;
        b.h0 = r.h0;
        b.hM = r.hM;
        b.hO = r.hO;
        b.hU = r.hU;
        b.hmin = r.hmin;
        b.h = r.h;
    }

    function _amounts(Breakdown memory b, CorrFiPricing.Result memory r, bool isBuy, bool exactIn, uint256 delta)
        internal
        pure
    {
        b.amountIn = r.amountIn;
        b.amountOut = r.amountOut;
        b.qty = r.qty;
        b.q1 = r.q1;
        b.q2 = r.q2;
        b.inv0 = r.inv0;
        b.inv1 = r.inv1;
        b.uPre = r.uPre;
        b.uPost = r.uPost;
        if (r.qty == 0) return;
        uint256 x = isBuy ? r.amountIn : r.amountOut; // USDC paid / received
        uint256 q = r.qty;
        b.avgPrice = Math.mulDiv(x, WAD, q);
        b.sideFair = b.dir >= 3 ? WAD - r.pFair : r.pFair; // a Short is not valued at the Long's P_fair
        uint256 pq = Math.mulDiv(b.sideFair, q, WAD);
        b.deviation = isBuy ? int256(x) - int256(pq) : int256(pq) - int256(x);
        if (pq != 0) b.deviationRate = b.deviation * int256(WAD) / int256(pq);
        b.devHmin = Math.mulDiv(r.hmin, q, WAD);
        b.devHU = Math.mulDiv(r.hU, q, WAD);
        b.devSize = b.deviation - int256(b.devHmin) - int256(b.devHU);
        // tolerance δ (M §5.8.3): p̄ = x / q
        if (delta > WAD) return; // a tolerance above 1 USDC per token is meaningless (limitDefined stays false)
        uint256 dq = Math.mulDiv(delta, q, WAD, Math.Rounding.Ceil); // ⌈δ·Q⌉ in units
        b.limitDefined = true;
        if (isBuy) {
            // exact-in: ⌊X / (p̄ + δ)⌋ ; exact-out: ⌈Q (p̄ + δ)⌉
            b.limit = exactIn ? Math.mulDiv(x * q, WAD, x * WAD + delta * q) : x + dq;
        } else if (x * WAD <= delta * q) {
            b.limitDefined = false; // p̄ ≤ δ
        } else {
            // exact-in: ⌊Q (p̄ − δ)⌋ ; exact-out: ⌈X / (p̄ − δ)⌉
            b.limit = exactIn ? x - dq : Math.mulDiv(x * q, WAD, x * WAD - delta * q, Math.Rounding.Ceil);
        }
    }
}
