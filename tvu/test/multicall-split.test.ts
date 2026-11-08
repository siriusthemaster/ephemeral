// 7 Nov: a public Arbitrum node stopped one eth_call of 500 calls after 5 s ("execution aborted (timeout = 5s)") and
// the run failed. A batch refused as too heavy is now split, and the results keep their order.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, type Hex } from 'viem';
import { ABI, multicall } from '../value.ts';
import type { Rpc } from '../rpc.ts';

const MAX = 120; // this fake node aborts any batch above 120 calls
function fakeRpc(seen: number[]): Rpc {
  return {
    call: async (_m: string, params: unknown[]) => {
      const { args } = decodeFunctionData({ abi: ABI, data: (params[0] as { data: Hex }).data });
      const calls = args[0] as readonly { callData: Hex }[];
      seen.push(calls.length);
      if (calls.length > MAX) throw new Error('execution aborted (timeout = 5s)');
      return encodeAbiParameters(
        [{ type: 'tuple[]', components: [{ type: 'bool', name: 'success' }, { type: 'bytes', name: 'returnData' }] }],
        [calls.map((c) => ({ success: true, returnData: ('0x' + c.callData.slice(-64)) as Hex }))],
      );
    },
  } as unknown as Rpc;
}

test('a batch the node aborts as too slow is split; results stay in order; the smaller size is kept', async () => {
  const addrs = Array.from({ length: 1000 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as Hex);
  const calls = addrs.map((a) => ({ target: a, callData: encodeFunctionData({ abi: ABI, functionName: 'getEthBalance', args: [a] }) }));
  const seen: number[] = [];
  const out = await multicall(fakeRpc(seen), calls, '0x1', 500);
  assert.equal(out.length, 1000);
  for (let i = 0; i < 1000; i++) assert.equal(BigInt(out[i]!), BigInt(addrs[i]!));
  assert.ok(seen.filter((n) => n > MAX).length <= 3, `refused batches: ${seen.filter((n) => n > MAX).length}`);
});

test('other errors are not split away', async () => {
  const rpc = { call: async () => Promise.reject(new Error('invalid opcode')) } as unknown as Rpc;
  const calls = [{ target: '0x0000000000000000000000000000000000000001', callData: '0x' as Hex }];
  await assert.rejects(multicall(rpc, calls, '0x1', 500), /invalid opcode/);
});

test('rate limited on every endpoint: wait and retry the same call, then give up after the last wait', async () => {
  const { __test } = await import('../value.ts');
  let n = 0;
  const ok = await __test.callWithPatience(async () => (++n < 3 ? Promise.reject(new Error('all RPC urls failed: HTTP 429')) : 'done'), [1, 1, 1], async () => {});
  assert.equal(ok, 'done');
  assert.equal(n, 3);
  await assert.rejects(__test.callWithPatience(async () => Promise.reject(new Error('HTTP 429')), [1], async () => {}), /429/);
  await assert.rejects(__test.callWithPatience(async () => Promise.reject(new Error('invalid opcode')), [1], async () => {}), /invalid opcode/);
});
