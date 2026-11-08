// Bug bounty, 3 to 7 Nov (fixed 7 Nov). Mocked, no network.
// - H3: an ETH send with no calldata to a contract (a forwarder) is not a transfer to it; a payment address with code
//   has no complete history (the client since 0.2.11, now here too).
// - Unspendable: the P256VERIFY precompile 0x…0100 and the system address 0xff…fe.
// - A token withdrawal without its token contract cannot be checked: blocked.
// - H1: a wallet that published the meta-address is never a destination. H5: gas from the destination itself.
// - Funding: a Transfer of zero or an ERC-1155 move of zero makes no payer and no arrival.
// - OP-stack deposits: gas or a payment from the L2 alias of a linked wallet counts as that wallet.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';
import { l1Of, withdrawChecks, type GuardInput } from './guards.ts';
import { TRANSFER_SINGLE_TOPIC, readFunding, type FundingReader, type FundLog } from './funding.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const S2 = '0x2222222222222222222222222222222222222222' as Hex;
const FWD = '0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' as Hex; // a contract that forwards the ETH it receives
const EOA = '0xeeee00000000000000000000000000000000000e' as Hex;
const KEY = '0x9999000000000000000000000000000000000099' as Hex;
const PAYER = '0x8888000000000000000000000000000000000088' as Hex;
const REG = '0x7777000000000000000000000000000000000077' as Hex;
const DEST = '0xdddd00000000000000000000000000000000000d' as Hex;
const TOKEN = '0x6666666666666666666666666666666666666666' as Hex;
const STRANGER = '0x3333333333333333333333333333333333333333' as Hex;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function explorer(to: Hex) {
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S}/transactions`))
      return json({ items: [{ hash: `0x${'c3'.repeat(32)}`, from: { hash: S }, to: { hash: to }, value: '1000000000000000000', raw_input: '0x' }], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
const node = (code: Record<string, string>): TokenLogCheck => ({
  node: { blockNumber: async () => 1000n, getLogs: async () => [], getCode: async (a) => code[a.toLowerCase()] ?? '0x' },
  fromBlock: 0n,
});

test('H3: 1 ETH with no calldata to a forwarding contract: history incomplete; to an EOA: complete', async () => {
  explorer(FWD);
  const r = await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, node({ [FWD]: '0x6080' }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.history, [{ from: S, to: FWD }]); // the forwarder still counts as a past destination
  explorer(EOA);
  const c = await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, node({}));
  assert.equal(c.ok, true);
});

test('H3: code that cannot be read counts as code; a payment address with code is never complete', async () => {
  explorer(EOA);
  const noCode: TokenLogCheck = { node: { blockNumber: async () => 1000n, getLogs: async () => [] }, fromBlock: 0n };
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, noCode)).ok, false);
  const delegated = node({ [S]: '0xef0100' + 'ab'.repeat(20) });
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, delegated)).ok, false);
});

const guard = (g: Partial<GuardInput>): GuardInput => ({
  destination: DEST,
  stealthAddress: S,
  walletAddress: KEY,
  payer: PAYER,
  ownStealthAddresses: [S, S2],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
  ...g,
});
const line = (g: Partial<GuardInput>, id: string) => withdrawChecks(guard(g)).find((c) => c.id === id);

test('unspendable: the P256VERIFY precompile and the system address block like the zero address', () => {
  for (const d of ['0x0000000000000000000000000000000000000100', '0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFE'] as Hex[]) {
    const c = withdrawChecks(guard({ destination: d }));
    assert.equal(c.length, 1);
    assert.equal(c[0]?.id, 'burn');
    assert.equal(c[0]?.level, 'block');
  }
});

test('a token withdrawal without its token contract is blocked: cannot check', () => {
  assert.equal(line({ isToken: true, gasFrom: [], tokenAddress: undefined }, 'token')?.level, 'block');
  assert.equal(line({ isToken: true, gasFrom: [], tokenAddress: TOKEN }, 'token'), undefined);
  // control: sending the token to its own contract is still the burn block
  assert.equal(withdrawChecks(guard({ isToken: true, tokenAddress: TOKEN, destination: TOKEN }))[0]?.id, 'burn');
});

test('H1: a wallet that published the meta-address blocks like the key wallet', () => {
  assert.equal(line({ destination: REG, registrants: [REG] }, 'H1')?.level, 'block');
  assert.equal(line({ destination: DEST, registrants: [REG] }, 'H1')?.level, 'ok');
});

test('H5: gas sent by the destination itself blocks a token withdrawal there', () => {
  const g = { isToken: true, tokenAddress: TOKEN, gasFrom: [DEST] };
  assert.equal(line({ ...g, destination: DEST }, 'H5')?.level, 'block');
  // control: the same gas sender, another destination
  assert.equal(line({ ...g, destination: EOA }, 'H5')?.level, 'ok');
});

test('OP-stack deposits: gas or a payment from the L2 alias of a linked wallet counts as that wallet', () => {
  const alias = (a: string) => `0x${((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0')}` as Hex;
  assert.equal(l1Of(alias(KEY)), KEY.toLowerCase());
  assert.equal(line({ isToken: true, tokenAddress: TOKEN, gasFrom: [alias(KEY)] }, 'H5')?.level, 'block');
  // H2: a payment that came in a deposit from the payer's L1 contract: withdrawing to that contract is a round trip
  assert.equal(line({ payers: [alias(REG)], destination: REG }, 'H2')?.level, 'block');
  // control: an unrelated gas sender passes
  assert.equal(line({ isToken: true, tokenAddress: TOKEN, gasFrom: [STRANGER] }, 'H5')?.level, 'ok');
});

const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const hx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;
function reader(logs: FundLog[]): FundingReader {
  const low = (x: string) => x.toLowerCase();
  return {
    head: async () => 1_000n,
    balance: async () => 1000n,
    nonce: async () => 0,
    getLogs: async ({ topics }) =>
      logs.filter((l) => topics.every((want, i) => want === null || want === undefined || (Array.isArray(want) ? want.map(low).includes(low(l.topics?.[i] ?? '')) : low(want) === low(l.topics?.[i] ?? '')))),
    tx: async (hash) => (hash === hx(1) ? { from: PAYER, to: S, value: 1000n, blockNumber: 100n } : { from: STRANGER, to: TOKEN, value: 0n, blockNumber: 500n }),
    succeeded: async () => true,
    blockTxs: async (b) => (b === 100n ? [{ hash: hx(1), from: PAYER, to: S, value: 1000n }] : []),
    tokenBalance: async () => 0n,
  } as FundingReader;
}

test('funding: a Transfer of zero and an ERC-1155 move of zero make no payer and no arrival', async () => {
  const logs: FundLog[] = [
    { address: TOKEN, topics: [TRANSFER, pad(STRANGER), pad(S)], data: `0x${word(0n)}`, blockNumber: 500n, transactionHash: hx(2), logIndex: 0 },
    { address: TOKEN, topics: [TRANSFER_SINGLE_TOPIC, pad(STRANGER), pad(STRANGER), pad(S)], data: `0x${word(7n)}${word(0n)}`, blockNumber: 600n, transactionHash: hx(3), logIndex: 0 },
  ];
  const f = (await readFunding(reader(logs), [{ address: S, announcements: [{ txHash: hx(1), caller: PAYER, blockNumber: 100n }] }], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.equal(f.payers.includes(STRANGER.toLowerCase() as Hex), false);
  assert.equal(f.tokens.length, 0);
  // control: an ERC-1155 move of 1 makes its sender a payer
  const one: FundLog[] = [{ ...logs[1]!, data: `0x${word(7n)}${word(1n)}` }];
  const g = (await readFunding(reader(one), [{ address: S, announcements: [{ txHash: hx(1), caller: PAYER, blockNumber: 100n }] }], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.equal(g.payers.includes(STRANGER.toLowerCase() as Hex), true);
});

// Bug bounty 8 Nov: getCode with no answer is unread (counts as code); the code a destination had when the ETH arrived
// counts too (a cleared EIP-7702 forwarder); H1 compares registrants de-aliased; a zero token address cannot be checked.
function explorerAt(to: Hex, block: number) {
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S}/transactions`))
      return json({ items: [{ hash: `0x${'c4'.repeat(32)}`, from: { hash: S }, to: { hash: to }, value: '1000000000000000000', raw_input: '0x', block_number: block }], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
const nodeAt = (code: (a: string, b?: bigint) => string | null): TokenLogCheck => ({
  node: { blockNumber: async () => 1000n, getLogs: async () => [], getCode: async (a, b) => code(a.toLowerCase(), b) },
  fromBlock: 0n,
});

test('H3: getCode answering null is unread, so the history is incomplete', async () => {
  explorerAt(EOA, 500);
  const r = await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, nodeAt((a) => (a === EOA ? null : '0x')));
  assert.equal(r.ok, false);
});

test('H3: a destination that had code when the ETH arrived and cleared it later: history incomplete', async () => {
  explorerAt(EOA, 500);
  const cleared = nodeAt((a, b) => (a === EOA && b === 500n ? '0xef0100' + 'ab'.repeat(20) : '0x'));
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, cleared)).ok, false);
  // control: no code then and now: complete; an old block the node cannot answer falls back to the code now
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, nodeAt(() => '0x'))).ok, true);
  const pruned = nodeAt((a, b) => (b !== undefined && a === EOA ? (() => { throw new Error('missing trie node'); })() : '0x'));
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, pruned)).ok, true);
});

test('H1: a registrant recorded under its OP deposit alias blocks its L1 address; a zero token address blocks', () => {
  const alias = (a: string) => `0x${((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0')}` as Hex;
  assert.equal(line({ destination: REG, registrants: [alias(REG)] }, 'H1')?.level, 'block');
  assert.equal(line({ isToken: true, gasFrom: [], tokenAddress: '0x0000000000000000000000000000000000000000' as Hex }, 'token')?.level, 'block');
});

test('H2: a spent address (nonce 1) whose explorer lists only an older payer is not fully known (bug bounty 8 Nov)', async () => {
  const P1 = '0x1212121212121212121212121212121212121212' as Hex;
  const r: FundingReader = {
    ...reader([]),
    balance: async () => 3n * 10n ** 18n,
    nonce: async () => 1,
    tx: async (hash) => (hash === hx(1) ? { from: P1, to: S, value: 10n * 10n ** 18n, blockNumber: 100n } : null),
    explorer: async () => [{ tx: hx(1), from: P1, value: 10n * 10n ** 18n, internal: false }],
  } as FundingReader;
  const f = (await readFunding(r, [{ address: S, announcements: [{ txHash: hx(1), caller: P1, blockNumber: 100n }] }], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.equal(f.payersKnown, false);
  assert.equal(f.gap, 'spent');
});
