// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test, Vm, console2} from "forge-std/Test.sol";
import {StealthPayout, IERC5564Announcer} from "../src/StealthPayout.sol";

/// @dev Same event and behaviour as the canonical ERC-5564 Announcer (it only emits).
contract Announcer {
    event Announcement(
        uint256 indexed schemeId,
        address indexed stealthAddress,
        address indexed caller,
        bytes ephemeralPubKey,
        bytes metadata
    );

    function announce(uint256 schemeId, address stealthAddress, bytes memory ephemeralPubKey, bytes memory metadata)
        external
    {
        emit Announcement(schemeId, stealthAddress, msg.sender, ephemeralPubKey, metadata);
    }
}

/// @dev Code put on a stealth address with vm.etch, standing in for an EIP-7702 delegation its owner set.
contract Rejecter {
    receive() external payable {
        revert("no thanks");
    }
}

contract GasBurner {
    uint256 internal x;

    receive() external payable {
        while (true) {
            x = x; // never ends: burns whatever gas it is given
        }
    }
}

/// @dev On receiving ETH, tries to call back into StealthPayout (mode 0: release(self), 1: withdrawParked(self),
///      2: settle(...) as itself), logs what came back, then accepts or reverts.
contract ReentrantRecipient {
    event Reentry(bool ok, bytes4 errorSelector);

    StealthPayout internal immutable target;
    uint256 internal immutable mode;
    bool internal immutable acceptAfter;

    constructor(StealthPayout t, uint256 m, bool accept) {
        target = t;
        mode = m;
        acceptAfter = accept;
    }

    receive() external payable {
        bytes memory data;
        if (mode == 0) data = abi.encodeCall(StealthPayout.release, (address(this)));
        else if (mode == 1) data = abi.encodeCall(StealthPayout.withdrawParked, (address(this)));
        else data = abi.encodeCall(StealthPayout.settle, (1, bytes32(uint256(1)), new StealthPayout.Recipient[](0)));
        (bool ok, bytes memory ret) = address(target).call(data);
        emit Reentry(ok, ret.length >= 4 ? bytes4(ret) : bytes4(0));
        if (!acceptAfter) revert("refused");
    }

    function pull(address to) external {
        target.withdrawParked(to);
    }
}

