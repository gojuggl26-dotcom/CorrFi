// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiVault} from "../src/CorrFiVault.sol";
import {CorrFiToken} from "../src/CorrFiToken.sol";
import {CorrFiMath} from "../src/lib/CorrFiMath.sol";
import {MockUSDC} from "./helpers/MockUSDC.sol";

/// @notice Test-only hub: settlement data chosen by the test so Long_T can be any value in [0, 1].
contract MockHub {
    address public router;
    address public treasury = address(0x7EA5);
    int256 public c;

    function setRouter(address router_) external {
        router = router_;
    }

    function setRho(int256 rho) external {
        c = rho;
    }

    function settlement(uint8) external view returns (ICorrFiHub.Settlement memory s) {
        // va = vb = WAD -> rho = c exactly; every bar valid
        s = ICorrFiHub.Settlement(2016, 2016, 1996, 2016, c, 1e18, 1e18);
    }
}

/// @notice Random operation sequences on one vault. The handler is also the (test) router.
contract VaultHandler is Test {
    CorrFiVault public v;
    CorrFiToken public lng;
    CorrFiToken public sht;
    MockUSDC public usdc;
    MockHub public hub;
    address public constant MAKER = address(0x3A3E);
    address[3] public actors = [address(0xA1), address(0xA2), address(0xA3)];
    bool public settled;
    uint256 public paidOut;
    uint256 public collateralAtSettlement;

    constructor(CorrFiVault v_, MockUSDC usdc_, MockHub hub_) {
        v = v_;
        lng = v_.longToken();
        sht = v_.shortToken();
        usdc = usdc_;
        hub = hub_;
        for (uint256 i; i < 3; ++i) {
            usdc.mint(actors[i], 1e15);
            vm.prank(actors[i]);
            usdc.approve(address(v), type(uint256).max);
        }
        usdc.mint(address(this), 1e15);
        usdc.approve(address(v), type(uint256).max);
        lng.approve(address(v), type(uint256).max);
        sht.approve(address(v), type(uint256).max);
    }

    function _actor(uint256 s) internal view returns (address) {
        return actors[s % 3];
    }

    // ---- before settlement

    function mint(uint256 who, uint256 amount) external {
        if (settled) return;
        amount = bound(amount, 1, 1e12);
        vm.prank(_actor(who));
        v.mint(amount);
    }

    function burn(uint256 who, uint256 amount) external {
        if (settled) return;
        address a = _actor(who);
        uint256 max = lng.balanceOf(a) < sht.balanceOf(a) ? lng.balanceOf(a) : sht.balanceOf(a);
        if (max == 0) return;
        vm.prank(a);
        v.burn(bound(amount, 1, max));
    }

    function transfer(uint256 from, uint256 to, bool long_, uint256 amount) external {
        address a = _actor(from);
        CorrFiToken t = long_ ? lng : sht;
        uint256 bal = t.balanceOf(a);
        if (bal == 0) return;
        vm.prank(a);
        t.transfer(_actor(to), bound(amount, 1, bal));
    }

    /// Router mints pairs and puts one side into the maker's custody (D1 / D3 mint leg), keeping A2.
    function routerMintToCustody(uint256 amount, bool long_) external {
        if (settled) return;
        amount = bound(amount, 1, 1e12);
        if (long_ && v.depositShort(MAKER) != 0) long_ = false;
        if (!long_ && v.depositLong(MAKER) != 0) long_ = true;
        v.mint(amount);
        v.depositIn(MAKER, long_ ? CorrFiVault.Side.Long : CorrFiVault.Side.Short, amount);
    }

    /// Router hands custody tokens to a taker (D1 / D3 in-stock leg).
    function routerCustodyOut(uint256 amount, uint256 to) external {
        if (settled) return;
        bool long_ = v.depositLong(MAKER) != 0;
        uint256 bal = long_ ? v.depositLong(MAKER) : v.depositShort(MAKER);
        if (bal == 0) return;
        v.depositOut(MAKER, long_ ? CorrFiVault.Side.Long : CorrFiVault.Side.Short, bound(amount, 1, bal), _actor(to));
    }

    // ---- settlement and after

    function settle(int256 rho) external {
        if (settled) return;
        hub.setRho(bound(rho, -1e18, 1e18));
        vm.warp(v.obsEnd());
        v.finalize();
        settled = true;
        collateralAtSettlement = usdc.balanceOf(address(v));
    }

    function redeem(uint256 who, uint256 ql, uint256 qs) external {
        if (!settled) return;
        address a = _actor(who);
        ql = bound(ql, 0, lng.balanceOf(a));
        qs = bound(qs, 0, sht.balanceOf(a));
        if (ql == 0 && qs == 0) return;
        vm.prank(a);
        paidOut += v.redeem(ql, qs);
    }

    function claim() external {
        if (!settled || (v.depositLong(MAKER) == 0 && v.depositShort(MAKER) == 0)) return;
        vm.prank(MAKER);
        paidOut += v.claimDeposit();
    }

    function sweep() external {
        if (!settled) return;
        paidOut += v.sweepDust();
    }

    /// Total amount every current holder could still claim (floor per holder, M §5.5).
    function outstandingClaims() external view returns (uint256 total) {
        uint256 l = v.longT();
        for (uint256 i; i < 3; ++i) total += CorrFiMath.payout(lng.balanceOf(actors[i]), sht.balanceOf(actors[i]), l);
        total += CorrFiMath.payout(lng.balanceOf(address(this)), sht.balanceOf(address(this)), l);
        total += CorrFiMath.payout(v.depositLong(MAKER), v.depositShort(MAKER), l);
    }
}

