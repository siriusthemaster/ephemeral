import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { jsonRpcNode, loadWithdrawalHistory, type RpcLog, type TokenLogCheck } from './history.ts';

const net = { blockscout: 'https://eth.blockscout.com/api/v2' };
const S1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex;
const S2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex;
const X = '0xcccccccccccccccccccccccccccccccccccccccc';
const T = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // a token contract
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The node, injected: no token transfer from any of the addresses on chain.
const noTokenLogs: TokenLogCheck = { node: { blockNumber: async () => 100n, getLogs: async () => [] }, fromBlock: 0n };
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const topic = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
/** A Transfer log as eth_getLogs returns it (hex log index). */
const transferLog = (tx: string, logIndex: number, from: string, to: string): RpcLog => ({
  transactionHash: tx,
  logIndex: `0x${logIndex.toString(16)}`,
  topics: [TRANSFER, topic(from), topic(to)],
});

test('loader: ETH sends with value and token transfers, across pages; zero-value calls skipped', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    seen.push(u);
    assert.equal(init?.credentials, 'omit');
    assert.equal(init?.referrerPolicy, 'no-referrer');
    const url = new URL(u);
    assert.equal(url.searchParams.get('filter'), 'from');
    if (url.pathname.endsWith(`/addresses/${S1}/transactions`)) {
      if (!url.searchParams.get('block_number'))
        return json({
          items: [{ from: { hash: S1 }, to: { hash: T }, value: '0' }],
          next_page_params: { block_number: 5, index: 1, items_count: 50 },
        });
      return json({ items: [{ from: { hash: S1 }, to: { hash: X }, value: '1000' }, { from: { hash: S1 }, to: null, value: '5' }], next_page_params: null });
    }
    if (url.pathname.endsWith(`/addresses/${S1}/token-transfers`))
      return json({ items: [{ from: { hash: S1 }, to: { hash: X } }], next_page_params: null });
    return json({ message: 'Not found' }, 404);
  }) as typeof fetch;
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, {}, noTokenLogs);
  assert.equal(r.ok, true);
  assert.deepEqual(r.history, [
    { from: S1, to: X },
    { from: S1, to: X },
  ]);
  assert.ok(seen.every((u) => u.startsWith('https://eth.blockscout.com/api/v2/addresses/')));
});

