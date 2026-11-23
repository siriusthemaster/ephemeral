// Bug bounty, 11 to 21 Nov: the tvu collector. Each test names the report it covers.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeFunctionData } from 'viem';
import { run, type Deps } from '../collect.ts';
import { MULTICALL3, UMBRA } from '../config.ts';
import { ABI } from '../value.ts';
import { annLog, addr, ETH, MockChain, testChain } from './mock.ts';

const PRICES = { eth: 2000, pol: 0.5 };
const deps = (m: MockChain, log: (s: string) => void = () => {}): Deps => ({
  makeRpc: async () => m,
  prices: async () => PRICES,
  sector: async () => ({ chains: {} }),
  now: () => Date.now(),
  log,
});
const opts = () => ({ dataDir: mkdtempSync(join(tmpdir(), 'tvu-23-')), budgetMs: 60_000, publish: true, chains: [testChain] });

test('whitelistsol 13 Nov: an announced burn address does not count, whatever it holds', async () => {
  const m = new MockChain();
  m.head = 1000;
  const zero = addr(0);
  const dead = '0x000000000000000000000000000000000000dead';
  const precompile = addr(1);
  const real = addr(0xabc);
  for (const [i, s] of [zero, dead, precompile, real].entries()) m.logs.push(annLog(s, addr(0x77), 300 + i));
  m.eth.set(zero, 26n * ETH); // 52,000 USD that nobody can spend
  m.eth.set(dead, 3n * ETH);
  m.eth.set(precompile, 1n * ETH);
  m.eth.set(real, 1n * ETH);
  const r = await run(opts(), deps(m));
  assert.equal(r.tvu!.parts.stealthNative, 2_000);
  assert.equal(r.tvu!.totalUsd, 2_000);
  assert.deepEqual(r.tvu!.excludedOutliers, { count: 3, usd: 60_000 });
});

/** A chain that refuses some of the calls that read the largest holders and Umbra together (every call with Umbra's
 *  native balance after the first one, which is the Umbra read itself). */
class RefusingTogether extends MockChain {
  together: number[] = [];
  private umbraReads = 0;
  constructor(private readonly refuse: (n: number, size: number) => boolean) {
    super();
  }
  override async call<T>(method: string, params: unknown[]): Promise<T> {
    if (method === 'eth_call') {
      const { args } = decodeFunctionData({ abi: ABI, data: (params[0] as { data: `0x${string}` }).data }) as unknown as {
        args: [{ target: string; callData: `0x${string}` }[]];
      };
      const umbra = args[0].some((c) => {
        if (c.target.toLowerCase() !== MULTICALL3) return false;
        const d = decodeFunctionData({ abi: ABI, data: c.callData });
        return d.functionName === 'getEthBalance' && (d.args as unknown as string[])[0]!.toLowerCase() === UMBRA;
      });
      if (umbra && this.umbraReads++ > 0) {
        this.together.push(args[0].length);
        if (this.refuse(this.together.length, args[0].length)) throw new Error('execution timeout');
      }
    }
    return super.call<T>(method, params);
  }
}
const holders = (m: MockChain) => {
  m.head = 1000;
  for (let i = 0; i < 3; i++) {
    m.logs.push(annLog(addr(0x900 + i), addr(0x77), 300 + i));
    m.eth.set(addr(0x900 + i), BigInt(i + 1) * ETH);
  }
};

test('Rusdi 11 Nov: one slow answer does not halve the third read; it is tried again at the same size', async () => {
  const m = new RefusingTogether((n) => n === 1);
  holders(m);
  const logs: string[] = [];
  const r = await run(opts(), deps(m, (s) => logs.push(s)));
  assert.ok(r.published);
  const full = 3 * 2 + 2; // three holders and Umbra, native and USDC each
  assert.deepEqual(m.together, [full, full]);
  assert.ok(logs.some((l) => /trying the same size once more/.test(l)));
  assert.ok(!logs.some((l) => /largest of/.test(l)), 'no smaller set was read');
});

test('Rusdi 11 Nov: a third read refused at every size is logged and publishes nothing', async () => {
  const m = new RefusingTogether(() => true);
  holders(m);
  const logs: string[] = [];
  await assert.rejects(run(opts(), deps(m, (s) => logs.push(s))), /refused at every size/);
  assert.ok(logs.filter((l) => /refused twice/.test(l)).length >= 2);
  // the same chain without refusals publishes
  const ok = new RefusingTogether(() => false);
  holders(ok);
  assert.ok((await run(opts(), deps(ok))).published);
});
