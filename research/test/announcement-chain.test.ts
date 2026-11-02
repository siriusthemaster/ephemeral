/**
 * ERC-5564 payments come from the chain, not from the announcement (bug bounty, 24 Oct, two reports, one cause).
 * A zero-value announcement must not count as a payment, and a stranger's "ETH" announcement must not turn a
 * token-paid address into an ETH payment and hide its H2 or H5 link. Also: the ERC-1155 batch selector (28 Oct).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { confirmPayments, WINDOW_AFTER, WINDOW_BEFORE, WINDOW_BEFORE_FIRST } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import { parseMetadata, type PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Funding, type Payment, type Registration, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000; // cutoff block; everything below happens after it
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const P = a(0xa001); // the payer
const X = a(0xbad1); // a stranger
const R = a(0x1e9); // a registrant
const D1 = a(0xd001);
const TA = a(0x7a7a);
const S = (i: number): string => a(0x5000 + i);

const ann = (stealth: string, asset: PaymentLog['asset'], token: string | null, tx: number, block = C + 1_000): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex: 0,
  blockTimestamp: 1_700_000_000 + block * 12,
  stealth,
  asset,
  token,
});
const arrive = (to: string, tx: number, block: number, token: string | null, from = P): TransferLite => ({
  hash: h(tx),
  block,
  from,
  to,
  category: token === null ? 'external' : 'erc20',
  token,
});
const out = (stealth: string, to: string, kind: Withdrawal['kind'], token: string | null, tx: number, block = C + 2_000): Withdrawal => ({
  stealth,
  txHash: h(tx),
  block,
  to,
  kind,
  token,
  txFrom: stealth,
  txType: 2,
  priorityFee: '1000000000',
});

/** What scan.ts does after confirmation: the payer is the sender of the transaction that moved the value. */
function toPayments(logs: readonly PaymentLog[], senderOf: Record<string, string>): Payment[] {
  return logs.map((p) => ({
    source: p.source,
    stealth: p.stealth,
    sender: senderOf[p.txHash] ?? '',
    block: p.blockNumber,
    timestamp: p.blockTimestamp ?? 0,
    asset: p.asset,
    token: p.token,
    txHash: p.txHash,
  }));
}
const world = (payments: Payment[], withdrawals: Withdrawal[], fundings: Funding[] = [], registrations: Registration[] = []): Dataset => ({
  payments,
  withdrawals,
  fundings,
  registrations,
  contracts: new Set(),
  delegated: new Set(),
  preUsed: new Set(),
});
const byStealth = (transfers: TransferLite[]) => (s: string) => transfers.filter((t) => t.to === s);

test('Fenzy 28 Oct: safeBatchTransferFrom (0x2eb2c2d6) in metadata is a token payment, not unknown', () => {
  const token = a(0x1155);
  const r = parseMetadata('0x99' + '2eb2c2d6' + token.slice(2) + '00'.repeat(32));
  assert.deepEqual(r, { asset: 'TOKEN', token });
  // control: an unlisted selector stays unknown
  assert.equal(parseMetadata('0x99' + 'deadbeef' + token.slice(2)).asset, 'UNKNOWN');
});

test('an announcement with nothing arriving next to it is not a payment', () => {
  const r = confirmPayments([ann(S(1), 'ETH', null, 1)], () => []);
  assert.deepEqual(r.payments, []);
  assert.equal(r.unfunded, 1);
  // so the address is not counted at all, even after a withdrawal from it
  const m = analyze(world(toPayments(r.payments, {}), [out(S(1), D1, 'eth', null, 101)]), opts).all;
  assert.equal(m.stealthAddresses, 0);
  assert.equal(m.withdrawn, 0);
});

test("Swaplane / One Cursor 24 Oct: a stranger's ETH announcement does not hide the token payment's H2", () => {
  const logs = [ann(S(1), 'TOKEN', TA, 1), ann(S(1), 'ETH', null, 2, C + 1_500)];
  const transfers = [arrive(S(1), 1, C + 1_000, TA)];
  const senders = { [h(1)]: P, [h(2)]: X };
  const withdrawals = [out(S(1), P, 'token', TA, 101)];

  // before: the announcement alone decided, so the address looked ETH-paid and the token back to the payer vanished
  const before = analyze(world(toPayments(logs, senders), withdrawals), opts).all;
  assert.equal(before.withdrawn, 0);
  assert.equal(before.h2Any, 0);

  const r = confirmPayments(logs, byStealth(transfers));
  assert.equal(r.unfunded, 1, 'the ETH claim moved nothing');
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token]), [['TOKEN', TA]]);
  const after = analyze(world(toPayments(r.payments, senders), withdrawals), opts).all;
  assert.equal(after.withdrawn, 1);
  assert.equal(after.singleWithdrawal, 1);
  assert.equal(after.h2Single, 1, 'the isolated H2 stays 1');
  assert.equal(after.h2Any, 1);
  assert.equal(after.identityLinked, 1);
});

