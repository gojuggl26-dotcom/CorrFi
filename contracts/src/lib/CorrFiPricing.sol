// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICorrFiHub} from "../interfaces/ICorrFiHub.sol";
import {ICorrFiVaultView} from "../interfaces/ICorrFiVaultView.sol";
import {CorrFiMath} from "./CorrFiMath.sol";
import {CorrFiCurve} from "./CorrFiCurve.sol";

/// @title CorrFiPricing
/// @notice Trade-time pricing and checks shared by the router's opcodes (CorrReport / CorrCurve / CorrGuard) and
///         the read-only quote breakdown (M §5.2, §5.8.2; 論点 36: one implementation, identical results).
///         Evaluation is split in three stages around the curve so that the router can let the curve revert
///         (BookTooThin) while the breakdown catches it — both run exactly this code.
library CorrFiPricing {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant DELTA = 300;

    // ---- reason codes (M §9.2.2). 0 = tradable.
    uint8 internal constant OK = 0;
    uint8 internal constant NOT_REGISTERED = 1; // order unknown / its pair not registered
    uint8 internal constant MAKER_INACTIVE = 2; // maker config missing or paused
    uint8 internal constant UNSYNCED = 3; // T-1: price-confirmed bars != accumulated bars
    uint8 internal constant STALE = 4; // T-2: age > Δ + g
    uint8 internal constant EXPIRED = 5; // T-3: at or after obsEnd
    uint8 internal constant TOO_MANY_INVALID = 6; // T-4: invalid bars > (N - N_min) / 2
    uint8 internal constant LOCKED = 7; // maker x market busy (re-entry)
    uint8 internal constant QTY_TOO_SMALL = 8;
    uint8 internal constant QTY_TOO_LARGE = 9;
    uint8 internal constant MARKET_CAP = 10; // |q1| > qmax,m
    uint8 internal constant GROUP_CAP = 11; // Σ|q| > q_grp
    uint8 internal constant UTILIZATION_CAP = 12; // risk-increasing with U_post >= U_max
    uint8 internal constant ALLOCATION_SHORT = 13; // the order's USDC allocation in Aqua is too small
    uint8 internal constant WALLET_SHORT = 14; // maker's USDC balance or Aqua allowance too small
    uint8 internal constant ZERO_AMOUNT = 15; // amountIn or amountOut is 0
    uint8 internal constant BOOK_TOO_THIN = 16;
    uint8 internal constant ORDER_INACTIVE = 17; // the order is not an active Aqua strategy (never shipped / docked)

    uint8 internal constant SIDE_LONG = 0;
    uint8 internal constant SIDE_SHORT = 1;

    /// Protocol constants fixed at router deployment (M §8.1).
    struct Params {
        uint256 cO; // freshness coefficient (WAD)
        uint256 grace; // g (s)
        uint256 hUMax; // WAD
        uint256 u0; // WAD
        uint256 uMax; // WAD
    }

    /// Maker settings (M §5.4, §8.1), set by the maker only.
    struct MakerConfig {
        uint128 riskBudget; // units (USDC)
        uint128 qMaxMarket; // qmax,m (token units)
        uint128 qGroup; // q_grp (token units)
        uint128 qMinTrade; // Q_min (token units)
        uint128 qMaxTrade; // Q_max (token units)
        uint64 kq; // WAD
        uint64 hM; // WAD
        bool active;
    }

    /// A trade request against one registered order.
    struct Trade {
        address maker;
        uint8 marketId;
        uint8 side; // SIDE_LONG / SIDE_SHORT (the order's book)
        bool isBuy; // taker buys the side token (tokenIn = USDC)
        bool exactIn;
        uint256 amount; // taker-specified amount (tokenIn if exactIn, else tokenOut)
    }

    /// Chain context of an evaluation.
    struct Ctx {
        ICorrFiHub hub;
        address usdc;
        address aqua;
        address app; // the router (Aqua app)
        bytes32 orderHash;
        uint256 nowTs;
    }

    /// Everything the breakdown returns (M §5.8.2).
    struct Result {
        uint8 reason;
        uint256 pFair;
        uint256 h0;
        uint256 hM;
        uint256 hO;
        uint256 hU;
        uint256 hmin;
        uint256 h;
        uint256 age;
        uint256 amountIn;
        uint256 amountOut;
        uint256 qty; // token quantity Q
        uint256 q1; // served from custody (buy) / paired and burned (sell)
        uint256 q2; // minted (buy) / bought into custody (sell)
        uint256 nl; // custody Long before
        uint256 ns; // custody Short before
        int256 inv0; // maker inventory q before (Long-equivalent, units)
        int256 inv1; // after
        uint256 uPre; // utilization before (WAD)
        uint256 uPost; // after
        ICorrFiHub.Quote state;
    }

    // ------------------------------------------------------------------ stage 1: CorrReport (M §5.2.1, T-1..T-4)

    function report(ICorrFiHub.Quote memory s, uint256 hM, Params memory prm, uint256 nowTs)
        internal
        pure
        returns (uint8 reason, uint256 age, uint256 hO, uint256 hmin)
    {
        if (s.confirmed != s.processed) return (UNSYNCED, 0, 0, 0); // T-1
        if (nowTs >= s.obsEnd) return (EXPIRED, 0, 0, 0); // T-3
        if (s.invalidBars > (s.n - s.nMin) / 2) return (TOO_MANY_INVALID, 0, 0, 0); // T-4
        if (nowTs > s.obsStart) {
            uint256 tRef = uint256(s.obsStart) + uint256(s.confirmed) * DELTA;
            age = nowTs > tRef ? nowTs - tRef : 0;
            if (age > DELTA + prm.grace) return (STALE, age, 0, 0); // T-2
        }
        hO = CorrFiMath.hO(age, s.sig2, prm.cO);
        hmin = s.h0 + hM + hO;
    }

    /// Stage 1 for the breakdown: maker checks + report.
    function preReport(Ctx memory x, Trade memory t, MakerConfig memory cfg, Params memory prm)
        internal
        view
        returns (Result memory r)
    {
        if (!cfg.active || cfg.riskBudget == 0) {
            r.reason = MAKER_INACTIVE;
            return r;
        }
        r.state = x.hub.quoteState(t.marketId);
        r.pFair = r.state.pFair;
        r.h0 = r.state.h0;
        r.hM = cfg.hM;
        (r.reason, r.age, r.hO, r.hmin) = report(r.state, cfg.hM, prm, x.nowTs);
    }

    // ------------------------------------------------------------------ stage 2: CorrCurve (M §5.2.2, §4.5)

    /// Direction D1..D4 of M §5.2.2.
    function direction(Trade memory t) internal pure returns (uint8) {
        if (t.side == SIDE_LONG) return t.isBuy ? 1 : 2;
        return t.isBuy ? 3 : 4;
    }

    function inventory(ICorrFiVaultView vault, address maker) internal view returns (uint256 nl, uint256 ns) {
        nl = vault.depositLong(maker);
        ns = vault.depositShort(maker);
    }

    /// Σ RC and Σ|q| over live (not finalized) markets, with market `m` evaluated at inventory `qm` (M §6.1, PROP-10).
    function exposure(ICorrFiHub hub, address maker, uint8 m, int256 qm)
        internal
        view
        returns (uint256 rcTotal, uint256 absTotal)
    {
        uint256 count = hub.marketCount();
        for (uint256 i; i < count; ++i) {
            ICorrFiVaultView v = ICorrFiVaultView(hub.marketVault(uint8(i)));
            if (v.finalized()) continue;
            int256 q = qm;
            if (i != m) {
                (uint256 nl, uint256 ns) = inventory(v, maker);
                q = int256(nl) - int256(ns);
            }
            if (q == 0) continue;
            rcTotal += CorrFiMath.riskCapital(q, hub.quoteState(uint8(i)).pFair);
            absTotal += uint256(q > 0 ? q : -q);
        }
    }

    /// Inventory, pre-trade utilization and the curve (h = hmin + hU(U*), U* before the trade — M §4.4).
    function curveFor(Ctx memory x, Trade memory t, MakerConfig memory cfg, Params memory prm, Result memory r)
        internal
        view
        returns (CorrFiCurve.Curve memory c)
    {
        (r.nl, r.ns) = inventory(ICorrFiVaultView(x.hub.marketVault(t.marketId)), t.maker);
        r.inv0 = int256(r.nl) - int256(r.ns);
        (uint256 rcPre,) = exposure(x.hub, t.maker, t.marketId, r.inv0);
        r.uPre = CorrFiMath.utilization(rcPre, cfg.riskBudget);
        r.hU = CorrFiMath.hU(r.uPre, prm.hUMax, prm.u0, prm.uMax);
        r.h = r.hmin + r.hU;
        c = CorrFiCurve.make(r.pFair, r.h, r.hmin, cfg.kq, cfg.qMaxMarket);
    }

    /// (amountIn, amountOut) on the curve. Reverts CorrFiCurve.BookTooThin when a sell cannot reach the amount.
    function amounts(CorrFiCurve.Curve memory c, int256 q0, uint8 dir, bool exactIn, uint256 amount)
        internal
        pure
        returns (uint256 amountIn, uint256 amountOut)
    {
        if (dir == 1) {
            if (exactIn) return (amount, CorrFiCurve.qtyD1ExactIn(c, q0, amount));
            return (CorrFiCurve.payD1(c, q0, amount), amount);
        }
        if (dir == 2) {
            if (exactIn) return (amount, CorrFiCurve.receiveD2(c, q0, amount));
            return (CorrFiCurve.qtyD2ExactOut(c, q0, amount), amount);
        }
        if (dir == 3) {
            if (exactIn) return (amount, CorrFiCurve.qtyD3ExactIn(c, q0, amount));
            return (CorrFiCurve.payD3(c, q0, amount), amount);
        }
        if (exactIn) return (amount, CorrFiCurve.receiveD4(c, q0, amount));
        return (CorrFiCurve.qtyD4ExactOut(c, q0, amount), amount);
    }

    /// Q1 / Q2 and the new inventory (M §5.2.2 table): Q1 = min(Q, the custody that is consumed).
    function split(uint8 dir, uint256 qty, uint256 nl, uint256 ns, int256 q0)
        internal
        pure
        returns (uint256 q1, uint256 q2, int256 inv1)
    {
        uint256 have = (dir == 1 || dir == 4) ? nl : ns; // D1 serves Long, D4 pairs with Long; D2/D3 use Short
        q1 = qty < have ? qty : have;
        q2 = qty - q1;
        inv1 = (dir == 1 || dir == 4) ? q0 - int256(qty) : q0 + int256(qty);
    }

    // ------------------------------------------------------------------ stage 3: CorrGuard (M §5.2.3)

    /// Fill in Q, Q1, Q2, q1, U_post from the amounts and check the post-trade constraints.
    function post(Ctx memory x, Trade memory t, MakerConfig memory cfg, Params memory prm, Result memory r)
        internal
        view
        returns (uint8)
    {
        r.qty = t.isBuy ? r.amountOut : r.amountIn;
        (r.q1, r.q2, r.inv1) = split(direction(t), r.qty, r.nl, r.ns, r.inv0);
        (uint256 rcPost, uint256 absPost) = exposure(x.hub, t.maker, t.marketId, r.inv1);
        r.uPost = CorrFiMath.utilization(rcPost, cfg.riskBudget);

        if (r.amountIn == 0 || r.amountOut == 0) return ZERO_AMOUNT;
        if (r.qty < cfg.qMinTrade) return QTY_TOO_SMALL;
        if (r.qty > cfg.qMaxTrade) return QTY_TOO_LARGE;
        uint256 abs1 = uint256(r.inv1 > 0 ? r.inv1 : -r.inv1);
        uint256 abs0 = uint256(r.inv0 > 0 ? r.inv0 : -r.inv0);
        if (abs1 > cfg.qMaxMarket) return MARKET_CAP;
        if (absPost > cfg.qGroup) return GROUP_CAP;
        if (abs1 > abs0 && r.uPost >= prm.uMax) return UTILIZATION_CAP; // only risk-increasing fills
        // gross funds: D1/D3 mint Q2 from the order's USDC; D2/D4 pay Receive from it (M §5.2.3-4)
        uint256 need = t.isBuy ? r.q2 : r.amountOut;
        if (need != 0) {
            (uint248 alloc,) = IAquaBalances(x.aqua).rawBalances(t.maker, x.app, x.orderHash, x.usdc);
            if (alloc < need) return ALLOCATION_SHORT;
            if (IERC20(x.usdc).balanceOf(t.maker) < need || IERC20(x.usdc).allowance(t.maker, x.aqua) < need) {
                return WALLET_SHORT;
            }
        }
        return OK;
    }
}

/// Minimal Aqua view used by the gross-funds check.
interface IAquaBalances {
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);
}
