// The withdrawal checks behind H1–H5 and the timing advice. Pure: easy to test.
import { isAddress, type Hex } from 'viem';

export type Level = 'block' | 'warn' | 'ok' | 'info';
export type Check = { id: string; level: Level; text: string };

export type GuardInput = {
  destination: string;
  stealthAddress: Hex;
  walletAddress?: Hex; // the wallet that signed the keys (and maybe registered them)
  payer?: Hex; // who sent the payment
  ownStealthAddresses: Hex[]; // every stealth address of ours we know about
  usedDestinations: Hex[]; // destinations used for other payments in this session
  receivedAt?: number; // ms
  isToken: boolean;
  hasGas: boolean;
  now: number;
};

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function withdrawChecks(g: GuardInput): Check[] {
  const out: Check[] = [];
  if (!isAddress(g.destination)) return [{ id: 'addr', level: 'block', text: 'Enter a valid Ethereum address.' }];
  if (same(g.destination, g.stealthAddress)) out.push({ id: 'self', level: 'block', text: 'That is the payment address itself.' });

  // H1 registrant reuse
  if (same(g.destination, g.walletAddress))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this is the wallet that created your stealth keys. Withdrawing here links the payment to you directly.',
    });
  else out.push({ id: 'H1', level: 'ok', text: 'H1: not your key wallet.' });

  // H2 round trip
  if (same(g.destination, g.payer))
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
  else out.push({ id: 'H3', level: 'ok', text: 'H3: a destination no other payment of yours went to.' });

  // H4 fee fingerprint
  out.push({ id: 'H4', level: 'ok', text: 'H4: fee set to the network standard, never custom.' });

  // H5 gas funding
  if (g.isToken && !g.hasGas)
    out.push({
      id: 'H5',
      level: 'block',
      text: 'H5: this payment holds a token but no ETH for gas. Do not fund it from a wallet linked to you.',
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
