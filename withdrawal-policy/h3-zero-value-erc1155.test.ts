// 25 Oct, two bug bounty reports on the H3 history loader:
// 1. A zero-value transaction from a stealth address was dropped from its history. A plain zero-value send to an EOA is
//    still a public link, so withdrawing another payment to that address must warn (reused collector), not say "unused".
//    Any other zero-value call that is not a transfer of the address's own tokens (an approval, an unknown call) can let
//    tokens leave later without a trace we read, so it makes the history incomplete.
// 2. The node check read only ERC-20/721 Transfer logs. An ERC-1155 TransferSingle or TransferBatch has another topic and
//    `from` in topic 2, so an approved operator could move a stealth address's ERC-1155 token without the explorer
//    showing it yet, and without using the address's nonce. Those logs are now read and compared too.
// Mocked explorer and node, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector, type Hex } from 'viem';
import { loadWithdrawalHistory, tokenCallRecipient, type RpcLog, type TokenLogCheck } from './history.ts';
import { destinationsFromHistory, withdrawChecks } from './guards.ts';

const net = { blockscout: 'https://eth.blockscout.com/api/v2' };
const S1 = '0x1111111111111111111111111111111111111111' as Hex; // payment 1
const S2 = '0x2222222222222222222222222222222222222222' as Hex; // payment 2, about to be withdrawn
const C = '0x3333333333333333333333333333333333333333'; // an EOA that payment 1 already touched
const D = '0x4444444444444444444444444444444444444444'; // where an ERC-1155 token went
const OPERATOR = '0x5555555555555555555555555555555555555555';
const NFT = '0x6666666666666666666666666666666666666666'; // an ERC-1155 contract
const W = '0x9999999999999999999999999999999999999999' as Hex; // key wallet
const TX1 = `0x${'a1'.repeat(32)}`;
const TX2 = `0x${'b2'.repeat(32)}`;

const UNUSED = 'H3: a destination no other payment of yours went to.';
const INCOMPLETE = 'H3: history incomplete. Past withdrawals could not be read, so this destination cannot be confirmed as unused.';
const COLLECTED = 'H3: you already sent another payment to this address. Collecting payments in one place links them.';

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const SINGLE = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62';
const BATCH = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb';
const word = (a: string) => `${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const topic = (a: string) => `0x${word(a)}`;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

/** Blockscout for S1 only: its transactions and token transfers as given, raw_input looked up per hash if left out. */
function explorer(opts: { txs: unknown[]; transfers?: unknown[]; fullTx?: Record<string, unknown> }) {
  const seen: string[] = [];
  globalThis.fetch = (async (u: string) => {
    seen.push(u);
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S1}/transactions`)) return json({ items: opts.txs, next_page_params: null });
    if (p.endsWith(`/addresses/${S1}/token-transfers`)) return json({ items: opts.transfers ?? [], next_page_params: null });
    const m = p.match(/\/transactions\/(0x[0-9a-f]{64})$/);
    if (m && opts.fullTx?.[m[1]]) return json(opts.fullTx[m[1]]);
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  return seen;
}

/** A truthful node: returns only the logs whose topics match the filter (null = any). */
function node(logs: RpcLog[]): TokenLogCheck {
  return {
    node: {
      blockNumber: async () => 1_000n,
      getLogs: async (q) =>
        logs.filter((l) => q.topics.every((t, i) => t === null || (l.topics?.[i] ?? '').toLowerCase() === t.toLowerCase())),
    },
    fromBlock: 0n,
  };
}

function h3(r: { history: { from: string; to: string }[]; ok: boolean }, destination: string) {
  const own = [S1, S2];
  return withdrawChecks({
    destination,
    stealthAddress: S2,
    walletAddress: W,
    payer: undefined, // required input; only H3 is read here
    ownStealthAddresses: own,
    usedDestinations: destinationsFromHistory(own, r.history),
    historyComplete: r.ok,
    isToken: false,
    hasGas: true,
    now: Date.now(),
  }).find((c) => c.id === 'H3')!.text;
}

test('topics: TransferSingle and TransferBatch are the ERC-1155 event selectors, not Transfer', () => {
  assert.equal(toEventSelector('TransferSingle(address,address,address,uint256,uint256)'), SINGLE);
  assert.equal(toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])'), BATCH);
  assert.equal(toEventSelector('Transfer(address,address,uint256)'), TRANSFER);
});

