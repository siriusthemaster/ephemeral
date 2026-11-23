// Bug bounty, 11 to 21 Nov. Mocked, no network.
// - H3: an ERC-721 or ERC-1155 transfer (or one of an unnamed token type) to a recipient with code calls it, and it can
//   pass the token on in the same transaction: history incomplete, like a plain ETH send to a contract. An ERC-20
//   transfer calls nothing: its recipient is the destination.
// - H3: an EIP-7702 delegation set and cleared around a relayed send. Every authorization raises the address's nonce
//   without a transaction of its own, so the explorer's count stays below the nonce and the history is incomplete.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const SAFE = '0x5afe00000000000000000000000000000000005a' as Hex; // a contract recipient
const EOA = '0xeeee00000000000000000000000000000000000e' as Hex;
const DELEGATE = '0xde1e00000000000000000000000000000000de1e' as Hex;
const BS = { blockscout: 'https://x/api/v2' };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function explorer(txs: unknown[], transfers: unknown[]) {
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S}/transactions`)) return json({ items: txs, next_page_params: null });
    if (p.endsWith(`/addresses/${S}/token-transfers`)) return json({ items: transfers, next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
/** a node: code now per address, and code at a block per `address@block` */
const node = (now: Record<string, string>, then: Record<string, string> = {}): TokenLogCheck => ({
  node: {
    blockNumber: async () => 1000n,
    getLogs: async () => [],
    getCode: async (a, b) => (b === undefined ? now[a.toLowerCase()] : then[`${a.toLowerCase()}@${b}`] ?? now[a.toLowerCase()]) ?? '0x',
  },
  fromBlock: 0n,
});
const transfer = (to: Hex, type: string | undefined, i: number, block?: number) => ({
  from: { hash: S },
  to: { hash: to },
  transaction_hash: `0x${i.toString(16).padStart(64, '0')}`,
  log_index: 0,
  ...(type === undefined ? {} : { token: { type } }),
  ...(block === undefined ? {} : { block_number: block }),
});
const withdrawalTx = (i: number) => ({ hash: `0x${i.toString(16).padStart(64, '0')}`, from: { hash: S }, to: { hash: `0x${'7'.repeat(40)}` }, value: '0', raw_input: '0xa9059cbb' + '00'.repeat(64) });

test('Rusdi 21 Nov: an ERC-1155 or ERC-721 transfer to a contract leaves the history incomplete, an ERC-20 one does not', async () => {
  for (const type of ['ERC-1155', 'ERC-721', undefined]) {
    explorer([withdrawalTx(1)], [transfer(SAFE, type, 1)]);
    const r = await loadWithdrawalHistory(BS, [S], undefined, { [S]: 1 }, node({ [SAFE]: '0x6080' }));
    assert.equal(r.ok, false, String(type));
    assert.ok(r.history.some((h) => h.to === SAFE), 'the contract still counts as a past destination');
  }
  // controls: an ERC-20 transfer to the same contract, and an ERC-1155 transfer to an EOA
  explorer([withdrawalTx(1)], [transfer(SAFE, 'ERC-20', 1)]);
  assert.equal((await loadWithdrawalHistory(BS, [S], undefined, { [S]: 1 }, node({ [SAFE]: '0x6080' }))).ok, true);
  explorer([withdrawalTx(1)], [transfer(EOA, 'ERC-1155', 1)]);
  assert.equal((await loadWithdrawalHistory(BS, [S], undefined, { [S]: 1 }, node({}))).ok, true);
});

test('Rusdi 21 Nov: a recipient that had code at the transfer and cleared it later still counts as one that was called', async () => {
  explorer([withdrawalTx(1)], [transfer(EOA, 'ERC-1155', 1, 500)]);
  const r = await loadWithdrawalHistory(BS, [S], undefined, { [S]: 1 }, node({}, { [`${EOA}@500`]: '0xef0100' + 'ab'.repeat(20) }));
  assert.equal(r.ok, false);
});

test('accpoww 11 Nov, cx 13 Nov: a delegation set and cleared through EIP-7702 leaves the history incomplete by the nonce', async () => {
  // set and clear in the address's own type-4 transactions: each also carries an authorization, which raises the
  // nonce a second time, so 2 transactions in the explorer stand against a nonce of 4
  const own = (i: number, to: Hex) => ({ hash: `0x${i.toString(16).padStart(64, '0')}`, from: { hash: S }, to: { hash: to }, value: '0', raw_input: '0x', block_number: 500 + i });
  explorer([own(1, DELEGATE), own(2, EOA)], []);
  const cleared = node({}); // no code now
  assert.equal((await loadWithdrawalHistory(BS, [S], undefined, { [S]: 4 }, cleared)).ok, false);
  // a sponsor's transaction carries the authorizations: no transaction of the address at all, nonce 2
  explorer([], []);
  assert.equal((await loadWithdrawalHistory(BS, [S], undefined, { [S]: 2 }, cleared)).ok, false);
  // control: the reports' worlds put the nonce at the transaction count, which no chain with EIP-7702 produces
  explorer([own(1, DELEGATE), own(2, EOA)], []);
  assert.equal((await loadWithdrawalHistory(BS, [S], undefined, { [S]: 2 }, cleared)).ok, true);
});
