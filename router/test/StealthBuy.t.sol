// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Deployers} from "@uniswap/v4-core/test/utils/Deployers.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StealthBuy, IERC5564Announcer} from "../src/StealthBuy.sol";

/// @dev Same event and behaviour as the canonical ERC-5564 Announcer (it only emits).
contract Announcer {
    event Announcement(
        uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

/// @notice Shared setup: fresh v4 PoolManager, the canonical Announcer address, an ETH/TKN pool without a hook.
abstract contract StealthBuyBase is Deployers {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    StealthBuy internal sb;
    MockERC20 internal tkn;
    PoolKey internal poolKey;
    address internal buyer = makeAddr("buyer");
    address internal stealth = makeAddr("stealth");
    bytes internal ephKey = abi.encodePacked(bytes1(0x02), keccak256("ephemeral public key x"));
    bytes1 internal viewTag = 0xc1;

    function setUp() public virtual {
        deployFreshManagerAndRouters();
        vm.etch(ANNOUNCER, address(new Announcer()).code);
        sb = new StealthBuy(manager, IERC5564Announcer(ANNOUNCER));
        (poolKey, tkn) = _ethPool(100 ether);
        vm.deal(buyer, 100 ether);
    }

    /// @dev ETH/TKN at 1:1, 0.3% LP fee, no hook. Full-range liquidity worth about `depth` ETH on each side.
    function _ethPool(uint256 depth) internal returns (PoolKey memory key, MockERC20 t) {
        t = new MockERC20("Some Token", "TKN", 18);
        t.mint(address(this), 1_000_000_000 ether);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        (key,) = initPool(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(t)), IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: depth + 1 ether}(
            key, IPoolManager.ModifyLiquidityParams(-887220, 887220, int256(depth), 0), ""
        );
    }

    /// @dev What the same buy would return right now (dry run, then state restored).
    function _quote(PoolKey memory key, uint256 ethIn) internal returns (uint256 out) {
        uint256 snap = vm.snapshotState();
        vm.deal(address(0xBEEF), ethIn);
        vm.prank(address(0xBEEF));
        out = sb.buy{value: ethIn}(key, StealthBuy.Stealth(address(0xCAFE), ephKey, viewTag, 0, 0), "");
        vm.revertToState(snap);
    }
}

contract StealthBuyTest is StealthBuyBase {
    event Announcement(
        uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata
    );

    function test_buyLandsOnStealthAddressWithGasAndAnnouncement() public {
        uint256 tip = 0.002 ether;
        uint256 pmBefore = address(manager).balance;

        vm.prank(buyer);
        uint256 out = sb.buy{value: 0.1 ether + tip}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 1, tip), "");

        assertGt(out, 0, "bought something");
        assertEq(tkn.balanceOf(stealth), out, "tokens on the stealth address");
        assertEq(tkn.balanceOf(address(sb)), 0, "router keeps no tokens");
        assertEq(stealth.balance, tip, "gas included");
        assertEq(address(sb).balance, 0, "no ETH left in the router");
        assertEq(buyer.balance, 100 ether - 0.1 ether - tip, "buyer paid exactly swap + tip");
        assertEq(address(manager).balance - pmBefore, 0.1 ether, "the whole swap amount went into the pool");
    }

    function test_announcementMatchesErc5564() public {
        uint256 quote = _quote(poolKey, 0.05 ether);
        vm.expectEmit(true, true, true, true, ANNOUNCER);
        emit Announcement(1, stealth, address(sb), ephKey, abi.encodePacked(viewTag, bytes4(0xa9059cbb), address(tkn), quote));
        vm.prank(buyer);
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
    }

    function test_slippageGuard() public {
        uint256 quote = _quote(poolKey, 0.05 ether);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StealthBuy.TooLittleReceived.selector, quote, quote + 1));
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, quote + 1, 0), "");
    }

    function test_rejects() public {
        vm.startPrank(buyer);
        vm.expectRevert(StealthBuy.ZeroStealthAddress.selector);
        sb.buy{value: 0.01 ether}(poolKey, StealthBuy.Stealth(address(0), ephKey, viewTag, 0, 0), "");
        vm.expectRevert(StealthBuy.BadEphemeralKey.selector);
        sb.buy{value: 0.01 ether}(poolKey, StealthBuy.Stealth(stealth, hex"02", viewTag, 0, 0), "");
        vm.expectRevert(StealthBuy.TipTooHigh.selector);
        sb.buy{value: 1 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0.02 ether), "");
        vm.expectRevert(StealthBuy.NothingToSwap.selector);
        sb.buy{value: 0.001 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0.001 ether), "");
        vm.stopPrank();
        vm.expectRevert(StealthBuy.NotPoolManager.selector);
        sb.unlockCallback("");
    }

    function test_rejectsTokenToTokenPool() public {
        (Currency a, Currency b) = deployMintAndApprove2Currencies();
        (PoolKey memory key,) = initPoolAndAddLiquidity(a, b, IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        vm.prank(buyer);
        vm.expectRevert(StealthBuy.NotNativeEthPool.selector);
        sb.buy{value: 0.01 ether}(key, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
    }

    function testFuzz_buyerPaysExactlySwapPlusTip(uint256 ethIn, uint256 tip) public {
        tip = bound(tip, 0, 0.01 ether);
        ethIn = bound(ethIn, 1e12, 1 ether);
        vm.prank(buyer);
        uint256 out = sb.buy{value: ethIn + tip}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, tip), "");
        assertEq(tkn.balanceOf(stealth), out);
        assertEq(stealth.balance, tip);
        assertEq(buyer.balance, 100 ether - ethIn - tip);
        assertEq(address(sb).balance, 0);
    }

    // ---------------------------------------------------------------- fresh address guard
    // 8 Oct, mainnet: one prepared buy (same stealth address, same ephemeral key) was sent twice, through two routers.

    function test_replaySameStealthAddressReverts() public {
        StealthBuy.Stealth memory s = StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0.001 ether);
        StealthBuy other = new StealthBuy(manager, IERC5564Announcer(ANNOUNCER)); // a second deployment
        vm.startPrank(buyer);
        uint256 out = sb.buy{value: 0.05 ether + 0.001 ether}(poolKey, s, "");
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        sb.buy{value: 0.05 ether + 0.001 ether}(poolKey, s, ""); // the same buy again
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        other.buy{value: 0.05 ether + 0.001 ether}(poolKey, s, ""); // ... or through another router
        vm.stopPrank();
        assertEq(tkn.balanceOf(stealth), out, "still exactly the first buy");
        assertEq(stealth.balance, 0.001 ether, "still exactly the first tip");
        assertEq(buyer.balance, 100 ether - 0.05 ether - 0.001 ether, "the replays cost the buyer nothing");
    }

    function test_prefundedWithOneWeiEthReverts() public {
        vm.deal(stealth, 1);
        vm.prank(buyer);
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
    }

    function test_holdingOneWeiTokenReverts() public {
        tkn.mint(stealth, 1);
        vm.prank(buyer);
        vm.expectRevert(StealthBuy.StealthAddressNotFresh.selector);
        sb.buy{value: 0.05 ether}(poolKey, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
    }

    function test_freshAddressStillWorks() public {
        address fresh = makeAddr("fresh stealth");
        assertEq(fresh.code.length, 0);
        assertEq(fresh.balance, 0);
        assertEq(tkn.balanceOf(fresh), 0);
        vm.prank(buyer);
        uint256 out =
            sb.buy{value: 0.05 ether + 0.001 ether}(poolKey, StealthBuy.Stealth(fresh, ephKey, viewTag, 1, 0.001 ether), "");
        assertGt(out, 0);
        assertEq(tkn.balanceOf(fresh), out, "tokens on the fresh address");
        assertEq(fresh.balance, 0.001 ether, "gas included");
        assertEq(buyer.balance, 100 ether - 0.05 ether - 0.001 ether);
        assertEq(address(sb).balance, 0);
    }
}
