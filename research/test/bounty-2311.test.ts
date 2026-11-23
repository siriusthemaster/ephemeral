/**
 * Bug bounty, 11 to 22 Nov (scanner). Each test names the report it covers.
 * (1) A payment the payer finished more than 12 blocks after its own unfunded announcement is that announcement's
 *     payment, when the payer signed it (the client's "Finish payment" pays later without announcing again).
 * (2) A later announcement reaches every unclaimed arrival before its own 2-block look-back, not only up to 12 blocks
 *     after the first funded announcement: nothing between two windows is read by nobody.
 * (3) Another party's ETH is never a later announcement's payment, and the payer's own ETH is the payment when it
 *     sent any: a zero-value announcement cannot turn a registrant's gas top-up into a payment.
 * (4) A router that a spam payment row names stays a foreign contract for H3 and H5 (preUsed and scope).
 * (5) The first event of a recipient, where its code is read, ignores token moves a stranger can forge.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPayments, neededTxs, WINDOW_AFTER, WINDOW_LATE } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { analyze, firstEvents, type Dataset, type Funding, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { a, h, CUTOFF_BLOCK as C } from './fixture.ts';

const P = a(0xa001); // the payer
const Q = a(0xa002); // another payer
const X = a(0xbad1); // a stranger
const G = a(0xbad2); // a griefer
const R = a(0x101); // a registrant
const D = a(0xd001); // a destination
const TA = a(0x7a7a);
const S = (i: number): string => a(0x5100 + i);

const ann = (stealth: string, asset: PaymentLog['asset'], token: string | null, tx: number, block: number): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex: 0,
  blockTimestamp: 1_700_000_000 + block * 12,
  stealth,
  asset,
  token,
});
const arrive = (to: string, tx: number, block: number, token: string | null, from: string): TransferLite => ({
  hash: h(tx),
  block,
  from,
  to,
  category: token === null ? 'external' : 'erc20',
  token,
});
const byStealth = (list: TransferLite[]) => (s: string) => list.filter((t) => t.to === s);
/** confirmPayments with the signer of every transaction stated: announcements and arrivals */
const confirm = (logs: PaymentLog[], transfers: TransferLite[], signers: Record<string, string>) =>
  confirmPayments(logs, byStealth(transfers), (hash) => signers[hash]);
const rows = (r: { payments: PaymentLog[] }) => r.payments.map((p) => [p.asset, p.txHash]);

// ------------------------------------------------------------------ (1) late finish (confirm.ts)
test('0xvijay 22 Nov: a payment the payer finished 13 blocks after its own unfunded announcement is its payment', () => {
  const A = C + 1_000;
  for (const [label, token] of [['ETH', null], ['token', TA]] as const) {
    const logs = [ann(S(1), token === null ? 'ETH' : 'TOKEN', token, 1, A)];
    const late = [arrive(S(1), 2, A + WINDOW_AFTER + 1, token, P)];
    const r = confirm(logs, late, { [h(1)]: P, [h(2)]: P });
    assert.deepEqual(rows(r), [[token === null ? 'ETH' : 'TOKEN', h(2)]], label);
    assert.equal(r.unfunded, 0, label);
    // the scan fetches the signer of that late transfer
    assert.ok(neededTxs(logs, byStealth(late)).includes(h(2)), label);
  }
  // a stranger's transfer after the window is nobody's payment: only the payer's own signature reaches there
  const s = confirm([ann(S(1), 'ETH', null, 1, A)], [arrive(S(1), 3, A + WINDOW_AFTER + 1, null, X)], { [h(1)]: P, [h(3)]: X });
  assert.deepEqual([s.payments.length, s.unfunded], [0, 1]);
  // about a day, no more
  const far = confirm([ann(S(1), 'ETH', null, 1, A)], [arrive(S(1), 2, A + WINDOW_LATE + 1, null, P)], { [h(1)]: P, [h(2)]: P });
  assert.deepEqual([far.payments.length, far.unfunded], [0, 1]);
});

test('0xvijay 22 Nov: the late reach ends before the payer s next announcement of the address, which reads its own payment', () => {
  const A = C + 2_000;
  const logs = [ann(S(2), 'ETH', null, 1, A), ann(S(2), 'ETH', null, 3, A + 20)];
  const r = confirm(logs, [arrive(S(2), 4, A + 21, null, P)], { [h(1)]: P, [h(3)]: P, [h(4)]: P });
  assert.deepEqual(rows(r), [['ETH', h(4)]]);
  assert.equal(r.unfunded, 1); // the first announcement, as before
});

