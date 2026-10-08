// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PoolManager} from "v4-core/PoolManager.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {PoolModifyLiquidityTest} from "v4-core/test/PoolModifyLiquidityTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StealthBuy, IERC5564Announcer} from "../src/StealthBuy.sol";
import {ERC5564Announcer} from "./ERC5564Announcer.sol";

/// @notice Local anvil only (chain id 31337), used by e2e/run.sh. Plain Uniswap v4, nothing else:
///         a fresh PoolManager (v4-core v4.0.0), a mock token, a native-ETH/token pool without a hook and deep liquidity,
///         the ERC-5564 Announcer at its canonical address, and StealthBuy. Writes the addresses to e2e/local.json.
/// forge script script/LocalSetup.s.sol --rpc-url http://127.0.0.1:8545 --broadcast --slow --unlocked --sender <anvil account 0>
contract LocalSetup is Script {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    uint160 constant SQRT_PRICE_1_1 = 79228162514264337593543950336;
    string constant OUT = "e2e/local.json";

    function run() external {
        require(block.chainid == 31337, "LocalSetup: local anvil only");
        uint256 startBlock = block.number;

        // The canonical Announcer address, with the standard Announcer code on it (anvil_setCode, local chains only).
        vm.rpc(
            "anvil_setCode",
            string.concat('["', vm.toString(ANNOUNCER), '","', vm.toString(type(ERC5564Announcer).runtimeCode), '"]')
        );

        vm.startBroadcast();
        PoolManager pm = new PoolManager(msg.sender);
        PoolModifyLiquidityTest lp = new PoolModifyLiquidityTest(IPoolManager(address(pm)));
        MockERC20 tkn = new MockERC20("Test Token", "TKN", 18);
        tkn.mint(msg.sender, 10_000 ether);
        tkn.approve(address(lp), type(uint256).max);

        // ETH/TKN at 1:1, 0.3% LP fee, no hook, full-range liquidity of about 1,000 ETH + 1,000 TKN.
        PoolKey memory key = PoolKey(Currency.wrap(address(0)), Currency.wrap(address(tkn)), 3000, 60, IHooks(address(0)));
        pm.initialize(key, SQRT_PRICE_1_1);
        lp.modifyLiquidity{value: 1_001 ether}(
            key, IPoolManager.ModifyLiquidityParams({tickLower: -887220, tickUpper: 887220, liquidityDelta: 1_000 ether, salt: 0}), ""
        );

        StealthBuy sb = new StealthBuy(IPoolManager(address(pm)), IERC5564Announcer(ANNOUNCER));
        vm.stopBroadcast();

        string memory o = "local";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeUint(o, "startBlock", startBlock);
        vm.serializeAddress(o, "announcer", ANNOUNCER);
        vm.serializeAddress(o, "poolManager", address(pm));
        vm.serializeAddress(o, "token", address(tkn));
        vm.serializeAddress(o, "stealthBuy", address(sb));
        vm.serializeUint(o, "fee", key.fee);
        vm.serializeInt(o, "tickSpacing", key.tickSpacing);
        string memory json = vm.serializeAddress(o, "hooks", address(key.hooks));
        vm.writeJson(json, OUT);

        console2.log("PoolManager", address(pm));
        console2.log("Token      ", address(tkn));
        console2.log("StealthBuy ", address(sb));
        console2.log("Announcer  ", ANNOUNCER);
        console2.log("wrote", OUT);
    }
}
