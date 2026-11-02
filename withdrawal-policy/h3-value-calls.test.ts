// 27 Oct, bug bounty (H3): the history loader recorded every ETH send with a value as a plain transfer to its `to`,
// without reading the calldata, and dropped a value-bearing contract creation (to = null) without counting it. A payment
// that left through a swap router was then recorded only as a transfer to the router while the history read as
// complete, so H3 called any other destination unused. An ETH send now counts as a transfer only with empty calldata;
// with calldata, or without `to`, the history is incomplete. Scenarios A, B and C of the report. Mocked, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';
import { destinationsFromHistory, withdrawChecks } from './guards.ts';

const net = { blockscout: 'https://eth.blockscout.com/api/v2' };
const S1 = '0x1111111111111111111111111111111111111111' as Hex;
const S2 = '0x2222222222222222222222222222222222222222' as Hex;
const ROUTER = '0xaaaa111111111111111111111111111111111111';
const D = '0xdddd00000000000000000000000000000000000d';
const EOA = '0xeeee00000000000000000000000000000000000e';
const SWAP_INPUT = '0x7ff36ab5000000000000000000000000dddd00000000000000000000000000000000000d';
const HASH = `0x${'c3'.repeat(32)}`;
const UNUSED = 'H3: a destination no other payment of yours went to.';
const INCOMPLETE = 'H3: history incomplete. Past withdrawals could not be read, so this destination cannot be confirmed as unused.';
const COLLECTED = 'H3: you already sent another payment to this address. Collecting payments in one place links them.';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
type Tx = { hash?: string; from: { hash: string }; to: { hash: string } | null; value: string; raw_input?: string };
function explorer(tx: Tx, details: Record<string, unknown> = {}) {
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S1}/transactions`)) return json({ items: [tx], next_page_params: null });
    const m = p.match(/\/transactions\/(0x[0-9a-f]{64})$/);
    if (m && m[1]) return m[1] in details ? json(details[m[1]]) : json({ message: 'Not found' }, 404);
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
const tokenLogs: TokenLogCheck = { node: { blockNumber: async () => 1000n, getLogs: async () => [] }, fromBlock: 0n };
const load = () => loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, tokenLogs);
const h3 = (history: { from: string; to: string }[], ok: boolean, destination = D) =>
  withdrawChecks({
    destination,
    stealthAddress: S2,
    walletAddress: '0x9999000000000000000000000000000000000099',
    payer: '0x8888000000000000000000000000000000000088',
    ownStealthAddresses: [S1, S2],
    usedDestinations: destinationsFromHistory([S1, S2], history),
    historyComplete: ok,
    isToken: false,
    hasGas: true,
    now: Date.now(),
  }).find((c) => c.id === 'H3')!;

test('scenario A: 1 ETH to a router with swap calldata: history incomplete, never unused; the router is a known destination', async () => {
  explorer({ from: { hash: S1 }, to: { hash: ROUTER }, value: '1000000000000000000', raw_input: SWAP_INPUT });
  const r = await load();
  assert.equal(r.ok, false);
  assert.deepEqual(r.history, [{ from: S1, to: ROUTER }]);
  assert.equal(h3(r.history, r.ok).text, INCOMPLETE);
  assert.equal(h3(r.history, r.ok, ROUTER).text, COLLECTED);
});

test('scenario B: a contract creation that carries 0.5 ETH (to = null): history incomplete', async () => {
  explorer({ from: { hash: S1 }, to: null, value: '500000000000000000', raw_input: '0x' });
  const r = await load();
  assert.equal(r.ok, false);
  assert.deepEqual(r.history, []);
  assert.equal(h3(r.history, r.ok).text, INCOMPLETE);
});

test('scenario C (control): the same swap calldata with value 0 stays incomplete', async () => {
  explorer({ from: { hash: S1 }, to: { hash: ROUTER }, value: '0', raw_input: SWAP_INPUT });
  const r = await load();
  assert.equal(r.ok, false);
  assert.equal(h3(r.history, r.ok).text, INCOMPLETE);
});

test('control: ETH to an EOA with empty calldata stays a plain send; the history is complete', async () => {
  for (const raw_input of ['0x', '']) {
    explorer({ from: { hash: S1 }, to: { hash: EOA }, value: '1000', raw_input });
    const r = await load();
    assert.equal(r.ok, true);
    assert.deepEqual(r.history, [{ from: S1, to: EOA }]);
    assert.equal(h3(r.history, r.ok).text, UNUSED);
    assert.equal(h3(r.history, r.ok, EOA).text, COLLECTED);
  }
});

test('calldata missing from the list: read from /transactions/<hash>; a call or unreadable input is incomplete', async () => {
  explorer({ hash: HASH, from: { hash: S1 }, to: { hash: EOA }, value: '1000' }, { [HASH]: { raw_input: '0x' } });
  assert.equal((await load()).ok, true);
  explorer({ hash: HASH, from: { hash: S1 }, to: { hash: ROUTER }, value: '1000' }, { [HASH]: { raw_input: SWAP_INPUT } });
  assert.equal((await load()).ok, false);
  explorer({ hash: HASH, from: { hash: S1 }, to: { hash: EOA }, value: '1000' });
  assert.equal((await load()).ok, false);
});
