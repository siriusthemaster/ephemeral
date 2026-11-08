// The withdrawal checks behind H1 to H5 and the timing advice. Pure: easy to test.
// The payers and the asset are read from the chain (funding.ts), never from announcement metadata alone.
import { isAddress, type Hex } from 'viem';

export type Level = 'block' | 'warn' | 'ok' | 'info';
export type Check = { id: string; level: Level; text: string };

export type GuardInput = {
  destination: string;
  stealthAddress: Hex;
  walletAddress: Hex | undefined; // required: the wallet that signed the keys (and maybe registered them). Unknown = undefined, and H1 blocks
  /**
   * Required: who funded the payment, read from the chain (the sender of a transaction that sent ETH to the stealth
   * address, or of a Transfer log to it). Not the announcement caller alone: a relayer or anyone else can announce.
   * Unknown = undefined, and H2 blocks. Pass undefined while any funding sender cannot be read (funding.ts payersKnown).
   */
  payer: Hex | undefined;
  /**
   * Every other payer read from the chain: further funding senders, the sender of each Transfer log to the address and
   * of the transaction that carried it, and the caller and sender of every announcement for it. H2 treats them all
   * like `payer`.
   */
  payers?: Hex[];
  ownStealthAddresses: Hex[]; // every stealth address of ours we know about
  usedDestinations: Hex[]; // destinations that other payments of yours were withdrawn to (rebuilt from chain history, plus this session)
  historyComplete: boolean; // true only once past withdrawals fully loaded; false while loading or unreadable. Missing = incomplete
  receivedAt?: number; // ms: the time of the block the funds arrived in (funding.ts arrivalBlock), not the announcement's
  /** True when the arrival block was found but its time could not be read: the timing check warns (bug bounty 8 Nov). */
  receivedAtUnknown?: boolean;
  isToken: boolean;
  /**
   * True when what the stealth address received could not be fully read from the chain (announcement metadata is often
   * too short to name the asset, and is never trusted for it). It may hold a token, so H5 never passes silently: without
   * ETH for gas it blocks like a token payment, with ETH it warns.
   */
  assetUnknown?: boolean;
  hasGas: boolean;
  /**
   * For a token payment, or one whose asset is unknown: who sent the ETH on the stealth address that pays the gas, read
   * from the chain (funding.ts gasSenders: every ETH sender and the sender of its transaction, except ETH that came in
   * the same transaction as the token). Holding ETH is not enough (bug bounty, 31 Oct): when it came from the key
   * wallet, another of your stealth addresses or a destination your payments went to, H5 blocks; from the payer of
   * another payment of yours it warns. Missing or null = not read, and H5 warns.
   */
  gasFrom?: Hex[] | null;
  /** Every payer of your other payments (their funding payers). Gas from one of them ties the two payments. */
  otherPayers?: Hex[];
  /** For a token withdrawal: the token contract (required). Sending the token to its own contract is blocked like a
   *  burn; a token withdrawal without it is blocked too (cannot check). */
  tokenAddress?: Hex;
  /** Wallets that published this meta-address in a registry (ERC-6538): like the key wallet, never a destination
   *  (bug bounty 3 Nov: the scanner counts a withdrawal to any registrant as H1, the guard did not see them). */
  registrants?: Hex[];
  now: number;
};

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// An input counts as known only when it is an address (any letter case). Missing, empty or malformed = unknown.
const known = (a: unknown): a is Hex => typeof a === 'string' && isAddress(a, { strict: false });

// Destinations nothing ever comes back from. Lowercase keys; a Map, so no key hits Object.prototype. Also the
// precompiles 0x…01 to 0x…11 (ecrecover to the BLS12-381 ones): no code, no owner, nothing sent there returns.
const UNSPENDABLE = new Map([
  ['0x0000000000000000000000000000000000000000', 'the zero address'],
  ['0x000000000000000000000000000000000000dead', 'the 0x…dEaD burn address'],
  ['0x55649e01b5df198d18d95b5cc5051630cfd45564', 'the ERC-5564 Announcer contract'],
  ['0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538', 'the ERC-6538 Registry contract'],
  ...Array.from({ length: 0x11 }, (_, i): [string, string] => {
    const n = (i + 1).toString(16).padStart(2, '0');
    return [`0x${'0'.repeat(38)}${n}`, `the precompile 0x…${n}`];
  }),
  // bug bounty 3 Nov: the P256VERIFY precompile (RIP-7212, live on several L2s) and the system address that EIP-4788
  // calls come from and EIP-7708 logs ETH moves under: nobody holds a key for either
  ['0x0000000000000000000000000000000000000100', 'the P256VERIFY precompile 0x…0100'],
  ['0xfffffffffffffffffffffffffffffffffffffffe', 'the system address 0xff…fe'],
]);
/** True for a destination nothing ever comes back from (the list above), in any letter case. */
export const isUnspendable = (a: unknown) => typeof a === 'string' && UNSPENDABLE.has(a.trim().toLowerCase());


