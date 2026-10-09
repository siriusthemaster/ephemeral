// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {Hooks} from "v4-core/libraries/Hooks.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {BaseTestHooks} from "v4-core/test/BaseTestHooks.sol";
import {DeltaReturningHook} from "v4-core/test/DeltaReturningHook.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StealthBuy} from "../src/StealthBuy.sol";
import {StealthBuyBase} from "./StealthBuy.t.sol";

/// @dev A stealth "address" that is a contract and re-enters StealthBuy when it receives the gas tip.
///      Its own address is no longer fresh by then, so the inner buy goes to another (fresh) stealth address.
contract ReenteringStealth {
    StealthBuy immutable sb;
    PoolKey key;
    bytes ephKey;
    address innerStealth;
    uint256 public reentered;
    uint256 public innerOut;

    constructor(StealthBuy _sb, PoolKey memory _key, bytes memory _ephKey, address _innerStealth) payable {
        sb = _sb;
        key = _key;
        ephKey = _ephKey;
        innerStealth = _innerStealth;
    }

    receive() external payable {
        if (reentered == 0) {
            reentered = 1;
            innerOut = sb.buy{value: address(this).balance}(
                key, StealthBuy.Stealth(innerStealth, ephKey, bytes1(0x11), 0, 0), ""
            );
        }
    }
}

/// @dev afterSwap hook that deploys a contract with CREATE2 (init code, salt and ETH value in hookData). The fresh-address
///      check runs before the swap, so this is how code can still appear on the stealth address within the buy.
contract DeployOnSwapHook is BaseTestHooks {
    function afterSwap(address, PoolKey calldata, IPoolManager.SwapParams calldata, BalanceDelta, bytes calldata hookData)
        external
        override
        returns (bytes4, int128)
    {
        (bytes memory initCode, bytes32 salt, uint256 value) = abi.decode(hookData, (bytes, bytes32, uint256));
        address deployed;
        assembly ("memory-safe") {
            deployed := create2(value, add(initCode, 0x20), mload(initCode), salt)
        }
        require(deployed != address(0), "create2 failed");
        return (IHooks.afterSwap.selector, 0);
    }
}

/// @dev A buyer contract that re-enters on its refund, buying on a second pool for `innerStealth`. The inner buy's revert
///      data is kept (not bubbled), so a test can see why it failed.
contract ReenteringBuyer {
    StealthBuy immutable sb;
    PoolKey key;
    PoolKey key2;
    bytes ephKey;
    address stealth;
    address innerStealth;
    uint256 depth;
    bytes public innerError;

    constructor(
        StealthBuy _sb,
        PoolKey memory _key,
        PoolKey memory _key2,
        bytes memory _ephKey,
        address _stealth,
        address _innerStealth
    ) {
        sb = _sb;
        key = _key;
        key2 = _key2;
        ephKey = _ephKey;
        stealth = _stealth;
        innerStealth = _innerStealth;
    }

    function go(uint256 amount) external {
        sb.buy{value: amount}(key, StealthBuy.Stealth(stealth, ephKey, bytes1(0x22), 0, 0), "");
    }

    receive() external payable {
        if (depth == 0 && address(this).balance > 0.01 ether) {
            depth = 1;
            try sb.buy{value: 0.01 ether}(key2, StealthBuy.Stealth(innerStealth, ephKey, bytes1(0x22), 0, 0), "") {}
            catch (bytes memory err) {
                innerError = err;
            }
        }
    }
}

