/**
 * Bug bounty, 24 and 25 Nov (scanner, confirm.ts). Each test names the report it covers.
 * (1) A late payment relayed for the payer (a permit: the log names the payer, a relayer signed) of the named token is
 *     the announcement's payment, as it is inside the window.
 * (3) A stranger's token dust in the window of an announce-first payment does not take the payer's late payment over.
 * (4) A stranger's row between the payer's announcement and its late payment does not become the first payment.
 * (6) A second announcement in the same block as the first funded one is a later announcement.
 * (7) An ERC-5564 announcement cannot claim an Umbra transfer a second time.
 * (8) A stranger's wei in the window does not hide the payer's late payment.
 * Heuristics (2, 5, 9) are in bounty-2511-heuristics.test.ts.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPayments, WINDOW_AFTER } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { a, h, CUTOFF_BLOCK as C, UMBRA } from './fixture.ts';

const P = a(0xa001); // the payer
const X = a(0xbad1); // a stranger
const G = a(0xbad2); // a griefer
const RL = a(0x1e1); // a relayer
const TA = a(0x7a7a);
const TB = a(0x7b7b);
const S = (i: number): string => a(0x5200 + i);
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const ann = (stealth: string, asset: PaymentLog['asset'], token: string | null, tx: number, block: number, logIndex = 0): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex,
  blockTimestamp: 1_700_000_000 + block * 12,
  stealth,
  asset,
  token,
});
/** `from` is what the transfer's log names; who signed the transaction is in the signers map */
const arrive = (to: string, tx: number, block: number, token: string | null, from: string, category?: string): TransferLite => ({
  hash: h(tx),
  block,
  from,
  to,
  category: category ?? (token === null ? 'external' : 'erc20'),
  token,
});
const byStealth = (list: TransferLite[]) => (s: string) => list.filter((t) => t.to === s);
const confirm = (logs: PaymentLog[], transfers: TransferLite[], signers: Record<string, string>) =>
  confirmPayments(logs, byStealth(transfers), (hash) => signers[hash]);
const rows = (r: { payments: PaymentLog[] }) => r.payments.map((p) => [p.asset, p.txHash]);
/** what scan.ts does next: the sender of a payment is the signer of the transaction that moved it */
const toPayments = (r: { payments: PaymentLog[] }, signers: Record<string, string>): Payment[] =>
  r.payments.map((p) => ({ source: p.source, stealth: p.stealth, sender: signers[p.txHash] ?? '', block: p.blockNumber, timestamp: p.blockTimestamp ?? 0, asset: p.asset, token: p.token, txHash: p.txHash }));
const own = (stealth: string, tx: number, to: string, kind: Withdrawal['kind'], token: string | null, block: number): Withdrawal => ({
  stealth, txHash: h(tx), block, to, kind, token, txFrom: stealth, txType: 2, priorityFee: '1000000000',
});
const dataset = (payments: Payment[], withdrawals: Withdrawal[], over: Partial<Dataset> = {}): Dataset => ({
  payments, withdrawals, fundings: [], registrations: [], contracts: new Set(), delegated: new Set(), preUsed: new Set(), ...over,
});

// ------------------------------------------------------------------ (1) late relayed payment
test('whitelistsol 25 Nov: a late relayed payment of the named token whose log names the payer is the payment', () => {
  const A = C + 1_000;
  const st = S(1);
  const logs = [ann(st, 'TOKEN', TA, 1, A)];
  // a permit or transferWithAuthorization: the log names the payer, a relayer signed the transaction
  const relayed = arrive(st, 2, A + WINDOW_AFTER + 5, TA, P);
  const r = confirm(logs, [relayed], { [h(1)]: P, [h(2)]: RL });
  assert.deepEqual(rows(r), [['TOKEN', h(2)]]);
  assert.equal(r.unfunded, 0);
  // a stranger's transfer of the same token names the stranger: nobody's payment, as before
  const s = confirm(logs, [arrive(st, 3, A + WINDOW_AFTER + 5, TA, X)], { [h(1)]: P, [h(3)]: RL });
  assert.deepEqual([s.payments.length, s.unfunded], [0, 1]);
  // only the token the announcement names: another token whose log names the payer is not bound
  const other = confirm(logs, [arrive(st, 4, A + WINDOW_AFTER + 5, TB, P)], { [h(1)]: P, [h(4)]: RL });
  assert.deepEqual([other.payments.length, other.unfunded], [0, 1]);
  // and an announcement that names no token binds nothing by a log
  const eth = confirm([ann(st, 'ETH', null, 1, A)], [relayed], { [h(1)]: P, [h(2)]: RL });
  assert.deepEqual([eth.payments.length, eth.unfunded], [0, 1]);
});

