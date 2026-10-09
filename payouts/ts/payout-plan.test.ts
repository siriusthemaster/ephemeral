import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, concat, decodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { metadataForETH, parseMetadata, parseMetaAddress, stealthAddressFor, viewTagMatch } from './stealth.ts';
import { findMyPayouts, paymentsOf, planEpoch, randomSalt, settleCalldata, STEALTH_PAYOUT_ABI, type Entitlement } from './payout-plan.ts';
import { leafHash, verifyInclusion } from './proof.ts';
import { testOwners, testPlan, FIXTURE_AMOUNT, FIXTURE_EPOCH } from './fixture.ts';
import { planNotesEpoch } from './notes.ts';
import { smallWorld, SMALL_BASE, SMALL_EPOCH, SMALL_MIN_CROWD } from './notes-fixture.ts';

const strip = (h: string) => h.slice(2).toLowerCase();

test('one equal payment per NFT, fresh addresses in ascending order, nothing per holder in the calldata', () => {
  const { owners, plan } = testPlan();
  const n = owners.reduce((s, o) => s + o.nftIds.length, 0);
  assert.equal(plan.recipients.length, n);
  assert.equal(plan.value, BigInt(n) * FIXTURE_AMOUNT);

  for (let i = 1; i < n; i++) assert.ok(BigInt(plan.recipients[i - 1].stealthAddress) < BigInt(plan.recipients[i].stealthAddress), 'ascending');
  assert.equal(new Set(plan.recipients.map((r) => r.ephemeralPubKey)).size, n, 'a fresh ephemeral key per payment');
  for (const r of plan.recipients) assert.match(r.ephemeralPubKey, /^0x0[23][0-9a-f]{64}$/);

  // Every payment announces the same amount: there is no distinctive amount to follow.
  const amounts = new Set(plan.recipients.map((r) => parseMetadata(metadataForETH(parseInt(r.viewTag.slice(2), 16), plan.amountEach)).amount));
  assert.deepEqual([...amounts], [FIXTURE_AMOUNT]);

  // The transaction input: epoch, root and (stealth address, ephemeral key, view tag) triples. No meta-address, no key of
  // any owner, no owner wallet, no NFT id field.
  const data = settleCalldata(plan);
  const decoded = decodeFunctionData({ abi: STEALTH_PAYOUT_ABI, data });
  assert.equal(decoded.args.length, 3);
  assert.equal(decoded.args[0], FIXTURE_EPOCH);
  assert.equal(decoded.args[1], plan.commitmentsRoot);
  for (const r of decoded.args[2]) assert.deepEqual(Object.keys(r).sort(), ['ephemeralPubKey', 'stealthAddress', 'viewTag']);
  for (const o of owners) {
    for (const secretish of [o.metaAddress, o.keys.spendingPublicKey, o.keys.viewingPublicKey, privateKeyToAccount(o.walletKey).address]) {
      assert.ok(!data.toLowerCase().includes(strip(secretish)), `${o.name}: ${secretish} not in calldata`);
    }
  }
});

test("each owner's viewing key finds exactly its own payouts and rebuilds its receipts from public data", () => {
  const { owners, plan } = testPlan();
  const payments = paymentsOf(plan);
  const seen = new Map<Address, string>();
  for (const o of owners) {
    const mine = findMyPayouts(o.keys, { epoch: plan.epoch, amountEach: plan.amountEach, payments, leaves: plan.leaves, myNftIds: o.nftIds });
    assert.equal(mine.receipts.length, o.nftIds.length, `${o.name} finds one payout per NFT`);
    assert.deepEqual(mine.unmatched, []);
    assert.deepEqual(mine.missing, []);
    assert.deepEqual(mine.receipts.map((r) => r.nftId).sort(), [...o.nftIds].sort());
    for (const r of mine.receipts) {
      const operatorCopy = plan.receipts.find((x) => x.nftId === r.nftId)!;
      assert.deepEqual(r, operatorCopy, 'same receipt the operator holds, without any private delivery');
      assert.ok(verifyInclusion(r.leaf, r.merkleProof, plan.commitmentsRoot));
      assert.ok(!seen.has(r.stealthAddress), 'no payment found by two owners');
      seen.set(r.stealthAddress, o.name);
    }
  }
  assert.equal(seen.size, plan.recipients.length, 'every payment found by its owner');
});