test('zero value, no calldata, to an EOA: the EOA is a past destination and H3 warns for it', async () => {
  explorer({ txs: [{ hash: TX1, from: { hash: S1 }, to: { hash: C }, value: '0', raw_input: '0x' }] });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, node([]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.history, [{ from: S1, to: C }]);
  assert.equal(h3(r, C), COLLECTED, 'not "unused": payment 1 already touched C');
  assert.equal(h3(r, D), UNUSED, 'an address nothing went to is still unused');
});

test('zero value, raw_input left out of the list: read from the transaction itself', async () => {
  const seen = explorer({
    txs: [{ hash: TX1, from: { hash: S1 }, to: { hash: C }, value: '0' }],
    fullTx: { [TX1]: { hash: TX1, raw_input: '0x' } },
  });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, node([]));
  assert.equal(r.ok, true);
  assert.deepEqual(r.history, [{ from: S1, to: C }]);
  assert.ok(seen.some((u) => u.endsWith(`/transactions/${TX1}`)));
});

test('zero value, an approval or an unknown call: history incomplete, H3 never says "unused"', async () => {
  const approveAll = `0xa22cb465${word(OPERATOR)}${'0'.repeat(63)}1`; // setApprovalForAll(operator, true)
  for (const input of [approveAll, '0xdeadbeef', null]) {
    explorer({ txs: [{ hash: TX1, from: { hash: S1 }, to: { hash: NFT }, value: '0', raw_input: input }] });
    const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, node([]));
    assert.equal(r.ok, false, `input ${input}`);
    assert.equal(h3(r, D), INCOMPLETE);
  }
});

test('zero value, transfer of its own tokens: the token recipient is a past destination', () => {
  const amount = '0'.repeat(63) + '1';
  assert.equal(tokenCallRecipient(S1, `0xa9059cbb${word(D)}${amount}`), D);
  assert.equal(tokenCallRecipient(S1, `0x23b872dd${word(S1)}${word(D)}${amount}`), D, 'transferFrom of its own tokens');
  assert.equal(tokenCallRecipient(S1, `0x23b872dd${word(C)}${word(D)}${amount}`), null, "someone else's tokens");
  assert.equal(tokenCallRecipient(S1, `0xa9059cbb${'f'.repeat(24)}${D.slice(2)}${amount}`), null, 'dirty address word');
  assert.equal(tokenCallRecipient(S1, '0xa9059cbb'), null, 'too short');
});

test('ERC-1155 TransferSingle by an approved operator, not indexed yet: history incomplete; indexed: H3 warns', async () => {
  // the operator's transaction moves S1's token to D; S1 signed nothing, so its nonce stays 0
  const single: RpcLog = { transactionHash: TX2, logIndex: '0x4', topics: [SINGLE, topic(OPERATOR), topic(S1), topic(D)] };
  explorer({ txs: [] });
  const lagging = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 0, [S2]: 0 }, node([single]));
  assert.equal(lagging.ok, false, 'the node has the move, the explorer does not yet');
  assert.equal(h3(lagging, D), INCOMPLETE);

  explorer({ txs: [], transfers: [{ transaction_hash: TX2, log_index: 4, from: { hash: S1 }, to: { hash: D }, token: { address: NFT } }] });
  const indexed = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 0, [S2]: 0 }, node([single]));
  assert.equal(indexed.ok, true);
  assert.equal(h3(indexed, D), COLLECTED);
});

test('ERC-1155 TransferBatch not indexed yet: history incomplete; a log from another address is ignored', async () => {
  const batch: RpcLog = { transactionHash: TX2, logIndex: 9, topics: [BATCH, topic(OPERATOR), topic(S1), topic(D)] };
  explorer({ txs: [] });
  assert.equal((await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 0, [S2]: 0 }, node([batch]))).ok, false);
  const other: RpcLog = { transactionHash: TX2, logIndex: 9, topics: [BATCH, topic(OPERATOR), topic(C), topic(D)] };
  assert.equal((await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 0, [S2]: 0 }, node([other]))).ok, true);
});