test('0xvijay 22 Nov: a stranger s funded announcement between the payer s announcement and its late payment hides nothing', () => {
  const A = C + 3_000;
  const logs = [ann(S(3), 'TOKEN', TA, 10, A), ann(S(3), 'TOKEN', TA, 11, A + 5)];
  const transfers = [arrive(S(3), 11, A + 5, null, X), arrive(S(3), 12, A + 20, TA, P)]; // the stranger's wei, then the payer's token
  const r = confirm(logs, transfers, { [h(10)]: P, [h(11)]: X, [h(12)]: P });
  assert.ok(rows(r).some(([asset, tx]) => asset === 'TOKEN' && tx === h(12)), JSON.stringify(rows(r)));
  assert.equal(r.unfunded, 0);
});

// ------------------------------------------------------------------ (2) residual reach of a later announcement
test('farikferis 14 Nov, 0xvijay 22 Nov: a payment between the first funded window and the later announcement s look-back counts', () => {
  const B = C + 4_000;
  const logs = [ann(S(4), 'UNKNOWN', null, 20, B), ann(S(4), 'ETH', null, 22, B + 34)];
  const transfers = [arrive(S(4), 20, B, null, G), arrive(S(4), 21, B + 29, null, P)]; // the griefer's 1 wei, the real 0.04 ETH
  const r = confirm(logs, transfers, { [h(20)]: G, [h(21)]: P, [h(22)]: P });
  assert.deepEqual(rows(r), [['ETH', h(20)], ['ETH', h(21)]]);
  assert.equal(r.unfunded, 0);
});

test('Akbar (sarungt656) 11 Nov: a token inside a second funded announcement s window stays in reach of its payer s later announcement', () => {
  const B = C + 5_000;
  const logs = [ann(S(5), 'ETH', null, 30, B), ann(S(5), 'ETH', null, 31, B + 1_000), ann(S(5), 'TOKEN', TA, 33, B + 1_020)];
  const transfers = [arrive(S(5), 30, B, null, X), arrive(S(5), 31, B + 1_000, null, P), arrive(S(5), 32, B + 1_005, TA, Q)];
  const r = confirm(logs, transfers, { [h(30)]: X, [h(31)]: P, [h(32)]: Q, [h(33)]: Q });
  assert.deepEqual(rows(r), [['ETH', h(30)], ['ETH', h(31)], ['TOKEN', h(32)]]);
  assert.equal(r.unfunded, 0);
});

// ------------------------------------------------------------------ (3) whose ETH is the payment
test('Rusdi 21 Nov: a zero-value announcement next to a registrant s gas top-up does not make the gas a payment', () => {
  const B = C + 6_000;
  const st = S(6);
  const logs = [ann(st, 'TOKEN', TA, 40, B), ann(st, 'UNKNOWN', null, 42, B + 11)];
  const transfers = [arrive(st, 40, B, TA, P), arrive(st, 41, B + 10, null, R)];
  const signers = { [h(40)]: P, [h(41)]: R, [h(42)]: X };
  const r = confirm(logs, transfers, signers);
  assert.deepEqual(rows(r), [['TOKEN', h(40)]]);
  assert.equal(r.unfunded, 1);
  assert.ok(neededTxs(logs, byStealth(transfers)).includes(h(41)), 'the gas top-up s signer is fetched');
  // the analysis keeps the H5 link and the single withdrawal: token out, then the leftover gas swept
  const payments: Payment[] = r.payments.map((p) => ({
    source: 'erc5564', stealth: st, sender: signers[p.txHash] ?? '', block: p.blockNumber, timestamp: 0, asset: p.asset, token: p.token, txHash: p.txHash,
  }));
  const own = (tx: number, kind: Withdrawal['kind'], token: string | null, block: number): Withdrawal => ({
    stealth: st, txHash: h(tx), block, to: D, kind, token, txFrom: st, txType: 2, priorityFee: '1000000000',
  });
  const fundings: Funding[] = [{ stealth: st, txHash: h(41), block: B + 10, from: R }];
  const ds: Dataset = {
    payments, withdrawals: [own(43, 'token', TA, B + 100), own(44, 'eth', null, B + 101)], fundings,
    registrations: [{ registrant: R, block: C - 10, registry: 'erc6538' }],
    contracts: new Set(), delegated: new Set(), preUsed: new Set(),
  };
  const m = analyze(ds, { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C }).all;
  assert.deepEqual([m.withdrawn, m.singleWithdrawal, m.h5], [1, 1, 1]);
});

test('niniitowok 12 Nov (3C): the payer s ETH is the payment, a stranger s ETH in the same window is not part of it', () => {
  const B = C + 7_000;
  const logs = [ann(S(7), 'ETH', null, 50, B)];
  const transfers = [arrive(S(7), 51, B + 1, null, P), arrive(S(7), 52, B + 2, null, X)];
  assert.deepEqual(neededTxs(logs, byStealth(transfers)).sort(), [h(50), h(51), h(52)].sort());
  const r = confirm(logs, transfers, { [h(50)]: P, [h(51)]: P, [h(52)]: X });
  assert.deepEqual(rows(r), [['ETH', h(51)]]);
  // control: an ETH payment a relayer announced (the payer sent no ETH) still counts on a first announcement
  const relayed = confirm(logs, [arrive(S(7), 51, B + 1, null, Q)], { [h(50)]: P, [h(51)]: Q });
  assert.deepEqual(rows(relayed), [['ETH', h(51)]]);
});

