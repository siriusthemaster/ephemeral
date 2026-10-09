import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildFixture } from './fixture.ts';
import { leafHash } from './proof.ts';

// test/StealthPayout.t.sol settles this file on chain and checks its leaf and metadata with Solidity's own encoding.
test('test/fixtures/epoch7.json is exactly what fixture.ts builds (regenerate: npm run fixture)', () => {
  const onDisk = JSON.parse(readFileSync(new URL('../test/fixtures/epoch7.json', import.meta.url), 'utf8'));
  assert.deepEqual(onDisk, JSON.parse(JSON.stringify(buildFixture())));
});

test('the fixture receipt is the TypeScript leaf of (nftId, epoch, stealthAddress, salt)', () => {
  const f = buildFixture();
  assert.equal(f.receipt.leaf, leafHash(BigInt(f.receipt.nftId), BigInt(f.epoch), f.receipt.stealthAddress, f.receipt.salt));
});
