/**
 * Bug bounty, 8 Nov, afternoon round (scanner). Each test names the report it covers.
 * (1) A stranger who funds his own earlier announcement (1 wei, or dust of any token) no longer hides the payer's
 *     payment: what arrived before that funded announcement and stayed unclaimed, from another signer, is still in
 *     reach of the payer's own announcement.
 * (2) The payer's own ETH beats a token bound only by its name.
 * (3) A token bound only by its name, relayed for the payer, is narrowed to the transfers whose log names the payer.
 * (4) ETH that left a stealth address in a transaction it did not sign counts as the owner's, also when the
 *     delegation that let it leave was cleared before the scan's end block.
 * (5) A relayed move of a token counts as the owner's only for a token that was paid in with the first payment.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPayments, neededTxs } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { a, h, CUTOFF_BLOCK as C } from './fixture.ts';

const S = a(0x5001);
const P = a(0xa001);
const STRANGER = a(0xbad1);
const RELAYER = a(0x1e1);
const TA = a(0x7a7a);
const TB = a(0x7b7b);
const ann = (asset: PaymentLog['asset'], token: string | null, tx: number, block: number): PaymentLog => ({
  source: 'erc5564', txHash: h(tx), blockNumber: block, logIndex: 0, stealth: S, asset, token,
});
const arrive = (tx: number, token: string | null, block: number, from = P): TransferLite =>
  ({ hash: h(tx), from, to: S, block, token, category: token === null ? 'external' : 'erc20' }) as TransferLite;
/** senderOf limited to what a production run fetches: neededTxs only */
function prod(logs: PaymentLog[], arrived: TransferLite[], signers: Record<string, string>) {
  const fetched = new Set(neededTxs(logs, () => arrived));
  return confirmPayments(logs, () => arrived, (x) => (fetched.has(x) ? signers[x] : undefined));
}
const rows = (r: ReturnType<typeof prod>) => r.payments.map((p) => [p.asset, p.token, p.txHash]);

test('Rusdi 8 Nov R1 (first), accpoww, Makino, Akbar: a stranger funding his own earlier announcement does not hide the payment', () => {
  // Rusdi: token TA paid at 90, the stranger announces at 91 naming TB and funds it with 1 wei at 93, the payer at 95
  const r = prod(
    [ann('TOKEN', TB, 2, 91), ann('TOKEN', TA, 3, 95)],
    [arrive(1, TA, 90), arrive(4, null, 93, STRANGER)],
    { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P, [h(4)]: STRANGER },
  );
  assert.ok(rows(r).some(([asset, token, tx]) => asset === 'TOKEN' && token === TA && tx === h(1)), 'the payer s token is a payment');
  // the dust variant: 1 unit of the token the stranger names, no ETH at all
  const d = prod(
    [ann('TOKEN', TB, 2, 91), ann('TOKEN', TA, 3, 95)],
    [arrive(1, TA, 90), arrive(4, TB, 93, STRANGER)],
    { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P, [h(4)]: STRANGER },
  );
  assert.ok(rows(d).some(([, token, tx]) => token === TA && tx === h(1)));
  // Makino: the payer paid ETH, the stranger's announcement carries dust of a token in its own transaction
  const m = prod(
    [ann('UNKNOWN', null, 2, 2_001), ann('ETH', null, 3, 2_006)],
    [arrive(1, null, 2_000), arrive(2, TB, 2_001, STRANGER)],
    { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P },
  );
  assert.ok(rows(m).some(([asset, , tx]) => asset === 'ETH' && tx === h(1)), 'the payer s ETH is a payment');
  // Akbar: a token paid at 2000, the stranger announces at 2001 naming nothing and adds 1 wei, the payer at 2010
  const k = prod(
    [ann('UNKNOWN', null, 2, 2_001), ann('TOKEN', TA, 3, 2_010)],
    [arrive(1, TA, 2_000), arrive(4, null, 2_001, STRANGER)],
    { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P, [h(4)]: STRANGER },
  );
  assert.ok(rows(k).some(([, token, tx]) => token === TA && tx === h(1)));
});