test('loader: a failing address makes ok false but keeps what loaded', async () => {
  globalThis.fetch = (async (u: string) => {
    if (u.includes(S2)) return json({ message: 'bad' }, 400);
    if (u.includes('/transactions')) return json({ items: [{ from: { hash: S1 }, to: { hash: X }, value: '1' }], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, {}, noTokenLogs);
  assert.equal(r.ok, false);
  assert.deepEqual(r.history, [{ from: S1, to: X }]);
});

test('loader: no addresses is ok without any request; no Blockscout is not ok', async () => {
  globalThis.fetch = (async () => {
    throw new Error('should not be called');
  }) as typeof fetch;
  assert.deepEqual(await loadWithdrawalHistory(net, []), { history: [], ok: true });
  const local = { blockscout: null }; // a network without Blockscout (e.g. a local chain)
  assert.deepEqual(await loadWithdrawalHistory(local, [S1]), { history: [], ok: false });
});

test('loader: at most 3 requests in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  globalThis.fetch = (async () => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  const many = Array.from({ length: 10 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex);
  const r = await loadWithdrawalHistory(net, many, undefined, {}, noTokenLogs);
  assert.equal(r.ok, true);
  assert.equal(peak, 3);
});

test('loader: explorer behind the chain (nonce says 2 sent, explorer shows 1) means history incomplete', async () => {
  globalThis.fetch = (async (u: string) => {
    if (u.includes(`/addresses/${S1}/transactions`))
      return json({ items: [{ from: { hash: S1 }, to: { hash: T }, value: '0' }], next_page_params: null }); // only the token send is indexed
    if (u.includes(`/addresses/${S1}/token-transfers`)) return json({ items: [{ from: { hash: S1 }, to: { hash: X } }], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  const lagging = await loadWithdrawalHistory(net, [S1], undefined, { [S1.toLowerCase()]: 2 }, noTokenLogs);
  assert.equal(lagging.ok, false, 'the ETH send is on chain but not indexed yet');
  assert.deepEqual(lagging.history, [{ from: S1, to: X }], 'keeps what did load');
  const caughtUp = await loadWithdrawalHistory(net, [S1], undefined, { [S1.toLowerCase()]: 1 }, noTokenLogs);
  assert.equal(caughtUp.ok, true);
});

// Claus Lab review, 9 Oct: "the tx count can match while the reused destination is still missing from history".
test('loader: tx count matches, but a relayed token transfer is on chain and not indexed yet: history incomplete', async () => {
  const Y = '0xdddddddddddddddddddddddddddddddddddddddd'; // where the relayed transfer went
  const A = `0x${'a1'.repeat(32)}`; // S1's own token transfer to X: S1 signed it (nonce 1)
  const B = `0x${'b2'.repeat(32)}`; // a relayer's transaction moving S1's tokens to Y (permit): S1's nonce stays 1
  let indexedB = false;
  globalThis.fetch = (async (u: string) => {
    if (u.includes(`/addresses/${S1}/transactions`))
      return json({ items: [{ hash: A, from: { hash: S1 }, to: { hash: T }, value: '0' }], next_page_params: null });
    if (u.includes(`/addresses/${S1}/token-transfers`))
      return json({
        items: [
          ...(indexedB ? [{ transaction_hash: B, log_index: 3, from: { hash: S1 }, to: { hash: Y } }] : []),
          { transaction_hash: A, log_index: 7, from: { hash: S1 }, to: { hash: X } },
        ],
        next_page_params: null,
      });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  const calls: { fromBlock: bigint; toBlock: bigint; topics: string[] }[] = [];
  const tokenLogs: TokenLogCheck = {
    node: {
      blockNumber: async () => 25_999n,
      getLogs: async (q) => {
        calls.push(q);
        const logs = [transferLog(A, 7, S1, X), transferLog(B, 3, S1, Y)];
        return logs.filter((_, i) => [12_000n, 24_000n][i] >= q.fromBlock && [12_000n, 24_000n][i] <= q.toBlock);
      },
    },
    fromBlock: 0n,
    firstBlock: { [S1.toLowerCase()]: 1_000n }, // S1's first payment
  };
  const nonce = { [S1.toLowerCase()]: 1 }; // matches the one indexed transaction

  const lagging = await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs);
  assert.equal(lagging.ok, false, 'the transfer to Y is on chain but not in the explorer yet');
  assert.deepEqual(lagging.history, [{ from: S1, to: X }], 'keeps what did load');
  assert.deepEqual(
    calls.map((c) => [c.fromBlock, c.toBlock]),
    [
      [1_000n, 10_999n],
      [11_000n, 20_999n],
      [21_000n, 25_999n],
    ],
    "from S1's first payment block to the head, in ranges of 10,000 blocks",
  );
  assert.ok(calls.every((c) => c.topics.length === 2 && c.topics[0] === TRANSFER && c.topics[1] === topic(S1)), 'Transfer logs from S1');

  indexedB = true;
  const both = await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs);
  assert.equal(both.ok, true, 'every transfer on chain is in the explorer');
  assert.deepEqual(both.history, [
    { from: S1, to: Y },
    { from: S1, to: X },
  ]);
});

test('loader: token transfer in an indexed transaction but not indexed itself; older explorer fields still match', async () => {
  const A = `0x${'a1'.repeat(32)}`;
  let items: unknown[] = [];
  globalThis.fetch = (async (u: string) => {
    if (u.includes('/transactions')) return json({ items: [{ from: { hash: S1 }, to: { hash: T }, value: '0' }], next_page_params: null });
    if (u.includes('/token-transfers')) return json({ items, next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
  const tokenLogs: TokenLogCheck = { node: { blockNumber: async () => 50n, getLogs: async () => [transferLog(A, 31, S1, X)] }, fromBlock: 0n };
  const nonce = { [S1.toLowerCase()]: 1 };
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs)).ok, false, 'transaction indexed, its transfer not yet');
  items = [{ tx_hash: A, log_index: '31', from: { hash: S1 }, to: { hash: X } }]; // older Blockscout: tx_hash, string index
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs)).ok, true);
  items = [{ transaction_hash: A, from: { hash: S1 }, to: { hash: X } }]; // no log index: same transaction and recipient
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs)).ok, true);
  items = [{ transaction_hash: A, log_index: 30, from: { hash: S1 }, to: { hash: X } }]; // another log of that transaction
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, nonce, tokenLogs)).ok, false);
});

