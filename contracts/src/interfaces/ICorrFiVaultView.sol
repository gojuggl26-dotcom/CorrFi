// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Vault reads used by the router and the quote breakdown.
interface ICorrFiVaultView {
    function depositLong(address maker) external view returns (uint256);
    function depositShort(address maker) external view returns (uint256);
    function finalized() external view returns (bool);
    function longToken() external view returns (address);
    function shortToken() external view returns (address);
}
