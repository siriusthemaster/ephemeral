/**
 * A stealth address counts as withdrawn, and a withdrawal as H2, only when the asset that left is the
 * asset that was paid in: the same token contract for a token payment. Reported by Toshit (L-01).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000; // cutoff block; everything below happens after it
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const P = a(0xa001); // the payer
const D1 = a(0xd001);
const TA = a(0x7a7a); // the ERC-20 paid in
const TB = a(0x7b7b); // an unrelated ERC-20
const S = (i: number): string => a(0x5000 + i);

const pay = (stealth: string, asset: Payment['asset'], token: string | null, tx: number, block = C + 1_000, source: Payment['source'] = 'erc5564'): Payment => ({
  source,
  stealth,
  sender: P,
  block,
  timestamp: 1_700_000_000 + block * 12,
  asset,
  token,
  txHash: h(tx),
});

const out = (stealth: string, to: string, kind: Withdrawal['kind'], token: string | null, tx: number, block = C + 2_000): Withdrawal => ({
  stealth,
  txHash: h(tx),
  block,
  to,
  kind,
  token,
  txFrom: stealth, // signed by the stealth address itself: an owned withdrawal
  txType: 2,
  priorityFee: '1000000000',
});

const world = (payments: Payment[], withdrawals: Withdrawal[]): Dataset => ({
  payments,
  withdrawals,
  fundings: [],
  registrations: [],
  contracts: new Set(),
  delegated: new Set(),
  preUsed: new Set(),
});

test('two ERC-20s: moving only the unrelated token back to the payer is neither a withdrawal nor H2', () => {
  const ds = world([pay(S(1), 'TOKEN', TA, 1)], [out(S(1), P, 'token', TB, 101)]);
  const r = analyze(ds, opts);
  for (const m of [r.all, r.sinceCutoff]) {
    assert.equal(m.stealthAddresses, 1);
    assert.equal(m.withdrawn, 0);
    assert.equal(m.singleWithdrawal, 0);
    assert.equal(m.h2Single, 0);
    assert.equal(m.h2Any, 0);
    assert.equal(m.paperLinked, 0);
    assert.equal(m.paperPct, 0);
    assert.equal(m.identityLinked, 0);
  }
});

test('two ERC-20s: an Umbra withdrawal of a token that was never paid in does not count either', () => {
  const ds = world([pay(S(1), 'TOKEN', TA, 1, C - 2_000, 'umbra')], [out(S(1), P, 'umbra-token', TB, 101, C - 1_000)]);
  const r = analyze(ds, opts);
  assert.equal(r.paperComparable.withdrawn, 0);
  assert.equal(r.paperComparable.h2Single, 0);
  assert.equal(r.all.withdrawn, 0);
});

test('two ERC-20s: unrelated-token moves to one address do not form an H3 cluster', () => {
  const ds = world(
    [pay(S(1), 'TOKEN', TA, 1), pay(S(2), 'TOKEN', TA, 2)],
    [out(S(1), D1, 'token', TB, 101), out(S(2), D1, 'token', TB, 102)],
  );
  assert.equal(analyze(ds, opts).h3.clusters, 0);
});

test('negative control: the paid token moved back to the payer is a withdrawal and H2', () => {
  const ds = world([pay(S(1), 'TOKEN', TA, 1)], [out(S(1), P, 'token', TA, 101)]);
  const r = analyze(ds, opts).all;
  assert.equal(r.withdrawn, 1);
  assert.equal(r.singleWithdrawal, 1);
  assert.equal(r.h2Single, 1);
  assert.equal(r.h2Any, 1);
  assert.equal(r.paperPct, 100);
});

test('negative control: paid token to a fresh address, unrelated token to the payer: withdrawn once, no H2', () => {
  const ds = world([pay(S(1), 'TOKEN', TA, 1)], [out(S(1), D1, 'token', TA, 101), out(S(1), P, 'token', TB, 102)]);
  const r = analyze(ds, opts).all;
  assert.equal(r.withdrawn, 1);
  assert.equal(r.singleWithdrawal, 1, 'the unrelated move does not break the single withdrawal');
  assert.equal(r.h2Single, 0);
  assert.equal(r.h2Any, 0);
});

test('negative control: paid token moves still cluster under H3', () => {
  const ds = world(
    [pay(S(1), 'TOKEN', TA, 1), pay(S(2), 'TOKEN', TA, 2)],
    [out(S(1), D1, 'token', TA, 101), out(S(2), D1, 'token', TA, 102)],
  );
  assert.equal(analyze(ds, opts).h3.clusters, 1);
});

test('ETH and a token paid in: the token going back to the payer is H2 on any withdrawal, an unrelated one is not', () => {
  const payments = [pay(S(1), 'ETH', null, 1), pay(S(1), 'TOKEN', TA, 2)];
  const paid = analyze(world(payments, [out(S(1), D1, 'eth', null, 101), out(S(1), P, 'token', TA, 102)]), opts).all;
  assert.equal(paid.h2Single, 0, 'the single withdrawal is the ETH, to D1');
  assert.equal(paid.h2Any, 1);
  const unrelated = analyze(world(payments, [out(S(1), D1, 'eth', null, 101), out(S(1), P, 'token', TB, 102)]), opts).all;
  assert.equal(unrelated.h2Any, 0);
});
