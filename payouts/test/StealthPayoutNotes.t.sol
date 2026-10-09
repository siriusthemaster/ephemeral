// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {StealthPayout, IERC5564Announcer} from "../src/StealthPayout.sol";
import {Announcer, Rejecter, GasBurner, ReentrantRecipient} from "./StealthPayout.t.sol";

/// @dev v2: settleNotes (unequal debts paid as equal-amount groups of denomination notes).
contract StealthPayoutNotesTest is Test {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    bytes32 constant ANNOUNCEMENT_TOPIC = keccak256("Announcement(uint256,address,address,bytes,bytes)");
    bytes32 constant REENTRY_TOPIC = keccak256("Reentry(bool,bytes4)");
    bytes32 constant ROOT = keccak256("notes root");
    uint256 constant TX_GAS_CAP = 1 << 24; // EIP-7825 (Ethereum L1 since Fusaka)

    StealthPayout internal payout;
    address internal operator = makeAddr("operator");

    event NotesSettled(
        address indexed payer,
        uint256 indexed epoch,
        bytes32 commitmentsRoot,
        uint256 declaredTotal,
        uint256 paid,
        uint256 notes,
        uint256 outstanding
    );
    event NoteGroup(address indexed payer, uint256 indexed epoch, uint256 amountEach, uint256 count);
    event Parked(address indexed recipient, uint256 amount);

    function setUp() public {
        vm.etch(ANNOUNCER, address(new Announcer()).code);
        payout = new StealthPayout(IERC5564Announcer(ANNOUNCER));
        vm.deal(operator, 1_000_000 ether);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev n fresh addresses in ascending order (random gaps); distinct seeds give disjoint sets with overwhelming odds.
    function _recipients(uint256 n, uint256 seed) internal pure returns (StealthPayout.Recipient[] memory rs) {
        rs = new StealthPayout.Recipient[](n);
        uint160 a = uint160(1) << 155;
        for (uint256 i; i < n; ++i) {
            bytes32 h = keccak256(abi.encode("notes", seed, i));
            a += 1 + uint160(uint256(h) >> 106);
            rs[i] = StealthPayout.Recipient(
                address(a), abi.encodePacked(bytes1(uint8(2 + (uint8(h[0]) & 1))), keccak256(abi.encode(h))), h[1]
            );
        }
    }

    function _groups(uint256[] memory amounts, uint256[] memory counts, uint256 seed)
        internal
        pure
        returns (StealthPayout.Group[] memory gs)
    {
        gs = new StealthPayout.Group[](amounts.length);
        for (uint256 j; j < amounts.length; ++j) {
            gs[j] = StealthPayout.Group(
                amounts[j], _recipients(counts[j], uint256(keccak256(abi.encode("group", seed, j))))
            );
        }
    }

    function _sum(StealthPayout.Group[] memory gs) internal pure returns (uint256 s) {
        for (uint256 j; j < gs.length; ++j) {
            s += gs[j].amountEach * gs[j].rs.length;
        }
    }

    function _three(uint256 seed) internal pure returns (StealthPayout.Group[] memory) {
        uint256[] memory amounts = new uint256[](3);
        uint256[] memory counts = new uint256[](3);
        (amounts[0], amounts[1], amounts[2]) = (1 ether, 2 ether, 4 ether);
        (counts[0], counts[1], counts[2]) = (3, 2, 1);
        return _groups(amounts, counts, seed); // 3 + 4 + 4 = 11 ether
    }

    function _settleNotes(uint256 epoch, bytes32 root, uint256 declared, StealthPayout.Group[] memory gs) internal {
        vm.prank(operator);
        payout.settleNotes{value: _sum(gs)}(epoch, root, declared, gs);
    }

    function _outstanding(address payer, uint256 epoch) internal view returns (uint256 declared, uint256 outstanding) {
        (uint128 d, uint128 o) = payout.notesEpochOf(payer, epoch);
        return (d, o);
    }

    function _calldataGas(bytes memory cd) internal pure returns (uint256 g) {
        for (uint256 i; i < cd.length; ++i) {
            g += cd[i] == 0 ? 4 : 16;
        }
    }

    // ---------------------------------------------------------------- one group per denomination

    function test_notes_eachGroupGetsItsDenomination() public {
        StealthPayout.Group[] memory gs = _three(1);
        vm.expectEmit(true, true, false, true, address(payout));
        emit NotesSettled(operator, 8, ROOT, 11 ether, 11 ether, 6, 0);
        vm.expectEmit(true, true, false, true, address(payout));
        emit NoteGroup(operator, 8, 1 ether, 3);
        vm.expectEmit(true, true, false, true, address(payout));
        emit NoteGroup(operator, 8, 2 ether, 2);
        vm.expectEmit(true, true, false, true, address(payout));
        emit NoteGroup(operator, 8, 4 ether, 1);
        vm.recordLogs();
        _settleNotes(8, ROOT, 11 ether, gs);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        for (uint256 j; j < 3; ++j) {
            for (uint256 i; i < gs[j].rs.length; ++i) {
                assertEq(gs[j].rs[i].stealthAddress.balance, gs[j].amountEach, "each note gets its group's amount");
            }
        }
        // Announcements in payment order, each with the 57-byte ETH metadata carrying its group's amount.
        uint256 k;
        uint256[6] memory want = [uint256(1 ether), 1 ether, 1 ether, 2 ether, 2 ether, 4 ether];
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ANNOUNCER) continue;
            assertEq(logs[i].topics[0], ANNOUNCEMENT_TOPIC);
            (, bytes memory meta) = abi.decode(logs[i].data, (bytes, bytes));
            assertEq(meta.length, 57);
            uint256 amount;
            assembly {
                amount := mload(add(meta, 57)) // last 32 bytes
            }
            assertEq(amount, want[k++]);
        }
        assertEq(k, 6);
        assertEq(payout.commitmentsRootOf(operator, 8), ROOT, "same epoch log as v1");
        (uint256 d, uint256 o) = _outstanding(operator, 8);
        assertEq(d, 11 ether);
        assertEq(o, 0, "complete");
        assertEq(address(payout).balance, 0);
    }

    function testFuzz_notes_valueConserved(uint8 groupCount, uint256 seed) public {
        uint256 g = bound(groupCount, 1, 6);
        uint256[] memory amounts = new uint256[](g);
        uint256[] memory counts = new uint256[](g);
        uint256 base = 1 + (seed % 1e15);
        for (uint256 j; j < g; ++j) {
            amounts[j] = base << j;
            counts[j] = 1 + uint256(keccak256(abi.encode(seed, j))) % 15;
        }
        StealthPayout.Group[] memory gs = _groups(amounts, counts, seed);
        uint256 total = _sum(gs);
        _settleNotes(seed, ROOT, total, gs);
        for (uint256 j; j < g; ++j) {
            for (uint256 i; i < counts[j]; ++i) {
                assertEq(gs[j].rs[i].stealthAddress.balance, amounts[j]);
            }
        }
        assertEq(address(payout).balance, 0);
        (, uint256 o) = _outstanding(operator, seed);
        assertEq(o, 0);
    }

    // ---------------------------------------------------------------- input checks

    function test_notes_inputChecks() public {
        StealthPayout.Group[] memory gs = _three(2);
        vm.startPrank(operator);

        vm.expectRevert(StealthPayout.NoRecipients.selector);
        payout.settleNotes{value: 0}(1, ROOT, 1, new StealthPayout.Group[](0));

        vm.expectRevert(StealthPayout.ZeroRoot.selector);
        payout.settleNotes{value: 11 ether}(1, bytes32(0), 11 ether, gs);

        vm.expectRevert(StealthPayout.BadDeclaredTotal.selector);
        payout.settleNotes{value: 11 ether}(1, ROOT, 0, gs);

        vm.expectRevert(StealthPayout.BadDeclaredTotal.selector);
        payout.settleNotes{value: 11 ether}(1, ROOT, uint256(type(uint128).max) + 1, gs);

        StealthPayout.Group[] memory bad = _three(2);
        bad[1].rs = new StealthPayout.Recipient[](0);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EmptyGroup.selector, 1));
        payout.settleNotes{value: 7 ether}(1, ROOT, 7 ether, bad);

        bad = _three(2);
        bad[0].amountEach = 0;
        vm.expectRevert(StealthPayout.ZeroAmount.selector);
        payout.settleNotes{value: 8 ether}(1, ROOT, 8 ether, bad);

        bad = _three(2);
        bad[2].amountEach = 2 ether; // two groups of the same amount
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.GroupsNotAscending.selector, 2));
        payout.settleNotes{value: 9 ether}(1, ROOT, 9 ether, bad);

        bad = _three(2);
        (bad[0], bad[2]) = (bad[2], bad[0]); // descending
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.GroupsNotAscending.selector, 1));
        payout.settleNotes{value: 11 ether}(1, ROOT, 11 ether, bad);

        bad = _three(2);
        (bad[1].rs[0], bad[1].rs[1]) = (bad[1].rs[1], bad[1].rs[0]); // out of order inside group 1: global index 3 + 1
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.NotAscending.selector, 4));
        payout.settleNotes{value: 11 ether}(1, ROOT, 11 ether, bad);

        bad = _three(2);
        bad[2].rs[0] = bad[0].rs[1]; // the same address in two groups: a distinctive 1 + 4 balance
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.DuplicateAddress.selector, 5));
        payout.settleNotes{value: 11 ether}(1, ROOT, 11 ether, bad);

        bad = _three(2);
        bad[1].rs[1].ephemeralPubKey = abi.encodePacked(bytes1(0x04), keccak256("x")); // 33 bytes, bad prefix
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.BadEphemeralKey.selector, 4));
        payout.settleNotes{value: 11 ether}(1, ROOT, 11 ether, bad);

        bad = _three(2);
        bad[0].rs[0].stealthAddress = address(0);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ZeroStealthAddress.selector, 0));
        payout.settleNotes{value: 11 ether}(1, ROOT, 11 ether, bad);

        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ValueMismatch.selector, 10 ether, 11 ether));
        payout.settleNotes{value: 10 ether}(1, ROOT, 11 ether, gs);

        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ExceedsDeclared.selector, 11 ether, 10 ether));
        payout.settleNotes{value: 11 ether}(1, ROOT, 10 ether, gs);

        vm.stopPrank();
        assertEq(address(payout).balance, 0);
        assertEq(payout.commitmentsRootOf(operator, 1), bytes32(0), "nothing settled");
        (uint256 d,) = _outstanding(operator, 1);
        assertEq(d, 0);

        // A reverted call leaves no transient mark behind: the same groups go through now.
        _settleNotes(1, ROOT, 11 ether, gs);
        assertEq(gs[2].rs[0].stealthAddress.balance, 4 ether);
    }

    // ---------------------------------------------------------------- the epoch log, shared with v1

    function test_notes_sharedEpochLogWithV1_perPayer() public {
        StealthPayout.Recipient[] memory rs = _recipients(3, 77);
        vm.prank(operator);
        payout.settle{value: 3 ether}(7, ROOT, rs);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 7));
        payout.settleNotes{value: 11 ether}(7, ROOT, 11 ether, _three(3));

        _settleNotes(9, ROOT, 11 ether, _three(4));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 9));
        payout.settle{value: 3 ether}(9, ROOT, _recipients(3, 78));
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 9));
        payout.settleNotes{value: 11 ether}(9, ROOT, 11 ether, _three(5));

        // Another payer has its own log.
        address other = makeAddr("another project");
        StealthPayout.Group[] memory gs = _three(6);
        vm.deal(other, 11 ether);
        vm.prank(other);
        payout.settleNotes{value: 11 ether}(9, keccak256("other"), 11 ether, gs);
        assertEq(payout.commitmentsRootOf(other, 9), keccak256("other"));
    }

    // ---------------------------------------------------------------- parts (per-transaction gas caps)

    function test_notes_inParts_addUpToTheDeclaredTotal() public {
        StealthPayout.Group[] memory all = _three(10); // 11 ether in total
        StealthPayout.Group[] memory first = new StealthPayout.Group[](2);
        (first[0], first[1]) = (all[0], all[1]); // 3 + 4 = 7
        StealthPayout.Group[] memory second = new StealthPayout.Group[](1);
        second[0] = all[2]; // 4

        vm.expectEmit(true, true, false, true, address(payout));
        emit NotesSettled(operator, 5, ROOT, 11 ether, 7 ether, 5, 4 ether);
        _settleNotes(5, ROOT, 11 ether, first);
        (, uint256 o) = _outstanding(operator, 5);
        assertEq(o, 4 ether, "outstanding is public until the last part");

        // v1 cannot take over an epoch in progress.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 5));
        payout.settle{value: 1 ether}(5, ROOT, _recipients(1, 11));

        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.PartMismatch.selector, operator, 5));
        payout.settleNotes{value: 4 ether}(5, keccak256("another root"), 11 ether, second);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.PartMismatch.selector, operator, 5));
        payout.settleNotes{value: 4 ether}(5, ROOT, 12 ether, second);

        StealthPayout.Group[] memory tooMuch = _three(12);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ExceedsDeclared.selector, 11 ether, 4 ether));
        payout.settleNotes{value: 11 ether}(5, ROOT, 11 ether, tooMuch);

        // An address already paid by part 1 in this same transaction is rejected in part 2.
        StealthPayout.Group[] memory reuse = new StealthPayout.Group[](1);
        reuse[0] = StealthPayout.Group(4 ether, new StealthPayout.Recipient[](1));
        reuse[0].rs[0] = all[0].rs[0];
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.DuplicateAddress.selector, 0));
        payout.settleNotes{value: 4 ether}(5, ROOT, 11 ether, reuse);

        vm.expectEmit(true, true, false, true, address(payout));
        emit NotesSettled(operator, 5, ROOT, 11 ether, 4 ether, 1, 0);
        payout.settleNotes{value: 4 ether}(5, ROOT, 11 ether, second);
        (, o) = _outstanding(operator, 5);
        assertEq(o, 0, "complete");

        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 5));
        payout.settleNotes{value: 1 ether}(5, ROOT, 11 ether, _three(13));
        vm.stopPrank();
        assertEq(address(payout).balance, 0);
    }

    /// @dev @contractclaus (9 Oct): a fresh R for the same entitlement in the same round must not pay twice. Parts of one
    ///      epoch must carry its root, which commits to every note's stealth address, so the same ledger re-planned with
    ///      fresh R (new addresses, so a new root) cannot join the epoch in progress; nothing joins it once complete; and
    ///      no part can pay past the declared total, whatever root it names.
    function test_notes_freshR_sameEpoch_secondPayoutReverts() public {
        StealthPayout.Group[] memory all = _three(30); // the plan: 11 ether, root ROOT
        StealthPayout.Group[] memory first = new StealthPayout.Group[](2);
        (first[0], first[1]) = (all[0], all[1]); // 7 ether
        StealthPayout.Group[] memory last = new StealthPayout.Group[](1);
        last[0] = all[2]; // 4 ether
        _settleNotes(6, ROOT, 11 ether, first);

        StealthPayout.Group[] memory replanned = _three(31); // the same notes under fresh R: every address new
        StealthPayout.Group[] memory replannedLast = new StealthPayout.Group[](1);
        replannedLast[0] = replanned[2];
        bytes32 freshRoot = keccak256("root of the re-plan");
        vm.startPrank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.PartMismatch.selector, operator, 6));
        payout.settleNotes{value: 11 ether}(6, freshRoot, 11 ether, replanned);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.PartMismatch.selector, operator, 6));
        payout.settleNotes{value: 4 ether}(6, freshRoot, 11 ether, replannedLast);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ExceedsDeclared.selector, 11 ether, 4 ether));
        payout.settleNotes{value: 11 ether}(6, ROOT, 11 ether, replanned); // the whole epoch again, under the right root
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 6));
        payout.settle{value: 3 ether}(6, freshRoot, replanned[0].rs);

        payout.settleNotes{value: 4 ether}(6, ROOT, 11 ether, last); // the plan's own last part completes the epoch
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 6));
        payout.settleNotes{value: 4 ether}(6, ROOT, 11 ether, replannedLast);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 6));
        payout.settleNotes{value: 11 ether}(6, freshRoot, 11 ether, replanned);
        vm.stopPrank();

        for (uint256 j; j < 3; ++j) {
            for (uint256 i; i < replanned[j].rs.length; ++i) {
                assertEq(replanned[j].rs[i].stealthAddress.balance, 0, "no fresh-R note was paid");
            }
            for (uint256 i; i < all[j].rs.length; ++i) {
                assertEq(all[j].rs[i].stealthAddress.balance, all[j].amountEach, "every planned note paid once");
            }
        }
        (, uint256 o) = _outstanding(operator, 6);
        assertEq(o, 0);
        assertEq(address(payout).balance, 0);
    }

    // ---------------------------------------------------------------- recipients with code, re-entrancy

    function test_notes_refusingRecipientParked_reentryBlocked() public {
        StealthPayout.Group[] memory gs = _three(20);
        address bad = gs[1].rs[0].stealthAddress;
        address evil = gs[0].rs[2].stealthAddress;
        vm.etch(bad, address(new Rejecter()).code);
        vm.etch(evil, address(new ReentrantRecipient(payout, 3, true)).code); // tries settleNotes as itself, then accepts

        vm.expectEmit(true, false, false, true, address(payout));
        emit Parked(bad, 2 ether);
        vm.recordLogs();
        _settleNotes(3, ROOT, 11 ether, gs);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != REENTRY_TOPIC) continue;
            (bool ok, bytes4 err) = abi.decode(logs[i].data, (bool, bytes4));
            assertFalse(ok);
            assertEq(err, StealthPayout.Reentrancy.selector);
            ++seen;
        }
        assertEq(seen, 1, "it tried, and the lock stopped it");
        assertEq(evil.balance, 1 ether, "paid exactly once");
        assertEq(bad.balance, 0);
        assertEq(payout.parked(bad), 2 ether, "a refused note is kept for its owner");
        assertEq(address(payout).balance, 2 ether, "balance == parked");

        vm.etch(bad, "");
        payout.release(bad);
        assertEq(bad.balance, 2 ether);
        assertEq(address(payout).balance, 0);
    }

    // ---------------------------------------------------------------- the TypeScript plan, settled on chain

    function test_notes_fixtureFromTs_settlesAndDebtOpens() public {
        string memory json = vm.readFile("test/fixtures/notes8.json");
        uint256 epoch = vm.parseJsonUint(json, ".epoch");
        uint256 declared = vm.parseJsonUint(json, ".declaredTotal");
        bytes32 root = vm.parseJsonBytes32(json, ".commitmentsRoot");
        StealthPayout.Group[] memory gs = _fixtureGroups(json);
        bytes[] memory metas = vm.parseJsonBytesArray(json, ".metadata");

        vm.recordLogs();
        vm.prank(operator);
        payout.settleNotes{value: declared}(epoch, root, declared, gs);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ANNOUNCER) continue;
            (, bytes memory meta) = abi.decode(logs[i].data, (bytes, bytes));
            assertEq(meta, metas[k++], "Solidity metadata == ts metadataForETH");
        }
        assertEq(k, metas.length);
        for (uint256 j; j < gs.length; ++j) {
            for (uint256 i; i < gs[j].rs.length; ++i) {
                assertEq(gs[j].rs[i].stealthAddress.balance, gs[j].amountEach);
            }
        }
        assertEq(payout.commitmentsRootOf(operator, epoch), root);
        (, uint256 o) = _outstanding(operator, epoch);
        assertEq(o, 0);
        _checkFixtureDebt(json, epoch, root);
    }

    function _fixtureGroups(string memory json) internal pure returns (StealthPayout.Group[] memory gs) {
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        uint256[] memory counts = vm.parseJsonUintArray(json, ".counts");
        address[] memory addrs = vm.parseJsonAddressArray(json, ".stealthAddresses");
        bytes[] memory keys = vm.parseJsonBytesArray(json, ".ephemeralPubKeys");
        uint256[] memory tags = vm.parseJsonUintArray(json, ".viewTags");
        gs = new StealthPayout.Group[](amounts.length);
        uint256 at;
        for (uint256 j; j < amounts.length; ++j) {
            gs[j] = StealthPayout.Group(amounts[j], new StealthPayout.Recipient[](counts[j]));
            for (uint256 i; i < counts[j]; ++i) {
                gs[j].rs[i] = StealthPayout.Recipient(addrs[at], keys[at], bytes1(uint8(tags[at])));
                ++at;
            }
        }
        assertEq(at, addrs.length);
    }

    struct Line {
        uint256 epoch;
        address owner;
        uint256 debt;
        uint256 carryIn;
        bytes32 root;
    }

    /// @dev Dave's private receipts open, with Solidity's own encoding, to leaves in the settled root, and add up to exactly
    ///      floor((debt + carryIn) / base) * base.
    function _checkFixtureDebt(string memory json, uint256 epoch, bytes32 root) internal view {
        Line memory l = Line(
            epoch,
            vm.parseJsonAddress(json, ".receipt.owner"),
            vm.parseJsonUint(json, ".receipt.debt"),
            vm.parseJsonUint(json, ".receipt.carryIn"),
            root
        );
        uint256 base = vm.parseJsonUint(json, ".base");
        uint256 count = vm.parseJsonAddressArray(json, ".receipt.stealthAddresses").length;
        uint256 sum;
        for (uint256 i; i < count; ++i) {
            sum += _checkNote(json, i, l);
        }
        // forge-lint: disable-next-line(divide-before-multiply) rounding down to the base unit is the rule
        assertEq(sum, ((l.debt + l.carryIn) / base) * base, "notes settle exactly the debt (rest carried)");
        assertGt(l.debt + l.carryIn - sum, 0);
        assertLt(l.debt + l.carryIn - sum, base);
    }

    function _checkNote(string memory json, uint256 i, Line memory l) internal view returns (uint256 denomination) {
        string memory at = string.concat("[", vm.toString(i), "]");
        address a = vm.parseJsonAddress(json, string.concat(".receipt.stealthAddresses", at));
        denomination = vm.parseJsonUint(json, string.concat(".receipt.denominations", at));
        bytes32 salt = vm.parseJsonBytes32(json, string.concat(".receipt.salts", at));
        bytes32 leaf =
            keccak256(bytes.concat(keccak256(abi.encode(l.epoch, l.owner, l.debt, l.carryIn, a, denomination, salt))));
        assertEq(
            leaf, vm.parseJsonBytes32(json, string.concat(".receipt.leaves", at)), "Solidity leaf == ts noteLeafHash"
        );
        assertTrue(
            _verify(vm.parseJsonBytes32Array(json, string.concat(".receipt.proofs", at)), l.root, leaf), "inclusion"
        );
        assertEq(a.balance, denomination, "paid that denomination");
    }

    function _verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            h = h < proof[i] ? keccak256(abi.encode(h, proof[i])) : keccak256(abi.encode(proof[i], h));
        }
        return h == root;
    }

    // ---------------------------------------------------------------- gas: the 200-holder epoch

    function _measure(uint256 epoch, uint256 declared, StealthPayout.Group[] memory gs)
        internal
        returns (uint256 total, uint256 notes)
    {
        bytes memory cd = abi.encodeCall(StealthPayout.settleNotes, (epoch, ROOT, declared, gs));
        uint256 value = _sum(gs);
        vm.prank(operator);
        uint256 g = gasleft();
        (bool ok,) = address(payout).call{value: value}(cd);
        uint256 exec = g - gasleft();
        assertTrue(ok, "settleNotes");
        for (uint256 j; j < gs.length; ++j) {
            notes += gs[j].rs.length;
        }
        total = exec + _calldataGas(cd) + 21_000;
    }

    /// @dev Splits groups into parts of at most maxNotes notes, keeping the order (like ts/notes.ts splitParts).
    function _part(StealthPayout.Group[] memory gs, uint256 from, uint256 maxNotes)
        internal
        pure
        returns (StealthPayout.Group[] memory part, uint256 next)
    {
        uint256 skip = from;
        uint256 room = maxNotes;
        StealthPayout.Group[] memory tmp = new StealthPayout.Group[](gs.length);
        uint256 used;
        for (uint256 j; j < gs.length && room > 0; ++j) {
            uint256 n = gs[j].rs.length;
            if (skip >= n) {
                skip -= n;
                continue;
            }
            uint256 take = n - skip < room ? n - skip : room;
            StealthPayout.Recipient[] memory rs = new StealthPayout.Recipient[](take);
            for (uint256 i; i < take; ++i) {
                rs[i] = gs[j].rs[skip + i];
            }
            tmp[used++] = StealthPayout.Group(gs[j].amountEach, rs);
            room -= take;
            skip = 0;
        }
        part = new StealthPayout.Group[](used);
        for (uint256 j; j < used; ++j) {
            part[j] = tmp[j];
        }
        next = from + maxNotes - room;
    }

    function test_gas_notes200() public {
        string memory json = vm.readFile("test/fixtures/notes200.json");
        uint256[] memory amounts = vm.parseJsonUintArray(json, ".amounts");
        uint256 declared = vm.parseJsonUint(json, ".declaredTotal");
        StealthPayout.Group[] memory gs = _groups(amounts, vm.parseJsonUintArray(json, ".counts"), 200);
        assertEq(_sum(gs), declared, "fixture adds up");

        // Whole epoch in one transaction (fine on a chain without a per-transaction cap).
        (uint256 total, uint256 n) = _measure(1, declared, gs);
        assertEq(n, vm.parseJsonUint(json, ".notes"));
        console2.log("200 holders: notes", n);
        console2.log("  one transaction, total gas (incl. 21000 + calldata):", total);
        console2.log("  per note:", total / n);
        assertLt(total / n, 50_000, "per-note cost regression");

        uint256 safeNotes = _worstCaseNotesPerPart(amounts[0]);
        uint256 parts = _settleInParts(gs, declared, safeNotes);
        console2.log("  parts under 2^24:", parts);
    }

    /// @dev Worst case per note: every recipient is a contract that burns its gas (an EIP-7702 front-run), so every note
    ///      parks. Returns how many notes fit a 2^24-gas transaction even then.
    function _worstCaseNotesPerPart(uint256 amount) internal returns (uint256 safeNotes) {
        uint256 burners = 60;
        StealthPayout.Group[] memory bg = new StealthPayout.Group[](1);
        bg[0] = StealthPayout.Group(amount, _recipients(burners, 999));
        bytes memory burnerCode = address(new GasBurner()).code;
        for (uint256 i; i < burners; ++i) {
            vm.etch(bg[0].rs[i].stealthAddress, burnerCode);
        }
        (uint256 worstTotal,) = _measure(2, _sum(bg), bg);
        uint256 worstPerNote = worstTotal / burners;
        safeNotes = (TX_GAS_CAP - 60_000) / worstPerNote;
        assertEq(payout.parked(bg[0].rs[0].stealthAddress), amount);
        console2.log("  worst case per note (all recipients burn gas and park):", worstPerNote);
        console2.log("  notes per part that fit 2^24 gas even in the worst case:", safeNotes);
    }

    /// @dev Under EIP-7825 (2^24 gas per transaction): the same epoch in parts of `maxNotes`, same root and declared total.
    ///      Fresh addresses: the one-transaction run already paid (and marked) the fixture's.
    function _settleInParts(StealthPayout.Group[] memory gs, uint256 declared, uint256 maxNotes)
        internal
        returns (uint256 parts)
    {
        uint256 from;
        uint256 n;
        for (uint256 j; j < gs.length; ++j) {
            n += gs[j].rs.length;
        }
        while (from < n) {
            StealthPayout.Group[] memory part;
            (part, from) = _part(gs, from, maxNotes);
            for (uint256 j; j < part.length; ++j) {
                part[j].rs = _recipients(part[j].rs.length, 5000 + parts * 100 + j);
            }
            (uint256 partGas,) = _measure(3, declared, part);
            assertLt(partGas, TX_GAS_CAP, "each part fits a 2^24 transaction");
            console2.log("  part", parts, "gas:", partGas);
            ++parts;
        }
        (, uint256 o) = _outstanding(operator, 3);
        assertEq(o, 0, "the parts add up to the declared total");
    }
}
