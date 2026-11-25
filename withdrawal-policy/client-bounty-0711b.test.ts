// Copied from ephemeral-client test/bounty-0711b.test.ts at commit 2d12269 (client 0.2.19-beta), the version guards.ts matches.
// Only the import path changed. Run with the rest: node --experimental-strip-types --test *.test.ts
// Bug bounty 3 to 7 Nov (client, next release). H5: gas sent by the destination itself. OP-stack deposits: gas or a
// payment from the L2 alias of a linked wallet counts as that wallet. Funding: a Transfer of zero or an ERC-1155 move
// of zero is no payer and no arrival (covered in funding by the shared code; guards here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { l1Of, withdrawChecks, type GuardInput } from './guards.ts';

const TOKEN = '0x9999999999999999999999999999999999999999' as Hex;
const KEY = '0x2222222222222222222222222222222222222222' as Hex;
const DEST = '0x6666666666666666666666666666666666666666' as Hex;
const OTHER = '0x7777777777777777777777777777777777777777' as Hex;
const base: GuardInput = {
  destination: DEST,
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: KEY,
  payer: '0x3333333333333333333333333333333333333333',
  payerKnown: true,
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111'],
  usedDestinations: [],
  historyComplete: true,
  isToken: true,
  token: { hasCode: true, standardTransfer: true },
  tokenAddress: TOKEN,
  hasGas: true,
  gasFrom: [],
  now: 10 * 3600_000,
};
const h5 = (g: Partial<GuardInput>) => withdrawChecks({ ...base, ...g }).find((c) => c.id === 'H5');
const h2 = (g: Partial<GuardInput>) => withdrawChecks({ ...base, ...g }).find((c) => c.id === 'H2');
const alias = (a: string) => `0x${((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0')}` as Hex;

test('H5: gas sent by the destination itself blocks a token withdrawal there; another destination passes', () => {
  assert.equal(h5({ gasFrom: [DEST] })?.level, 'block');
  assert.equal(h5({ gasFrom: [DEST], destination: OTHER })?.level, 'ok');
});

test('OP-stack deposits: the L2 alias of the key wallet as gas sender blocks; the alias of a payer blocks H2', () => {
  assert.equal(l1Of(alias(KEY)), KEY.toLowerCase());
  assert.equal(h5({ gasFrom: [alias(KEY)] })?.level, 'block');
  assert.equal(h2({ isToken: false, payers: [alias(OTHER)], destination: OTHER })?.level, 'block');
  assert.equal(h5({ gasFrom: [OTHER] })?.level, 'ok');
});

test('H1 (8 Nov): a registrant recorded under its OP deposit alias blocks its L1 address', () => {
  const REG = '0x4444444444444444444444444444444444444444' as Hex;
  const h1 = withdrawChecks({ ...base, isToken: false, registrants: [alias(REG)], destination: REG }).find((c) => c.id === 'H1');
  assert.equal(h1?.level, 'block');
});
