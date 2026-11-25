// Bug bounty, 22 to 25 Nov. Each test names the report it covers.
// (1) guards.ts had fallen behind the client (0xasuma, 24 Nov): it is now the client's 0.2.19 guards. These tests pin
//     the client fixes that were missing here: a payment through a contract blocks H2 (#59, #48, #55), the registry
//     answer for both forms of an address (#61, #118), the direct registry answer for the destination (#34), and a
//     limited payment scan never reads as complete history (scanCoverage).
// (2) The EIP-4788 and EIP-2935 system contracts are unspendable destinations (Marwan, 22 Nov).
// (3) What stays stricter here than in the client: a token withdrawal without its token contract blocks.
// (4) history.ts takes the client's rule for a cut explorer list (#6).
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { H1_REGISTRY_UNREAD, H2_VIA_CONTRACT, blocking, isUnspendable, l1Of, scanCoverage, withdrawChecks, type GuardInput } from './guards.ts';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';

const KEY = '0x1111111111111111111111111111111111111111' as Hex;
const DEST = '0x2222222222222222222222222222222222222222' as Hex;
const SA = '0x3333333333333333333333333333333333333333' as Hex;
const PAYER = '0x4444444444444444444444444444444444444444' as Hex;
const OTHER = '0x5555555555555555555555555555555555555555' as Hex;
const TOKEN = '0x6666666666666666666666666666666666666666' as Hex;

const base = (over: Partial<GuardInput> = {}): GuardInput => ({
  destination: DEST,
  stealthAddress: SA,
  walletAddress: KEY,
  registrants: [],
  payers: [PAYER],
  payerKnown: true,
  ownStealthAddresses: [SA],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
  ...over,
});
const line = (id: string, g: GuardInput) => withdrawChecks(g).find((c) => c.id === id);

// ------------------------------------------------------------------ (1) the client fixes this copy was missing
test('0xasuma 24 Nov (#59, #48, #55): a payment that came through a contract blocks H2, as in the client', () => {
  const c = line('H2', base({ payerViaContract: true }))!;
  assert.deepEqual([c.level, c.text], ['block', H2_VIA_CONTRACT]);
  assert.equal(line('H2', base())!.level, 'ok');
});

test('0xasuma 24 Nov: until every payer is read (payerKnown), H2 blocks every destination', () => {
  for (const payerKnown of [false, undefined]) {
    const c = withdrawChecks(base({ payerKnown: payerKnown as boolean }));
    assert.equal(c.find((x) => x.id === 'H2')!.level, 'block', String(payerKnown));
    assert.equal(blocking(c), true);
  }
  // "known" with no payer address to compare against is not known
  assert.equal(line('H2', base({ payers: [] }))!.level, 'block');
});

test('0xasuma 24 Nov (#61, #118): the registry answer counts for the alias form and the L1 form of the destination', () => {
  const alias = l1Of(DEST);
  assert.equal(line('H1', base({ registered: { [alias.toLowerCase()]: true } }))!.level, 'block');
  const both = { [DEST.toLowerCase()]: false, [alias.toLowerCase()]: false };
  assert.equal(line('H1', base({ registrants: null, registered: both }))!.level, 'ok');
  assert.equal(line('H1', base({ registrants: null, registered: { [DEST.toLowerCase()]: false } }))!.text, H1_REGISTRY_UNREAD);
});

test('0xasuma 24 Nov (#34): a destination the registry shows with a meta-address blocks H1, also when no registrant list names it', () => {
  assert.equal(line('H1', base({ registered: { [DEST.toLowerCase()]: true } }))!.level, 'block');
  // and gas from such a wallet blocks H5 for a token payment
  const g = base({ isToken: true, tokenAddress: TOKEN, token: { hasCode: true, standardTransfer: true }, gasFrom: [OTHER], registered: { [OTHER.toLowerCase()]: true } });
  assert.equal(line('H5', g)!.level, 'block');
  assert.equal(line('H5', { ...g, registered: { [OTHER.toLowerCase()]: false } })!.level, 'ok');
});