contract VaultInvariantTest is Test {
    VaultHandler handler;
    CorrFiVault v;
    MockUSDC usdc;

    function setUp() public {
        usdc = new MockUSDC();
        MockHub hub = new MockHub();
        CorrFiVault impl = new CorrFiVault();
        CorrFiToken timpl = new CorrFiToken();
        v = CorrFiVault(Clones.clone(address(impl)));
        CorrFiToken l = CorrFiToken(Clones.clone(address(timpl)));
        CorrFiToken s = CorrFiToken(Clones.clone(address(timpl)));
        l.initialize(address(v), "L", "L");
        s.initialize(address(v), "S", "S");
        v.initialize(address(hub), 0, address(usdc), address(l), address(s), uint64(block.timestamp + 7 days));
        handler = new VaultHandler(v, usdc, hub);
        hub.setRouter(address(handler)); // the handler plays the (test) router
        targetContract(address(handler));
    }

    /// A1 (before settlement): Long supply = Short supply = collateral = USDC held.
    /// A2 / A5: custody is one-sided and the ledger equals the tokens the vault holds.
    /// S1 / A4 (after settlement): the vault can always pay every outstanding holder.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 64
    function invariant_accounting() public view {
        CorrFiToken lng = v.longToken();
        CorrFiToken sht = v.shortToken();
        address maker = handler.MAKER();
        assertTrue(v.depositLong(maker) == 0 || v.depositShort(maker) == 0, "A2");
        assertEq(lng.balanceOf(address(v)), v.depositLong(maker), "A5 long");
        assertEq(sht.balanceOf(address(v)), v.depositShort(maker), "A5 short");
        if (!handler.settled()) {
            assertEq(lng.totalSupply(), sht.totalSupply(), "A1 supplies");
            assertEq(lng.totalSupply(), v.collateral(), "A1 collateral");
            assertEq(usdc.balanceOf(address(v)), v.collateral(), "A1 USDC");
        } else {
            assertGe(usdc.balanceOf(address(v)), handler.outstandingClaims(), "S1");
            assertLe(handler.paidOut(), handler.collateralAtSettlement(), "no more paid than held");
        }
    }
}
