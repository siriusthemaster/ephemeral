import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { loadWithdrawalHistory } from './history.ts';


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
  const r = await loadWithdrawalHistory(net, [S1, S2]);
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
  const r = await loadWithdrawalHistory(net, [S1, S2]);
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
  const r = await loadWithdrawalHistory(net, many);
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
  const lagging = await loadWithdrawalHistory(net, [S1], undefined, { [S1.toLowerCase()]: 2 });
  assert.equal(lagging.ok, false, 'the ETH send is on chain but not indexed yet');
  assert.deepEqual(lagging.history, [{ from: S1, to: X }], 'keeps what did load');
  const caughtUp = await loadWithdrawalHistory(net, [S1], undefined, { [S1.toLowerCase()]: 1 });
  assert.equal(caughtUp.ok, true);
});
