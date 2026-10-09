import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { stealthPrivateKey } from './stealth.ts';
import { findMyPayouts, paymentsOf } from './payout-plan.ts';
import { buildTree, merkleProof, proveEntitlement, verifyEntitlement, verifyInclusion, type EntitlementProof, type OnchainEpoch } from './proof.ts';
import { testPlan } from './fixture.ts';

test('Merkle: every leaf proves its inclusion, nothing else does, and the root ignores input order', () => {
  for (let size = 1; size <= 17; size++) {
    const leaves = Array.from({ length: size }, (_, i) => keccak256(toHex(`leaf ${size}/${i}`)));
    const tree = buildTree(leaves);
    assert.equal(buildTree([...leaves].reverse()).root, tree.root);
    for (const l of leaves) {
      const p = merkleProof(tree, l);
      assert.ok(verifyInclusion(l, p, tree.root));
      if (p.length > 0) {
        const tampered = [...p];
        tampered[0] = keccak256(tampered[0]);
        assert.ok(!verifyInclusion(l, tampered, tree.root));
      }
    }
    assert.ok(!verifyInclusion(keccak256(toHex('not a leaf')), merkleProof(tree, leaves[0]), tree.root));
  }
  assert.throws(() => buildTree([]), /No leaves/);
  assert.throws(() => buildTree([keccak256('0x01'), keccak256('0x01')]), /Duplicate/);
});

// A realistic setting: dave holds NFTs 5, 6 and 7; he proves to one verifier (say, an auditor Claus picks) that a given
// payment settled NFT 6's reward for epoch 7. The verifier reads the chain; nothing is published.
const CHAIN_ID = 8453;
const PAYOUT: Address = '0x000000000000000000000000000000000000b0b0';
const PAYER: Address = '0x00000000000000000000000000000000000a1fa1';
const VERIFIER = 'auditor.example: entitlement check';

async function setting() {
  const { owners, plan } = testPlan();
  const dave = owners.find((o) => o.name === 'dave')!;
  const found = findMyPayouts(dave.keys, { epoch: plan.epoch, amountEach: plan.amountEach, payments: paymentsOf(plan), leaves: plan.leaves, myNftIds: dave.nftIds });
  const receipt = found.receipts.find((r) => r.nftId === 6n)!;
  const sk = stealthPrivateKey(dave.keys.spendingPrivateKey, dave.keys.viewingPrivateKey, receipt.ephemeralPubKey);
  const onchain: OnchainEpoch = {
    chainId: CHAIN_ID,
    payoutContract: PAYOUT,
    payer: PAYER,
    epoch: plan.epoch,
    commitmentsRoot: plan.commitmentsRoot,
    amountEach: plan.amountEach,
    paidStealthAddresses: plan.recipients.map((r) => r.stealthAddress),
  };
  const challenge = keccak256(toHex('verifier nonce 1'));
  return { owners, plan, dave, receipt, sk, onchain, challenge };
}

