// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The canonical ERC-5564 Announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564 on mainnet and major L2s).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title  StealthPayout (toy, unaudited)
/// @notice Settles one reward epoch for many holders in one transaction: the same amount to every recipient, each to a
///         fresh ERC-5564 stealth address, each announced so the holder's wallet can find it with its viewing key.
///         The public record is per epoch ("payer P settled epoch N: count, amountEach, commitments root"), never per holder.
/// @dev    What the chain shows: the payer, the epoch, n equal payments to n fresh addresses in ascending order,
///         n announcements and a Merkle root of hiding commitments. What it does not show: which holder or NFT any
///         payment belongs to. The payer (the operator) generated the stealth addresses and does know that mapping.
///         Anyone can use this contract; each payer has its own epoch log. See PAYOUTS.md for the threat model and limits.
contract StealthPayout {
    /// @param stealthAddress  one-time address generated off-chain from the holder's stealth meta-address
    /// @param ephemeralPubKey compressed secp256k1 public key (33 bytes) used to generate it
    /// @param viewTag         first byte of the hashed shared secret; lets the holder skip 255/256 of announcements
    struct Recipient {
        address stealthAddress;
        bytes ephemeralPubKey;
        bytes1 viewTag;
    }

    uint256 public constant SCHEME_ID = 1; // secp256k1 with view tags
    bytes4 public constant ETH_SELECTOR = 0xeeeeeeee; // ERC-5564 metadata layout for native ETH
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Gas forwarded with each payment. A fresh stealth address has no code and needs none. A recipient that has
    ///         code (for example an EIP-7702 delegation set by its owner) gets this much; if it reverts or runs out, its
    ///         payment is parked for it below instead of reverting the whole epoch for everyone else.
    uint256 public constant SEND_GAS = 10_000;

    IERC5564Announcer public immutable announcer;

    /// @notice payer => epoch => commitments root. Non-zero once that payer has settled that epoch.
    mapping(address payer => mapping(uint256 epoch => bytes32 root)) public commitmentsRootOf;

    /// @notice Payments a recipient did not accept within SEND_GAS. Only ever credited to the address they were sent to.
    ///         Invariant: address(this).balance == sum of parked.
    mapping(address recipient => uint256 amount) public parked;

    event EpochSettled(
        address indexed payer, uint256 indexed epoch, uint256 count, uint256 amountEach, bytes32 commitmentsRoot
    );
    event Parked(address indexed recipient, uint256 amount);
    event Released(address indexed recipient, address indexed to, uint256 amount);

    error NoRecipients();
    error ZeroRoot();
    error EpochAlreadySettled(address payer, uint256 epoch);
    error UnequalSplit(uint256 value, uint256 count);
    error ZeroAmount();
    error ZeroStealthAddress(uint256 index);
    error NotAscending(uint256 index);
    error BadEphemeralKey(uint256 index);
    error NothingParked();
    error SendFailed();
    error Reentrancy();

    constructor(IERC5564Announcer _announcer) {
        announcer = _announcer;
    }

    /// @dev Transient-storage lock (EIP-1153). This contract uses no other transient slot.
    modifier nonReentrant() {
        bool locked;
        assembly {
            locked := tload(0)
        }
        if (locked) revert Reentrancy();
        assembly {
            tstore(0, 1)
        }
        _;
        assembly {
            tstore(0, 0)
        }
    }

    /// @notice Pays epoch `epoch` to every recipient: msg.value / rs.length each, exactly (reverts on any remainder).
    /// @param epoch           the payer's epoch number; each payer can settle each epoch once
    /// @param commitmentsRoot Merkle root over H(nftId, epoch, stealthAddress, salt), one leaf per payment (see ts/proof.ts);
    ///                        lets a holder later prove to a verifier of their choice which entitlement a payment settled
    /// @param rs              recipients in strictly ascending stealthAddress order. The order is enforced: it makes the
    ///                        position of a payment independent of NFT ids and owners, and it rules out paying one
    ///                        address twice (which would give it a distinctive 2x balance)
    function settle(uint256 epoch, bytes32 commitmentsRoot, Recipient[] calldata rs) external payable nonReentrant {
        uint256 n = rs.length;
        if (n == 0) revert NoRecipients();
        if (commitmentsRoot == bytes32(0)) revert ZeroRoot();
        if (commitmentsRootOf[msg.sender][epoch] != bytes32(0)) revert EpochAlreadySettled(msg.sender, epoch);
        if (msg.value % n != 0) revert UnequalSplit(msg.value, n);
        uint256 amountEach = msg.value / n;
        if (amountEach == 0) revert ZeroAmount();

        // Checks: every recipient, before anything is paid.
        address prev;
        for (uint256 i; i < n; ++i) {
            address s = rs[i].stealthAddress;
            if (s == address(0)) revert ZeroStealthAddress(i);
            if (s <= prev) revert NotAscending(i);
            bytes calldata k = rs[i].ephemeralPubKey;
            if (k.length != 33 || (k[0] != 0x02 && k[0] != 0x03)) revert BadEphemeralKey(i);
            prev = s;
        }

        // Effects.
        commitmentsRootOf[msg.sender][epoch] = commitmentsRoot;
        emit EpochSettled(msg.sender, epoch, n, amountEach, commitmentsRoot);

        // Interactions. Every payment is announced, including a parked one, so its owner can find it either way.
        for (uint256 i; i < n; ++i) {
            Recipient calldata r = rs[i];
            announcer.announce(
                SCHEME_ID,
                r.stealthAddress,
                r.ephemeralPubKey,
                abi.encodePacked(r.viewTag, ETH_SELECTOR, ETH_TOKEN, amountEach) // 57 bytes
            );
            if (!_send(r.stealthAddress, amountEach, SEND_GAS)) {
                // Written after the call only when the call failed, and a failed call's own state changes (including
                // any re-entry it attempted) are rolled back, so nothing can interleave with this credit.
                parked[r.stealthAddress] += amountEach;
                emit Parked(r.stealthAddress, amountEach);
            }
        }
    }

    /// @notice Pushes a parked payment to the address it was meant for, with all remaining gas. Anyone can call it (a
    ///         relayer, or the payer along with a later epoch), so that address needs no gas of its own.
    function release(address recipient) external nonReentrant {
        uint256 amount = parked[recipient];
        if (amount == 0) revert NothingParked();
        parked[recipient] = 0;
        emit Released(recipient, recipient, amount);
        if (!_send(recipient, amount, gasleft())) revert SendFailed();
    }

    /// @notice For a recipient with code that will not take a push: it calls this itself and names where the ETH goes.
    function withdrawParked(address to) external nonReentrant {
        uint256 amount = parked[msg.sender];
        if (amount == 0) revert NothingParked();
        parked[msg.sender] = 0;
        emit Released(msg.sender, to, amount);
        if (!_send(to, amount, gasleft())) revert SendFailed();
    }

    /// @dev Plain value call that copies no return data (a recipient cannot return-bomb the loop).
    function _send(address to, uint256 amount, uint256 gasLimit) private returns (bool ok) {
        assembly {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }
}
