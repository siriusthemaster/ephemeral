// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IHooks} from "v4-core/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency, CurrencyLibrary} from "v4-core/types/Currency.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {StealthBuy} from "../src/StealthBuy.sol";
import {StealthBuyBase} from "./StealthBuy.t.sol";

/// @dev A token that keeps 10% of every transfer that does not come from `exempt` (the test's liquidity provider).
contract FeeOnTransferToken is MockERC20 {
    address public immutable exempt;
    address public constant COLLECTOR = address(0xFEE);

    constructor(address _exempt) MockERC20("Fee Token", "FOT", 18) {
        exempt = _exempt;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (msg.sender == exempt) return super.transfer(to, amount);
        uint256 fee = amount / 10;
        super.transfer(COLLECTOR, fee);
        return super.transfer(to, amount - fee);
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        return super.transferFrom(from, to, amount); // liquidity goes in without a fee
    }
}

/// @dev Bug bounty 8 Nov: the slippage guard and the announcement use what reached the stealth address.
contract StealthBuyFeeOnTransferTest is StealthBuyBase {
    function _fotPool() internal returns (PoolKey memory key, FeeOnTransferToken t) {
        t = new FeeOnTransferToken(address(this));
        t.mint(address(this), 1_000_000_000 ether);
        t.approve(address(modifyLiquidityRouter), type(uint256).max);
        (key,) = initPool(CurrencyLibrary.ADDRESS_ZERO, Currency.wrap(address(t)), IHooks(address(0)), 3000, SQRT_PRICE_1_1);
        modifyLiquidityRouter.modifyLiquidity{value: 101 ether}(
            key, IPoolManager.ModifyLiquidityParams(-887220, 887220, int256(100 ether), 0), ""
        );
    }

    function test_feeOnTransfer_announcesAndGuardsWhatArrived() public {
        (PoolKey memory key, FeeOnTransferToken t) = _fotPool();
        vm.prank(buyer);
        uint256 out = sb.buy{value: 0.05 ether}(key, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
        assertEq(out, t.balanceOf(stealth), "the returned amount is what the stealth address holds");
        assertGt(t.balanceOf(t.COLLECTOR()), 0, "the token kept its fee");
    }

    function test_feeOnTransfer_minOutAboveWhatArrivedReverts() public {
        (PoolKey memory key,) = _fotPool();
        uint256 snap = vm.snapshotState();
        vm.prank(buyer);
        uint256 arrived = sb.buy{value: 0.05 ether}(key, StealthBuy.Stealth(stealth, ephKey, viewTag, 0, 0), "");
        vm.revertToState(snap);
        // a minOut between what arrived and the pool's nominal output: before, it passed
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(StealthBuy.TooLittleReceived.selector, arrived, arrived + 1));
        sb.buy{value: 0.05 ether}(key, StealthBuy.Stealth(stealth, ephKey, viewTag, arrived + 1, 0), "");
    }
}
