// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license Part of the CorrFi SwapVM router, derived from 1inch SwapVM — "Powered by SwapVM — © Degensoft Ltd
///                 2025" (SwapVM-1.1 §3.1C).
/// @custom:changes 2026-09-26 (CorrFi): opcode bodies of CorrReport / CorrCurve / CorrGuard (0xd0-0xd2) and the
///                 maker-hook settlement, deployed as an external library that runs in the router's context (DEC-12).

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {SwapQuery, SwapRegisters} from "@1inch/swap-vm/contracts/libs/VM.sol";

import {ICorrFiHub} from "../interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "./CorrFiPricing.sol";
import {CorrFiCurve} from "./CorrFiCurve.sol";
import {CorrFiVault} from "../CorrFiVault.sol";

/// @title CorrFiEngine
/// @notice The router's CorrFi opcodes and maker hooks (M §5.2, §5.3), plus the three evaluation stages used by the
///         quote breakdown (M §5.8.2). Called by DELEGATECALL, so storage, transient storage, the Aqua app identity
///         and msg.sender are the router's. The opcodes and the breakdown run the same CorrFiPricing functions
///         (論点 36).
library CorrFiEngine {
    using SafeERC20 for IERC20;

    struct OrderInfo {
        address maker;
        uint8 marketId;
        uint8 side;
        uint32 generation;
        bool registered;
    }

    /// Router storage (the router holds one instance and passes it to the library). An order is registered only
    /// together with the other book of its market / generation (CorrFiOrders.registerPair), so `registered` also
    /// means that the pair is complete (review S04-12).
    struct State {
        mapping(bytes32 orderHash => OrderInfo) orderInfo;
        mapping(address maker => CorrFiPricing.MakerConfig) config;
    }

    /// Chain addresses and protocol constants of the router.
    struct Env {
        ICorrFiHub hub;
        address usdc;
        address aqua;
        address app; // the router (Aqua app)
        CorrFiPricing.Params prm;
    }

    error CorrReject(uint8 reason); // see CorrFiPricing reason codes

    event CorrSwap(
        bytes32 indexed orderHash,
        address indexed maker,
        uint8 indexed marketId,
        uint8 dir,
        uint256 qty,
        uint256 q1,
        uint256 q2,
        uint256 pFair,
        uint256 h,
        uint256 hmin
    );

    bytes32 private constant _PLAN_SEED = keccak256("CorrFi.settlePlan");
    bytes32 private constant _LOCK_SEED = keccak256("CorrFi.makerLock");

    // ------------------------------------------------------------------ opcodes (M §5.2)

    /// 0xd0: registration, maker settings, T-1..T-4, h_min; registers balanceOut <- P_fair, balanceIn <- h_min;
    /// takes the maker's lock in execution. The lock covers all of the maker's markets (DEC-15): the group and
    /// utilization caps are evaluated over every market, and a taker callback runs between CorrGuard and the
    /// settlement hooks, so a nested trade on another market would otherwise see stale inventory.
    function report(State storage st, Env memory e, SwapQuery memory q, SwapRegisters memory reg, bool isStatic)
        public
        returns (SwapRegisters memory)
    {
        CorrFiPricing.Trade memory t = _trade(st, e, q, reg);
        CorrFiPricing.Result memory r = CorrFiPricing.preReport(_ctx(e, q.orderHash), t, st.config[t.maker], e.prm);
        if (r.reason != CorrFiPricing.OK) revert CorrReject(r.reason);
        bytes32 lockSlot = _lockSlot(t.maker);
        if (_tload(lockSlot) != 0) revert CorrReject(CorrFiPricing.LOCKED);
        if (!isStatic) _tstore(lockSlot, 1); // released by the second hook (M §5.4, PROP-16, DEC-15)
        reg.balanceOut = r.pFair;
        reg.balanceIn = r.hmin;
        return reg;
    }

    /// 0xd1: amounts on the inventory path; in execution, the settle plan for the hooks and the trade event.
    function curve(State storage st, Env memory e, SwapQuery memory q, SwapRegisters memory reg, bool isStatic)
        public
        returns (SwapRegisters memory)
    {
        CorrFiPricing.Trade memory t = _trade(st, e, q, reg);
        CorrFiPricing.Result memory r;
        r.pFair = reg.balanceOut;
        r.hmin = reg.balanceIn;
        CorrFiCurve.Curve memory c = CorrFiPricing.curveFor(_ctx(e, q.orderHash), t, st.config[t.maker], e.prm, r);
        uint8 dir = CorrFiPricing.direction(t);
        (reg.amountIn, reg.amountOut) = CorrFiPricing.amounts(c, r.inv0, dir, t.exactIn, t.amount);
        if (!isStatic) {
            uint256 qty = t.isBuy ? reg.amountOut : reg.amountIn;
            (uint256 q1, uint256 q2,) = CorrFiPricing.split(dir, qty, r.nl, r.ns, r.inv0);
            bytes32 slot = _planSlot(q.orderHash);
            _tstore(slot, 1 | (t.isBuy ? 2 : 0) | (uint256(t.side) << 8) | (uint256(t.marketId) << 16));
            _tstore(bytes32(uint256(slot) + 1), q1);
            _tstore(bytes32(uint256(slot) + 2), q2);
            emit CorrSwap(q.orderHash, t.maker, t.marketId, dir, qty, q1, q2, r.pFair, r.h, r.hmin);
        }
        return reg;
    }

    /// 0xd2: post-trade constraints (M §5.2.3).
    function guard(State storage st, Env memory e, SwapQuery memory q, SwapRegisters memory reg) public view {
        CorrFiPricing.Trade memory t = _trade(st, e, q, reg);
        CorrFiPricing.Result memory r;
        r.amountIn = reg.amountIn;
        r.amountOut = reg.amountOut;
        uint8 reason = CorrFiPricing.post(_ctx(e, q.orderHash), t, st.config[t.maker], e.prm, r);
        if (reason != CorrFiPricing.OK) revert CorrReject(reason);
    }

    // ------------------------------------------------------------------ maker hooks (M §5.3)

    /// preTransferOut: for buys (D1 / D3), put Q = Q1 (custody) + Q2 (fresh mint) of the side token into the order.
    function settleBuy(Env memory e, address maker, address tokenOut, uint256 amountOut, bytes32 orderHash) public {
        (bool exists, bool isBuy, uint8 side, uint8 m, uint256 q1, uint256 q2) = _readPlan(orderHash);
        if (!exists) return;
        if (isBuy) {
            IAqua aqua = IAqua(e.aqua);
            CorrFiVault vault = CorrFiVault(e.hub.marketVault(m));
            if (q1 != 0) vault.depositOut(maker, CorrFiVault.Side(side), q1, address(this));
            if (q2 != 0) {
                aqua.pull(maker, orderHash, e.usdc, q2, address(this));
                IERC20(e.usdc).forceApprove(address(vault), q2);
                vault.mint(q2);
                address other = side == CorrFiPricing.SIDE_LONG ? address(vault.shortToken()) : address(vault.longToken());
                IERC20(other).forceApprove(address(vault), q2);
                vault.depositIn(maker, CorrFiVault.Side(1 - side), q2);
            }
            IERC20(tokenOut).forceApprove(address(aqua), amountOut); // K5: every push consumes an approval
            aqua.push(maker, address(this), orderHash, tokenOut, amountOut);
        }
        _hookDone(orderHash, maker);
    }

    /// postTransferIn: for sells (D2 / D4), take the received side tokens out of the order; pair Q1 with the
    /// opposite custody and burn (USDC back into the order), keep Q2 in custody.
    function settleSell(Env memory e, address maker, address tokenIn, uint256 amountIn, bytes32 orderHash) public {
        (bool exists, bool isBuy, uint8 side, uint8 m, uint256 q1, uint256 q2) = _readPlan(orderHash);
        if (!exists) return;
        if (!isBuy) {
            IAqua aqua = IAqua(e.aqua);
            CorrFiVault vault = CorrFiVault(e.hub.marketVault(m));
            aqua.pull(maker, orderHash, tokenIn, amountIn, address(this));
            if (q1 != 0) {
                vault.depositOut(maker, CorrFiVault.Side(1 - side), q1, address(this));
                vault.burn(q1);
                IERC20(e.usdc).forceApprove(address(aqua), q1);
                aqua.push(maker, address(this), orderHash, e.usdc, q1);
            }
            if (q2 != 0) {
                IERC20(tokenIn).forceApprove(address(vault), q2);
                vault.depositIn(maker, CorrFiVault.Side(side), q2);
            }
        }
        _hookDone(orderHash, maker);
    }

    // ------------------------------------------------------------------ breakdown stages (M §5.8.2)

    /// Stage 1 (as CorrReport): maker settings, T-1..T-4, spreads.
    function stageReport(Env memory e, bytes32 orderHash, CorrFiPricing.Trade memory t, CorrFiPricing.MakerConfig memory cfg)
        public
        view
        returns (CorrFiPricing.Result memory)
    {
        return CorrFiPricing.preReport(_ctx(e, orderHash), t, cfg, e.prm);
    }

    /// Stage 2 without the amounts: inventory, U* and h, for the breakdown of a book too thin (review S04-10).
    function stageInventory(
        Env memory e,
        bytes32 orderHash,
        CorrFiPricing.Trade memory t,
        CorrFiPricing.MakerConfig memory cfg,
        CorrFiPricing.Result memory r
    ) public view returns (CorrFiPricing.Result memory) {
        CorrFiPricing.curveFor(_ctx(e, orderHash), t, cfg, e.prm, r);
        return r;
    }

    /// Stage 2 (as CorrCurve): inventory, U*, h and the amounts. Reverts CorrFiCurve.BookTooThin like the opcode.
    function stageCurve(
        Env memory e,
        bytes32 orderHash,
        CorrFiPricing.Trade memory t,
        CorrFiPricing.MakerConfig memory cfg,
        CorrFiPricing.Result memory r
    ) public view returns (CorrFiPricing.Result memory) {
        CorrFiCurve.Curve memory c = CorrFiPricing.curveFor(_ctx(e, orderHash), t, cfg, e.prm, r);
        (r.amountIn, r.amountOut) = CorrFiPricing.amounts(c, r.inv0, CorrFiPricing.direction(t), t.exactIn, t.amount);
        return r;
    }

    /// Stage 3 (as CorrGuard): Q, Q1, Q2, post-trade inventory and utilization, constraints.
    function stagePost(
        Env memory e,
        bytes32 orderHash,
        CorrFiPricing.Trade memory t,
        CorrFiPricing.MakerConfig memory cfg,
        CorrFiPricing.Result memory r
    ) public view returns (CorrFiPricing.Result memory) {
        r.reason = CorrFiPricing.post(_ctx(e, orderHash), t, cfg, e.prm, r);
        return r;
    }

    // ------------------------------------------------------------------ internals

    function _trade(State storage st, Env memory e, SwapQuery memory q, SwapRegisters memory reg)
        private
        view
        returns (CorrFiPricing.Trade memory)
    {
        OrderInfo memory info = st.orderInfo[q.orderHash];
        if (!info.registered || info.maker != q.maker) revert CorrReject(CorrFiPricing.NOT_REGISTERED);
        return CorrFiPricing.Trade(
            info.maker,
            info.marketId,
            info.side,
            q.tokenIn == e.usdc,
            q.isExactIn,
            q.isExactIn ? reg.amountIn : reg.amountOut
        );
    }

    function _ctx(Env memory e, bytes32 orderHash) private view returns (CorrFiPricing.Ctx memory) {
        return CorrFiPricing.Ctx(e.hub, e.usdc, e.aqua, e.app, orderHash, block.timestamp);
    }

    function _planSlot(bytes32 orderHash) private pure returns (bytes32) {
        return keccak256(abi.encode(orderHash, _PLAN_SEED));
    }

    function _lockSlot(address maker) private pure returns (bytes32) {
        return keccak256(abi.encode(maker, _LOCK_SEED));
    }

    function _readPlan(bytes32 orderHash)
        private
        view
        returns (bool exists, bool isBuy, uint8 side, uint8 m, uint256 q1, uint256 q2)
    {
        bytes32 slot = _planSlot(orderHash);
        uint256 head = _tload(slot);
        exists = head & 1 != 0;
        isBuy = head & 2 != 0;
        side = uint8(head >> 8);
        m = uint8(head >> 16);
        q1 = _tload(bytes32(uint256(slot) + 1));
        q2 = _tload(bytes32(uint256(slot) + 2));
    }

    /// Both hooks always run (their flags are mandatory); the second one clears the plan and releases the lock.
    function _hookDone(bytes32 orderHash, address maker) private {
        bytes32 slot = _planSlot(orderHash);
        uint256 head = _tload(slot);
        if ((head >> 24) & 0xff == 0) {
            _tstore(slot, head | (uint256(1) << 24));
        } else {
            _tstore(slot, 0);
            _tstore(bytes32(uint256(slot) + 1), 0);
            _tstore(bytes32(uint256(slot) + 2), 0);
            _tstore(_lockSlot(maker), 0);
        }
    }

    function _tstore(bytes32 slot, uint256 v) private {
        assembly ("memory-safe") {
            tstore(slot, v)
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 v) {
        assembly ("memory-safe") {
            v := tload(slot)
        }
    }
}
