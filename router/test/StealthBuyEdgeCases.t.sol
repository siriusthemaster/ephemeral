// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {DeltaReturningHook} from "v4-core/test/DeltaReturningHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StealthBuy} from "../src/StealthBuy.sol";
import {StealthBuyBase} from "./StealthBuy.t.sol";

/// @dev A stealth "address" that is a contract and re-enters StealthBuy when it receives the gas tip.
contract ReenteringStealth {
    StealthBuy immutable sb;
    PoolKey key;
    bytes ephKey;
    uint256 public reentered;
    uint256 public innerOut;

    constructor(StealthBuy _sb, PoolKey memory _key, bytes memory _ephKey) {
        sb = _sb;
        key = _key;
        ephKey = _ephKey;
    }

    receive() external payable {
        if (reentered == 0) {
            reentered = 1;
            innerOut = sb.buy{value: address(this).balance}(
                key, StealthBuy.Stealth(address(this), ephKey, bytes1(0x11), 0, 0), ""
            );
        }
    }
}

/// @dev A buyer contract that re-enters on its refund.
contract ReenteringBuyer {
    StealthBuy immutable sb;
    PoolKey key;
    PoolKey key2;
    bytes ephKey;
    address stealth;
    uint256 depth;

    constructor(StealthBuy _sb, PoolKey memory _key, PoolKey memory _key2, bytes memory _ephKey, address _stealth) {
        sb = _sb;
        key = _key;
        key2 = _key2;
        ephKey = _ephKey;
        stealth = _stealth;
    }

    function go(uint256 amount) external {
        sb.buy{value: amount}(key, StealthBuy.Stealth(stealth, ephKey, bytes1(0x22), 0, 0), "");
    }

    receive() external payable {
        if (depth == 0 && address(this).balance > 0.01 ether) {
            depth = 1;
            sb.buy{value: 0.01 ether}(key2, StealthBuy.Stealth(stealth, ephKey, bytes1(0x22), 0, 0), "");
        }
    }
}

