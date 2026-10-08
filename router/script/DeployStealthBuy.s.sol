// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {StealthBuy, IERC5564Announcer} from "../src/StealthBuy.sol";

/// forge script script/DeployStealthBuy.s.sol --rpc-url mainnet <signer flags> --broadcast --verify
/// No owner, no settings: anyone can deploy it, and the result is the same contract.
contract DeployStealthBuy is Script {
    IPoolManager constant POOL_MANAGER = IPoolManager(0x000000000004444c5dc75cB358380D2e3dE08A90); // Uniswap v4, mainnet
    IERC5564Announcer constant ANNOUNCER = IERC5564Announcer(0x55649E01B5Df198D18D95b5cc5051630cfD45564); // ERC-5564

    function run() external returns (StealthBuy sb) {
        vm.startBroadcast();
        sb = new StealthBuy(POOL_MANAGER, ANNOUNCER);
        vm.stopBroadcast();
        console2.log("StealthBuy:", address(sb));
    }
}