// ------------------------------------------------------------------ (4) foreign contracts (heuristics.ts)
test('Rusdi 21 Nov: one spam payment row to a router does not bring it back into H3 and H5', () => {
  const B = C + 8_000;
  const ROUTER = a(0x7007);
  const S1 = S(11);
  const S2 = S(12);
  const S3 = S(13);
  const ethPay = (st: string, tx: number): Payment => ({ source: 'erc5564', stealth: st, sender: P, block: B, timestamp: 0, asset: 'ETH', token: null, txHash: h(tx) });
  const out = (st: string, tx: number, kind: Withdrawal['kind'], token: string | null, block = B + 50): Withdrawal => ({
    stealth: st, txHash: h(tx), block, to: ROUTER, kind, token, txFrom: st, txType: 2, priorityFee: null,
  });
  const base: Dataset = {
    payments: [
      ethPay(S1, 60),
      ethPay(S2, 61),
      { source: 'erc5564', stealth: S3, sender: P, block: B, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(62) },
    ],
    withdrawals: [out(S1, 63, 'eth', null), out(S2, 64, 'eth', null), { ...out(S3, 65, 'token', TA, B + 60), to: D }],
    fundings: [{ stealth: S3, txHash: h(66), block: B + 10, from: ROUTER }],
    registrations: [{ registrant: ROUTER, block: C - 10, registry: 'erc6538' }],
    contracts: new Set([ROUTER]),
    delegated: new Set(),
    preUsed: new Set(),
  };
  const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };
  const clean = analyze(base, opts);
  // one announcement and a unit of a token to the router: a payment row, and the router (a contract, nonce >= 1) is preUsed
  const spam: Dataset = {
    ...base,
    payments: [...base.payments, { source: 'erc5564', stealth: ROUTER, sender: X, block: B + 5, timestamp: 0, asset: 'TOKEN', token: a(0xfa4e), txHash: h(67) }],
    preUsed: new Set([ROUTER]),
  };
  const attacked = analyze(spam, opts);
  for (const r of [clean, attacked]) {
    assert.deepEqual([r.h3.clusters, r.h3.clusteredStealth], [0, 0]);
    assert.equal(r.all.h5, 0);
  }
});

test('Rusdi 21 Nov: a payment row outside the paper scope does not make a router ours for the paper figure', () => {
  const ROUTER = a(0x7008);
  const U = S(14);
  const pre = C - 1_000;
  const ds: Dataset = {
    payments: [
      { source: 'umbra', stealth: U, sender: P, block: pre, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(70) },
      // after the cutoff, ERC-5564: outside paperComparable's sources and blocks
      { source: 'erc5564', stealth: ROUTER, sender: X, block: C + 10, timestamp: 0, asset: 'TOKEN', token: a(0xfa4e), txHash: h(71) },
    ],
    withdrawals: [{ stealth: U, txHash: h(72), block: pre + 50, to: D, kind: 'umbra-token', token: TA, txFrom: U, txType: 2, priorityFee: null }],
    fundings: [{ stealth: U, txHash: h(73), block: pre + 10, from: ROUTER }],
    registrations: [{ registrant: ROUTER, block: pre - 100, registry: 'umbra' }],
    contracts: new Set([ROUTER]),
    delegated: new Set(),
    preUsed: new Set(),
  };
  const r = analyze(ds, { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C });
  assert.equal(r.paperComparable.h5, 0);
});

// ------------------------------------------------------------------ (5) first event (scan.ts step 8)
test('Rusdi 21 Nov: a forged earlier token move does not move a recipient s first event', () => {
  const st = S(15);
  const FAKE = a(0xfa4e);
  const w = (tx: number, block: number, kind: Withdrawal['kind'], token: string | null, txFrom: string): Withdrawal => ({
    stealth: st, txHash: h(tx), block, to: D, kind, token, txFrom, txType: 2, priorityFee: null,
  });
  const relay = new Set([TA]);
  assert.equal(firstEvents([w(1, 100, 'token', FAKE, X), w(2, 500, 'eth', null, st)], [], relay).get(D), 500);
  assert.equal(firstEvents([w(1, 100, 'token', FAKE, st), w(2, 500, 'eth', null, st)], [], relay).get(D), 100, 'signed by the address');
  assert.equal(firstEvents([w(1, 100, 'token', TA, a(0x1e1)), w(2, 500, 'eth', null, st)], [], relay).get(D), 100, 'a relay token');
  assert.equal(firstEvents([w(1, 100, 'token', FAKE, X)], [], relay).has(D), false);
});
