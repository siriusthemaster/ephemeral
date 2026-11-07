import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hostOf, redact } from '../rpc.ts';

test('a keyed RPC url never reaches the log: host only, path and key removed', () => {
  const url = 'https://eth-mainnet.g.alchemy.com/v2/AbCdEf123456SECRETKEY';
  assert.equal(hostOf(url), 'eth-mainnet.g.alchemy.com');
  const msg = redact(`fetch failed for ${url}: HTTP 429`, url);
  assert.ok(!msg.includes('SECRETKEY') && !msg.includes('AbCdEf'), msg);
  const msg2 = redact('POST /v2/AbCdEf123456SECRETKEY returned 500', url);
  assert.ok(!msg2.includes('SECRETKEY'), msg2);
  assert.equal(redact('timeout', url), 'timeout');
});
