// 22 Oct: the nonce comparison behind H3 failed open. loadWithdrawalHistory compared the explorer with the on-chain
// nonce only for addresses with a lowercase key in `sentCount`; the parameter defaulted to {} and a missing entry (or a
// failed read, -1 in the client) was skipped, so `ok` stayed true. That comparison is the only thing that catches an
// ETH withdrawal the explorer has not indexed yet (the 8 Oct case), so H3 could say "a destination no other payment of
// yours went to" for a destination another payment had just been sent to.
// Now every address needs a usable nonce, keys in any case; anything else is incomplete history.
// Scenario: payment S1 was withdrawn in ETH to D (S1's nonce is 1 on chain), the explorer has not indexed it yet,
// and the user now withdraws payment S2 to the same D. Mocked explorer and node, no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';
import { destinationsFromHistory, withdrawChecks } from './guards.ts';

const net = { blockscout: 'https://eth.blockscout.com/api/v2' };
const S1 = '0x1111111111111111111111111111111111111111' as Hex; // payment 1, ETH, already withdrawn to D (nonce 1)
const S2 = '0x2222222222222222222222222222222222222222' as Hex; // payment 2, about to be withdrawn
const S1m = getAddress('0xabcdef0000000000000000000000000000000001'); // a payment address with letters, checksummed
const D = '0xdddddddddddddddddddddddddddddddddddddddd';
const FRESH = '0xfefefefefefefefefefefefefefefefefefefefe';
const W = '0x9999999999999999999999999999999999999999' as Hex; // key wallet

const FALSE_UNUSED = 'H3: a destination no other payment of yours went to.';
const INCOMPLETE = 'H3: history incomplete. Past withdrawals could not be read, so this destination cannot be confirmed as unused.';
const COLLECTED = 'H3: you already sent another payment to this address. Collecting payments in one place links them.';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { 'content-type': 'application/json' } });

/** Blockscout: lagging = nothing indexed yet; otherwise `sender`'s ETH withdrawal to D is listed. */
function explorer(opts: { lagging: boolean; sender?: Hex }) {
  const sender = (opts.sender ?? S1).toLowerCase();
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (!opts.lagging && p.endsWith(`/addresses/${sender}/transactions`))
      return json({ items: [{ from: { hash: sender }, to: { hash: D }, value: '1000' }], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
// The node: no token transfer from either address (the withdrawal was ETH), so the token side passes.
const tokenLogs: TokenLogCheck = { node: { blockNumber: async () => 1_000n, getLogs: async () => [] }, fromBlock: 0n };

function h3(own: Hex[], r: { history: { from: string; to: string }[]; ok: boolean }, destination = D, from = S2) {
  return withdrawChecks({
    destination,
    stealthAddress: from,
    walletAddress: W,
    payer: undefined, // required input; only H3 is read here
    ownStealthAddresses: own,
    usedDestinations: destinationsFromHistory(own, r.history),
    historyComplete: r.ok,
    isToken: false,
    hasGas: true,
    now: Date.now(),
  }).find((c) => c.id === 'H3')!;
}

test('control: full lowercase nonce map, explorer lagging: history incomplete, H3 warns', async () => {
  explorer({ lagging: true });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, tokenLogs);
  assert.equal(r.ok, false);
  assert.equal(h3([S1, S2], r).text, INCOMPLETE);
});

test('control: full nonce map, explorer caught up: ok, D is a known collector, a fresh destination is unused', async () => {
  explorer({ lagging: false });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 }, tokenLogs);
  assert.equal(r.ok, true, 'a complete nonce map that matches the explorer is not over blocked');
  assert.equal(h3([S1, S2], r).text, COLLECTED);
  assert.equal(h3([S1, S2], r, FRESH).text, FALSE_UNUSED, 'the true "unused" line still shows when it is true');
});

