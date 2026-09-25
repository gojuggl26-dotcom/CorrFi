// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license Derived from 1inch SwapVM — "Powered by SwapVM — © Degensoft Ltd 2025" (SwapVM-1.1 §3.1C).
/// @custom:changes 2026-09-26 (CorrFi): opcode dispatch limited to Deadline (0x20) + CorrReport / CorrCurve /
///                 CorrGuard (0xd0-0xd2); router-as-maker-hook settlement with vault custody; order registry,
///                 maker settings and a market entry point. The CorrFi code runs from the linked libraries
///                 CorrFiEngine and CorrFiOrders in this contract's context (DEC-12). SwapVM.sol is not modified.

import {SwapVM} from "@1inch/swap-vm/contracts/SwapVM.sol";
import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {Context} from "@1inch/swap-vm/contracts/libs/VM.sol";
import {Deadline} from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import {ICorrFiHub} from "./interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "./lib/CorrFiPricing.sol";
import {CorrFiEngine} from "./lib/CorrFiEngine.sol";
import {CorrFiOrders} from "./lib/CorrFiOrders.sol";

/// @title CorrFiRouter
/// @notice SwapVM router whose programs price CorrFi Long / Short against a maker's Aqua USDC allocation
///         (M §3.4, §5). Opcodes decide amounts; the router's own maker hooks move vault custody, mint and burn.
contract CorrFiRouter is SwapVM {
    uint8 public constant OP_DEADLINE = 0x20;
    uint8 public constant OP_CORR_REPORT = 0xd0;
    uint8 public constant OP_CORR_CURVE = 0xd1;
    uint8 public constant OP_CORR_GUARD = 0xd2;

    error UnknownOpcode(uint256 opcode);
    error OnlySelf();

    // emitted from the linked libraries in this contract's context (declared here for the router ABI)
    event CorrOrderRegistered(
        bytes32 indexed orderHash, address indexed maker, uint8 indexed marketId, uint8 side, uint32 generation, ISwapVM.Order order
    );
    event MakerConfigSet(address indexed maker, CorrFiPricing.MakerConfig config);
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

    ICorrFiHub public immutable HUB;
    address public immutable USDC;
    // protocol constants (M §8.1)
    uint256 public immutable C_O;
    uint256 public immutable GRACE;
    uint256 public immutable HU_MAX;
    uint256 public immutable U0;
    uint256 public immutable U_MAX;

    CorrFiEngine.State internal _st;

    constructor(address aqua, address weth, address owner, ICorrFiHub hub, CorrFiPricing.Params memory prm)
        SwapVM(aqua, weth, owner, "CorrFi Router", "1")
    {
        HUB = hub;
        USDC = hub.usdc();
        C_O = prm.cO;
        GRACE = prm.grace;
        HU_MAX = prm.hUMax;
        U0 = prm.u0;
        U_MAX = prm.uMax;
    }

    // ------------------------------------------------------------------ views

    function params() public view returns (CorrFiPricing.Params memory) {
        return CorrFiPricing.Params(C_O, GRACE, HU_MAX, U0, U_MAX);
    }

    function makerConfig(address maker) external view returns (CorrFiPricing.MakerConfig memory) {
        return _st.config[maker];
    }

    function orderInfo(bytes32 orderHash) external view returns (CorrFiEngine.OrderInfo memory) {
        return _st.orderInfo[orderHash];
    }

    function pairMask(address maker, uint8 marketId, uint32 generation) external view returns (uint8) {
        return _st.pairMask[maker][marketId][generation];
    }

    // ------------------------------------------------------------------ maker settings, registration, entry

    function setMakerConfig(CorrFiPricing.MakerConfig calldata c) external {
        CorrFiOrders.setConfig(_st, c);
    }

    /// Register the maker's Long-book and Short-book orders of one market / generation together (M §5.1).
    function registerCorrPair(ISwapVM.Order calldata longOrder, ISwapVM.Order calldata shortOrder) external {
        CorrFiOrders.registerPair(_st, _env(), longOrder, shortOrder);
    }

    /// Trade on a registered order with the caller as the taker (M §5.6). `limit` is the minimum out (exact-in) or
    /// the maximum in (exact-out).
    function trade(
        ISwapVM.Order calldata order,
        uint8 marketId,
        uint8 side,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint256 limit,
        uint40 deadline
    ) external returns (uint256 amountIn, uint256 amountOut) {
        return CorrFiOrders.enter(_st, USDC, order, marketId, side, isBuy, exactIn, amount, limit, deadline);
    }

    // ------------------------------------------------------------------ opcodes (M §5.2)

    function _env() internal view returns (CorrFiEngine.Env memory) {
        return CorrFiEngine.Env(HUB, USDC, address(AQUA), address(this), params());
    }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        if (opcode == OP_DEADLINE) {
            Deadline.exec(ctx, args);
        } else if (opcode == OP_CORR_REPORT) {
            ctx.swap = CorrFiEngine.report(_st, _env(), ctx.query, ctx.swap, ctx.vm.isStaticContext);
        } else if (opcode == OP_CORR_CURVE) {
            ctx.swap = CorrFiEngine.curve(_st, _env(), ctx.query, ctx.swap, ctx.vm.isStaticContext);
        } else if (opcode == OP_CORR_GUARD) {
            CorrFiEngine.guard(_st, _env(), ctx.query, ctx.swap);
        } else {
            revert UnknownOpcode(opcode);
        }
    }

    // ------------------------------------------------------------------ maker hooks (M §5.3)

    modifier onlySelf() {
        if (msg.sender != address(this)) revert OnlySelf();
        _;
    }

    function preTransferOut(
        address maker,
        address,
        address,
        address tokenOut,
        uint256,
        uint256 amountOut,
        bytes32 orderHash,
        bytes calldata,
        bytes calldata
    ) external onlySelf {
        CorrFiEngine.settleBuy(_env(), maker, tokenOut, amountOut, orderHash);
    }

    function postTransferIn(
        address maker,
        address,
        address tokenIn,
        address,
        uint256 amountIn,
        uint256,
        uint256,
        bytes32 orderHash,
        bytes calldata,
        bytes calldata
    ) external onlySelf {
        CorrFiEngine.settleSell(_env(), maker, tokenIn, amountIn, orderHash);
    }
}
