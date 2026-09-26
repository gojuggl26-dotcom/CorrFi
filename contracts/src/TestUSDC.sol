// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title TestUSDC
/// @notice The 6-decimal test token CorrFi uses instead of Circle's USDC on Base Sepolia (DEC-13) and on local chains.
///         It has no value. The deployer (owner) mints without limit to fund makers and bots; anyone else mints any
///         amount through `faucet`, up to FAUCET_DAILY_LIMIT per address in each 24-hour window (the window starts at
///         the first claim after the previous one ended). The symbol is not "USDC" so that it cannot be mistaken for
///         Circle's token (default "tUSDC"; the local replay shows "USDC (replay)").
contract TestUSDC is ERC20, Ownable {
    uint256 public constant FAUCET_DAILY_LIMIT = 10_000e6;
    uint256 public constant FAUCET_PERIOD = 1 days;

    /// One storage slot per address: when its current window started and how much it has claimed in it.
    struct Claim {
        uint64 windowStart;
        uint192 used;
    }

    mapping(address => Claim) internal _claims;

    event FaucetClaimed(address indexed account, uint256 amount);

    error FaucetZeroAmount();
    error FaucetLimitExceeded(uint256 available, uint256 resetsAt);

    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) Ownable(msg.sender) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// Owner only, no cap: funding makers, bots and fixtures.
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// Anyone: `amount` to the caller, within what is left of FAUCET_DAILY_LIMIT in the current window.
    function faucet(uint256 amount) external {
        if (amount == 0) revert FaucetZeroAmount();
        Claim memory c = _claims[msg.sender];
        if (block.timestamp >= uint256(c.windowStart) + FAUCET_PERIOD) c = Claim(uint64(block.timestamp), 0);
        uint256 available = FAUCET_DAILY_LIMIT - c.used;
        if (amount > available) revert FaucetLimitExceeded(available, uint256(c.windowStart) + FAUCET_PERIOD);
        c.used += uint192(amount);
        _claims[msg.sender] = c;
        _mint(msg.sender, amount);
        emit FaucetClaimed(msg.sender, amount);
    }

    /// What `account` can still claim now, and when its window resets (0 when no window is open).
    function faucetAvailable(address account) external view returns (uint256 available, uint256 resetsAt) {
        Claim memory c = _claims[account];
        if (block.timestamp >= uint256(c.windowStart) + FAUCET_PERIOD) return (FAUCET_DAILY_LIMIT, 0);
        return (FAUCET_DAILY_LIMIT - c.used, uint256(c.windowStart) + FAUCET_PERIOD);
    }
}
