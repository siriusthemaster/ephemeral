import { test } from 'node:test';
import assert from 'node:assert/strict';
import { keccak256, toHex, type Address, type Hex } from 'viem';
import { stealthPrivateKey } from './stealth.ts';
import { findMyNotes, notesOf, planNotesEpoch, type NoteReceipt } from './notes.ts';
import { proveDebtSettled, verifyDebtSettled, type DebtProof, type OnchainNotesEpoch } from './notes-proof.ts';
import { smallPlan, smallWorld, SMALL_BASE, SMALL_EPOCH, SMALL_MIN_CROWD, type SmallOwner } from './notes-fixture.ts';

const CHAIN_ID = 8453;
const PAYOUT: Address = '0x000000000000000000000000000000000000b0b0';
const PAYER: Address = '0x00000000000000000000000000000000000a1fa1';
const VERIFIER = 'auditor.example: debt check';

function setting(name = 'dave') {
  const { owners, lines, plan } = smallPlan();
  const who = owners.find((o) => o.name === name)!;
  const line = lines.find((l) => l.owner === who.owner)!;
  const found = findMyNotes(who.keys, { epoch: plan.epoch, base: plan.base, owner: who.owner, debt: line.debt, carryIn: line.carryIn, notes: notesOf(plan), leaves: plan.leaves });
  const keysFor = (o: SmallOwner, rs: NoteReceipt[]) => rs.map((r) => stealthPrivateKey(o.keys.spendingPrivateKey, o.keys.viewingPrivateKey, r.ephemeralPubKey));
  const onchain: OnchainNotesEpoch = {
    chainId: CHAIN_ID,
    payoutContract: PAYOUT,
    payer: PAYER,
    epoch: plan.epoch,
    commitmentsRoot: plan.commitmentsRoot,
    paidNotes: notesOf(plan).map((n) => ({ stealthAddress: n.stealthAddress, amount: n.amount })),
  };
  const ledger = new Map(lines.map((l) => [l.owner.toLowerCase(), l.debt]));
  const ledgerDebt = (o: Address) => ledger.get(o.toLowerCase());
  const challenge = keccak256(toHex('verifier nonce 1'));
  const prove = (receipts: NoteReceipt[], ownerKey: Hex = who.walletKey, keys = keysFor(who, receipts)) =>
    proveDebtSettled({ receipts, stealthPrivateKeys: keys, ownerPrivateKey: ownerKey, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const expect = { verifier: VERIFIER, challenge, base: SMALL_BASE, ledgerDebt, onchain };
  return { owners, lines, plan, who, line, found, keysFor, onchain, ledgerDebt, challenge, prove, expect };
}

test('a holder proves to one verifier that their notes settled exactly their ledger line (debt incl. carry)', async () => {
  const { who, line, found, prove, expect } = setting('dave');
  assert.equal(found.receipts.length, 4);
  const proof = await prove(found.receipts);
  const v = await verifyDebtSettled(proof, { ...expect, ledgerCarryIn: line.carryIn });
  assert.equal(v.ok, true);
  if (!v.ok) return;
  assert.equal(v.owner, who.owner);
  assert.equal(v.debt, line.debt);
  assert.equal(v.paid + v.carryOut, line.debt + line.carryIn, 'paid + carried == debt + carry in, to the wei');
  assert.ok(v.carryOut < SMALL_BASE);
  assert.equal(v.notes, 4);

  // gina, a previous owner who sold during the epoch, proves her partial share the same way.
  const g = setting('gina');
  const gv = await verifyDebtSettled(await g.prove(g.found.receipts), g.expect);
  assert.equal(gv.ok, true);
});

test('what the verifier rejects', async () => {
  const s = setting('dave');
  const proof = await s.prove(s.found.receipts);
  const check = async (p: DebtProof, e: Partial<typeof s.expect> & { ledgerCarryIn?: bigint } = {}) => {
    const v = await verifyDebtSettled(p, { ...s.expect, ...e });
    return v.ok ? 'ok' : v.reason;
  };
  assert.equal(await check(proof), 'ok');
  assert.equal(await check(proof, { verifier: 'someone else' }), 'made for another verifier');
  assert.equal(await check(proof, { challenge: keccak256(toHex('verifier nonce 2')) }), 'stale or foreign challenge');
  assert.equal(await check(proof, { onchain: { ...s.onchain, chainId: 1 } }), 'wrong chain or contract');
  assert.equal(await check(proof, { onchain: { ...s.onchain, epoch: 9n } }), 'wrong payer or epoch');
  assert.equal(await check(proof, { onchain: { ...s.onchain, commitmentsRoot: keccak256('0x00') } }), 'root does not match the chain');
  assert.equal(await check(proof, { ledgerDebt: () => s.line.debt + 1n }), 'debt does not match the public ledger');
  assert.equal(await check(proof, { ledgerCarryIn: 0n }), 'carry does not match the ledger');
  assert.equal(await check(proof, { onchain: { ...s.onchain, paidNotes: s.onchain.paidNotes.filter((n) => n.stealthAddress !== proof.notes[0].stealthAddress) } }), 'note was not paid in this epoch');
  assert.equal(await check({ ...proof, notes: [{ ...proof.notes[0], denomination: proof.notes[0].denomination * 2n }, ...proof.notes.slice(1)] }), 'denomination does not match the chain');
  assert.equal(await check({ ...proof, notes: [{ ...proof.notes[0], salt: keccak256(proof.notes[0].salt) }, ...proof.notes.slice(1)] }), 'note does not open to this ledger line');
  assert.equal(await check({ ...proof, notes: [proof.notes[0], ...proof.notes] }), 'a note is listed twice');
  assert.equal(await check({ ...proof, notes: proof.notes.slice(1) }), 'statement does not name these notes');
  assert.equal(await check({ ...proof, notes: [{ ...proof.notes[0], signature: proof.notes[1].signature }, ...proof.notes.slice(1)] }), 'note not signed by its stealth address');
  assert.equal(await check({ ...proof, ownerSignature: proof.notes[0].signature }), 'not signed by the owner');

  // Showing only some notes: the holder signs a new statement over 3 of 4, and the sum no longer settles the debt.
  assert.equal(await check(await s.prove(s.found.receipts.slice(1))), 'notes do not settle the debt exactly');

  // Splicing in someone else's note: frank's note does not open to dave's ledger line (and dave cannot sign for it).
  const f = setting('frank');
  const franks = await f.prove(f.found.receipts);
  assert.equal(await check({ ...proof, notes: [...proof.notes.slice(1), franks.notes[0]] }), 'note does not open to this ledger line');

  // Someone who knows dave's wallet, debt and the public batch but not his keys cannot build the proof.
  const bob = s.owners.find((o) => o.name === 'bob')!;
  await assert.rejects(s.prove(s.found.receipts, bob.walletKey), /owner key/);
  await assert.rejects(s.prove(s.found.receipts, s.who.walletKey, s.keysFor(bob, s.found.receipts)), /does not control/);
});

test('a misstated debt is provable to the verifier; an omitted note is not (that needs the ZK statement)', async () => {
  const { owners, lines, holders } = smallWorld();
  const dave = owners.find((o) => o.name === 'dave')!;
  const line = lines.find((l) => l.owner === dave.owner)!;
  const committed = line.debt - SMALL_BASE; // the operator commits one unit less than the ledger says, and pays that
  const lied = planNotesEpoch({ epoch: SMALL_EPOCH, base: SMALL_BASE, minCrowd: SMALL_MIN_CROWD, holders: holders.map((h) => (h.owner === dave.owner ? { ...h, debt: committed } : h)) });
  const mine = findMyNotes(dave.keys, { epoch: SMALL_EPOCH, base: SMALL_BASE, owner: dave.owner, debt: committed, carryIn: line.carryIn, notes: notesOf(lied), leaves: lied.leaves });
  const keys = mine.receipts.map((r) => stealthPrivateKey(dave.keys.spendingPrivateKey, dave.keys.viewingPrivateKey, r.ephemeralPubKey));
  const challenge = keccak256(toHex('n'));
  const proof = await proveDebtSettled({ receipts: mine.receipts, stealthPrivateKeys: keys, ownerPrivateKey: dave.walletKey, payer: PAYER, chainId: CHAIN_ID, payoutContract: PAYOUT, verifier: VERIFIER, challenge });
  const onchain: OnchainNotesEpoch = { chainId: CHAIN_ID, payoutContract: PAYOUT, payer: PAYER, epoch: SMALL_EPOCH, commitmentsRoot: lied.commitmentsRoot, paidNotes: notesOf(lied).map((n) => ({ stealthAddress: n.stealthAddress, amount: n.amount })) };
  const base = { verifier: VERIFIER, challenge, base: SMALL_BASE, onchain };
  // Every check passes against what the operator committed on chain ...
  assert.equal((await verifyDebtSettled(proof, { ...base, ledgerDebt: () => committed })).ok, true);
  // ... and fails only on the public ledger: the verifier now holds evidence that the payer committed a wrong debt for dave.
  const v = await verifyDebtSettled(proof, { ...base, ledgerDebt: () => line.debt });
  assert.equal(v.ok ? 'ok' : v.reason, 'debt does not match the public ledger');
});

test('the proof shows the verifier only this holder\'s notes of this epoch, and no key material', async () => {
  const { owners, plan, who, found, prove, keysFor } = setting('dave');
  const proof = await prove(found.receipts);
  const shown = JSON.stringify(proof, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).toLowerCase();
  for (const r of plan.receipts.filter((x) => x.owner !== who.owner)) {
    assert.ok(!shown.includes(r.stealthAddress.slice(2).toLowerCase()), 'no other holder\'s note');
    assert.ok(!shown.includes(r.salt.slice(2)), 'no other salt');
  }
  for (const secret of [who.keys.viewingPrivateKey, who.keys.spendingPrivateKey, who.walletKey, ...keysFor(who, found.receipts)] as Hex[]) {
    assert.ok(!shown.includes(secret.slice(2).toLowerCase()), 'no key material');
  }
  assert.equal(owners.length, 7);
});
