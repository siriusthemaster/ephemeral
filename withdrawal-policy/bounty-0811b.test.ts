// Bug bounty, 8 Nov, afternoon round. Mocked, no network.
// - History: viem answers undefined for an address without code; that is no code, not unread (accpoww).
// - Guards: a destination typed in the alias form of a linked L1 contract is linked (Makino); a registrant recorded
//   under its alias with gas from its real address blocks H5, and a shared payer recorded that way warns (Rusdi).
// - Timing: an arrival time that could not be read warns (Akbar).
// - Funding: a token that reached the address more than 7,200 blocks before its first announcement is read too
//   (Swaplane EPH-01, Akbar), as in the client since 0.2.11.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { loadWithdrawalHistory, type TokenLogCheck } from './history.ts';
import { withdrawChecks, type GuardInput } from './guards.ts';
import { readFunding, type FundingReader, type FundLog } from './funding.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const EOA = '0xeeee00000000000000000000000000000000000e' as Hex;
const FWD = '0xf0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0' as Hex;
const KEY = '0x9999000000000000000000000000000000000099' as Hex;
const PAYER = '0x8888000000000000000000000000000000000088' as Hex;
const EARLY = '0x5555000000000000000000000000000000000055' as Hex; // paid a token long before announcing
const REG = '0x7777000000000000000000000000000000000077' as Hex;
const TOKEN = '0x6666666666666666666666666666666666666666' as Hex;
const alias = (a: string) => `0x${((BigInt(a) + 0x1111000000000000000000000000000000001111n) % (1n << 160n)).toString(16).padStart(40, '0')}` as Hex;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function explorer(to: Hex | null) {
  globalThis.fetch = (async (u: string) => {
    const p = new URL(u).pathname.toLowerCase();
    if (p.endsWith(`/addresses/${S}/transactions`))
      return json({ items: to ? [{ hash: `0x${'c3'.repeat(32)}`, from: { hash: S }, to: { hash: to }, value: '1', raw_input: '0x', block_number: 100 }] : [], next_page_params: null });
    return json({ items: [], next_page_params: null });
  }) as typeof fetch;
}
/** A node behind viem: getCode answers undefined for no code, as viem's getCode action does. */
const viemNode: TokenLogCheck = {
  node: { blockNumber: async () => 1000n, getLogs: async () => [], getCode: async (a) => (a.toLowerCase() === FWD ? '0x6080' : undefined) },
  fromBlock: 0n,
};

test('accpoww 8 Nov: undefined from getCode is no code, so a plain send and a plain payment address are complete', async () => {
  explorer(EOA);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, viemNode)).ok, true);
  explorer(null);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 0 }, viemNode)).ok, true);
  // controls: a forwarder, and a getCode that fails, stay incomplete
  explorer(FWD);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, viemNode)).ok, false);
  const down: TokenLogCheck = { node: { ...viemNode.node, getCode: async () => null }, fromBlock: 0n };
  explorer(EOA);
  assert.equal((await loadWithdrawalHistory({ blockscout: 'https://x/api/v2' }, [S], undefined, { [S]: 1 }, down)).ok, false);
});

const base: GuardInput = {
  destination: '0x4444000000000000000000000000000000000044',
  stealthAddress: S,
  walletAddress: KEY,
  registrants: [REG],
  payer: PAYER,
  ownStealthAddresses: [S],
  usedDestinations: [],
  historyComplete: true,
  receivedAt: Date.now() - 3 * 3600_000,
  isToken: false,
  hasGas: true,
  now: Date.now(),
};
const line = (g: Partial<GuardInput>, id: string) => withdrawChecks({ ...base, ...g }).find((c) => c.id === id);
const tok = { isToken: true, tokenAddress: TOKEN };

test('Makino 8 Nov: a destination typed as the alias of a linked L1 contract is linked (H1, H2, H5)', () => {
  assert.equal(line({ destination: alias(REG) }, 'H1')?.level, 'block');
  assert.equal(line({ destination: alias(PAYER) }, 'H2')?.level, 'block');
  const gas = '0x2b2b00000000000000000000000000000000002b' as Hex;
  assert.equal(line({ ...tok, destination: alias(gas), gasFrom: [gas] }, 'H5')?.level, 'block');
  assert.equal(line({ ...tok, gasFrom: [gas] }, 'H5')?.level, 'ok', 'control');
});

test('Rusdi 8 Nov R2: gas from the real address of a registrant recorded under its alias blocks; a shared payer warns', () => {
  assert.equal(line({ ...tok, registrants: [alias(REG)], gasFrom: [REG] }, 'H5')?.level, 'block');
  const P2 = '0x4545454545454545454545454545454545454545' as Hex;
  assert.equal(line({ ...tok, otherPayers: [alias(P2)], gasFrom: [P2] }, 'H5')?.level, 'warn');
});

test('Akbar 8 Nov: an arrival time that could not be read warns on timing', () => {
  assert.equal(line({ receivedAtUnknown: true }, 'time')?.level, 'warn');
  assert.equal(line({}, 'time'), undefined, 'control');
});

const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const hx = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex;

test('Swaplane EPH-01 and Akbar 8 Nov: a token sent long before the first announcement is read, with its payer', async () => {
  const early: FundLog = { address: TOKEN, topics: [TRANSFER, pad(EARLY), pad(S)], data: `0x${(5n).toString(16).padStart(64, '0')}`, blockNumber: 1_000n, transactionHash: hx(2), logIndex: 0 };
  const asked: [bigint, bigint][] = [];
  const reader = {
    head: async () => 30_000n,
    balance: async () => 0n,
    nonce: async () => 0,
    getLogs: async ({ fromBlock, toBlock, topics }: { fromBlock: bigint; toBlock: bigint; topics: (Hex | Hex[] | null)[] }) => {
      asked.push([fromBlock, toBlock]);
      return [early].filter((l) => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock && topics[0] === TRANSFER);
    },
    tx: async (h: Hex) => (h === hx(2) ? { from: EARLY, to: TOKEN, value: 0n, blockNumber: 1_000n } : { from: PAYER, to: S, value: 0n, blockNumber: 20_000n }),
    succeeded: async () => true,
    blockTxs: async () => [],
    tokenBalance: async () => 5n,
  } as unknown as FundingReader;
  const f = (await readFunding(reader, [{ address: S, announcements: [{ txHash: hx(1), caller: PAYER, blockNumber: 20_000n }] }], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.ok(f.payers.map((p) => p.toLowerCase()).includes(EARLY.toLowerCase()), 'the early token s payer is known');
  assert.ok(asked.some(([from]) => from === 0n), 'the blocks before the window were asked');
});
