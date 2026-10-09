// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "v4-core/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "v4-core/types/PoolKey.sol";
import {Currency} from "v4-core/types/Currency.sol";
import {BalanceDelta} from "v4-core/types/BalanceDelta.sol";
import {TickMath} from "v4-core/libraries/TickMath.sol";

/// @notice The canonical ERC-5564 Announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564 on mainnet and major L2s).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata) external;
}

/// @title StealthBuy
/// @notice Buys a token with ETH on any Uniswap v4 pool and delivers it straight to an ERC-5564 stealth address,
///         optionally with a little ETH for gas, and announces it so the receiver's wallet can find it.
/// @dev    What this gives: the tokens land on a one-time address that only the holder of the stealth keys can find and
///         spend, and the gas to move them is already there, so the receiver never funds that address from a known wallet.
///         What it does not give: the buyer's own address is visible as the sender of this transaction. Buying for
///         yourself from a known wallet links you to the stealth address; for that case fund the buy from a private source.
///         Holds no funds between calls, has no owner and nothing to configure. Its only state is `used`: the stealth
///         addresses it has paid, so that none of them can be paid by this deployment again.
contract StealthBuy is IUnlockCallback {
    IPoolManager public immutable poolManager;
    IERC5564Announcer public immutable announcer;

    /// @notice Stealth addresses this deployment has paid. Lasting: an address stays used after it is emptied.
    ///         The record is per deployment; another StealthBuy deployment keeps its own.
    mapping(address => bool) public used;

    uint256 public constant SCHEME_ID = 1; // secp256k1 with view tags
    uint256 public constant MAX_GAS_TIP = 0.01 ether;
    bytes4 internal constant TRANSFER_SELECTOR = 0xa9059cbb; // ERC-5564 metadata: the token moved like transfer()

    event StealthBought(
        address indexed stealthAddress, address indexed token, uint256 ethIn, uint256 tokensOut, uint256 gasTip
    );

    error NotPoolManager();
    error NotNativeEthPool();
    error ZeroStealthAddress();
    error BadEphemeralKey();
    error TipTooHigh();
    error NothingToSwap();
    error TooLittleReceived(uint256 out, uint256 minOut);
    error EthTransferFailed();
    error StealthAddressNotFresh();
    error StealthAddressUsed();

    struct CallbackData {
        PoolKey key;
        uint256 amountIn;
        address stealthAddress;
        bytes hookData;
    }

    constructor(IPoolManager _poolManager, IERC5564Announcer _announcer) {
        poolManager = _poolManager;
        announcer = _announcer;
    }

    /// @param stealthAddress  one-time address generated from the receiver's stealth meta-address
    /// @param ephemeralPubKey compressed secp256k1 public key (33 bytes) used to generate it
    /// @param viewTag         first byte of the hashed shared secret; lets the receiver skip 255/256 of announcements
    /// @param minOut          slippage guard: least amount of the token the stealth address must receive
    /// @param gasTip          ETH sent along to the stealth address for gas (0 to skip, at most MAX_GAS_TIP)
    struct Stealth {
        address stealthAddress;
        bytes ephemeralPubKey;
        bytes1 viewTag;
        uint256 minOut;
        uint256 gasTip;
    }

    /// @param key      the pool; currency0 must be native ETH, currency1 is the token bought
    /// @param s        where the tokens go and how the receiver finds them
    /// @param hookData passed through to the pool's hook, if it has one
    /// @dev msg.value = ETH to swap + s.gasTip. ETH the pool does not use is refunded to the caller.
    ///      A stealth address is paid at most once by this deployment: `used` records it before any external call, and a
    ///      second buy to it reverts with StealthAddressUsed, also after the address was emptied.
    ///      It must also be fresh: no code, no ETH and none of the token bought, checked before the swap. That also
    ///      catches an address paid through another deployment and not emptied since, e.g. the same buy sent twice.
    function buy(PoolKey calldata key, Stealth calldata s, bytes calldata hookData)
        external
        payable
        returns (uint256 tokensOut)
    {
        if (Currency.unwrap(key.currency0) != address(0)) revert NotNativeEthPool();
        if (s.stealthAddress == address(0)) revert ZeroStealthAddress();
        if (s.ephemeralPubKey.length != 33) revert BadEphemeralKey();
        if (s.gasTip > MAX_GAS_TIP) revert TipTooHigh();
        if (msg.value <= s.gasTip) revert NothingToSwap();
        address to = s.stealthAddress;
        if (used[to]) revert StealthAddressUsed();
        used[to] = true; // effect before any external call (the balance check below is the first)
        if (to.code.length != 0 || to.balance != 0 || key.currency1.balanceOf(to) != 0) revert StealthAddressNotFresh();

        uint256 amountIn = msg.value - s.gasTip;
        uint256 ethPaid;
        (ethPaid, tokensOut) = abi.decode(
            poolManager.unlock(abi.encode(CallbackData(key, amountIn, s.stealthAddress, hookData))), (uint256, uint256)
        );
        if (tokensOut < s.minOut) revert TooLittleReceived(tokensOut, s.minOut);
        _announce(s, Currency.unwrap(key.currency1), tokensOut, ethPaid);

        if (s.gasTip > 0) _sendEth(s.stealthAddress, s.gasTip);
        if (amountIn > ethPaid) _sendEth(msg.sender, amountIn - ethPaid);
    }

    /// @dev ERC-5564 metadata for a token: view tag | transfer selector | token | amount (57 bytes).
    function _announce(Stealth calldata s, address token, uint256 out, uint256 ethPaid) internal {
        announcer.announce(
            SCHEME_ID, s.stealthAddress, s.ephemeralPubKey, abi.encodePacked(s.viewTag, TRANSFER_SELECTOR, token, out)
        );
        emit StealthBought(s.stealthAddress, token, ethPaid, out, s.gasTip);
    }

    /// @dev Exact-input ETH -> token swap; the token goes straight from the PoolManager to the stealth address.
    function unlockCallback(bytes calldata raw) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        CallbackData memory d = abi.decode(raw, (CallbackData));
        BalanceDelta delta = poolManager.swap(
            d.key,
            IPoolManager.SwapParams({
                zeroForOne: true,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            d.hookData
        );
        int128 eth = delta.amount0();
        int128 tok = delta.amount1();
        uint256 ethPaid = eth < 0 ? uint256(uint128(-eth)) : 0;
        uint256 out = tok > 0 ? uint256(uint128(tok)) : 0;
        if (ethPaid > 0) poolManager.settle{value: ethPaid}();
        if (out > 0) poolManager.take(d.key.currency1, d.stealthAddress, out);
        return abi.encode(ethPaid, out);
    }

    function _sendEth(address to, uint256 amount) internal {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
