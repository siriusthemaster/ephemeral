import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { parseMetadata } from '../lib/decode.ts';
import { analyze, type Dataset } from '../lib/heuristics.ts';
import * as fx from './fixture.ts';

const dataset = (): Dataset => ({
  payments: fx.payments.map((p) => ({
    source: p.source,
    stealth: p.stealth,
    sender: p.sender,
    block: p.block,
    timestamp: fx.timeOf(p.block),
    asset: p.asset,
    token: p.token,
    txHash: p.tx,
  })),
  withdrawals: fx.withdrawals.map((w) => ({
    stealth: w.stealth,
    txHash: w.tx,
    block: w.block,
    to: w.to,
    kind: w.kind,
    token: w.token,
    txFrom: w.txFrom,
    txType: w.type,
    priorityFee: w.type >= 2 ? w.fee : null,
  })),
  fundings: fx.fundings.map((f) => ({ stealth: f.stealth, txHash: f.tx, block: f.block, from: f.from })),
  registrations: fx.registrations,
  contracts: new Set(fx.contracts),
  delegated: new Set<string>(),
  preUsed: new Set(fx.preUsed),
});

const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: fx.CUTOFF_BLOCK };

test('every rule fires exactly where the fixture says', () => {
  assert.deepEqual(analyze(dataset(), opts), fx.expected);
});

test('paper metric is |H1 or H2| over all withdrawn, not over single withdrawals', () => {
  const r = analyze(dataset(), opts).all;
  assert.equal(r.paperPct, Math.round((r.paperLinked / r.withdrawn) * 10_000) / 100);
  assert.notEqual(r.withdrawn, r.singleWithdrawal);
});

test('a registration after the cutoff does not count for the comparable figure', () => {
  const ds = dataset();
  ds.registrations = [{ registrant: fx.R1, block: fx.CUTOFF_BLOCK + 1, registry: 'umbra' }];
  assert.equal(analyze(ds, opts).paperComparable.h1Single, 0);
});

test('a priority fee used by more than five withdrawals is not unique', () => {
  const ds = dataset();
  for (let i = 0; i < 6; i++) {
    ds.withdrawals.push({ stealth: fx.S(7), txHash: fx.h(900 + i), block: 5_567_000 + i, to: fx.D(8), kind: 'eth', token: null, txFrom: fx.S(7), txType: 2, priorityFee: '1234567' });
  }
  const r = analyze(ds, opts);
  assert.equal(r.h4.linkedStealth, 0);
  assert.equal(r.h4.groups, 0);
});

test('a withdrawal inside the payment transaction is ignored', () => {
  const ds = dataset();
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(6), block: 5_550_000, to: fx.R1, kind: 'eth', token: null, txFrom: fx.S(6), txType: 2, priorityFee: '5' });
  assert.equal(analyze(ds, opts).all.h1Any, 1);
});

test('a registrant paying the gas as the sender does not link the recipient', () => {
  const ds = dataset();
  const s5 = ds.payments.find((p) => p.stealth === fx.S(5));
  if (s5) s5.sender = fx.R2; // R2 is both the payer and the funder
  assert.equal(analyze(ds, opts).all.h5, 0);
});

test('an EIP-7702 delegated stealth address may have a relayer submit its withdrawal', () => {
  const ds = dataset();
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(906), block: 5_556_000, to: fx.D(8), kind: 'eth', token: null, txFrom: fx.RELAYER, txType: 4, priorityFee: '11' });
  // ETH that left in a transaction the address did not sign needs code at the address in that block: owned also when
  // the code read at the scan's end block shows a plain EOA (the delegation was cleared since, bug bounty 8 Nov)
  assert.equal(analyze(ds, opts).all.withdrawn, fx.expected.all.withdrawn + 1, 'delegation cleared before the scan end');
  ds.delegated.add(fx.S(6));
  assert.equal(analyze(ds, opts).all.withdrawn, fx.expected.all.withdrawn + 1);
});

test('a smart account or EIP-7702 delegation does not make a fake token event owner-made (F38)', () => {
  const ds = dataset();
  // S6 withdraws its ETH itself to a fresh destination
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(906), block: 5_556_000, to: fx.D(8), kind: 'eth', token: null, txFrom: fx.S(6), txType: 2, priorityFee: '11' });
  const base = analyze(ds, opts).all;
  // a scammer's contract emits Transfer(S6 -> R1) for a token S6 was never paid; S6 is delegated later
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(907), block: 5_556_100, to: fx.R1, kind: 'token', token: fx.T9, txFrom: fx.SCAMMER, txType: 2, priorityFee: '12' });
  ds.delegated.add(fx.S(6));
  assert.equal(analyze(ds, opts).all.h1Any, base.h1Any, 'a fake token event on a delegated address does not link it to a registrant');
  ds.delegated.delete(fx.S(6));
  ds.contracts.add(fx.S(6));
  assert.equal(analyze(ds, opts).all.h1Any, base.h1Any, 'nor on a smart-account address');
  // ETH relayed out of a smart account still counts and links when it reaches a registrant
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(908), block: 5_556_200, to: fx.R1, kind: 'eth', token: null, txFrom: fx.RELAYER, txType: 2, priorityFee: '13' });
  assert.equal(analyze(ds, opts).all.h1Any, base.h1Any + 1);
});

test('a transaction in the first payment block does not count as a withdrawal (F39)', () => {
  const ds = dataset();
  const s6 = ds.payments.find((p) => p.stealth === fx.S(6));
  if (!s6) throw new Error('fixture');
  ds.withdrawals.push({ stealth: fx.S(6), txHash: fx.h(909), block: s6.block, to: fx.R1, kind: 'eth', token: null, txFrom: fx.S(6), txType: 2, priorityFee: '14' });
  const r = analyze(ds, opts).all;
  assert.equal(r.withdrawn, fx.expected.all.withdrawn);
  assert.equal(r.h1Any, fx.expected.all.h1Any);
});

test('gas that arrived before the first payment does not link', () => {
  const ds = dataset();
  ds.fundings = ds.fundings.map((f) => (f.stealth === fx.S(5) ? { ...f, block: 5_490_000 } : f));
  assert.equal(analyze(ds, opts).all.h5, 0);
});

test('an address that was used before its first payment is left out', () => {
  const ds = dataset();
  ds.preUsed = new Set();
  assert.equal(analyze(ds, opts).all.stealthAddresses, fx.expected.all.stealthAddresses + 1);
});

test('ERC-5564 metadata: ETH, known token selectors, everything else unknown', () => {
  const token = '7171'.padStart(40, '0');
  assert.deepEqual(parseMetadata('0x99eeeeeeee' + 'ee'.repeat(52)), { asset: 'ETH', token: null });
  assert.deepEqual(parseMetadata('0x99a9059cbb' + token + '00'.repeat(32)), { asset: 'TOKEN', token: '0x' + token });
  assert.deepEqual(parseMetadata('0x9912345678' + token), { asset: 'UNKNOWN', token: null });
  assert.deepEqual(parseMetadata('0x99'), { asset: 'UNKNOWN', token: null });
});
