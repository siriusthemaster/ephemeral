// Copied from ephemeral-client test/h2-round-trip.test.ts at commit 2d12269 (client 0.2.19-beta), the version guards.ts matches.
// Only the import path changed. Run with the rest: node --experimental-strip-types --test *.test.ts
// Bug bounty 26.10 (H2, Medium): the public docs say an H2 round trip is "Blocked: the payer is never a destination",
// but the policy let an integrator relax a payer match to a warning, and the public withdrawal-policy module only
// warned for a known payer. Since 0.2.10 every known payer (payer or any of payers) blocks, with no setting, like H1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import type { Hex } from 'viem';
import { POLICY, blocking, withdrawChecks, type GuardInput } from './guards.ts';

const PAYER = '0x3333333333333333333333333333333333333333' as Hex;
const FUNDER = '0x4444444444444444444444444444444444444444' as Hex;
const CALLER = '0x5555555555555555555555555555555555555555' as Hex;
const base: GuardInput = {
  destination: '0x6666666666666666666666666666666666666666',
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: '0x2222222222222222222222222222222222222222',
  payer: PAYER,
  payers: [CALLER, FUNDER],
  payerKnown: true,
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111'],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
};
const h2 = (c: ReturnType<typeof withdrawChecks>) => c.find((x) => x.id === 'H2')!;

test('the report: every known payer is blocked as a destination, under any policy', () => {
  for (const d of [PAYER, FUNDER, CALLER, FUNDER.toUpperCase().replace('0X', '0x')])
    for (const policy of [undefined, { H2: 'block' as const }, { H2: 'warn' as const }]) {
      const c = withdrawChecks({ ...base, destination: d }, policy);
      assert.equal(h2(c).level, 'block', `${d} ${JSON.stringify(policy)}`);
      assert.equal(h2(c).text, 'H2: this address paid you. Sending the payment back links both ends.');
      assert.equal(blocking(c), true);
    }
  // only `payers`, no `payer`: still blocked
  assert.equal(h2(withdrawChecks({ ...base, payer: undefined, destination: FUNDER }, { H2: 'warn' })).level, 'block');
});

test('control: a destination that paid nothing passes H2', () => {
  assert.equal(h2(withdrawChecks(base)).level, 'ok');
  assert.equal(h2(withdrawChecks(base, { H2: 'warn' })).level, 'ok');
});

test('what the docs say is what the engine does: H2 is listed as blocked', () => {
  assert.equal(POLICY.find((p) => p.id === 'H2')!.level, 'block');
  // the website docs live next to the client in the site repo; this check runs only where they are present
  const docUrl = new URL('../../web/content/docs/using/withdraw-without-leaking.mdx', import.meta.url);
  if (!existsSync(docUrl)) return;
  const doc = readFileSync(docUrl, 'utf8');
  assert.match(doc, /\| \*\*H2\*\* round trip \|[^\n]*\| Blocked: the payer is never a destination/);
});