test('an observer who knows every public meta-address and all NFT ownership cannot link a payment to an owner', () => {
  const { owners, plan } = testPlan();
  const payments = paymentsOf(plan);
  const metas = owners.map((o) => ({ name: o.name, ...parseMetaAddress(o.metaAddress) }));
  const allNftIds = [...owners.flatMap((o) => o.nftIds), 13n, 14n]; // NFT ownership is public on chain

  // A. The scan needs the viewing PRIVATE key. Everything an observer can compute from public data fails the address
  //    check: hashing public keys instead of the ECDH secret, or guessing viewing keys.
  const publicGuesses = (ephemeral: Hex, viewing: Hex): Hex[] => [
    keccak256(viewing),
    keccak256(ephemeral),
    keccak256(concat([ephemeral, viewing])),
    keccak256(concat([viewing, ephemeral])),
    keccak256(bytesToHex(secp256k1.ProjectivePoint.fromHex(strip(ephemeral)).add(secp256k1.ProjectivePoint.fromHex(strip(viewing))).toRawBytes(true))),
  ];
  let addressMatches = 0;
  let viewTagHits = 0;
  let tries = 0;
  for (const p of payments) {
    for (const m of metas) {
      for (const h of publicGuesses(p.ephemeralPubKey, m.viewingPublicKey)) {
        tries++;
        if (stealthAddressFor(m.spendingPublicKey, h).toLowerCase() === p.stealthAddress.toLowerCase()) addressMatches++;
      }
      for (let g = 0; g < 32; g++) {
        const guessedViewingKey = keccak256(toHex(`guess/${m.name}/${g}`));
        const h = viewTagMatch(guessedViewingKey, p.ephemeralPubKey, p.viewTag);
        tries++;
        if (!h) continue;
        viewTagHits++; // about 1 in 256 by chance
        if (stealthAddressFor(m.spendingPublicKey, h).toLowerCase() === p.stealthAddress.toLowerCase()) addressMatches++;
      }
    }
  }
  assert.equal(addressMatches, 0, `no link found in ${tries} tries`);
  assert.ok(viewTagHits < tries / 50, 'view tags alone only give chance-level hits');

  // B. The leaves are public. Without the secret salt they open to nothing, even trying every NFT id with every paid
  //    address and every salt an observer could guess.
  const published = new Set(plan.leaves);
  const guessSalts = (nftId: bigint, a: Address, tag: number): Hex[] => [
    toHex(0, { size: 32 }),
    toHex(nftId, { size: 32 }),
    keccak256(toHex(nftId)),
    keccak256(a),
    toHex(tag, { size: 32 }),
    keccak256(concat([toHex('StealthPayout.salt.v1'), toHex(tag, { size: 32 })])),
  ];
  let leafMatches = 0;
  for (const p of payments) {
    for (const nftId of allNftIds) {
      for (const salt of guessSalts(nftId, p.stealthAddress, p.viewTag)) if (published.has(leafHash(nftId, plan.epoch, p.stealthAddress, salt))) leafMatches++;
    }
  }
  assert.equal(leafMatches, 0, 'leaves hide their NFT');

  // Control: the same brute force against a plan with a guessable salt links every payment. The salt must be secret.
  const weak = planEpoch({
    epoch: plan.epoch,
    amountEach: plan.amountEach,
    entitlements: owners.flatMap((o) => o.nftIds.map((nftId) => ({ nftId, metaAddress: o.metaAddress }))),
    salt: ({ nftId }) => toHex(nftId, { size: 32 }),
  });
  const weakLeaves = new Set(weak.leaves);
  let linked = 0;
  for (const r of weak.recipients) for (const nftId of allNftIds) if (weakLeaves.has(leafHash(nftId, weak.epoch, r.stealthAddress, toHex(nftId, { size: 32 })))) linked++;
  assert.equal(linked, weak.recipients.length, 'a guessable salt would give every payment away');

  // C. Position carries nothing either: the order is ascending stealth address (enforced on chain), not NFT order.
  const nftOrder = plan.receipts.map((r) => r.nftId);
  assert.notDeepEqual(nftOrder, [...nftOrder].sort((a, b) => (a < b ? -1 : 1)));
});

test('a skipped or mis-committed holder notices, privately', () => {
  const owners = testOwners();
  const dave = owners.find((o) => o.name === 'dave')!;
  const frank = owners.find((o) => o.name === 'frank')!;
  const entitlements: Entitlement[] = owners.flatMap((o) =>
    o.nftIds
      .filter((id) => id !== 6n) // operator skips dave's NFT 6
      .map((nftId) => ({ nftId: nftId === 12n ? 99n : nftId, metaAddress: o.metaAddress })), // and commits frank's 12 as "99"
  );
  const plan = planEpoch({ epoch: 8n, amountEach: FIXTURE_AMOUNT, entitlements });
  const args = { epoch: plan.epoch, amountEach: plan.amountEach, payments: paymentsOf(plan), leaves: plan.leaves };

  const d = findMyPayouts(dave.keys, { ...args, myNftIds: dave.nftIds });
  assert.deepEqual(d.missing, [6n]);
  assert.equal(d.receipts.length, 2);

  const f = findMyPayouts(frank.keys, { ...args, myNftIds: frank.nftIds });
  assert.equal(f.unmatched.length, 1, 'paid, but the commitment names an NFT frank does not hold');
  assert.deepEqual(f.missing, [12n]);
});