// ------------------------------------------------------------------ (3) token dust and the announce-first flow
test('whitelistsol 25 Nov: a stranger s dust of the named token does not take the payer s late payment over', () => {
  const A = C + 1_000;
  const st = S(21);
  const logs = [ann(st, 'TOKEN', TA, 10, A)];
  const transfers = [arrive(st, 11, A + 5, TA, X), arrive(st, 12, A + 500, TA, P)];
  const signers = { [h(10)]: P, [h(11)]: X, [h(12)]: P };
  const r = confirm(logs, transfers, signers);
  assert.deepEqual(rows(r), [['TOKEN', h(12)]]);
  assert.deepEqual([r.unfunded, r.tokenDust], [0, 1]);
  // the real H2 link stays: the payer is the sender, and the token going back to it is a round trip
  const m = analyze(dataset(toPayments(r, signers), [own(st, 13, P, 'token', TA, A + 600)]), opts).all;
  assert.deepEqual([m.withdrawn, m.h2Single], [1, 1]);
  // control: the payer's transfer inside the window wins, the dust is counted as dust, as before
  const inWindow = confirm(logs, [arrive(st, 11, A + 5, TA, X), arrive(st, 12, A + 10, TA, P)], signers);
  assert.deepEqual([rows(inWindow), inWindow.tokenDust], [[['TOKEN', h(12)]], 1]);
});

test('whitelistsol 25 Nov: any stranger dust next to an ETH announcement does not hide the payer s late ETH', () => {
  const A = C + 2_000;
  const st = S(22);
  const r = confirm([ann(st, 'ETH', null, 20, A)], [arrive(st, 21, A + 5, TB, X), arrive(st, 22, A + 500, null, P)], { [h(20)]: P, [h(21)]: X, [h(22)]: P });
  assert.deepEqual(rows(r), [['ETH', h(22)]]);
  assert.deepEqual([r.assetMismatch, r.tokenDust], [0, 1]);
});

test('whitelistsol 25 Nov: dust placed earlier for the payer s next announcement does not take its late payment over', () => {
  const B = C + 3_000;
  const st = S(23);
  // the first announcement is funded in its window; the payer announces again and pays later, a stranger's dust waits
  const logs = [ann(st, 'ETH', null, 30, B), ann(st, 'TOKEN', TA, 33, B + 1_000)];
  const transfers = [arrive(st, 31, B, null, P), arrive(st, 32, B + 900, TA, X), arrive(st, 34, B + 1_100, TA, P)];
  const r = confirm(logs, transfers, { [h(30)]: P, [h(31)]: P, [h(32)]: X, [h(33)]: P, [h(34)]: P });
  assert.deepEqual(rows(r), [['ETH', h(31)], ['TOKEN', h(34)]]);
});

// ------------------------------------------------------------------ (4) a row earlier than the real payment
test('whitelistsol 25 Nov: a stranger s wei and announcement before the payer s late payment is not the first payment', () => {
  const A = C - 50; // the payer announces before the cutoff and pays after it
  const st = S(31);
  const logs = [ann(st, 'TOKEN', TA, 40, A), ann(st, 'ETH', null, 41, A + 20)];
  const transfers = [arrive(st, 41, A + 20, null, G), arrive(st, 42, C + 50, TA, P)];
  const signers = { [h(40)]: P, [h(41)]: G, [h(42)]: P };
  const r = confirm(logs, transfers, signers);
  assert.deepEqual(rows(r), [['TOKEN', h(42)]]);
  assert.equal(r.unfunded, 1); // the griefer's announcement
  // the address is first paid after the cutoff, as the real payment says
  const res = analyze(dataset(toPayments(r, signers), []), opts);
  assert.deepEqual([res.sinceCutoff.stealthAddresses, res.all.stealthAddresses], [1, 1]);

  // the same with the griefer's wei inside the payer's window, and with the wei sent after a zero-value announcement
  const inWindow = confirm([ann(st, 'TOKEN', TA, 40, A), ann(st, 'ETH', null, 43, A + 5)], [arrive(st, 43, A + 5, null, G), arrive(st, 42, C + 50, TA, P)], {
    ...signers,
    [h(43)]: G,
  });
  assert.deepEqual(rows(inWindow), [['TOKEN', h(42)]]);
  const lateWei = confirm([ann(st, 'TOKEN', TA, 40, A), ann(st, 'UNKNOWN', null, 44, A + 1)], [arrive(st, 45, A + 30, null, G), arrive(st, 42, C + 50, TA, P)], {
    ...signers,
    [h(44)]: G,
    [h(45)]: G,
  });
  assert.deepEqual(rows(lateWei), [['TOKEN', h(42)]]);

  // control: the griefer's wei after the real payment is still his own payment (the documented 12 Nov cost), and
  // the first block stays the real payment's
  const after = confirm([ann(st, 'TOKEN', TA, 40, A), ann(st, 'ETH', null, 46, C + 100)], [arrive(st, 42, C + 50, TA, P), arrive(st, 46, C + 100, null, G)], {
    ...signers,
    [h(46)]: G,
  });
  assert.deepEqual(rows(after), [['TOKEN', h(42)], ['ETH', h(46)]]);
  assert.equal(Math.min(...after.payments.map((p) => p.blockNumber)), C + 50);
});

