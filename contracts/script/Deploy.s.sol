// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {Aqua} from "@1inch/aqua/src/Aqua.sol";

import {CorrFiHub} from "../src/CorrFiHub.sol";
import {CorrFiRouter} from "../src/CorrFiRouter.sol";
import {CorrFiLens} from "../src/CorrFiLens.sol";
import {ICorrFiHub} from "../src/interfaces/ICorrFiHub.sol";
import {CorrFiPricing} from "../src/lib/CorrFiPricing.sol";
import {TestUSDC} from "../src/TestUSDC.sol";

/// @notice Deploys the protocol (M §8.2.2): Aqua (unless AQUA is given), the hub (BarFeed / Accumulator /
///         FairValue / market factory), the router with its linked libraries, and the quote lens; registers the
///         router in the hub and writes deployments/<chainId>.json. Markets are created afterwards by the operator
///         tool (engine/bin/create-market.ts), which computes and signs the initial report.
///
/// Environment (no secrets are printed):
///   DEPLOYER_KEY    deployer = hub owner (router rescue owner)
///   USDC            token address; unset -> deploy the test token TestUSDC (local chains and Base Sepolia, DEC-13)
///   USDC_NAME, USDC_SYMBOL   the test token's name / symbol (default "Test USDC" / "tUSDC")
///   AQUA            existing Aqua; unset -> deploy lib/aqua v1.0.0 as is
///   WETH            required by the SwapVM constructor, unused (default: OP Stack predeploy 0x4200...0006)
///   REPORTER, PRICE_SIGNER, TREASURY
///   H_FLOOR, C_O, GRACE, HU_MAX, U0, U_MAX   protocol constants (defaults: M §8.1; c_O = 1.5 from S06, DEC-19)
///   DEPLOY_NAME     output file name under deployments/ (default: the chain id)
contract Deploy is Script {
    function run() external {
        uint256 key = vm.envUint("DEPLOYER_KEY");
        address deployer = vm.addr(key);
        address weth = vm.envOr("WETH", address(0x4200000000000000000000000000000000000006));
        address reporter = vm.envAddress("REPORTER");
        address signer = vm.envAddress("PRICE_SIGNER");
        address treasury = vm.envAddress("TREASURY");
        CorrFiPricing.Params memory prm = CorrFiPricing.Params(
            vm.envOr("C_O", uint256(15e17)), // S06 adopted c_O = 1.5 (DEC-19)
            vm.envOr("GRACE", uint256(60)),
            vm.envOr("HU_MAX", uint256(2e16)),
            vm.envOr("U0", uint256(6e17)),
            vm.envOr("U_MAX", uint256(9e17))
        );

        vm.startBroadcast(key);
        address usdc = vm.envOr("USDC", address(0));
        if (usdc == address(0)) {
            require(block.chainid == 31337 || block.chainid == 84532, "USDC required outside local / Base Sepolia");
            usdc = address(new TestUSDC(vm.envOr("USDC_NAME", string("Test USDC")), vm.envOr("USDC_SYMBOL", string("tUSDC"))));
        }
        address aqua = vm.envOr("AQUA", address(0));
        if (aqua == address(0)) aqua = address(new Aqua());
        CorrFiHub hub = new CorrFiHub(deployer, usdc, vm.envOr("H_FLOOR", uint256(5e15)), reporter, signer, treasury);
        CorrFiRouter router = new CorrFiRouter(aqua, weth, deployer, ICorrFiHub(address(hub)), prm);
        hub.setRouter(address(router));
        CorrFiLens lens = new CorrFiLens(router);
        vm.stopBroadcast();

        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "block", block.number);
        vm.serializeAddress(o, "usdc", usdc);
        vm.serializeAddress(o, "aqua", aqua);
        vm.serializeAddress(o, "hub", address(hub));
        vm.serializeAddress(o, "router", address(router));
        vm.serializeAddress(o, "weth", weth);
        string memory json = vm.serializeAddress(o, "lens", address(lens));
        string memory name = vm.envOr("DEPLOY_NAME", vm.toString(block.chainid));
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", name, ".json");
        vm.writeJson(json, path);
        console2.log("hub", address(hub));
        console2.log("router", address(router));
        console2.log("lens", address(lens));
    }
}
