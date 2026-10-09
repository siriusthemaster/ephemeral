// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The canonical ERC-5564 Announcer (0x55649E01B5Df198D18D95b5cc5051630cfD45564 on mainnet and major L2s).
interface IERC5564Announcer {
    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external;
}

/// @title  StealthPayout (toy, unaudited)
/// @notice Settles one reward epoch for many holders: every payment to a fresh ERC-5564 stealth address, each announced
///         so the holder's wallet can find it with its viewing key, and every payment in a group of equal amounts.
///         v1 `settle`: one group, the same amount to every recipient (equal rewards per NFT).
///         v2 `settleNotes`: unequal debts. Each holder's debt is split off-chain into notes from a public denomination
///         set; the call pays one equal-amount group per denomination. The public record is per epoch ("payer P settled
///         epoch N: declared total, notes per denomination, commitments root"), never per holder.
/// @dev    What the chain shows: the payer, the epoch, groups of equal payments to fresh addresses in ascending order,
///         one announcement per payment and a Merkle root of hiding commitments. What it does not show: which holder or
///         NFT any payment belongs to. The payer (the operator) generated the stealth addresses and does know that mapping.
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

    /// @notice v2: every recipient of a group gets exactly `amountEach` (one denomination).
    struct Group {
        uint256 amountEach;
        Recipient[] rs;
    }

    /// @notice v2: an epoch paid in notes, possibly over several calls (parts) when one transaction cannot carry it.
    struct NotesEpoch {
        uint128 declaredTotal; // fixed by the first part
        uint128 outstanding; // declaredTotal minus everything paid so far; 0 once complete
    }

    uint256 public constant SCHEME_ID = 1; // secp256k1 with view tags
    bytes4 public constant ETH_SELECTOR = 0xeeeeeeee; // ERC-5564 metadata layout for native ETH
    address public constant ETH_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice Gas forwarded with each payment. A fresh stealth address has no code and needs none. A recipient that has
    ///         code (for example an EIP-7702 delegation set by its owner) gets this much; if it reverts or runs out, its
    ///         payment is parked for it below instead of reverting the whole epoch for everyone else.
    uint256 public constant SEND_GAS = 10_000;

    IERC5564Announcer public immutable announcer;

    /// @notice payer => epoch => commitments root. Non-zero once that payer has settled (or, in v2, started) that epoch.
    ///         One log for both versions: an epoch id is settled once, by `settle` or by `settleNotes`.
    mapping(address payer => mapping(uint256 epoch => bytes32 root)) public commitmentsRootOf;

    /// @notice v2: payer => epoch => declared total and what is still outstanding.
    mapping(address payer => mapping(uint256 epoch => NotesEpoch)) public notesEpochOf;

    /// @notice Payments a recipient did not accept within SEND_GAS. Only ever credited to the address they were sent to.
    ///         Invariant: address(this).balance == sum of parked.
    mapping(address recipient => uint256 amount) public parked;

    event EpochSettled(
        address indexed payer, uint256 indexed epoch, uint256 count, uint256 amountEach, bytes32 commitmentsRoot
    );
    /// @notice v2, once per call. `outstanding == 0` means the epoch is complete: everything declared has been paid.
    event NotesSettled(
        address indexed payer,
        uint256 indexed epoch,
        bytes32 commitmentsRoot,
        uint256 declaredTotal,
        uint256 paid,
        uint256 notes,
        uint256 outstanding
    );
    /// @notice v2, once per group: `count` payments of exactly `amountEach`.
    event NoteGroup(address indexed payer, uint256 indexed epoch, uint256 amountEach, uint256 count);
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
    // v2
    error EmptyGroup(uint256 group);
    error GroupsNotAscending(uint256 group);
    error DuplicateAddress(uint256 index);
    error ValueMismatch(uint256 value, uint256 sum);
    error BadDeclaredTotal();
    error ExceedsDeclared(uint256 paid, uint256 outstanding);
    error PartMismatch(address payer, uint256 epoch);

    constructor(IERC5564Announcer _announcer) {
        announcer = _announcer;
    }

    /// @dev Transient-storage lock (EIP-1153) in slot 0. settleNotes also marks each paid address in the transient slot
    ///      equal to the address itself (never 0, since address(0) is rejected) so no address is paid twice in a transaction.
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

    // ------------------------------------------------------------------------------------------------ v1: equal rewards

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
        _check(rs, 0, false);

        // Effects.
        commitmentsRootOf[msg.sender][epoch] = commitmentsRoot;
        emit EpochSettled(msg.sender, epoch, n, amountEach, commitmentsRoot);

        // Interactions.
        _pay(rs, amountEach);
    }

    // ------------------------------------------------------------------------------- v2: unequal debts, as notes

    /// @notice Pays (part of) epoch `epoch` as notes: every recipient of `groups[j]` gets exactly `groups[j].amountEach`.
    ///         The first call for an epoch fixes its root and declared total; an epoch too large for one transaction can be
    ///         paid in further calls (parts) with the same root and declared total, until everything declared is paid.
    /// @param epoch           the payer's epoch number, in the same log as `settle` (an id is settled by one or the other)
    /// @param commitmentsRoot Merkle root over every note of the epoch (all parts):
    ///                        H(epoch, owner, debt, carryIn, stealthAddress, denomination, salt), see ts/notes.ts
    /// @param declaredTotal   what the public ledger says this epoch pays out; the parts must add up to exactly this
    /// @param groups          strictly ascending, distinct `amountEach` (one group per denomination); within a group,
    ///                        strictly ascending stealth addresses; no address twice in the transaction
    function settleNotes(uint256 epoch, bytes32 commitmentsRoot, uint256 declaredTotal, Group[] calldata groups)
        external
        payable
        nonReentrant
    {
        uint256 g = groups.length;
        if (g == 0) revert NoRecipients();
        if (commitmentsRoot == bytes32(0)) revert ZeroRoot();
        bytes32 logged = commitmentsRootOf[msg.sender][epoch];
        NotesEpoch memory e = notesEpochOf[msg.sender][epoch];
        if (logged == bytes32(0)) {
            if (declaredTotal == 0 || declaredTotal > type(uint128).max) revert BadDeclaredTotal();
            // forge-lint: disable-next-line(unsafe-typecast) bounded on the line above
            e = NotesEpoch(uint128(declaredTotal), uint128(declaredTotal));
        } else if (e.outstanding == 0) {
            revert EpochAlreadySettled(msg.sender, epoch); // by settle(), or every part already paid
        } else if (logged != commitmentsRoot || e.declaredTotal != declaredTotal) {
            revert PartMismatch(msg.sender, epoch);
        }

        // Checks: every group and recipient, before anything is paid.
        uint256 paid;
        uint256 notes;
        uint256 prevAmount;
        for (uint256 j; j < g; ++j) {
            uint256 amountEach = groups[j].amountEach;
            if (amountEach == 0) revert ZeroAmount();
            if (amountEach <= prevAmount) revert GroupsNotAscending(j);
            Recipient[] calldata rs = groups[j].rs;
            if (rs.length == 0) revert EmptyGroup(j);
            _check(rs, notes, true);
            paid += amountEach * rs.length;
            notes += rs.length;
            prevAmount = amountEach;
        }
        if (msg.value != paid) revert ValueMismatch(msg.value, paid);
        if (paid > e.outstanding) revert ExceedsDeclared(paid, e.outstanding);

        // Effects.
        // forge-lint: disable-next-line(unsafe-typecast) paid <= e.outstanding, a uint128
        e.outstanding -= uint128(paid);
        if (logged == bytes32(0)) commitmentsRootOf[msg.sender][epoch] = commitmentsRoot;
        notesEpochOf[msg.sender][epoch] = e;
        emit NotesSettled(msg.sender, epoch, commitmentsRoot, e.declaredTotal, paid, notes, e.outstanding);
        for (uint256 j; j < g; ++j) {
            emit NoteGroup(msg.sender, epoch, groups[j].amountEach, groups[j].rs.length);
        }

        // Interactions.
        for (uint256 j; j < g; ++j) {
            _pay(groups[j].rs, groups[j].amountEach);
        }
    }

    // ------------------------------------------------------------------------------------------------ parked payments

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

    // ------------------------------------------------------------------------------------------------ internals

    /// @dev Non-zero, strictly ascending addresses with 33-byte compressed keys. `offset` makes error indexes global across
    ///      groups. With `markSeen`, each address is also marked in transient storage and a repeat anywhere in the same
    ///      transaction reverts (ascending order only rules out repeats within one group).
    function _check(Recipient[] calldata rs, uint256 offset, bool markSeen) private {
        address prev;
        for (uint256 i; i < rs.length; ++i) {
            address s = rs[i].stealthAddress;
            if (s == address(0)) revert ZeroStealthAddress(offset + i);
            if (s <= prev) revert NotAscending(offset + i);
            bytes calldata k = rs[i].ephemeralPubKey;
            if (k.length != 33 || (k[0] != 0x02 && k[0] != 0x03)) revert BadEphemeralKey(offset + i);
            if (markSeen) {
                bool seen;
                assembly {
                    seen := tload(s)
                    tstore(s, 1)
                }
                if (seen) revert DuplicateAddress(offset + i);
            }
            prev = s;
        }
    }

    /// @dev Every payment is announced, including a parked one, so its owner can find it either way.
    function _pay(Recipient[] calldata rs, uint256 amountEach) private {
        for (uint256 i; i < rs.length; ++i) {
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

    /// @dev Plain value call that copies no return data (a recipient cannot return-bomb the loop).
    function _send(address to, uint256 amount, uint256 gasLimit) private returns (bool ok) {
        assembly {
            ok := call(gasLimit, to, amount, 0, 0, 0, 0)
        }
    }
}
