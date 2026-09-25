// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import {ICorrFiHub} from "./interfaces/ICorrFiHub.sol";
import {CorrFiMath} from "./lib/CorrFiMath.sol";
import {CorrFiToken} from "./CorrFiToken.sol";

/// @title CorrFiVault
/// @notice Collateral vault of one market (M §2.3-2.4, §5.4-5.5): 1 USDC <-> 1 Long + 1 Short, settlement,
///         pull-based redemption, the Maker inventory custody (moved only by the router), and the true-dust sweep.
///         Cloned per market by CorrFiHub (EIP-1167).
contract CorrFiVault is ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 internal constant WAD = 1e18;

    enum Side {
        Long,
        Short
    }

    error AlreadyInitialized();
    error OnlyRouter();
    error MintClosed();
    error AlreadyFinalized();
    error NotFinalized();
    error NotReady(uint32 processed, uint32 n);
    error ZeroAmount();
    error OppositeDepositNotEmpty();
    error BadRecipient();

    event Minted(address indexed account, uint256 amount);
    event Burned(address indexed account, uint256 amount);
    event Finalized(uint256 longT, bool isVoid, int256 rho, uint32 nValid, uint32 processed);
    event Redeemed(address indexed account, uint256 longAmount, uint256 shortAmount, uint256 payout);
    event DepositIn(address indexed maker, Side side, uint256 amount);
    event DepositOut(address indexed maker, Side side, uint256 amount, address to);
    event DepositClaimed(address indexed maker, uint256 longAmount, uint256 shortAmount, uint256 payout);
    event DustSwept(address indexed treasury, uint256 amount);

    ICorrFiHub public hub;
    uint8 public marketId;
    IERC20 public usdc;
    CorrFiToken public longToken;
    CorrFiToken public shortToken;
    uint64 public obsEnd;

    uint256 public collateral; // USDC backing the outstanding pairs before settlement (A1)
    bool public finalized;
    bool public isVoid;
    uint256 public longT; // settlement value of Long (WAD)

    /// Maker inventory held in custody (M §5.4): the ledger N_L, N_S is exactly these balances (A5).
    mapping(address maker => uint256) public depositLong;
    mapping(address maker => uint256) public depositShort;

    constructor() {
        hub = ICorrFiHub(address(0xdead)); // the implementation itself can never be initialized
    }

    function initialize(address hub_, uint8 marketId_, address usdc_, address long_, address short_, uint64 obsEnd_)
        external
    {
        if (address(hub) != address(0)) revert AlreadyInitialized();
        hub = ICorrFiHub(hub_);
        marketId = marketId_;
        usdc = IERC20(usdc_);
        longToken = CorrFiToken(long_);
        shortToken = CorrFiToken(short_);
        obsEnd = obsEnd_;
    }

    // ------------------------------------------------------------------ direct operations (anyone)

    /// 1 USDC -> 1 Long + 1 Short, before obsEnd.
    function mint(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (block.timestamp >= obsEnd) revert MintClosed();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        collateral += amount;
        longToken.mint(msg.sender, amount);
        shortToken.mint(msg.sender, amount);
        emit Minted(msg.sender, amount);
    }

    /// 1 Long + 1 Short -> 1 USDC, before finalize.
    function burn(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (finalized) revert AlreadyFinalized();
        longToken.burn(msg.sender, amount);
        shortToken.burn(msg.sender, amount);
        collateral -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Burned(msg.sender, amount);
    }

    /// Fix Long_T once every bar has been processed (the hub's crank treats unposted points as invalid after
    /// obsEnd + 48 h, so this is always reachable — M §5.5, §6.2.1, PROP-09).
    function finalize() external nonReentrant {
        if (finalized) revert AlreadyFinalized();
        ICorrFiHub.Settlement memory s = hub.settlement(marketId);
        if (s.processed != s.n) revert NotReady(s.processed, s.n);
        (uint256 l, bool v) = CorrFiMath.longT(s.c, s.va, s.vb, s.nValid, s.nMin);
        finalized = true;
        isVoid = v;
        longT = l;
        emit Finalized(l, v, v ? int256(0) : CorrFiMath.rho(s.c, s.va, s.vb), s.nValid, s.processed);
    }

    /// Burn Long / Short and receive floor(qL * L) + floor(qS * (1 - L)) (M §5.5). No deadline (DEC-01).
    function redeem(uint256 longAmount, uint256 shortAmount) external nonReentrant returns (uint256 payout) {
        if (!finalized) revert NotFinalized();
        if (longAmount == 0 && shortAmount == 0) revert ZeroAmount();
        if (longAmount != 0) longToken.burn(msg.sender, longAmount);
        if (shortAmount != 0) shortToken.burn(msg.sender, shortAmount);
        payout = CorrFiMath.payout(longAmount, shortAmount, longT);
        usdc.safeTransfer(msg.sender, payout);
        emit Redeemed(msg.sender, longAmount, shortAmount, payout);
    }

    // ------------------------------------------------------------------ Maker custody (router only, M §5.4)

    modifier onlyRouter() {
        if (msg.sender != hub.router()) revert OnlyRouter();
        _;
    }

    /// Router hands `amount` of `side` tokens (pulled from msg.sender) into the maker's custody.
    /// The opposite custody must be empty: min(N_L, N_S) = 0 (A2) is enforced here as well.
    function depositIn(address maker, Side side, uint256 amount) external onlyRouter nonReentrant {
        if (finalized) revert AlreadyFinalized();
        if (amount == 0) revert ZeroAmount();
        if (side == Side.Long) {
            if (depositShort[maker] != 0) revert OppositeDepositNotEmpty();
            depositLong[maker] += amount;
            IERC20(address(longToken)).safeTransferFrom(msg.sender, address(this), amount);
        } else {
            if (depositLong[maker] != 0) revert OppositeDepositNotEmpty();
            depositShort[maker] += amount;
            IERC20(address(shortToken)).safeTransferFrom(msg.sender, address(this), amount);
        }
        emit DepositIn(maker, side, amount);
    }

    /// Router takes `amount` of `side` tokens out of the maker's custody and sends them to `to`.
    function depositOut(address maker, Side side, uint256 amount, address to) external onlyRouter nonReentrant {
        if (finalized) revert AlreadyFinalized();
        if (amount == 0) revert ZeroAmount();
        if (to == address(this)) revert BadRecipient(); // would shrink the ledger but keep the tokens (A5, review S03-7)
        if (side == Side.Long) {
            depositLong[maker] -= amount;
            IERC20(address(longToken)).safeTransfer(to, amount);
        } else {
            depositShort[maker] -= amount;
            IERC20(address(shortToken)).safeTransfer(to, amount);
        }
        emit DepositOut(maker, side, amount, to);
    }

    /// After settlement the maker redeems its custody with the same formula as redeem (M §5.4-5.5).
    function claimDeposit() external nonReentrant returns (uint256 payout) {
        if (!finalized) revert NotFinalized();
        uint256 ql = depositLong[msg.sender];
        uint256 qs = depositShort[msg.sender];
        if (ql == 0 && qs == 0) revert ZeroAmount();
        depositLong[msg.sender] = 0;
        depositShort[msg.sender] = 0;
        if (ql != 0) longToken.burn(address(this), ql);
        if (qs != 0) shortToken.burn(address(this), qs);
        payout = CorrFiMath.payout(ql, qs, longT);
        usdc.safeTransfer(msg.sender, payout);
        emit DepositClaimed(msg.sender, ql, qs, payout);
    }

    /// The maker's custody and whether the market is settled, in one read (the router's exposure loop, S04-14).
    function custodyOf(address maker) external view returns (uint256 nl, uint256 ns, bool isFinalized) {
        return (depositLong[maker], depositShort[maker], finalized);
    }

    // ------------------------------------------------------------------ true dust (DEC-01)

    /// Anything above the (rounded-up) value of every outstanding token — custody included, because custody
    /// tokens are part of the total supply — goes to the treasury. Outstanding holders can always redeem in full.
    function sweepDust() external nonReentrant returns (uint256 amount) {
        if (!finalized) revert NotFinalized();
        uint256 keep = CorrFiMath.reserve(longToken.totalSupply(), shortToken.totalSupply(), longT);
        uint256 bal = usdc.balanceOf(address(this));
        if (bal <= keep) return 0;
        amount = bal - keep;
        address to = hub.treasury();
        usdc.safeTransfer(to, amount);
        emit DustSwept(to, amount);
    }
}