contract StealthPayoutTest is Test {
    address constant ANNOUNCER = 0x55649E01B5Df198D18D95b5cc5051630cfD45564;
    bytes32 constant ANNOUNCEMENT_TOPIC = keccak256("Announcement(uint256,address,address,bytes,bytes)");
    bytes32 constant REENTRY_TOPIC = keccak256("Reentry(bool,bytes4)");
    bytes32 constant ROOT = keccak256("commitments root");

    StealthPayout internal payout;
    address internal operator = makeAddr("operator");

    event EpochSettled(
        address indexed payer, uint256 indexed epoch, uint256 count, uint256 amountEach, bytes32 commitmentsRoot
    );
    event Parked(address indexed recipient, uint256 amount);
    event Released(address indexed recipient, address indexed to, uint256 amount);

    function setUp() public {
        vm.etch(ANNOUNCER, address(new Announcer()).code);
        payout = new StealthPayout(IERC5564Announcer(ANNOUNCER));
        vm.deal(operator, 1_000 ether);
    }

    // ---------------------------------------------------------------- helpers

    /// @dev n fresh addresses in ascending order (random gaps), 33-byte compressed-looking keys, random view tags.
    function _recipients(uint256 n, uint256 seed) internal pure returns (StealthPayout.Recipient[] memory rs) {
        rs = new StealthPayout.Recipient[](n);
        uint160 a = uint160(1) << 155;
        for (uint256 i; i < n; ++i) {
            bytes32 h = keccak256(abi.encode(seed, i));
            a += 1 + uint160(uint256(h) >> 106);
            rs[i] = StealthPayout.Recipient(
                address(a), abi.encodePacked(bytes1(uint8(2 + (uint8(h[0]) & 1))), keccak256(abi.encode(h))), h[1]
            );
        }
    }

    function _settle(uint256 epoch, StealthPayout.Recipient[] memory rs, uint256 value) internal {
        vm.prank(operator);
        payout.settle{value: value}(epoch, ROOT, rs);
    }

    function _meta(bytes1 viewTag, uint256 amount) internal pure returns (bytes memory) {
        return
            abi.encodePacked(viewTag, bytes4(0xeeeeeeee), address(0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE), amount);
    }

    function _calldataGas(bytes memory cd) internal pure returns (uint256 g) {
        for (uint256 i; i < cd.length; ++i) {
            g += cd[i] == 0 ? 4 : 16;
        }
    }

    /// @dev OpenZeppelin MerkleProof (sorted pairs), same as ts/proof.ts.
    function _verify(bytes32[] memory proof, bytes32 root, bytes32 leaf) internal pure returns (bool) {
        bytes32 h = leaf;
        for (uint256 i; i < proof.length; ++i) {
            h = h < proof[i] ? keccak256(abi.encode(h, proof[i])) : keccak256(abi.encode(proof[i], h));
        }
        return h == root;
    }

    // ---------------------------------------------------------------- equal split

    function test_equalSplit_everyRecipientGetsTheSameAmount() public {
        StealthPayout.Recipient[] memory rs = _recipients(5, 1);
        _settle(7, rs, 5 ether);
        for (uint256 i; i < 5; ++i) {
            assertEq(rs[i].stealthAddress.balance, 1 ether, "same amount each");
        }
        assertEq(address(payout).balance, 0, "nothing left in the contract");
        assertEq(operator.balance, 995 ether);
        assertEq(payout.commitmentsRootOf(operator, 7), ROOT, "epoch log");
    }

    function testFuzz_equalSplit(uint8 count, uint96 amountEach, uint256 seed) public {
        uint256 n = bound(count, 1, 40);
        uint256 each = bound(amountEach, 1, 1e21);
        StealthPayout.Recipient[] memory rs = _recipients(n, seed);
        vm.deal(operator, n * each);
        _settle(seed, rs, n * each);
        for (uint256 i; i < n; ++i) {
            assertEq(rs[i].stealthAddress.balance, each);
        }
        assertEq(address(payout).balance, 0);
    }

    function test_remainderReverts() public {
        StealthPayout.Recipient[] memory rs = _recipients(3, 2);
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.UnequalSplit.selector, 10, 3));
        payout.settle{value: 10}(7, ROOT, rs);
    }

    function test_zeroAmountReverts() public {
        StealthPayout.Recipient[] memory rs = _recipients(3, 2);
        vm.prank(operator);
        vm.expectRevert(StealthPayout.ZeroAmount.selector);
        payout.settle{value: 0}(7, ROOT, rs);
    }

    // ---------------------------------------------------------------- ERC-5564 announcements and events

    function test_announcementsMatchERC5564() public {
        uint256 n = 4;
        StealthPayout.Recipient[] memory rs = _recipients(n, 3);
        vm.recordLogs();
        _settle(9, rs, n * 0.25 ether);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ANNOUNCER) continue;
            assertEq(logs[i].topics[0], ANNOUNCEMENT_TOPIC);
            assertEq(uint256(logs[i].topics[1]), 1, "scheme 1");
            assertEq(address(uint160(uint256(logs[i].topics[2]))), rs[k].stealthAddress, "stealth address");
            assertEq(address(uint160(uint256(logs[i].topics[3]))), address(payout), "caller");
            (bytes memory eph, bytes memory meta) = abi.decode(logs[i].data, (bytes, bytes));
            assertEq(eph, rs[k].ephemeralPubKey, "ephemeral key");
            assertEq(meta.length, 57, "57-byte metadata");
            assertEq(meta, _meta(rs[k].viewTag, 0.25 ether), "view tag | 0xeeeeeeee | 0xEeee..EEeE | amount");
            ++k;
        }
        assertEq(k, n, "one announcement per payment");
    }

    function test_epochSettledEvent_onlyPerEpochData() public {
        StealthPayout.Recipient[] memory rs = _recipients(6, 4);
        vm.expectEmit(true, true, false, true, address(payout));
        emit EpochSettled(operator, 7, 6, 0.5 ether, ROOT);
        _settle(7, rs, 3 ether);
    }

    // ---------------------------------------------------------------- input checks and the epoch log

    function test_inputChecks() public {
        StealthPayout.Recipient[] memory rs = _recipients(3, 5);
        vm.startPrank(operator);

        vm.expectRevert(StealthPayout.NoRecipients.selector);
        payout.settle{value: 1 ether}(1, ROOT, new StealthPayout.Recipient[](0));

        vm.expectRevert(StealthPayout.ZeroRoot.selector);
        payout.settle{value: 3 ether}(1, bytes32(0), rs);

        StealthPayout.Recipient[] memory bad = _recipients(3, 5);
        bad[0].stealthAddress = address(0);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.ZeroStealthAddress.selector, 0));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        bad = _recipients(3, 5);
        bad[2].stealthAddress = bad[1].stealthAddress; // the same address twice would get a distinctive 2x balance
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.NotAscending.selector, 2));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        bad = _recipients(3, 5);
        (bad[0], bad[1]) = (bad[1], bad[0]); // out of order
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.NotAscending.selector, 1));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        bad = _recipients(3, 5);
        bad[1].ephemeralPubKey = abi.encodePacked(bytes1(0x02), bytes31(0)); // 32 bytes
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.BadEphemeralKey.selector, 1));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        bad = _recipients(3, 5);
        bad[1].ephemeralPubKey = abi.encodePacked(bytes1(0x04), keccak256("x"), keccak256("y")); // 65 bytes, uncompressed
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.BadEphemeralKey.selector, 1));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        bad = _recipients(3, 5);
        bad[2].ephemeralPubKey = abi.encodePacked(bytes1(0x05), keccak256("x")); // 33 bytes, bad prefix
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.BadEphemeralKey.selector, 2));
        payout.settle{value: 3 ether}(1, ROOT, bad);

        vm.stopPrank();
        assertEq(address(payout).balance, 0);
        assertEq(payout.commitmentsRootOf(operator, 1), bytes32(0), "nothing settled");
    }

    function test_duplicateEpochReverts_perCaller() public {
        _settle(7, _recipients(3, 6), 3 ether);

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(StealthPayout.EpochAlreadySettled.selector, operator, 7));
        payout.settle{value: 3 ether}(7, ROOT, _recipients(3, 7));

        // Another payer has its own log: its epoch 7 is independent.
        address other = makeAddr("another project");
        vm.deal(other, 3 ether);
        vm.prank(other);
        payout.settle{value: 3 ether}(7, keccak256("other root"), _recipients(3, 8));
        assertEq(payout.commitmentsRootOf(other, 7), keccak256("other root"));
        assertEq(payout.commitmentsRootOf(operator, 7), ROOT);
    }

    function test_rejectsPlainEthTransfers() public {
        vm.prank(operator);
        (bool ok,) = address(payout).call{value: 1 ether}("");
        assertFalse(ok, "ETH only comes in through settle");
    }

    // ---------------------------------------------------------------- recipients with code (e.g. EIP-7702)

    function test_revertingRecipient_isParked_othersPaid_thenReleased() public {
        StealthPayout.Recipient[] memory rs = _recipients(5, 9);
        address bad = rs[2].stealthAddress;
        vm.etch(bad, address(new Rejecter()).code);

        vm.expectEmit(true, false, false, true, address(payout));
        emit Parked(bad, 1 ether);
        _settle(7, rs, 5 ether);

        for (uint256 i; i < 5; ++i) {
            if (i != 2) assertEq(rs[i].stealthAddress.balance, 1 ether, "others paid");
        }
        assertEq(bad.balance, 0);
        assertEq(payout.parked(bad), 1 ether, "earned reward kept for its owner");
        assertEq(address(payout).balance, 1 ether, "balance == parked");

        // While it still refuses, a push fails and the payment stays parked.
        vm.expectRevert(StealthPayout.SendFailed.selector);
        payout.release(bad);
        assertEq(payout.parked(bad), 1 ether);

        // The owner removes the delegation; anyone (a relayer, or the operator next epoch) pushes it.
        vm.etch(bad, "");
        vm.prank(makeAddr("relayer"));
        payout.release(bad);
        assertEq(bad.balance, 1 ether);
        assertEq(payout.parked(bad), 0);
        assertEq(address(payout).balance, 0);

        vm.expectRevert(StealthPayout.NothingParked.selector);
        payout.release(bad);
    }

    function test_gasBurningRecipient_isBounded() public {
        StealthPayout.Recipient[] memory rs = _recipients(5, 10);
        address burner = rs[4].stealthAddress;
        vm.etch(burner, address(new GasBurner()).code);
        vm.prank(operator);
        uint256 g = gasleft();
        payout.settle{value: 5 ether}(7, ROOT, rs);
        uint256 used = g - gasleft();
        for (uint256 i; i < 4; ++i) {
            assertEq(rs[i].stealthAddress.balance, 1 ether);
        }
        assertEq(payout.parked(burner), 1 ether);
        assertLt(
            used,
            5 * 60_000 + payout.SEND_GAS() + 2_300 + 30_000,
            "a burner costs at most SEND_GAS plus the parking write"
        );
    }

    // ---------------------------------------------------------------- re-entrancy

    function _reentryLogs(Vm.Log[] memory logs) internal pure returns (uint256 seen, bool anyOk, bytes4 lastErr) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != REENTRY_TOPIC) continue;
            (bool ok, bytes4 err) = abi.decode(logs[i].data, (bool, bytes4));
            ++seen;
            anyOk = anyOk || ok;
            lastErr = err;
        }
    }

    function test_reentrancy_duringSettle_isBlocked() public {
        StealthPayout.Recipient[] memory rs = _recipients(5, 11);
        for (uint256 mode; mode < 3; ++mode) {
            // A recipient that tries to call back (release / withdrawParked / settle) and then accepts the ETH.
            address evil = rs[1].stealthAddress;
            vm.etch(evil, address(new ReentrantRecipient(payout, mode, true)).code);
            vm.deal(evil, 0);
            vm.recordLogs();
            _settle(100 + mode, rs, 5 ether);
            (uint256 seen, bool anyOk, bytes4 err) = _reentryLogs(vm.getRecordedLogs());
            assertEq(seen, 1, "it did try to re-enter");
            assertFalse(anyOk, "re-entry failed");
            assertEq(err, StealthPayout.Reentrancy.selector, "blocked by the lock");
            assertEq(evil.balance, 1 ether, "paid exactly once");
            assertEq(payout.parked(evil), 0);
        }
        assertEq(address(payout).balance, 0);
        for (uint256 i; i < 5; ++i) {
            if (i != 1) assertEq(rs[i].stealthAddress.balance, 3 ether, "3 epochs each");
        }
    }

    function test_reentrancy_duringReleaseAndWithdraw_isBlocked() public {
        StealthPayout.Recipient[] memory rs = _recipients(3, 12);
        address evil = rs[0].stealthAddress;

        // Epoch 1: it refuses after trying to re-enter, so its payment is parked.
        vm.etch(evil, address(new ReentrantRecipient(payout, 0, false)).code);
        _settle(1, rs, 3 ether);
        assertEq(payout.parked(evil), 1 ether);

        // release() forwards all gas; it tries release(self) again, is blocked, refuses: nothing moves.
        vm.expectRevert(StealthPayout.SendFailed.selector);
        payout.release(evil);
        assertEq(payout.parked(evil), 1 ether);

        // Now it accepts after trying release(self) again: paid once, never twice.
        vm.etch(evil, address(new ReentrantRecipient(payout, 0, true)).code);
        vm.recordLogs();
        payout.release(evil);
        (uint256 seen, bool anyOk, bytes4 err) = _reentryLogs(vm.getRecordedLogs());
        assertEq(seen, 1);
        assertFalse(anyOk);
        assertEq(err, StealthPayout.Reentrancy.selector);
        assertEq(evil.balance, 1 ether);

        // Epoch 2: parked again; this time it withdraws itself to itself and tries withdrawParked again on receipt.
        vm.etch(evil, address(new ReentrantRecipient(payout, 1, false)).code);
        _settle(2, rs, 3 ether);
        assertEq(payout.parked(evil), 1 ether);
        vm.etch(evil, address(new ReentrantRecipient(payout, 1, true)).code);
        vm.recordLogs();
        ReentrantRecipient(payable(evil)).pull(evil);
        (seen, anyOk, err) = _reentryLogs(vm.getRecordedLogs());
        assertEq(seen, 1);
        assertFalse(anyOk);
        assertEq(err, StealthPayout.Reentrancy.selector);
        assertEq(evil.balance, 2 ether, "two epochs, each paid once");
        assertEq(payout.parked(evil), 0);
        assertEq(address(payout).balance, 0);
        for (uint256 i = 1; i < 3; ++i) {
            assertEq(rs[i].stealthAddress.balance, 2 ether);
        }
    }

    function test_withdrawParked_toAnyAddress() public {
        StealthPayout.Recipient[] memory rs = _recipients(2, 13);
        address smart = rs[1].stealthAddress;
        vm.etch(smart, address(new Rejecter()).code);
        _settle(1, rs, 2 ether);
        address fresh = makeAddr("fresh destination");
        vm.expectEmit(true, true, false, true, address(payout));
        emit Released(smart, fresh, 1 ether);
        vm.prank(smart); // the recipient's own code calls this (an EIP-7702 account can)
        payout.withdrawParked(fresh);
        assertEq(fresh.balance, 1 ether);
        assertEq(address(payout).balance, 0);
        vm.prank(makeAddr("someone else"));
        vm.expectRevert(StealthPayout.NothingParked.selector);
        payout.withdrawParked(fresh);
    }

    // ---------------------------------------------------------------- the TypeScript plan, settled on chain

    function test_fixtureFromTs_settlesAndProofVerifies() public {
        string memory json = vm.readFile("test/fixtures/epoch7.json");
        uint256 epoch = vm.parseJsonUint(json, ".epoch");
        uint256 amountEach = vm.parseJsonUint(json, ".amountEach");
        bytes32 root = vm.parseJsonBytes32(json, ".commitmentsRoot");
        address[] memory addrs = vm.parseJsonAddressArray(json, ".stealthAddresses");
        bytes[] memory keys = vm.parseJsonBytesArray(json, ".ephemeralPubKeys");
        uint256[] memory tags = vm.parseJsonUintArray(json, ".viewTags");
        bytes[] memory metas = vm.parseJsonBytesArray(json, ".metadata");

        uint256 n = addrs.length;
        StealthPayout.Recipient[] memory rs = new StealthPayout.Recipient[](n);
        for (uint256 i; i < n; ++i) {
            rs[i] = StealthPayout.Recipient(addrs[i], keys[i], bytes1(uint8(tags[i])));
        }

        vm.recordLogs();
        vm.prank(operator);
        payout.settle{value: n * amountEach}(epoch, root, rs);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        uint256 k;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != ANNOUNCER) continue;
            (, bytes memory meta) = abi.decode(logs[i].data, (bytes, bytes));
            assertEq(meta, metas[k], "Solidity metadata == ts metadataForETH");
            assertEq(addrs[k].balance, amountEach);
            ++k;
        }
        assertEq(k, n);
        assertEq(payout.commitmentsRootOf(operator, epoch), root);
        _checkFixtureReceipt(json, epoch, root);
    }

    /// @dev A holder's private receipt opens to a leaf in the root that was settled on chain.
    function _checkFixtureReceipt(string memory json, uint256 epoch, bytes32 root) internal view {
        uint256 nftId = vm.parseJsonUint(json, ".receipt.nftId");
        address s = vm.parseJsonAddress(json, ".receipt.stealthAddress");
        bytes32 salt = vm.parseJsonBytes32(json, ".receipt.salt");
        bytes32 leaf = vm.parseJsonBytes32(json, ".receipt.leaf");
        bytes32[] memory proof = vm.parseJsonBytes32Array(json, ".receipt.proof");
        assertEq(
            keccak256(bytes.concat(keccak256(abi.encode(nftId, epoch, s, salt)))), leaf, "Solidity leaf == ts leafHash"
        );
        assertTrue(_verify(proof, root, leaf), "inclusion");
        assertFalse(
            _verify(proof, root, keccak256(bytes.concat(keccak256(abi.encode(nftId + 1, epoch, s, salt))))), "other NFT"
        );
        assertGt(s.balance, 0, "that address was paid");
    }

    // ---------------------------------------------------------------- gas

    function _measure(uint256 n, uint256 epoch) internal returns (uint256 execGas, uint256 calldataGas) {
        StealthPayout.Recipient[] memory rs = _recipients(n, 1000 + n);
        uint256 value = n * 0.001 ether;
        bytes memory cd = abi.encodeCall(StealthPayout.settle, (epoch, ROOT, rs));
        calldataGas = _calldataGas(cd);
        vm.prank(operator);
        uint256 g = gasleft();
        (bool ok,) = address(payout).call{value: value}(cd);
        execGas = g - gasleft();
        assertTrue(ok);
        assertEq(rs[n - 1].stealthAddress.balance, 0.001 ether);
    }

    function test_gasPerRecipient() public {
        uint256[3] memory sizes = [uint256(10), 100, 200];
        uint256[3] memory total;
        console2.log("recipients | execution gas | calldata gas | tx total (incl. 21000) | per recipient");
        for (uint256 j; j < 3; ++j) {
            (uint256 exec, uint256 cdGas) = _measure(sizes[j], 500 + j);
            total[j] = exec + cdGas + 21_000;
            console2.log(
                string.concat(
                    vm.toString(sizes[j]),
                    " | ",
                    vm.toString(exec),
                    " | ",
                    vm.toString(cdGas),
                    " | ",
                    vm.toString(total[j]),
                    " | ",
                    vm.toString(total[j] / sizes[j])
                )
            );
        }
        uint256 marginal = (total[2] - total[1]) / 100;
        console2.log("marginal gas per extra recipient (100 -> 200):", marginal);
        assertLt(marginal, 60_000, "per-recipient cost regression");
    }
}