test('random salts work too, but then the operator must hand each receipt over privately', () => {
  const { owners } = testPlan();
  const entitlements = owners.flatMap((o) => o.nftIds.map((nftId) => ({ nftId, metaAddress: o.metaAddress })));
  const plan = planEpoch({ epoch: 9n, amountEach: FIXTURE_AMOUNT, entitlements, salt: randomSalt });
  for (const r of plan.receipts) {
    assert.equal(r.leaf, leafHash(r.nftId, r.epoch, r.stealthAddress, r.salt));
    assert.ok(verifyInclusion(r.leaf, r.merkleProof, plan.commitmentsRoot));
  }
  const bob = owners.find((o) => o.name === 'bob')!;
  const b = findMyPayouts(bob.keys, { epoch: plan.epoch, amountEach: plan.amountEach, payments: paymentsOf(plan), leaves: plan.leaves, myNftIds: bob.nftIds });
  assert.equal(b.unmatched.length, 2, 'bob still finds both payments with his viewing key');
  assert.equal(b.receipts.length, 0, 'but cannot open their leaves without the delivered salts');
});

// @contractclaus (9 Oct): "try a fresh R for the same entitlement in the same round. A second payout must fail; the
// nullifier should track the entitlement, not the destination." On chain: test_freshR_sameEntitlementSameEpoch_* and
// test_notes_freshR_sameEpoch_* (the epoch log is keyed on (payer, epoch)). Here: the planner, the one place that sees
// entitlements, keys on the NFT id (v2: the owner's ledger line), never on the destination.
test('a fresh R for the same entitlement in the same round: new destination, still refused by entitlement', () => {
  const { owners, plan } = testPlan();
  const entitlements = owners.flatMap((o) => o.nftIds.map((nftId) => ({ nftId, metaAddress: o.metaAddress })));
  // The same round planned again: every R is fresh, so every destination and the root are new. Anything keyed on the
  // destination would let all of it through.
  const again = planEpoch({ epoch: plan.epoch, amountEach: plan.amountEach, entitlements });
  const paid = new Set(plan.recipients.map((r) => r.stealthAddress));
  assert.ok(again.recipients.every((r) => !paid.has(r.stealthAddress)), 'no destination in common');
  assert.notEqual(again.commitmentsRoot, plan.commitmentsRoot, 'so a new root: it cannot join the settled round on chain');

  // Inside one round, the same NFT for the same holder twice (two fresh Rs, two destinations): refused by NFT id.
  const bob = owners.find((o) => o.name === 'bob')!;
  const twice = [...entitlements, { nftId: bob.nftIds[0], metaAddress: bob.metaAddress }];
  assert.throws(() => planEpoch({ epoch: plan.epoch, amountEach: plan.amountEach, entitlements: twice }), /NFT 2 listed twice/);

  // v2: the same ledger line (owner, epoch) twice, same meta-address: refused by owner.
  const { holders } = smallWorld();
  assert.throws(
    () => planNotesEpoch({ epoch: SMALL_EPOCH, base: SMALL_BASE, minCrowd: SMALL_MIN_CROWD, holders: [...holders, { ...holders[0] }] }),
    /listed twice: one ledger line per owner per epoch/,
  );
});

test('rejects bad input', () => {
  const { owners } = testPlan();
  const meta = owners[0].metaAddress;
  assert.throws(() => planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [] }), /Nothing to pay/);
  assert.throws(() => planEpoch({ epoch: 1n, amountEach: 0n, entitlements: [{ nftId: 1n, metaAddress: meta }] }), /positive/);
  assert.throws(
    () => planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [{ nftId: 1n, metaAddress: meta }, { nftId: 1n, metaAddress: owners[1].metaAddress }] }),
    /listed twice/,
  );
  assert.throws(() => planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [{ nftId: 1n, metaAddress: '0x1234' }] }), /meta-address/);
  const sameKey = keccak256(toHex('one key for everything'));
  assert.throws(
    () => planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [{ nftId: 1n, metaAddress: meta }, { nftId: 2n, metaAddress: meta }], ephemeralKey: () => sameKey }),
    /Same stealth address twice/,
    'one owner, one reused key: the same address would be paid twice',
  );
  assert.throws(
    () => planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [{ nftId: 1n, metaAddress: meta }, { nftId: 2n, metaAddress: owners[1].metaAddress }], ephemeralKey: () => sameKey }),
    /Ephemeral key reused/,
  );
  assert.equal(getAddress(planEpoch({ epoch: 1n, amountEach: 1n, entitlements: [{ nftId: 1n, metaAddress: `st:eth:${meta}` }] }).recipients[0].stealthAddress).length, 42);
});
