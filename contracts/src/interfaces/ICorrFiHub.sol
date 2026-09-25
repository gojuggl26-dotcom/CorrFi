// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

/// @notice Read interface of CorrFiHub used by the vaults (S03) and the router (S04).
interface ICorrFiHub {
    /// Data needed to settle a market (M §2.5.3, §5.5).
    struct Settlement {
        uint32 processed;
        uint32 n;
        uint32 nMin;
        uint32 nValid;
        int256 c;
        uint256 va;
        uint256 vb;
    }

    /// Price state read by the router at trade time (M §4.2.2, §5.2.1).
    struct Quote {
        uint256 pFair;
        uint256 h0;
        uint256 sig2;
        uint32 confirmed; // price-confirmed bars
        uint32 processed; // accumulated bars
        uint32 invalidBars; // processed - nValid (T-4)
        uint32 n;
        uint32 nMin;
        uint64 obsStart;
        uint64 obsEnd;
    }

    function router() external view returns (address);
    function treasury() external view returns (address);
    function usdc() external view returns (address);
    function marketCount() external view returns (uint8);
    function marketVault(uint8 marketId) external view returns (address);
    function settlement(uint8 marketId) external view returns (Settlement memory);
    function quoteState(uint8 marketId) external view returns (Quote memory);
}