test('the holder proves one payment to one verifier: signed by the stealth key, leaf opens, leaf is in the settled root', async () => {
  const { receipt, sk, onchain, challenge } = await setting();
  assert.equal(privateKeyToAccount(sk).address, getAddress(receipt.stealthAddress), 'the derived key controls the paid address');

  const proof = await proveEntitlement({ receipt, stealthPrivateKey: sk, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const v = await verifyEntitlement(proof, { verifier: VERIFIER, challenge, onchain });
  assert.deepEqual(v, { ok: true, nftId: 6n, stealthAddress: getAddress(receipt.stealthAddress) });
});

test('optionally also signed by the owner wallet, so the verifier can check ownerOf(nftId) itself', async () => {
  const { dave, receipt, sk, onchain, challenge } = await setting();
  const proof = await proveEntitlement({
    receipt, stealthPrivateKey: sk, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge, ownerPrivateKey: dave.walletKey,
  });
  const v = await verifyEntitlement(proof, { verifier: VERIFIER, challenge, onchain });
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.ownerWallet, privateKeyToAccount(dave.walletKey).address);

  const bobWallet = privateKeyToAccount(keccak256(toHex('bob wallet'))).address;
  const forged: EntitlementProof = { ...proof, statement: { ...proof.statement, ownerWallet: bobWallet } };
  assert.equal((await verifyEntitlement(forged, { verifier: VERIFIER, challenge, onchain })).ok, false);
});

test('what the verifier rejects', async () => {
  const { owners, plan, receipt, sk, onchain, challenge } = await setting();
  const proof = await proveEntitlement({ receipt, stealthPrivateKey: sk, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const check = async (p: EntitlementProof, expect = { verifier: VERIFIER, challenge, onchain }) => {
    const v = await verifyEntitlement(p, expect);
    return v.ok ? 'ok' : v.reason;
  };

  assert.equal(await check(proof, { verifier: 'someone else', challenge, onchain }), 'made for another verifier');
  assert.equal(await check(proof, { verifier: VERIFIER, challenge: keccak256(toHex('verifier nonce 2')), onchain }), 'stale or foreign challenge');
  assert.equal(await check(proof, { verifier: VERIFIER, challenge, onchain: { ...onchain, chainId: 1 } }), 'wrong chain or contract');
  assert.equal(await check(proof, { verifier: VERIFIER, challenge, onchain: { ...onchain, epoch: 8n } }), 'wrong payer or epoch');
  assert.equal(await check(proof, { verifier: VERIFIER, challenge, onchain: { ...onchain, commitmentsRoot: keccak256('0x00') } }), 'root does not match the chain');
  assert.equal(await check(proof, { verifier: VERIFIER, challenge, onchain: { ...onchain, amountEach: 1n } }), 'amount does not match the chain');
  assert.equal(
    await check(proof, { verifier: VERIFIER, challenge, onchain: { ...onchain, paidStealthAddresses: onchain.paidStealthAddresses.filter((a) => a !== receipt.stealthAddress) } }),
    'address was not paid in this epoch',
  );
  assert.equal(await check({ ...proof, salt: keccak256(proof.salt) }), 'leaf does not open to this NFT and address');
  assert.equal(await check({ ...proof, statement: { ...proof.statement, nftId: 5n } }), 'leaf does not open to this NFT and address', 'cannot re-label it as another NFT');
  assert.equal(await check({ ...proof, merkleProof: proof.merkleProof.slice(1) }), 'leaf not in the committed root');

  // Bob sees the same public payment and knows dave's NFT ids (ownership is public). Without the stealth key he cannot sign.
  const bob = owners.find((o) => o.name === 'bob')!;
  const bobKey = stealthPrivateKey(bob.keys.spendingPrivateKey, bob.keys.viewingPrivateKey, receipt.ephemeralPubKey); // wrong key for this address
  await assert.rejects(
    proveEntitlement({ receipt, stealthPrivateKey: bobKey, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge }),
    /does not control/,
  );
  const otherReceipt = plan.receipts.find((r) => r.nftId === 2n)!; // bob's own payment: valid key for a different address
  const bobSk = stealthPrivateKey(bob.keys.spendingPrivateKey, bob.keys.viewingPrivateKey, otherReceipt.ephemeralPubKey);
  const bobsProof = await proveEntitlement({ receipt: otherReceipt, stealthPrivateKey: bobSk, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const spliced: EntitlementProof = { ...proof, stealthSignature: bobsProof.stealthSignature };
  assert.equal(await check(spliced), 'not signed by the stealth address');
  assert.equal(await check({ ...proof, ownerSignature: bobsProof.stealthSignature }), 'owner signature without an owner wallet');
});

test('the proof reveals nothing about the holder\'s other payouts', async () => {
  const { dave, plan, receipt, sk, challenge } = await setting();
  const proof = await proveEntitlement({ receipt, stealthPrivateKey: sk, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const shown = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
  const others = plan.receipts.filter((r) => dave.nftIds.includes(r.nftId) && r.nftId !== 6n);
  assert.equal(others.length, 2);
  for (const r of others) {
    assert.ok(!shown.includes(r.stealthAddress.slice(2).toLowerCase()), 'other payout address not in the proof');
    assert.ok(!shown.includes(r.salt.slice(2)), 'other salt not in the proof');
  }
  for (const secret of [dave.keys.viewingPrivateKey, dave.keys.spendingPrivateKey, dave.keys.viewingPublicKey, dave.keys.spendingPublicKey, sk] as Hex[]) {
    assert.ok(!shown.includes(secret.slice(2).toLowerCase()), 'no key material in the proof');
  }
});