// OP-stack deposits (Base, OP Mainnet): a deposit a contract starts on L1 arrives on L2 (transaction type 0x7e) from the
// L1 address plus 0x1111000000000000000000000000000000001111. Compared the plain way, gas or a payment sent that way by
// a wallet linked to you looked unrelated (bug bounty 7 Nov). `l1Of` undoes that offset; on chains without deposits the
// result is a different address that matches nothing.
const ALIAS_OFFSET = 0x1111000000000000000000000000000000001111n;
const U160 = 1n << 160n;
export const l1Of = (a: string): string => `0x${((BigInt(a) - ALIAS_OFFSET + U160) % U160).toString(16).padStart(40, '0')}`;
const withL1 = (list: readonly string[]): string[] => {
  const out = [...list];
  for (const x of list) if (/^0x[0-9a-fA-F]{40}$/.test(x)) out.push(l1Of(x));
  return out;
};
/** True when `a`, in its plain or its de-aliased form, is in `list` in either form: a destination typed as the alias of
 * a linked L1 contract, or a registrant recorded under its alias with gas from its real address (bug bounty 8 Nov). */
const linked = (list: readonly string[], a: string | undefined): boolean =>
  !!a && withL1(list).some((x) => same(x, a) || (/^0x[0-9a-fA-F]{40}$/.test(a) && same(x, l1Of(a))));

