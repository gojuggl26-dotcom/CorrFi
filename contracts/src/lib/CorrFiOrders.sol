// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license Part of the CorrFi SwapVM router, derived from 1inch SwapVM — "Powered by SwapVM — © Degensoft Ltd
///                 2025" (SwapVM-1.1 §3.1C).
/// @custom:changes 2026-09-26 (CorrFi): order registration, maker settings and the market entry point of the router,
///                 deployed as an external library that runs in the router's context (DEC-12).

import {ISwapVM} from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import {MakerTraits, MakerTraitsLib} from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";
import {IMakerHooks} from "@1inch/swap-vm/contracts/interfaces/IMakerHooks.sol";

import {ICorrFiHub} from "../interfaces/ICorrFiHub.sol";
import {ICorrFiVaultView} from "../interfaces/ICorrFiVaultView.sol";
import {CorrFiPricing} from "./CorrFiPricing.sol";
import {CorrFiEngine} from "./CorrFiEngine.sol";

/// @title CorrFiOrders
/// @notice Order registration (M §5.1), maker settings (M §5.4) and the entry point (M §5.6) of the router.
///         Called by DELEGATECALL: msg.sender is the router's caller (maker or taker) and storage is the router's.
library CorrFiOrders {
    using MakerTraitsLib for MakerTraits;

    uint8 internal constant OP_DEADLINE = 0x20;
    uint8 internal constant OP_CORR_REPORT = 0xd0;
    uint8 internal constant OP_CORR_CURVE = 0xd1;
    uint8 internal constant OP_CORR_GUARD = 0xd2;
    uint256 internal constant PROGRAM_LENGTH = 19; // 0x20 05 obsEnd | 0xd0 06 m side gen | 0xd1 00 | 0xd2 00
    uint256 internal constant MAX_QTY = 1e18; // caps above 10^12 tokens would let the curve's integers overflow

    error BadOrder(uint8 code);
    error AlreadyRegistered(bytes32 orderHash);
    error BadConfig();
    error EntryMismatch();

    event CorrOrderRegistered(
        bytes32 indexed orderHash, address indexed maker, uint8 indexed marketId, uint8 side, uint32 generation, ISwapVM.Order order
    );
    event MakerConfigSet(address indexed maker, CorrFiPricing.MakerConfig config);

    // ------------------------------------------------------------------ maker settings (M §5.4)

    function setConfig(CorrFiEngine.State storage st, CorrFiPricing.MakerConfig calldata c) external {
        if (
            c.kq == 0 || c.qMaxMarket == 0 || c.riskBudget == 0 || c.qMinTrade == 0 || c.qMaxTrade < c.qMinTrade
                || c.qGroup < c.qMaxMarket || c.qGroup > MAX_QTY
        ) revert BadConfig();
        st.config[msg.sender] = c;
        emit MakerConfigSet(msg.sender, c);
    }

    // ------------------------------------------------------------------ order registration (M §5.1, PROP-14)

    /// Register the maker's Long-book and Short-book orders of one market / generation together.
    function registerPair(
        CorrFiEngine.State storage st,
        CorrFiEngine.Env memory e,
        ISwapVM.Order calldata longOrder,
        ISwapVM.Order calldata shortOrder
    ) external {
        (uint8 m, uint32 g) = _register(st, e, longOrder, CorrFiPricing.SIDE_LONG);
        (uint8 m2, uint32 g2) = _register(st, e, shortOrder, CorrFiPricing.SIDE_SHORT);
        if (m != m2 || g != g2) revert BadOrder(1);
    }

    function _register(CorrFiEngine.State storage st, CorrFiEngine.Env memory e, ISwapVM.Order calldata o, uint8 side)
        private
        returns (uint8 marketId, uint32 generation)
    {
        if (o.maker != msg.sender) revert BadOrder(2);
        MakerTraits tr = o.traits;
        // Aqua mode; hooks exactly preTransferOut + postTransferIn targeting the router; no unwrap / permit2 /
        // zero-amount; receiver = maker (M §5.1 table)
        uint256 required = MakerTraitsLib.USE_AQUA_INSTEAD_OF_SIGNATURE_BIT_FLAG
            | MakerTraitsLib.HAS_PRE_TRANSFER_OUT_HOOK_BIT_FLAG | MakerTraitsLib.HAS_POST_TRANSFER_IN_HOOK_BIT_FLAG
            | MakerTraitsLib.PRE_TRANSFER_OUT_HOOK_HAS_TARGET | MakerTraitsLib.POST_TRANSFER_IN_HOOK_HAS_TARGET;
        if (MakerTraits.unwrap(tr) & (uint256(0xfff) << 244) != required) revert BadOrder(3); // bits 244..255
        if (tr.receiver(o.maker) != o.maker) revert BadOrder(4);
        (IMakerHooks targetOut, bytes calldata outData) = tr.preTransferOutHook(o.maker, o.data);
        (IMakerHooks targetIn, bytes calldata inData) = tr.postTransferInHook(o.maker, o.data);
        if (
            address(targetOut) != address(this) || address(targetIn) != address(this) || outData.length != 0
                || inData.length != 0
        ) {
            revert BadOrder(5);
        }
        // program: Deadline(obsEnd) -> CorrReport(m, side, generation) -> CorrCurve -> CorrGuard
        bytes calldata p = tr.program(o.data);
        if (p.length != PROGRAM_LENGTH) revert BadOrder(6);
        marketId = uint8(p[9]);
        if (uint8(p[10]) != side) revert BadOrder(7);
        generation = uint32(bytes4(p[11:15]));
        ICorrFiHub.Quote memory s = e.hub.quoteState(marketId); // reverts for unknown markets
        bytes memory expected = abi.encodePacked(
            OP_DEADLINE, uint8(5), uint40(s.obsEnd), OP_CORR_REPORT, uint8(6), marketId, side, generation
        );
        if (keccak256(abi.encodePacked(expected, OP_CORR_CURVE, uint8(0), OP_CORR_GUARD, uint8(0))) != keccak256(p)) {
            revert BadOrder(8);
        }
        // token pair = {USDC, side token}
        (address a, address b) = tr.tokens(o.data);
        ICorrFiVaultView vault = ICorrFiVaultView(e.hub.marketVault(marketId));
        address sideToken = side == CorrFiPricing.SIDE_LONG ? vault.longToken() : vault.shortToken();
        if (!((a == e.usdc && b == sideToken) || (a == sideToken && b == e.usdc))) revert BadOrder(9);

        bytes32 h = keccak256(abi.encode(o)); // = SwapVM.hash for Aqua-mode orders
        if (st.orderInfo[h].registered) revert AlreadyRegistered(h);
        st.orderInfo[h] = CorrFiEngine.OrderInfo(o.maker, marketId, side, generation, true);
        st.pairMask[o.maker][marketId][generation] |= uint8(1) << side;
        emit CorrOrderRegistered(h, o.maker, marketId, side, generation, o);
    }

    // ------------------------------------------------------------------ entry point (M §5.6, PROP-13 / PROP-15)

    /// Trade on a registered order. The caller stays the taker: this library runs by DELEGATECALL from the router
    /// and runs `swap` by DELEGATECALL to the router again. Transfer mode is always transferFrom + Aqua push (K6).
    /// `limit` is the minimum out (exact-in) or maximum in (exact-out).
    function enter(
        CorrFiEngine.State storage st,
        address usdc,
        ISwapVM.Order calldata order,
        uint8 marketId,
        uint8 side,
        bool isBuy,
        bool exactIn,
        uint256 amount,
        uint256 limit,
        uint40 deadline
    ) external returns (uint256 amountIn, uint256 amountOut) {
        CorrFiEngine.OrderInfo memory info = st.orderInfo[keccak256(abi.encode(order))];
        if (!info.registered || info.marketId != marketId || info.side != side) revert EntryMismatch();
        (address a,) = order.traits.tokens(order.data);
        bool aIsUsdc = a == usdc;
        TakerTraitsLib.Args memory args;
        args.taker = msg.sender;
        args.isExactIn = exactIn;
        args.useTransferFromAndAquaPush = true;
        args.isAToB = isBuy ? aIsUsdc : !aIsUsdc; // tokenIn is USDC for buys
        args.threshold = abi.encodePacked(limit);
        args.deadline = deadline;
        (bool ok, bytes memory ret) =
            address(this).delegatecall(abi.encodeCall(ISwapVM.swap, (order, amount, TakerTraitsLib.build(args))));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        (amountIn, amountOut,) = abi.decode(ret, (uint256, uint256, bytes32));
    }
}
