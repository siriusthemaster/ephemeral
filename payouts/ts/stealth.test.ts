// Bug bounty, 24 Nov (0xasuma): stealth.ts here and in router/e2e/ was a copy from before client 0.2.10 while its
// header said it was the client's code. It is now the client's src/lib/stealth.ts as of 0.2.19 (commit 2d12269).
// These tests pin what the old copy got wrong: a 33-byte meta-address was paid as one key doing both jobs, a high-S
// signature gave a second set of keys, and r or s of 0 or n gave keys at all.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { concat, keccak256, toHex, type Hex } from 'viem';
import { secp256k1 } from '@noble/curves/secp256k1';
import {
  assertMetaAddress,
  generateStealthAddress,
  isHighS,
  keysFromSignature,
  legacyKeysFromSignature,
  metaAddressOf,
  parseMetaAddress,
  viewTagMatch,
} from './stealth.ts';

const N = secp256k1.CURVE.n;
const word = (x: bigint): Hex => `0x${x.toString(16).padStart(64, '0')}` as Hex;
const label = (s: string) => BigInt(keccak256(toHex(s))) % (N - 1n) + 1n;
const R = label('stealth test r');
const S_LOW = (() => {
  const s = label('stealth test s');
  return s > N >> 1n ? N - s : s;
})();
const sig = (r: bigint, s: bigint): Hex => concat([word(r), word(s), '0x1b']);
const EPH = word(label('stealth test ephemeral'));

test('the copies here and in router/e2e are the same file, the client 0.2.19 one', () => {
  const here = readFileSync(new URL('./stealth.ts', import.meta.url), 'utf8');
  const router = readFileSync(new URL('../../router/e2e/stealth.ts', import.meta.url), 'utf8');
  assert.equal(router, here);
  assert.match(here, /client 0\.2\.19-beta \(ephemeral-client commit 2d12269\)/);
});

test('a 33-byte meta-address is refused, never paid as one key doing both jobs', () => {
  const keys = keysFromSignature(sig(R, S_LOW));
  const full = metaAddressOf(keys);
  const short = full.slice(0, 2 + 66) as Hex; // the spending key only
  for (const input of [short, `st:eth:${short}`]) assert.throws(() => parseMetaAddress(input), /too short/);
  // the full 66-byte form still works and its payment is found by the owner's view tag check
  const meta = parseMetaAddress(`st:eth:${full}`);
  const g = generateStealthAddress(meta, EPH);
  assert.notEqual(viewTagMatch(keys.viewingPrivateKey, g.ephemeralPublicKey, g.viewTag), null);
  // a meta-address built by hand is checked before any payment
  assert.throws(() => generateStealthAddress({ spendingPublicKey: meta.spendingPublicKey, viewingPublicKey: meta.spendingPublicKey.slice(0, 40) as Hex }, EPH));
  assert.throws(() => assertMetaAddress({ spendingPublicKey: meta.spendingPublicKey, viewingPublicKey: `0x04${'11'.repeat(32)}` as Hex }));
  assert.doesNotThrow(() => assertMetaAddress(meta));
});

test('the high-S form of a signature gives the same keys as its low-S form', () => {
  const low = sig(R, S_LOW);
  const high = sig(R, N - S_LOW);
  assert.equal(isHighS(low), false);
  assert.equal(isHighS(high), true);
  assert.deepEqual(keysFromSignature(high), keysFromSignature(low));
  assert.equal(metaAddressOf(keysFromSignature(high)), metaAddressOf(keysFromSignature(low)));
  // the keys a high-S signature gave before 0.2.11 stay reachable for older payments
  assert.notDeepEqual(legacyKeysFromSignature(high), keysFromSignature(high));
});

test('r or s of 0 or n is no signature: no keys', () => {
  for (const [r, s] of [
    [0n, S_LOW],
    [N, S_LOW],
    [R, 0n],
    [R, N],
  ] as const)
    assert.throws(() => keysFromSignature(sig(r, s)), /r and s must be between 1 and n - 1/, `${r} ${s}`);
});
