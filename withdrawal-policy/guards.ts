// The withdrawal checks behind H1–H5 and the timing advice. Pure: easy to test.
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
  receivedAt?: number; // ms
  isToken: boolean;
  /**
   * True when what the stealth address received could not be fully read from the chain (announcement metadata is often
   * too short to name the asset, and is never trusted for it). It may hold a token, so H5 never passes silently: without
   * ETH for gas it blocks like a token payment, with ETH it warns.
   */
  assetUnknown?: boolean;
  hasGas: boolean;
  now: number;
};

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
// An input counts as known only when it is an address (any letter case). Missing, empty or malformed = unknown.
const known = (a: unknown): a is Hex => typeof a === 'string' && isAddress(a, { strict: false });

// Destinations nothing ever comes back from. Lowercase keys; a Map, so no key hits Object.prototype.
const UNSPENDABLE = new Map([
  ['0x0000000000000000000000000000000000000000', 'the zero address'],
  ['0x000000000000000000000000000000000000dead', 'the 0x…dEaD burn address'],
  ['0x55649e01b5df198d18d95b5cc5051630cfd45564', 'the ERC-5564 Announcer contract'],
  ['0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538', 'the ERC-6538 Registry contract'],
]);

export function withdrawChecks(g: GuardInput): Check[] {
  const out: Check[] = [];
  const unspendable = typeof g.destination === 'string' ? UNSPENDABLE.get(g.destination.toLowerCase()) : undefined;
  if (unspendable) return [{ id: 'burn', level: 'block', text: `That is ${unspendable}. Funds sent there are lost for good.` }];
  if (!isAddress(g.destination)) return [{ id: 'addr', level: 'block', text: 'Enter a valid Ethereum address.' }];
  if (same(g.destination, g.stealthAddress)) out.push({ id: 'self', level: 'block', text: 'That is the payment address itself.' });

  // H1 registrant reuse. Fail closed: while the key wallet is unknown, no destination can be checked against it.
  if (same(g.destination, g.walletAddress))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this is the wallet that created your stealth keys. Withdrawing here links the payment to you directly.',
    });
  else if (!known(g.walletAddress))
    out.push({ id: 'H1', level: 'block', text: 'H1: cannot check, key wallet unknown. Withdraw stays locked until the key wallet is known.' });
  else out.push({ id: 'H1', level: 'ok', text: 'H1: not your key wallet.' });

  // H2 round trip. Fail closed: while the payer is unknown, nothing can be ruled out. A known payer warns, as before.
  // Every payer read from the chain counts, not only the one passed as `payer`.
  const payers = [g.payer, ...(Array.isArray(g.payers) ? g.payers : [])];
  if (!known(g.payer))
    out.push({ id: 'H2', level: 'block', text: 'H2: cannot check, payer unknown. Withdraw stays locked until the payer is known.' });
  else if (payers.some((p) => same(g.destination, p)))
    out.push({ id: 'H2', level: 'warn', text: 'H2: this address sent you the payment. Sending it back links both ends.' });
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

  // H5 gas funding. A payment whose asset could not be read counts as a possible token payment.
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
  else if (g.assetUnknown === true)
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: what this payment holds could not be fully read from the chain, so it may also hold a token. Never top it up with ETH from a wallet linked to you.',
    });
  else out.push({ id: 'H5', level: 'ok', text: 'H5: pays its own gas.' });

  // timing
  if (g.receivedAt && g.now - g.receivedAt < 3600_000)
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
