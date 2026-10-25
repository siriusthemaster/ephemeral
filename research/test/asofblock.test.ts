/**
 * paperComparable looks at the chain as of the cutoff: payments at or after it must not count,
 * like withdrawals, fundings and registrations. Reported by Lucky.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000; // cutoff block
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const S = a(0x5001);
const A1 = a(0xa001);
const A2 = a(0xa002);
const A3 = a(0xa003);
const D1 = a(0xd001);
const RELAYER = a(0x1e1);
const T0 = a(0x7070);
const T1 = a(0x7171);

const pay = (sender: string, block: number, tx: number, token: string | null = null, stealth = S): Payment => ({
  source: 'umbra',
  stealth,
  sender,
  block,
  timestamp: 1_600_000_000 + block * 12,
  asset: token === null ? 'ETH' : 'TOKEN',
  token,
  txHash: h(tx),
});

const out = (to: string, block: number, tx: number, kind: Withdrawal['kind'] = 'eth', token: string | null = null, txFrom = S, stealth = S): Withdrawal => ({
  stealth,
  txHash: h(tx),
  block,
  to,
  kind,
  token,
  txFrom,
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

test('H2: a payment from A2 after the cutoff does not turn a pre-cutoff withdrawal to A2 into an H2 link', () => {
  const ds = world([pay(A1, C - 1_000, 1), pay(A2, C + 1_000, 2)], [out(A2, C - 500, 101)]);
  const r = analyze(ds, opts).paperComparable;
  assert.equal(r.withdrawn, 1);
  assert.equal(r.singleWithdrawal, 1);
  assert.equal(r.h2Single, 0);
  assert.equal(r.paperLinked, 0);
  assert.equal(r.h2Any, 0);
  assert.equal(r.identityLinked, 0);
});

test('withdrawn: a token paid after the cutoff does not make a pre-cutoff relayed move of that token count', () => {
  // paid T0 before the cutoff; a relayer moves T1, which only arrives after the cutoff
  const ds = world([pay(A1, C - 1_000, 1, T0), pay(A3, C + 1_000, 2, T1)], [out(D1, C - 500, 101, 'token', T1, RELAYER)]);
  const r = analyze(ds, opts).paperComparable;
  assert.equal(r.stealthAddresses, 1);
  assert.equal(r.withdrawn, 0);
  assert.equal(r.singleWithdrawal, 0);
});

test('withdrawn: ETH paid after the cutoff does not change the paid asset of a pre-cutoff token payment', () => {
  // paid T0 before the cutoff and withdrawn through Umbra; ETH arrives only after the cutoff
  const ds = world([pay(A1, C - 1_000, 1, T0), pay(A2, C + 1_000, 2)], [out(D1, C - 500, 101, 'umbra-token', T0, RELAYER)]);
  const r = analyze(ds, opts).paperComparable;
  assert.equal(r.withdrawn, 1);
  assert.equal(r.singleWithdrawal, 1);
});

test('control: a pre-cutoff payment from A2 still makes the withdrawal to A2 an H2 link', () => {
  const ds = world([pay(A1, C - 3_000, 1), pay(A2, C - 2_000, 2)], [out(A2, C - 1_000, 101)]);
  const r = analyze(ds, opts).paperComparable;
  assert.equal(r.h2Single, 1);
  assert.equal(r.paperLinked, 1);
  assert.equal(r.paperPct, 100);
});

test('control: the cutoff block is the boundary (C - 1 counts, C does not)', () => {
  for (const [block, h2] of [
    [C - 1, 1],
    [C, 0],
  ] as const) {
    const ds = world([pay(A1, C - 3_000, 1), pay(A2, block, 2)], [out(A2, C - 2_000, 101)]);
    assert.equal(analyze(ds, opts).paperComparable.h2Single, h2, `A2 paid at block ${block}`);
  }
});

test('control: tokens paid before the cutoff still let a relayed move count', () => {
  // an Umbra token payment leaves through a relayed TokenWithdrawal (umbra-token), not a Transfer from the stealth address
  const ds = world([pay(A1, C - 2_000, 1, T0), pay(A3, C - 1_500, 2, T1)], [out(D1, C - 1_000, 101, 'umbra-token', T1, RELAYER)]);
  const r = analyze(ds, opts).paperComparable;
  assert.equal(r.withdrawn, 1);
  assert.equal(r.singleWithdrawal, 1);
});

test('control: all and sinceCutoff still see payments after the cutoff', () => {
  const S2 = a(0x5002);
  const ds = world([pay(A3, C + 100, 1, null, S2)], [out(A3, C + 200, 101, 'eth', null, S2, S2)]);
  const r = analyze(ds, opts);
  assert.equal(r.paperComparable.stealthAddresses, 0);
  for (const m of [r.all, r.sinceCutoff]) {
    assert.equal(m.stealthAddresses, 1);
    assert.equal(m.withdrawn, 1);
    assert.equal(m.h2Single, 1);
  }
});