test("a stranger's ETH announcement does not hide H5 either (token-only address, gas from a registrant)", () => {
  const logs = [ann(S(2), 'TOKEN', TA, 3), ann(S(2), 'ETH', null, 4, C + 1_200)];
  const transfers = [arrive(S(2), 3, C + 1_000, TA)];
  const senders = { [h(3)]: P, [h(4)]: X };
  const fundings = [{ stealth: S(2), txHash: h(203), block: C + 1_500, from: R }];
  const registrations = [{ registrant: R, block: C + 10, registry: 'erc6538' as const }];
  const withdrawals = [out(S(2), D1, 'token', TA, 102)];

  const before = analyze(world(toPayments(logs, senders), withdrawals, fundings, registrations), opts).all;
  assert.equal(before.h5, 0);
  const r = confirmPayments(logs, byStealth(transfers));
  const after = analyze(world(toPayments(r.payments, senders), withdrawals, fundings, registrations), opts).all;
  assert.equal(after.needingOwnGas, 1);
  assert.equal(after.h5, 1);
  assert.equal(after.identityLinked, 1);
});

test('the asset is what arrived: ETH sent with a token is gas, a wrong metadata claim is counted', () => {
  const tip = arrive(S(3), 5, C + 1_000, null);
  const tok = arrive(S(3), 5, C + 1_000, TA);
  const r = confirmPayments([ann(S(3), 'ETH', null, 5)], byStealth([tip, tok]));
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token, p.txHash]), [['TOKEN', TA, h(5)]]);
  assert.equal(r.assetMismatch, 1);
  // unknown metadata (short or unlisted selector) is no mismatch: the chain names the asset
  const u = confirmPayments([ann(S(3), 'UNKNOWN', null, 5)], byStealth([tok]));
  assert.equal(u.assetMismatch, 0);
  assert.equal(u.payments[0]?.asset, 'TOKEN');
});

test('the payment transaction is the one that moved the value, inside the window around the announcement', () => {
  const at = C + 10_000;
  // first announcement of the address: paid up to a day before it (payers often send first), or 12 blocks after
  for (const b of [at - WINDOW_BEFORE_FIRST, at - 6, at, at + WINDOW_AFTER]) {
    const r = confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, b, null)]));
    assert.equal(r.payments.length, 1, `block ${b - at}`);
    assert.equal(r.payments[0]?.txHash, h(7));
    assert.equal(r.payments[0]?.blockNumber, b);
  }
  for (const b of [at - WINDOW_BEFORE_FIRST - 1, at + WINDOW_AFTER + 1]) {
    const r = confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, b, null)]));
    assert.equal(r.unfunded, 1, `block ${b - at}`);
  }
  // a later announcement of the same address only looks 2 blocks back: gas sent after the first payment is not a new payment
  const first = ann(S(4), 'TOKEN', TA, 6, at);
  const later = ann(S(4), 'ETH', null, 8, at + 500);
  const paid = arrive(S(4), 6, at, TA);
  for (const b of [at + 500 - WINDOW_BEFORE, at + 500 + WINDOW_AFTER]) {
    const r = confirmPayments([first, later], byStealth([paid, arrive(S(4), 9, b, null)]));
    assert.deepEqual(r.payments.map((p) => p.asset), ['TOKEN', 'ETH'], `block ${b - at - 500}`);
  }
  const gas = confirmPayments([first, later], byStealth([paid, arrive(S(4), 9, at + 500 - WINDOW_BEFORE - 1, null)]));
  assert.deepEqual(gas.payments.map((p) => p.asset), ['TOKEN']);
  assert.equal(gas.unfunded, 1);
  // the address sending to itself is not a payment; two announcements for one transfer are one payment
  assert.equal(confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, at, null, S(4))])).unfunded, 1);
  const twice = confirmPayments([ann(S(4), 'ETH', null, 6, at), ann(S(4), 'ETH', null, 8, at + 1)], byStealth([arrive(S(4), 7, at, null)]));
  assert.equal(twice.payments.length, 1);
});

test('Umbra announcements pass through unchanged: the Umbra contract moves the funds itself', () => {
  const u: PaymentLog = { ...ann(S(5), 'ETH', null, 9), source: 'umbra' };
  const r = confirmPayments([u], () => []);
  assert.deepEqual(r.payments, [u]);
  assert.equal(r.unfunded, 0);
});