// ------------------------------------------------------------------ (6) a second announcement in the same block
test('whitelistsol 25 Nov: a stranger s announcement in the same block does not turn discarded dust into a payment', () => {
  const B = C + 6_000;
  const st = S(51);
  const transfers = [arrive(st, 60, B - 50, TB, P), arrive(st, 61, B, TA, P)]; // the payer's dust of another token, then its payment
  const signers = { [h(60)]: P, [h(61)]: P, [h(62)]: P, [h(63)]: X };
  for (const block of [B, B + 1]) {
    const r = confirm([ann(st, 'TOKEN', TA, 62, B), ann(st, 'ETH', null, 63, block, 1)], transfers, signers);
    assert.deepEqual(rows(r), [['TOKEN', h(61)]], `second announcement at ${block - B} blocks`);
    assert.equal(r.tokenDust, 1);
  }
  // two real payments in one block by two payers stay two payments
  const two = confirm([ann(st, 'TOKEN', TA, 62, B), ann(st, 'ETH', null, 63, B, 1)], [arrive(st, 61, B, TA, P), arrive(st, 63, B, null, X)], signers);
  assert.deepEqual(rows(two), [['TOKEN', h(61)], ['ETH', h(63)]]);
});

// ------------------------------------------------------------------ (7) an Umbra transfer claimed again
test('whitelistsol 25 Nov: a stranger s ERC-5564 announcement does not count an Umbra transfer a second time', () => {
  const B = C + 7_000;
  const st = S(61);
  const umbra: PaymentLog = { source: 'umbra', txHash: h(70), blockNumber: B, logIndex: 0, blockTimestamp: 0, stealth: st, asset: 'ETH', token: null };
  const internal = arrive(st, 70, B, null, UMBRA, 'internal');
  const r = confirm([umbra, ann(st, 'ETH', null, 71, B + 3)], [internal], { [h(70)]: P, [h(71)]: G });
  assert.deepEqual(r.payments.map((p) => [p.source, p.txHash]), [['umbra', h(70)]]);
  // without the Umbra payment the same transfer is the announcement's, as before
  assert.deepEqual(rows(confirm([ann(st, 'ETH', null, 71, B + 3)], [internal], { [h(70)]: P, [h(71)]: G })), [['ETH', h(70)]]);
});

// ------------------------------------------------------------------ (8) a stranger's wei in the window
test('farikferis 24 Nov: a stranger s wei in the window does not hide the payer s late payment or its H2 link', () => {
  const A = C + 9_000;
  const st = S(71);
  const logs = [ann(st, 'ETH', null, 80, A)];
  const signers = { [h(80)]: P, [h(81)]: X, [h(82)]: P };
  const real = arrive(st, 82, A + 15, null, P);
  const r = confirm(logs, [arrive(st, 81, A + 5, null, X), real], signers);
  assert.deepEqual(rows(r), [['ETH', h(82)]]);
  const m = analyze(dataset(toPayments(r, signers), [own(st, 83, P, 'eth', null, A + 100)]), opts).all;
  assert.deepEqual([m.h2Single, m.h2Any, m.identityLinked], [1, 1, 1]);
  // the dust-token variant
  const dust = confirm(logs, [arrive(st, 81, A + 5, TB, X), real], signers);
  assert.deepEqual([rows(dust), dust.tokenDust], [[['ETH', h(82)]], 1]);
  // controls: an empty window, and the payer's own ETH in the window
  assert.deepEqual(rows(confirm(logs, [real], signers)), [['ETH', h(82)]]);
  assert.deepEqual(rows(confirm(logs, [arrive(st, 81, A + 5, null, X), arrive(st, 84, A + 6, null, P)], { ...signers, [h(84)]: P })), [['ETH', h(84)]]);
  // a relayer's announcement of an ETH payment, with nothing later from the relayer, still counts
  assert.deepEqual(rows(confirm(logs, [arrive(st, 81, A + 5, null, X)], { [h(80)]: RL, [h(81)]: X })), [['ETH', h(81)]]);
});

