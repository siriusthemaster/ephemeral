// Bug bounty, 9 Nov: the tvu collector. Each test names the report it covers.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, type Deps } from '../collect.ts';
import { UMBRA } from '../config.ts';
import { buildTvu, sanityCheck } from '../output.ts';
import { annLog, addr, ETH, MockChain, testChain } from './mock.ts';

const PRICES = { eth: 2000, pol: 0.5 };
const deps = (m: MockChain): Deps => ({
  makeRpc: async () => m,
  prices: async () => PRICES,
  sector: async () => ({ chains: {} }),
  now: () => Date.now(),
  log: () => {},
});
const opts = () => ({ dataDir: mkdtempSync(join(tmpdir(), 'tvu-c-')), budgetMs: 60_000, publish: true, chains: [testChain] });

/** A chain where one pot jumps between A and B after every eth_call (every Multicall3 batch) it answers. */
class Bouncing extends MockChain {
  constructor(
    private readonly A: string,
    private readonly B: string,
    private readonly pot: bigint,
  ) {
    super();
    this.eth.set(B, pot); // after the token check (the first eth_call) it sits at A, when A's batch is read
  }
  override async call<T>(method: string, params: unknown[]): Promise<T> {
    const r = await super.call<T>(method, params);
    if (method === 'eth_call') {
      const atA = this.eth.has(this.A);
      this.eth.delete(atA ? this.A : this.B);
      this.eth.set(atA ? this.B : this.A, this.pot);
    }
    return r;
  }
}

test('Rusdi 9 Nov: a pot bouncing between two addresses on every read is never counted twice', async () => {
  for (let trial = 0; trial < 12; trial++) {
    const xs = Array.from({ length: 600 }, (_, i) => addr(0x1000 + i));
    const [A, B] = [xs[0]!, xs[300]!]; // in different batches of the first read
    const m = new Bouncing(A, B, 100n * ETH); // 200,000 USD, under the per-address cap
    m.head = 5000;
    xs.forEach((x, i) => m.logs.push(annLog(x, addr(0x77), 200 + i)));
    // 598 bystanders with 1 ETH each, so the second read also spreads over several batches
    for (const x of xs) if (x !== A && x !== B) m.eth.set(x, 1n * ETH);
    const r = await run(opts(), deps(m));
    assert.ok(r.published);
    assert.ok(r.tvu!.parts.stealthNative <= 598 * 2_000 + 200_000, `trial ${trial}: counted ${r.tvu!.parts.stealthNative}`);
  }
});

test('control: a pot that does not move is counted once', async () => {
  const m = new MockChain();
  m.head = 1000;
  const S = addr(0xabc);
  m.logs.push(annLog(S, addr(0x77), 300));
  m.eth.set(S, 100n * ETH);
  const r = await run(opts(), deps(m));
  assert.equal(r.tvu!.parts.stealthNative, 200_000);
});

test('accpoww 9 Nov: the native currency Umbra holds for stealth owners is counted', async () => {
  const m = new MockChain();
  m.head = 1000;
  m.logs.push(annLog(addr(0xabc), addr(0x77), 300));
  m.eth.set(UMBRA, 3n * ETH); // 6,000 USD of native payments waiting in Umbra
  m.umbraUsdc = 70_000_000n; // 70 USD of token payments
  const r = await run(opts(), deps(m));
  assert.equal(r.tvu!.parts.umbraPendingNative, 6_000);
  assert.equal(r.tvu!.parts.umbraPendingTokens, 70);
  assert.equal(r.tvu!.totalUsd, 6_070);
  assert.equal(r.tvu!.byChain.ethereum!.usd, 6_070);
});

test('Akbar 9 Nov: the jump check is skipped only when both values are below the floor, as the method now says', () => {
  const t = (usd: number) =>
    buildTvu([{ key: 'ethereum', native: usd, tokens: 0, umbraPending: 0, umbraNative: 0, addresses: 3 }], { count: 0, usd: 0 }, PRICES, 1_800_000_000);
  sanityCheck(t(900), t(100)); // both below 1,000 USD: no check
  // a fall from above the floor to near zero is the shape of a failed read: it stops, and says how to go on
  assert.throws(() => sanityCheck(t(10), t(5_000)), /TVU_ALLOW_JUMP=1/);
  sanityCheck(t(10), t(5_000), true);
});