contract StealthBuyEdgeCasesTest is StealthBuyBase {
    /// @dev A contract already on the stealth address is refused by the fresh-address check. Code can still appear there
    ///      during the buy (here a hook deploys it with CREATE2 mid-swap); its re-entry on the tip stays harmless.
    function test_reentrantStealthAddressCannotTouchOtherFunds() public {
        address hookAddr = address(uint160(0xC0DE) << 144 | Hooks.AFTER_SWAP_FLAG);
        vm.etch(hookAddr, address(new DeployOnSwapHook()).code);
        vm.deal(hookAddr, 0.5 ether);
        (PoolKey memory key, MockERC20 t) = _deepEthPool(IHooks(hookAddr));
        address innerStealth = makeAddr("inner stealth");
        bytes memory initCode =
            abi.encodePacked(type(ReenteringStealth).creationCode, abi.encode(sb, poolKey, ephKey, innerStealth));
        bytes32 salt = keccak256("stealth");
        address rs = vm.computeCreate2Address(salt, keccak256(initCode), hookAddr);
        assertEq(rs.code.length, 0, "fresh before the buy");

        uint256 tip = 0.01 ether;
        vm.prank(buyer);
        uint256 out = sb.buy{value: 1 ether + tip}(
            key, StealthBuy.Stealth(rs, ephKey, 0xaa, 0, tip), abi.encode(initCode, salt, uint256(0.5 ether))
        );
        assertGt(rs.code.length, 0, "deployed during the buy");
        assertEq(ReenteringStealth(payable(rs)).reentered(), 1);
        assertEq(t.balanceOf(rs), out, "outer buy delivered");
        assertEq(tkn.balanceOf(innerStealth), ReenteringStealth(payable(rs)).innerOut(), "inner buy delivered");
        assertGt(tkn.balanceOf(innerStealth), 0);
        assertEq(rs.balance, 0, "the re-entrant buy spent its own ETH + the tip, nothing more");
        assertEq(address(sb).balance, 0, "router holds nothing");
        assertEq(buyer.balance, 100 ether - 1 ether - tip, "outer buyer paid exactly swap + tip");
    }

    function test_stealthAddressWithCodeReverts() public {
        ReenteringStealth rs = new ReenteringStealth(sb, poolKey, ephKey, makeAddr("inner stealth"));
        address delegated = makeAddr("delegated eoa");
        vm.etch(delegated, abi.encodePacked(hex"ef0100", address(rs))); // EIP-7702 delegation designator (23 bytes)
        vm.startPrank(buyer);
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(address(rs), ephKey, 0xaa, 0, 0.001 ether), "");
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(delegated, ephKey, 0xaa, 0, 0.001 ether), "");
        vm.stopPrank();
    }

    function test_reentrantBuyerOnRefundIsHarmless() public {
        (PoolKey memory key, MockERC20 narrow) = _narrowPool();
        address stealth2 = makeAddr("second stealth");
        ReenteringBuyer rb = new ReenteringBuyer(sb, key, poolKey, ephKey, stealth, stealth2);
        vm.deal(address(rb), 50 ether);
        rb.go(50 ether);
        assertEq(address(sb).balance, 0);
        assertGt(narrow.balanceOf(stealth), 0);
        assertGt(address(rb).balance, 40 ether, "refund of the unfilled part came back");
        assertEq(rb.innerError().length, 0, "the re-entrant buy went through");
        assertGt(tkn.balanceOf(stealth2), 0, "re-entrant buy on the second pool also delivered");
    }

    /// @dev The record is written before any external call, so a buy re-entering from the refund (the last call) to the
    ///      same stealth address already finds it used, even though it holds none of the second pool's token.
    function test_reentrantBuyToSameAddressFindsItUsed() public {
        (PoolKey memory key, MockERC20 narrow) = _narrowPool();
        ReenteringBuyer rb = new ReenteringBuyer(sb, key, poolKey, ephKey, stealth, stealth);
        vm.deal(address(rb), 50 ether);
        rb.go(50 ether);
        assertGt(narrow.balanceOf(stealth), 0, "outer buy delivered");
        assertEq(rb.innerError(), abi.encodeWithSelector(StealthBuy.StealthAddressUsed.selector));
        assertEq(tkn.balanceOf(stealth), 0, "nothing from the re-entrant buy");
        assertEq(address(sb).balance, 0);
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

    /// @dev ETH/token at 1:1 with the given hook, full-range liquidity of about 100 ETH on each side.
    function _deepEthPool(IHooks hooks) internal returns (PoolKey memory key, MockERC20 t) {
        t = new MockERC20("H", "H", 18);
        t.mint(address(this), 1_000_000 ether);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        (key,) = initPool(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(t)), hooks, 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 101 ether}(
            key, IPoolManager.ModifyLiquidityParams(-887220, 887220, 100 ether, 0), ""
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