test('control: the payer s own gas next to its funded announcement is no new payment for a later stranger', () => {
  // the payer pays TA with its own gas ETH a block ahead, announces at 1000; a stranger announces at 1500
  const r = prod(
    [ann('TOKEN', TA, 3, 1_000), ann('ETH', null, 5, 1_500)],
    [arrive(1, null, 999), arrive(2, TA, 999)],
    { [h(1)]: P, [h(2)]: P, [h(3)]: P, [h(5)]: STRANGER },
  );
  assert.deepEqual(rows(r), [['TOKEN', TA, h(2)]]);
  assert.equal(r.unfunded, 1);
});

test('Makino 8 Nov: the payer s own ETH beats a stranger s unit of the token the announcement names', () => {
  const r = prod([ann('TOKEN', TA, 2, 1_000)], [arrive(5, null, 1_001), arrive(6, TA, 1_002, STRANGER)], { [h(2)]: P, [h(5)]: P, [h(6)]: STRANGER });
  assert.deepEqual(rows(r), [['ETH', null, h(5)]]);
  assert.equal(r.tokenDust, 1);
  // control: without the payer's ETH, a relayed token named by the announcement is still the payment
  const relayed = prod([ann('TOKEN', TA, 2, 1_000)], [arrive(6, TA, 1_002, P)], { [h(2)]: P, [h(6)]: RELAYER });
  assert.deepEqual(rows(relayed), [['TOKEN', TA, h(6)]]);
});

test('Znax (Tri) 8 Nov F1: a stranger s dust of a relayed named token is no second payment', () => {
  // the payer's TA moved by a relayer (permit or transferWithAuthorization: the log names the payer), then dust of TA
  const r = prod(
    [ann('TOKEN', TA, 2, 1_000)],
    [arrive(6, TA, 1_001, P), arrive(7, TA, 1_003, STRANGER)],
    { [h(2)]: P, [h(6)]: RELAYER, [h(7)]: STRANGER },
  );
  assert.deepEqual(rows(r), [['TOKEN', TA, h(6)]]);
  assert.equal(r.tokenDust, 1);
});

// ------------------------------------------------------------------ owned withdrawals (heuristics.ts)
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };
const D = a(0xd001);
const pay = (token: string | null, tx: number, block: number, sender = P): Payment => ({
  source: 'erc5564', stealth: S, sender, block, timestamp: 0, asset: token === null ? 'ETH' : 'TOKEN', token, txHash: h(tx),
});
const world = (payments: Payment[], withdrawals: Withdrawal[], delegated = new Set<string>()): Dataset => ({
  payments, withdrawals, fundings: [], registrations: [], contracts: new Set(), delegated, preUsed: new Set(),
});

test('accpoww 8 Nov: relayer-paid ETH leaving a stealth address counts, also when its delegation was cleared before the scan end', () => {
  const out: Withdrawal = { stealth: S, txHash: h(2), block: C + 1_010, to: D, kind: 'eth', token: null, txFrom: RELAYER, txType: 2, priorityFee: null };
  assert.equal(analyze(world([pay(null, 1, C + 1_000)], [out], new Set([S])), opts).all.withdrawn, 1, 'delegated at the scan end');
  assert.equal(analyze(world([pay(null, 1, C + 1_000)], [out]), opts).all.withdrawn, 1, 'cleared before the scan end');
});

test('Makino 8 Nov: a fabricated Transfer of a stranger s own token, after his dust was counted as paid, is no owner move', () => {
  const R = a(0xe5e5); // where the stranger wants the address to look withdrawn to
  const real = pay(null, 1, C + 1_000);
  const dust = pay(TB, 3, C + 1_050, STRANGER);
  const fake: Withdrawal = { stealth: S, txHash: h(4), block: C + 1_100, to: R, kind: 'token', token: TB, txFrom: STRANGER, txType: 2, priorityFee: null };
  assert.equal(analyze(world([real, dust], [fake]), opts).all.withdrawn, 0);
  // control: a token that was the first payment, moved by a relayer, is the owner's move
  const tokenPaid = pay(TA, 5, C + 1_000);
  const relayed: Withdrawal = { stealth: S, txHash: h(6), block: C + 1_100, to: D, kind: 'token', token: TA, txFrom: RELAYER, txType: 2, priorityFee: null };
  assert.equal(analyze(world([tokenPaid], [relayed]), opts).all.withdrawn, 1);
});
