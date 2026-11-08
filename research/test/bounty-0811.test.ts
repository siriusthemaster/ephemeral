/**
 * Bug bounty, 8 Nov. (1) A stranger who announces a stealth address before its payer, naming another token, no longer
 * shortens the payer's own announcement window: the long look-back stays until an announcement of the address is
 * funded. (2) An announcement that names a token but was paid in ETH from the payer in a separate transaction is an
 * ETH payment, also in a production run where only the transactions neededTxs lists have a known signer.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPayments, neededTxs, WINDOW_AFTER } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { a, h } from './fixture.ts';

const S = a(0x5001);
const P = a(0xa001);
const STRANGER = a(0xbad1);
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

test('a stranger announcing first, naming another token, does not hide the payer s first payment', () => {
  const logs = [ann('TOKEN', TB, 2, 1_001), ann('TOKEN', TA, 3, 1_005)];
  const arrived = [arrive(1, TA, 1_000)];
  const r = prod(logs, arrived, { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P });
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token, p.txHash]), [['TOKEN', TA, h(1)]]);
  assert.equal(r.unfunded, 1); // the stranger's own announcement
  // the ETH variant
  const e = prod([ann('TOKEN', TB, 2, 1_001), ann('ETH', null, 3, 1_005)], [arrive(1, null, 1_000)], { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P });
  assert.deepEqual(e.payments.map((p) => [p.asset, p.txHash]), [['ETH', h(1)]]);
});

test('control: after a funded announcement a later one still looks only 2 blocks back (gas is no new payment)', () => {
  const logs = [ann('TOKEN', TA, 2, 1_000), ann('ETH', null, 3, 1_500)];
  const arrived = [arrive(1, TA, 1_000), arrive(4, null, 1_500 - 3)];
  const r = prod(logs, arrived, { [h(1)]: P, [h(2)]: P, [h(3)]: P, [h(4)]: P });
  assert.deepEqual(r.payments.map((p) => p.asset), ['TOKEN']);
  assert.equal(r.unfunded, 1);
});

test('a token named but paid in ETH by the payer in a separate transaction is an ETH payment (production signers)', () => {
  const logs = [ann('TOKEN', TA, 2, 1_000)];
  const arrived = [arrive(5, null, 1_000 + WINDOW_AFTER - 1)];
  const r = prod(logs, arrived, { [h(2)]: P, [h(5)]: P });
  assert.deepEqual(r.payments.map((p) => [p.asset, p.txHash]), [['ETH', h(5)]]);
  assert.equal(r.unfunded, 0);
  // control: the same with a stranger's ETH and nothing from the payer stays unfunded (P4b)
  const s = prod(logs, [arrive(5, null, 1_005, STRANGER)], { [h(2)]: P, [h(5)]: STRANGER });
  assert.equal(s.payments.length, 0);
  assert.equal(s.unfunded, 1);
});
