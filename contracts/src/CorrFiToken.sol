// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title CorrFiToken
/// @notice Long or Short token of one CorrFi market (M §2.3): ERC-20 with 6 decimals, freely transferable, minted
///         and burned only by the market's vault. Deployed once as an implementation and cloned per market
///         (EIP-1167), so name / symbol live in storage set by `initialize`.
contract CorrFiToken is ERC20 {
    error AlreadyInitialized();
    error OnlyVault();

    address public vault;
    string private _tokenName;
    string private _tokenSymbol;

    constructor() ERC20("", "") {
        vault = address(0xdead); // the implementation itself can never be initialized
    }

    function initialize(address vault_, string calldata name_, string calldata symbol_) external {
        if (vault != address(0)) revert AlreadyInitialized();
        vault = vault_;
        _tokenName = name_;
        _tokenSymbol = symbol_;
    }

    modifier onlyVault() {
        if (msg.sender != vault) revert OnlyVault();
        _;
    }

    function name() public view override returns (string memory) {
        return _tokenName;
    }

    function symbol() public view override returns (string memory) {
        return _tokenSymbol;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyVault {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyVault {
        _burn(from, amount);
    }
}