test('loader: a node that refuses large ranges gets smaller ones; no node, or an unreadable one, is not ok', async () => {
  globalThis.fetch = (async () => json({ items: [], next_page_params: null })) as typeof fetch;
  const ranges: [bigint, bigint][] = [];
  const picky: TokenLogCheck = {
    node: {
      blockNumber: async () => 20_000n,
      getLogs: async (q) => {
        if (q.toBlock - q.fromBlock + 1n > 4_000n) throw new Error('block range too large');
        ranges.push([q.fromBlock, q.toBlock]);
        return [];
      },
    },
    fromBlock: 10_001n,
  };
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, {}, picky)).ok, true);
  assert.equal(ranges[0][0], 10_001n);
  assert.equal(ranges.at(-1)![1], 20_000n);
  for (let i = 0; i < ranges.length; i++) {
    assert.ok(ranges[i][1] - ranges[i][0] + 1n <= 4_000n);
    if (i) assert.equal(ranges[i][0], ranges[i - 1][1] + 1n, 'contiguous');
  }

  assert.equal((await loadWithdrawalHistory(net, [S1])).ok, false, 'no node: token transfers cannot be confirmed');
  const down: TokenLogCheck = { node: { blockNumber: async () => 100n, getLogs: async () => Promise.reject(new Error('down')) }, fromBlock: 0n };
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, {}, down)).ok, false, 'logs unreadable');
  const noHead: TokenLogCheck = { node: { blockNumber: async () => Promise.reject(new Error('down')), getLogs: async () => [] }, fromBlock: 0n };
  assert.equal((await loadWithdrawalHistory(net, [S1], undefined, {}, noHead)).ok, false, 'head unreadable');
});

test('jsonRpcNode: eth_blockNumber and eth_getLogs over plain JSON-RPC; RPC errors throw', async () => {
  const bodies: { method: string; params: unknown[] }[] = [];
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    assert.equal(u, 'https://rpc.example');
    assert.equal(init?.method, 'POST');
    assert.equal(init?.credentials, 'omit');
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    if (body.method === 'eth_blockNumber') return json({ jsonrpc: '2.0', id: body.id, result: '0x3e8' });
    if (body.params[0].fromBlock === '0x1') return json({ jsonrpc: '2.0', id: body.id, error: { code: -32005, message: 'range too large' } });
    return json({ jsonrpc: '2.0', id: body.id, result: [transferLog(`0x${'a1'.repeat(32)}`, 2, S1, X)] });
  }) as typeof fetch;
  const node = jsonRpcNode('https://rpc.example');
  assert.equal(await node.blockNumber(), 1000n);
  const logs = await node.getLogs({ fromBlock: 16n, toBlock: 255n, topics: [TRANSFER as Hex, topic(S1) as Hex] });
  assert.equal(logs.length, 1);
  assert.deepEqual(bodies[1], {
    jsonrpc: '2.0',
    id: 2,
    method: 'eth_getLogs',
    params: [{ fromBlock: '0x10', toBlock: '0xff', topics: [TRANSFER, topic(S1)] }],
  });
  await assert.rejects(node.getLogs({ fromBlock: 1n, toBlock: 2n, topics: [] }), /range too large/);
});
