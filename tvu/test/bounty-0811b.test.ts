// Bug bounty 8 Nov, afternoon round: the tvu collector. Each test names the report it covers.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, type Deps } from '../collect.ts';
import { FallbackRpc } from '../rpc.ts';
import { annLog, addr, ETH, MockChain, ROUTER, testChain } from './mock.ts';

const PRICES = { eth: 2000, pol: 0.5 };
const deps = (m: MockChain): Deps => ({
  makeRpc: async () => m,
  prices: async () => PRICES,
  sector: async () => ({ chains: {} }),
  now: () => Date.now(),
  log: () => {},
});
const opts = () => ({ dataDir: mkdtempSync(join(tmpdir(), 'tvu-b-')), budgetMs: 60_000, publish: true, chains: [testChain] });

/** A chain that runs `after[n]` once its n-th eth_call (one Multicall3 batch) has been answered. */
class Moving extends MockChain {
  n = 0;
  after: Record<number, () => void> = {};
  override async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = await super.call<T>(method, params);
    if (method === 'eth_call') this.after[++this.n]?.();
    return r;
  }
}

test('Makino and Rusdi 8 Nov: one pot moved from batch to batch while the run reads is counted once', async () => {
  const m = new Moving();
  m.head = 5000;
  const xs = Array.from({ length: 600 }, (_, i) => addr(0x1000 + i));
  xs.forEach((x, i) => m.logs.push(annLog(x, addr(0x77), 200 + i)));
  const [A, B, C] = [xs[0]!, xs[300]!, xs[550]!];
  m.eth.set(A, 100n * ETH); // 200,000 USD, under the per-address cap at every read
  // eth_call 1 checks the tokens, 2 to 4 are the three balance batches: the pot hops after batches 1 and 2
  m.after[2] = () => (m.eth.delete(A), m.eth.set(B, 100n * ETH));
  m.after[3] = () => (m.eth.delete(B), m.eth.set(C, 100n * ETH));
  const r = await run(opts(), deps(m));
  assert.ok(r.published);
  assert.equal(r.tvu!.parts.stealthNative, 200_000, 'counted at one address, not at three');
});

test('Rusdi 8 Nov: a balance moved into Umbra between the two reads is counted once', async () => {
  const m = new Moving();
  m.head = 1000;
  const S = addr(0xabc);
  m.logs.push(annLog(S, addr(0x77), 300));
  m.usdc.set(S, 100_000_000n); // 100 USD
  m.after[2] = () => (m.usdc.delete(S), (m.umbraUsdc += 100_000_000n));
  const r = await run(opts(), deps(m));
  assert.equal(r.tvu!.parts.stealthTokens, 0);
  assert.equal(r.tvu!.parts.umbraPendingTokens, 100);
  assert.equal(r.tvu!.totalUsd, 100);
});

test('Makino 8 Nov: a router announcement of somebody else\'s address no longer erases it, in either order', async () => {
  const m = new MockChain();
  m.head = 1000;
  const V1 = addr(0xb1), V2 = addr(0xb2), OWN = addr(0xb3);
  m.logs.push(annLog(V1, ROUTER, 300), annLog(V1, addr(0x77), 310)); // router first
  m.logs.push(annLog(V2, addr(0x77), 320), annLog(V2, ROUTER, 330)); // router after
  m.logs.push(annLog(OWN, ROUTER, 340)); // the router's own traffic
  m.usdc.set(V1, 500_000_000n);
  m.usdc.set(V2, 500_000_000n);
  m.usdc.set(OWN, 9_000_000_000n);
  const r = await run(opts(), deps(m));
  assert.equal(r.tvu!.parts.stealthTokens, 1000, 'both victims count, the router-only address does not');
  assert.equal(r.tvu!.excludedOutliers.usd, 0);
});

test('Makino 8 Nov: a gateway error that repeats the request path leaves no key in the thrown message', async () => {
  const KEY = 'Zx9QkLmP4rT7vW2yB8nC5dF1';
  const url = `https://arb-mainnet.example-gateway.io/v2/${KEY}`;
  const f = (async (_u: string, init: { body: string }) => {
    const id = JSON.parse(init.body).id;
    return { status: 200, text: async () => JSON.stringify({ id, error: { code: -32602, message: `block range too large for POST /v2/${KEY}` } }) };
  }) as never;
  const r = new FallbackRpc([url], { fetchImpl: f, sleep: async () => {} });
  await assert.rejects(r.call('eth_getLogs', []), (e: unknown) => {
    const msg = `${(e as Error).message} ${(e as { detail?: string }).detail ?? ''}`;
    assert.ok(!msg.includes(KEY) && !msg.includes(KEY.slice(0, 12)), msg);
    return true;
  });
  // the key alone, without the path around it, is removed too
  const f2 = (async (_u: string, init: { body: string }) => {
    const id = JSON.parse(init.body).id;
    return { status: 200, text: async () => JSON.stringify({ id, error: { code: -32000, message: `unknown api key ${KEY}` } }) };
  }) as never;
  await assert.rejects(new FallbackRpc([url], { fetchImpl: f2, sleep: async () => {} }).call('eth_getLogs', []), (e: unknown) => {
    assert.ok(!(e as Error).message.includes(KEY), (e as Error).message);
    return true;
  });
});