export function withdrawChecks(g: GuardInput): Check[] {
  const out: Check[] = [];
  const unspendable = typeof g.destination === 'string' ? UNSPENDABLE.get(g.destination.toLowerCase()) : undefined;
  if (unspendable) return [{ id: 'burn', level: 'block', text: `That is ${unspendable}. Funds sent there are lost for good.` }];
  // a token sent to its own contract is stuck there for good
  if (g.isToken && same(g.destination, g.tokenAddress))
    return [{ id: 'burn', level: 'block', text: 'That is the token contract itself. Tokens sent there are lost for good.' }];
  // fail closed like every other input (bug bounty 3 Nov): without the token contract the check above cannot run
  if (g.isToken && (typeof g.tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(g.tokenAddress) || /^0x0{40}$/.test(g.tokenAddress)))
    out.push({ id: 'token', level: 'block', text: 'Cannot check, token contract unknown. Withdraw stays locked until it is known.' });
  if (!isAddress(g.destination)) return [{ id: 'addr', level: 'block', text: 'Enter a valid Ethereum address.' }];
  if (same(g.destination, g.stealthAddress)) out.push({ id: 'self', level: 'block', text: 'That is the payment address itself.' });

  // H1 registrant reuse. Fail closed: while the key wallet is unknown, no destination can be checked against it.
  if (linked(known(g.walletAddress) ? [g.walletAddress] : [], g.destination))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this is the wallet that created your stealth keys. Withdrawing here links the payment to you directly.',
    });
  else if (Array.isArray(g.registrants) && linked(g.registrants.filter((r): r is Hex => typeof r === 'string'), g.destination))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this wallet published your meta-address in the registry. Withdrawing here links the payment to you directly.',
    });
  else if (!known(g.walletAddress))
    out.push({ id: 'H1', level: 'block', text: 'H1: cannot check, key wallet unknown. Withdraw stays locked until the key wallet is known.' });
  else out.push({ id: 'H1', level: 'ok', text: 'H1: not your key wallet.' });

  // H2 round trip. Every known payer blocks, like H1: the payer is never a destination (bug bounty, 26 Oct; before, a
  // known payer only warned). Every payer read from the chain counts, not only the one passed as `payer`. Fail closed:
  // while the payer is unknown, nothing can be ruled out, so every destination is blocked.
  const payers = [g.payer, ...(Array.isArray(g.payers) ? g.payers : [])];
  if (linked(payers.filter((p): p is Hex => known(p)), g.destination))
    out.push({ id: 'H2', level: 'block', text: 'H2: this address sent you the payment. Sending it back links both ends.' });
  else if (!known(g.payer))
    out.push({ id: 'H2', level: 'block', text: 'H2: cannot check, payer unknown. Withdraw stays locked until the payer is known.' });
  else out.push({ id: 'H2', level: 'ok', text: 'H2: not the payer.' });

  // H3 collector
  if (g.ownStealthAddresses.some((a) => same(a, g.destination)))
    out.push({ id: 'H3', level: 'warn', text: 'H3: this is another of your stealth addresses. Merging payments links them.' });
  else if (g.usedDestinations.some((a) => same(a, g.destination)))
    out.push({
      id: 'H3',
      level: 'warn',
      text: 'H3: you already sent another payment to this address. Collecting payments in one place links them.',
    });
  else if (g.historyComplete !== true) // fail safe: false, or left out by a caller (undefined at runtime), is incomplete
    out.push({
      id: 'H3',
      level: 'warn',
      text: 'H3: history incomplete. Past withdrawals could not be read, so this destination cannot be confirmed as unused.',
    });
  else out.push({ id: 'H3', level: 'ok', text: 'H3: a destination no other payment of yours went to.' });

  // H4 fee fingerprint
  out.push({ id: 'H4', level: 'ok', text: 'H4: fee set to the network standard, never custom.' });

  // H5 gas funding. A payment whose asset could not be read counts as a possible token payment. Holding ETH is not enough
  // for a token payment (31 Oct): where that ETH came from is checked against every wallet linked to you.
  const tokenLike = g.isToken || g.assetUnknown === true;
  const gasFrom = Array.isArray(g.gasFrom) ? (withL1(g.gasFrom.filter((x): x is Hex => typeof x === 'string')) as Hex[]) : null;
  const mine: [string | undefined, string][] = [
    [g.walletAddress, 'your key wallet'],
    ...(Array.isArray(g.registrants) ? g.registrants : []).map((r): [string, string] => [r, 'a wallet that published your meta-address']),
    // gas from the destination itself: withdrawing there sends the payment back to whoever paid its gas (bug bounty 3 Nov)
    [g.destination, 'this destination'],
    ...g.ownStealthAddresses.filter((a) => !same(a, g.stealthAddress)).map((a): [string, string] => [a, 'another of your payment addresses']),
    ...g.usedDestinations.map((a): [string, string] => [a, 'an address your payments were withdrawn to']),
  ];
  // both sides in both forms: gasFrom is de-aliased above, each linked address is de-aliased here (bug bounty 8 Nov)
  const linkedBy = gasFrom ? mine.find(([a]) => linked(gasFrom, a))?.[1] : undefined;
  // the payer of another payment of yours: ties the two payments, unless it also paid this one (then it already does)
  const sharedPayer = gasFrom
    ? (Array.isArray(g.otherPayers) ? g.otherPayers : []).some((p) => typeof p === 'string' && linked(gasFrom, p) && !linked(payers.filter((q): q is Hex => known(q)), p))
    : false;
  if (g.isToken && !g.hasGas)
    out.push({
      id: 'H5',
      level: 'block',
      text: 'H5: this payment holds a token but no ETH for gas. Do not fund it from a wallet linked to you.',
    });
  else if (g.assetUnknown === true && !g.hasGas)
    out.push({
      id: 'H5',
      level: 'block',
      text: 'H5: what this payment holds could not be read from the chain, so it may be a token with no ETH for gas. Do not fund it from a wallet linked to you.',
    });
  else if (tokenLike && linkedBy)
    out.push({
      id: 'H5',
      level: 'block',
      text: `H5: the ETH for gas on this payment came from a linked wallet (${linkedBy}). Withdrawing it would tie the payment to that wallet.`,
    });
  else if (tokenLike && sharedPayer)
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: the ETH for gas on this payment came from a linked wallet (the payer of another payment of yours), so withdrawing it may tie the two payments together.',
    });
  else if (g.isToken && !gasFrom)
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: where the ETH for gas on this payment came from could not be read from the chain, so it cannot be confirmed that it did not come from a linked wallet.',
    });
  else if (g.assetUnknown === true)
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: what this payment holds could not be fully read from the chain, so it may also hold a token. Never top it up with ETH from a wallet linked to you.',
    });
  else out.push({ id: 'H5', level: 'ok', text: 'H5: pays its own gas.' });

  // timing
  if (g.receivedAtUnknown === true)
    out.push({
      id: 'time',
      level: 'warn',
      text: 'Timing: when the funds arrived could not be read. If they came in less than an hour ago, waiting makes the payment and the withdrawal harder to pair.',
    });
  else if (g.receivedAt && g.now - g.receivedAt < 3600_000)
    out.push({
      id: 'time',
      level: 'warn',
      text: 'Timing: received less than an hour ago. Waiting makes the payment and the withdrawal harder to pair.',
    });
  return out;
}

export const blocking = (c: Check[]) => c.some((x) => x.level === 'block');
export const warnings = (c: Check[]) => c.filter((x) => x.level === 'warn');

/**
 * Past withdrawal destinations from public chain history: where your own stealth addresses sent funds. Feed the
 * result into `usedDestinations`, so H3 still knows a collector after a reload or on another device. Transfers from
 * addresses that are not yours are ignored; transfers between your own addresses are left out (H3 already flags
 * those as merges). Unique and lowercased.
 */
export function destinationsFromHistory(own: Hex[], history: { from: string; to: string }[]): Hex[] {
  const mine = new Set(own.map((a) => a.toLowerCase()));
  const out = new Set<string>();
  for (const t of history) {
    const from = typeof t?.from === 'string' ? t.from.toLowerCase() : '';
    const to = typeof t?.to === 'string' ? t.to.toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}$/.test(to) || !mine.has(from) || mine.has(to)) continue;
    out.add(to);
  }
  return [...out] as Hex[];
}
