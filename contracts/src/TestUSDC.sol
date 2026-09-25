// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice The 6-decimal test token CorrFi uses instead of Circle's USDC on Base Sepolia (DEC-13) and on local chains.
///         It has no value; anyone can mint (no faucet cap: user decision 2026-09-26). The symbol is not "USDC" so
///         that it cannot be mistaken for Circle's token (default "tUSDC"; the local replay shows "USDC (replay)").
contract TestUSDC is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