test('default: sentCount left out or {}: history incomplete, never "unused" for the reused destination', async () => {
  explorer({ lagging: true });
  for (const nonces of [undefined, {}]) {
    const r = await loadWithdrawalHistory(net, [S1, S2], undefined, nonces, tokenLogs);
    assert.equal(r.ok, false, `sentCount ${JSON.stringify(nonces)}`);
    assert.equal(h3([S1, S2], r).text, INCOMPLETE);
  }
  explorer({ lagging: false });
  const caughtUp = await loadWithdrawalHistory(net, [S1, S2], undefined, undefined, tokenLogs);
  assert.equal(caughtUp.ok, false, 'without nonces even a caught up explorer cannot be confirmed');
});

test('checksummed keys: matched case insensitively, so the lag is still caught and a match still counts', async () => {
  explorer({ lagging: true, sender: S1m });
  const lagging = await loadWithdrawalHistory(net, [S1m, S2], undefined, { [S1m]: 1, [getAddress(S2)]: 0 }, tokenLogs);
  assert.ok(S1m !== S1m.toLowerCase(), 'the key really is checksummed');
  assert.equal(lagging.ok, false, 'nonce 1 under a checksummed key, nothing indexed');
  assert.equal(h3([S1m, S2], lagging).text, INCOMPLETE);
  // lowercase addresses asked, checksummed keys given (and the other way round): same result
  const lower = await loadWithdrawalHistory(net, [S1m.toLowerCase() as Hex, S2], undefined, { [S1m]: 1, [S2]: 0 }, tokenLogs);
  assert.equal(lower.ok, false);
  explorer({ lagging: false, sender: S1m });
  const caughtUp = await loadWithdrawalHistory(net, [S1m, S2], undefined, { [S1m]: 1, [getAddress(S2)]: 0 }, tokenLogs);
  assert.equal(caughtUp.ok, true, 'checksummed keys with matching nonces are a complete map');
  assert.equal(h3([S1m, S2], caughtUp).text, COLLECTED);
});

test('one entry missing (its nonce read failed and was left out): history incomplete', async () => {
  explorer({ lagging: true });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S2]: 0 }, tokenLogs);
  assert.equal(r.ok, false);
  assert.equal(h3([S1, S2], r).text, INCOMPLETE);
  explorer({ lagging: false });
  const caughtUp = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1 }, tokenLogs);
  assert.equal(caughtUp.ok, false, 'S2 has no nonce, so S2 cannot be confirmed either');
});

test('unusable nonce values: -1 (a failed read), NaN, Infinity, a fraction, a string, null: history incomplete', async () => {
  explorer({ lagging: true });
  for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5, '1', null]) {
    const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: bad as number, [S2]: 0 }, tokenLogs);
    assert.equal(r.ok, false, `nonce ${String(bad)}`);
    assert.equal(h3([S1, S2], r).text, INCOMPLETE);
  }
});

test('two keys for one address: the larger nonce counts, an unusable one makes it incomplete', async () => {
  explorer({ lagging: true });
  const both = await loadWithdrawalHistory(net, [S1m, S2], undefined, { [S1m.toLowerCase()]: 0, [S1m]: 1, [S2]: 0 }, tokenLogs);
  assert.equal(both.ok, false, 'nonce 1 wins over 0: the lag is caught');
  explorer({ lagging: false, sender: S1m });
  const failed = await loadWithdrawalHistory(net, [S1m, S2], undefined, { [S1m.toLowerCase()]: 1, [S1m]: -1, [S2]: 0 }, tokenLogs);
  assert.equal(failed.ok, false, 'a failed read under either key is no nonce');
  const fine = await loadWithdrawalHistory(net, [S1m, S2], undefined, { [S1m.toLowerCase()]: 1, [S1m]: 1, [S2]: 0 }, tokenLogs);
  assert.equal(fine.ok, true);
});

test('token side unchanged: a full nonce map without tokenLogs is still not ok', async () => {
  explorer({ lagging: false });
  const r = await loadWithdrawalHistory(net, [S1, S2], undefined, { [S1]: 1, [S2]: 0 });
  assert.equal(r.ok, false);
});
