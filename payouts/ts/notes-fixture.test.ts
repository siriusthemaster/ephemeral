import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getAddress } from 'viem';
import { buildSmallFixture, buildWorldFixture } from './notes-fixture.ts';
import { noteLeafHash, roundDown } from './notes.ts';
import { verifyInclusion } from './proof.ts';

const onDisk = (f: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${f}`, import.meta.url), 'utf8'));

// test/StealthPayout.t.sol settles notes8.json on chain and uses notes200.json for the 200-holder gas numbers.
test('test/fixtures/notes8.json and notes200.json are exactly what notes-fixture.ts builds (regenerate: npm run fixtures)', () => {
  assert.deepEqual(onDisk('notes8.json'), JSON.parse(JSON.stringify(buildSmallFixture())));
  assert.deepEqual(onDisk('notes200.json'), JSON.parse(JSON.stringify(buildWorldFixture())));
});

test('the notes8 receipt: each leaf is noteLeafHash(epoch, owner, debt, carryIn, address, denomination, salt), in the root, and they add up', () => {
  const f = buildSmallFixture();
  const r = f.receipt;
  let sum = 0n;
  r.leaves.forEach((leaf, i) => {
    assert.equal(leaf, noteLeafHash(BigInt(f.epoch), getAddress(r.owner), BigInt(r.debt), BigInt(r.carryIn), r.stealthAddresses[i], BigInt(r.denominations[i]), r.salts[i]));
    assert.ok(verifyInclusion(leaf, r.proofs[i], f.commitmentsRoot));
    sum += BigInt(r.denominations[i]);
  });
  assert.equal(sum, roundDown(BigInt(r.debt), BigInt(r.carryIn), BigInt(f.base)).paid);
});