test('0xasuma 24 Nov (scanCoverage): a payment scan limited to recent days never reads as complete history', () => {
  assert.deepEqual(scanCoverage('all', true), { historyComplete: true, ownPartial: false });
  assert.deepEqual(scanCoverage('all', false), { historyComplete: false, ownPartial: false });
  for (const r of ['7', '30', '90', 'anything else']) assert.deepEqual(scanCoverage(r, true), { historyComplete: false, ownPartial: true }, r);
  const h3 = line('H3', base({ ...scanCoverage('30', true) }))!;
  assert.equal(h3.level, 'warn');
  assert.match(h3.text, /history incomplete/);
  assert.equal(line('H3', base({ ...scanCoverage('all', true) }))!.level, 'ok');
  // H5 for a token payment compares the gas sources with past destinations: partial history cannot say "ok" either
  const token = { isToken: true, tokenAddress: TOKEN, token: { hasCode: true, standardTransfer: true }, gasFrom: [OTHER] };
  assert.equal(line('H5', base({ ...token, ...scanCoverage('7', true) }))!.level, 'warn');
  assert.equal(line('H5', base({ ...token, ...scanCoverage('all', true) }))!.level, 'ok');
});

// ------------------------------------------------------------------ (2) system contracts
const SYSTEM = [
  ['0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02', /EIP-4788 beacon roots/], // EIP-4788 BEACON_ROOTS_ADDRESS
  ['0x0000F90827F1C53a10cb7A02335B175320002935', /EIP-2935 history storage/], // EIP-2935 HISTORY_STORAGE_ADDRESS
] as const;

test('Marwan 22 Nov: the EIP-4788 and EIP-2935 system contracts are unspendable, in any letter case', () => {
  for (const [addr, name] of SYSTEM) {
    for (const d of [addr, addr.toLowerCase(), '0x' + addr.slice(2).toUpperCase(), getAddress(addr)]) {
      assert.equal(isUnspendable(d), true, d);
      for (const isToken of [false, true]) {
        const c = withdrawChecks(base({ destination: d, isToken, tokenAddress: TOKEN }));
        assert.deepEqual(c.map((x) => [x.id, x.level]), [['burn', 'block']], d);
        assert.match(c[0]!.text, name);
      }
    }
  }
  // control: the old EIP-2935 address from an earlier draft of the EIP is an ordinary address here
  assert.equal(isUnspendable('0x0aae40965e6800cd9b1f4b05ff21581047e3f91e'), false);
});

// ------------------------------------------------------------------ (3) stricter here than the client
test('a token withdrawal without its token contract still blocks here (cannot check), also with the token confirmed', () => {
  const g = { isToken: true, gasFrom: [], token: { hasCode: true, standardTransfer: true } };
  for (const tokenAddress of [undefined, '0x' as Hex, ('0x' + '0'.repeat(40)) as Hex]) {
    const c = line('token', base({ ...g, tokenAddress }))!;
    assert.deepEqual([c.level, c.text], ['block', 'Cannot check, token contract unknown. Withdraw stays locked until it is known.']);
  }
  assert.equal(line('token', base({ ...g, tokenAddress: TOKEN })), undefined);
});

// ------------------------------------------------------------------ (4) history.ts: a cut explorer list (client 0.2.19, #6)
// In this folder the nonce comparison and the node's token logs already catch a cut list in practice; these tests pin
// the client's own rule in pages() by giving a nonce equal to what was read, so only the cut list itself can fail it.
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const quietNode: TokenLogCheck = { node: { blockNumber: async () => 1_000n, getLogs: async () => [], getCode: async () => '0x' }, fromBlock: 0n };
/** The explorer lists one ETH send per page; `pages` pages exist, and page `missing` (if any) answers 404. */
function explorer(pages: number, missing?: number) {
  globalThis.fetch = (async (u: string) => {
    const url = new URL(u);
    const p = url.pathname.toLowerCase();
    if (!p.endsWith(`/addresses/${SA.toLowerCase()}/transactions`)) return json({ items: [], next_page_params: null });
    const n = Number(url.searchParams.get('page') ?? '0');
    if (n === missing) return json({ message: 'not found' }, 404);
    const to = `0x${'d'.repeat(39)}${n}`;
    return json({ items: [{ from: { hash: SA.toLowerCase() }, to: { hash: to }, value: '1000', raw_input: '0x' }], next_page_params: n + 1 < pages ? { page: n + 1 } : null });
  }) as typeof fetch;
}

test('0xasuma 24 Nov (client #6): an explorer page missing in the middle of the list makes the history incomplete', async () => {
  explorer(3);
  const whole = await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [SA], undefined, { [SA]: 3 }, quietNode);
  assert.deepEqual([whole.ok, whole.history.length], [true, 3]);
  explorer(3, 1);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [SA], undefined, { [SA]: 1 }, quietNode)).ok, false);
});

test('0xasuma 24 Nov (client #6): a list longer than the pages read is never complete', async () => {
  explorer(9);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [SA], undefined, { [SA]: 4 }, quietNode)).ok, false);
});