contract StealthBuyEdgeCasesTest is StealthBuyBase {
    function test_reentrantStealthAddressCannotTouchOtherFunds() public {
        ReenteringStealth rs = new ReenteringStealth(sb, poolKey, ephKey);
        vm.deal(address(rs), 0.5 ether);
        uint256 tip = 0.01 ether;
        vm.prank(buyer);
        uint256 out = sb.buy{value: 1 ether + tip}(poolKey, StealthBuy.Stealth(address(rs), ephKey, 0xaa, 0, tip), "");
        assertEq(rs.reentered(), 1);
        assertEq(tkn.balanceOf(address(rs)), out + rs.innerOut(), "both buys delivered");
        assertEq(address(sb).balance, 0, "router holds nothing");
        assertEq(buyer.balance, 100 ether - 1 ether - tip, "outer buyer paid exactly swap + tip");
    }

    function test_reentrantBuyerOnRefundIsHarmless() public {
        (PoolKey memory key, MockERC20 narrow) = _narrowPool();
        ReenteringBuyer rb = new ReenteringBuyer(sb, key, poolKey, ephKey, stealth);
        vm.deal(address(rb), 50 ether);
        rb.go(50 ether);
        assertEq(address(sb).balance, 0);
        assertGt(narrow.balanceOf(stealth), 0);
        assertGt(address(rb).balance, 40 ether, "refund of the unfilled part came back");
        assertGt(tkn.balanceOf(stealth), 0, "re-entrant buy on the second pool also delivered");
    }

    function test_partialFillRefundIsExact() public {
        (PoolKey memory key, MockERC20 narrow) = _narrowPool();
        uint256 pmBefore = address(manager).balance;
        vm.prank(buyer);
        uint256 out = sb.buy{value: 20 ether + 0.001 ether}(key, StealthBuy.Stealth(stealth, ephKey, 0xbb, 0, 0.001 ether), "");
        uint256 ethIntoPool = address(manager).balance - pmBefore;
        assertLt(ethIntoPool, 20 ether, "partial fill");
        assertEq(buyer.balance, 100 ether - ethIntoPool - 0.001 ether, "refund = unused ETH, exactly");
        assertEq(narrow.balanceOf(stealth), out);
        assertEq(address(sb).balance, 0);
    }

    function test_hookCreditingEthToCallerJustReverts() public {
        (PoolKey memory key, MockERC20 t, address hookAddr) = _deltaHookPool();
        t.mint(address(manager), 1_000 ether); // unaccounted tokens so the hook's take below can succeed
        // hook pays 5 ETH into every swap's specified side: the caller would be owed ETH
        DeltaReturningHook(hookAddr).setDeltaSpecified(-5 ether);
        uint256 before = buyer.balance;
        vm.prank(buyer);
        vm.expectRevert(bytes4(0x5212cba1)); // CurrencyNotSettled(): StealthBuy never takes positive ETH deltas
        sb.buy{value: 0.01 ether}(key, StealthBuy.Stealth(stealth, ephKey, 0xcc, 0, 0), "");
        assertEq(buyer.balance, before);

        // hook takes 100% of the output tokens: the caller ends with a token debt -> revert, no ETH lost
        DeltaReturningHook(hookAddr).setDeltaSpecified(0);
        DeltaReturningHook(hookAddr).setDeltaUnspecifiedAfterSwap(1 ether);
        vm.prank(buyer);
        vm.expectRevert(bytes4(0x5212cba1)); // CurrencyNotSettled()
        sb.buy{value: 0.01 ether}(key, StealthBuy.Stealth(stealth, ephKey, 0xcc, 0, 0), "");
    }

    function test_tokenSideFeeHookAnnouncesWhatArrived() public {
        (PoolKey memory key, MockERC20 t, address hookAddr) = _deltaHookPool();
        DeltaReturningHook(hookAddr).setDeltaUnspecifiedAfterSwap(0.001 ether); // hook keeps 0.001 TKN of the output
        vm.recordLogs();
        vm.prank(buyer);
        uint256 out = sb.buy{value: 0.1 ether}(key, StealthBuy.Stealth(stealth, ephKey, 0xdd, 0, 0), "");
        assertEq(t.balanceOf(stealth), out, "announced amount = amount that arrived, net of the hook take");
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == ANNOUNCER) {
                (, bytes memory metadata) = abi.decode(logs[i].data, (bytes, bytes));
                assertEq(metadata.length, 57, "ERC-5564 token metadata is 57 bytes");
                assertEq(uint8(metadata[0]), 0xdd);
                assertEq(bytes4(bytes.concat(metadata[1], metadata[2], metadata[3], metadata[4])), bytes4(0xa9059cbb));
                found = true;
            }
        }
        assertTrue(found);
    }

    function _deltaHookPool() internal returns (PoolKey memory key, MockERC20 t, address hookAddr) {
        hookAddr = address(
            uint160(
                Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG
                    | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
            )
        );
        vm.etch(hookAddr, address(new DeltaReturningHook(manager)).code);
        vm.deal(hookAddr, 10 ether);
        t = new MockERC20("T", "T", 18);
        t.mint(address(this), 1_000_000 ether);
        t.mint(hookAddr, 1_000 ether);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        (key,) = initPoolAndAddLiquidityETH(
            CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(t)), IHooks(hookAddr), 3000, SQRT_PRICE_1_1, 10 ether
        );
    }

    /// @dev Deployers' LIQUIDITY_PARAMS: ticks -120..120, 1e18 liquidity, only a little ETH of depth.
    function _narrowPool() internal returns (PoolKey memory key, MockERC20 t) {
        t = new MockERC20("N", "N", 18);
        t.mint(address(this), 1_000_000 ether);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        (key,) = initPoolAndAddLiquidityETH(
            CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(t)), IHooks(address(0)), 3000, SQRT_PRICE_1_1, 10 ether
        );
    }
}
