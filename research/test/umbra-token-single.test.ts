/**
 * An Umbra token payment waits in the Umbra contract and leaves only through TokenWithdrawal. A direct transfer of the
 * same token from the stealth address moves other tokens, so it must not break the payment's single-withdrawal status
 * (the paper metric). Reported 25 Oct (bug bounty, Low). ERC-5564 token payments are paid straight to the stealth
 * address, so there a direct transfer is the payment leaving, as before.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000; // cutoff block
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };
const P = a(0xa001); // the payer
const R = a(0xa002); // a registrant
const D = a(0xd001); // a direct-transfer destination
const T = a(0x7a7a); // the token paid in
const S = a(0x5001); // the stealth address
const RELAYER = a(0x6001);

const pay = (source: Payment['source'], block: number): Payment => ({
  source,
  stealth: S,
  sender: P,
  block,
  timestamp: 1_700_000_000 + block * 12,
  asset: 'TOKEN',
  token: T,
  txHash: h(1),
});
const w = (kind: Withdrawal['kind'], to: string, tx: number, block: number, txFrom: string): Withdrawal => ({
  stealth: S,
  txHash: h(tx),
  block,
  to,
  kind,
  token: T,
  txFrom,
  txType: 2,
  priorityFee: '1000000000',
});
const world = (payments: Payment[], withdrawals: Withdrawal[]): Dataset => ({
  payments,
  withdrawals,
  fundings: [],
  registrations: [{ registrant: R, block: 1, registry: 'umbra' }],
  contracts: new Set(),
  delegated: new Set(),
  preUsed: new Set(),
});

test('Umbra token payment emptied in one TokenWithdrawal to a registrant: single and H1, with or without a direct transfer', () => {
  const base = [w('umbra-token', R, 101, C - 900, RELAYER)];
  for (const withdrawals of [base, [...base, w('token', D, 102, C - 800, S)]]) {
    const r = analyze(world([pay('umbra', C - 1_000)], withdrawals), opts);
    for (const m of [r.paperComparable, r.all]) {
      assert.equal(m.withdrawn, 1);
      assert.equal(m.singleWithdrawal, 1, `${withdrawals.length} withdrawal rows`);
      assert.equal(m.h1Single, 1);
      assert.equal(m.paperLinked, 1);
    }
  }
});

test('Umbra token payment never withdrawn: a direct transfer of the same token alone is not a withdrawal', () => {
  const r = analyze(world([pay('umbra', C - 1_000)], [w('token', D, 102, C - 800, S)]), opts);
  assert.equal(r.paperComparable.withdrawn, 0);
  assert.equal(r.all.withdrawn, 0);
  assert.equal(r.all.h1Any, 0);
});

test('negative control: ERC-5564 token payment, a direct transfer is the payment leaving; two moves are not single', () => {
  const one = analyze(world([pay('erc5564', C + 1_000)], [w('token', D, 102, C + 2_000, S)]), opts).all;
  assert.equal(one.withdrawn, 1);
  assert.equal(one.singleWithdrawal, 1);
  const two = analyze(world([pay('erc5564', C + 1_000)], [w('token', D, 102, C + 2_000, S), w('token', R, 103, C + 3_000, S)]), opts).all;
  assert.equal(two.withdrawn, 1);
  assert.equal(two.singleWithdrawal, 0);
  assert.equal(two.h1Any, 1, 'the wider any-withdrawal measure still sees the registrant');
});
