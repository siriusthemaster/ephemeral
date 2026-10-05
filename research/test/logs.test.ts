import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FreePlanError, scanLogs, type RawLog } from '../lib/logs.ts';
import { Rpc, RpcError } from '../lib/rpc.ts';
import { hex } from '../lib/util.ts';

/** A stand-in for Rpc whose eth_getLogs is answered by a function. */
function stub(answer: (from: bigint, to: bigint, call: number) => RawLog[]): Rpc {
  let calls = 0;
  return {
    async call(_method: string, params: unknown[]) {
      const q = params[0] as { fromBlock: string; toBlock: string };
      return answer(BigInt(q.fromBlock), BigInt(q.toBlock), ++calls);
    },
  } as unknown as Rpc;
}

const logAt = (b: bigint): RawLog => ({
  address: '0x0', topics: ['0x0'], data: '0x', blockNumber: hex(b), transactionHash: '0x' + b.toString(16).padStart(64, '0'), logIndex: '0x0',
});
const LOG_BLOCKS = [1_000n, 250_000n, 999_999n, 3_000_000n];
const inRange = (from: bigint, to: bigint) => LOG_BLOCKS.filter((b) => b >= from && b <= to).map(logAt);
const base = { addresses: ['0x0'], topic0s: ['0x0'], from: 0n, to: 3_000_000n, backoffMs: () => 1 };

test('an outage (HTTP 503) is waited out, not mistaken for a plan limit', async () => {
  const rpc = stub((from, to, call) => {
    if (call <= 5) throw new RpcError(503, 'Gave up after 2 attempts: HTTP 503');
    return inRange(from, to);
  });
  const logs = await scanLogs(rpc, base);
  assert.deepEqual(logs.map((l) => BigInt(l.blockNumber)), LOG_BLOCKS);
});

test('a range error shrinks the span and still returns every log once', async () => {
  const rpc = stub((from, to) => {
    if (to - from > 100_000n) throw new RpcError(-32005, 'query returned more than 10000 results');
    return inRange(from, to);
  });
  const logs = await scanLogs(rpc, base);
  assert.deepEqual(logs.map((l) => BigInt(l.blockNumber)), LOG_BLOCKS);
});

test('a provider that only allows 10 blocks is reported as a plan limit', async () => {
  const rpc = stub((from) => {
    throw new RpcError(-32600, `You can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [${hex(from)}, ${hex(from + 9n)}]`);
  });
  await assert.rejects(scanLogs(rpc, base), FreePlanError);
});

test('an explicit free-tier message is reported as a plan limit', async () => {
  const rpc = stub(() => {
    throw new RpcError(-32600, 'Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range.');
  });
  await assert.rejects(scanLogs(rpc, base), FreePlanError);
});
