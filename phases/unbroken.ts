// Reference accounting for the Unbroken and First Light boosts, Season 1 (v3.2, 9 Oct 2026).
// Both are about tokens, not wallets: each token carries the day it was bought, and whether it was bought in the
// first hour (First Light).
// - A buy adds tokens dated today.
// - A sell removes tokens pro rata across their ages (no wallet-wide reset).
// - A transfer moves tokens pro rata across their ages; they keep their dates in the new wallet.
// - The boost on a token ramps from 0 to +1.00 over its first 7 days held.
// - First Light: tokens bought in the launch hour carry +0.50, under the same pro-rata rules.
// - v3.1: shared contracts (NFT vaults, staking, lending, exchange wallets, any pool) are treated like the pool:
//   tokens going in leave the ledger like a sale, tokens coming out are new, dated that day, without First Light.
//   Ages cannot be pooled in a contract and handed to someone else.
// - v3.2: signer control is not ownership (a Safe can hold customer deposits). EOAs and EIP-7702 accounts are
//   wallets. Any other contract, Safe and ERC-4337 accounts included, is shared unless every owner signed an
//   attestation that the account holds only their own tokens, bound to the owner set and threshold at signing: any
//   owner or threshold change voids it (attestationValid, classify, reclassify). An attestation cannot prove
//   beneficial ownership, and an EOA custodian is invisible: see PHASES.md, "Known limits".
// Every step is linear in the amounts, so splitting a wallet (before a sale or at any time) changes nothing.
// Amounts are integers (token wei). Pure functions: the indexer applies the same steps to every $EPH transfer.
import { createHash } from 'node:crypto';

export const RAMP_DAYS = 7;

/** Bucket key = acquisition day × 2 + (1 if bought in the launch hour). */
export type Wallet = Map<number, bigint>;
const dayOf = (k: number) => Math.floor(k / 2);
const isFirstLight = (k: number) => k % 2 === 1;
export type Ledger = Map<string, Wallet>;

const key = (w: string) => w.toLowerCase();
const wallet = (l: Ledger, w: string): Wallet => {
  let x = l.get(key(w));
  if (!x) l.set(key(w), (x = new Map()));
  return x;
};
export const balanceOf = (l: Ledger, w: string) => [...(l.get(key(w)) ?? new Map()).values()].reduce((s, a) => s + a, 0n);

/** Takes `amount` out of a wallet pro rata across its days (rounding down), the rounding rest from the youngest days. */
function take(src: Wallet, amount: bigint): Wallet {
  const bal = [...src.values()].reduce((s, a) => s + a, 0n);
  if (amount > bal) throw new Error('amount exceeds balance');
  const out: Wallet = new Map();
  if (amount === 0n) return out;
  let moved = 0n;
  for (const [d, a] of src) {
    const m = (a * amount) / bal;
    if (m > 0n) {
      out.set(d, m);
      moved += m;
    }
  }
  let rest = amount - moved;
  const youngestFirst = [...src.keys()].sort((x, y) => dayOf(y) - dayOf(x) || (isFirstLight(x) ? 1 : 0) - (isFirstLight(y) ? 1 : 0));
  for (const d of youngestFirst) {
    if (rest === 0n) break;
    const left = src.get(d)! - (out.get(d) ?? 0n);
    const m = left < rest ? left : rest;
    if (m > 0n) {
      out.set(d, (out.get(d) ?? 0n) + m);
      rest -= m;
    }
  }
  for (const [d, m] of out) {
    const left = src.get(d)! - m;
    if (left === 0n) src.delete(d);
    else src.set(d, left);
  }
  return out;
}

export function buy(l: Ledger, w: string, amount: bigint, day: number, firstLight = false): void {
  const x = wallet(l, w);
  const k = day * 2 + (firstLight ? 1 : 0);
  x.set(k, (x.get(k) ?? 0n) + amount);
}

export function sell(l: Ledger, w: string, amount: bigint): void {
  take(wallet(l, w), amount);
}

export function transfer(l: Ledger, from: string, to: string, amount: bigint): void {
  if (key(from) === key(to)) return;
  const moved = take(wallet(l, from), amount);
  const dst = wallet(l, to);
  for (const [d, m] of moved) dst.set(d, (dst.get(d) ?? 0n) + m);
}

/**
 * Unbroken weight on `today`, exact and in "token-days, capped at 7": each day's tokens × min(age in days, 7).
 * Linear in the amounts, so moving tokens never creates or destroys weight (no rounding at all).
 */
export function weight7(l: Ledger, w: string, today: number): bigint {
  let s = 0n;
  for (const [k, a] of l.get(key(w)) ?? new Map<number, bigint>()) s += a * BigInt(Math.min(RAMP_DAYS, Math.max(0, today - dayOf(k))));
  return s;
}

/** Tokens the wallet holds that were bought in the launch hour (they carry First Light, +0.50). */
export function firstLightTokens(l: Ledger, w: string): bigint {
  let s = 0n;
  for (const [k, a] of l.get(key(w)) ?? new Map<number, bigint>()) if (isFirstLight(k)) s += a;
  return s;
}

/** Tokens counted as Unbroken on `today` (token wei): weight7 / 7. */
export const seasoned = (l: Ledger, w: string, today: number) => weight7(l, w, today) / BigInt(RAMP_DAYS);

/** The wallet's Unbroken boost on `today`: +1.00 × seasoned / balance (0 to 1.00). */
export function unbrokenBoost(l: Ledger, w: string, today: number): number {
  const bal = balanceOf(l, w);
  return bal === 0n ? 0 : Number((weight7(l, w, today) * 10_000n) / (bal * BigInt(RAMP_DAYS))) / 10_000;
}

export const totalFirstLight = (l: Ledger) => [...l.keys()].reduce((s, w) => s + firstLightTokens(l, w), 0n);
export const totalWeight7 = (l: Ledger, today: number) => [...l.keys()].reduce((s, w) => s + weight7(l, w, today), 0n);
export const totalSeasoned = (l: Ledger, today: number) => totalWeight7(l, today) / BigInt(RAMP_DAYS);
export const totalBalance = (l: Ledger) => [...l.keys()].reduce((s, w) => s + balanceOf(l, w), 0n);

/** How the indexer classes an address (v3.1). */
export type Kind = 'wallet' | 'shared';

/**
 * One $EPH transfer, as the indexer applies it (v3.1).
 * wallet -> wallet: tokens keep their ages (pro rata). wallet -> shared: like a sale. shared -> wallet: like a buy
 * dated `day`; `firstLight` is set only for buys from the official pool in the launch hour. shared -> shared: nothing.
 */
export function move(l: Ledger, from: string, to: string, amount: bigint, day: number, kindOf: (a: string) => Kind, firstLight = false): void {
  const f = kindOf(from);
  const t = kindOf(to);
  if (f === 'wallet' && t === 'wallet') return transfer(l, from, to, amount);
  if (f === 'wallet') sell(l, from, amount);
  if (t === 'wallet') buy(l, to, amount, day, firstLight);
}

/** The owner set and threshold of a multi-owner account, canonical (owners sorted, lowercased). */
export function ownersHash(owners: string[], threshold: number): string {
  const set = [...new Set(owners.map(key))].sort();
  if (set.length !== owners.length) throw new Error('owner listed twice');
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > set.length) throw new Error('bad threshold');
  return createHash('sha256').update(`${threshold}|${set.join(',')}`).digest('hex');
}

/**
 * v3.2: "every owner of this account holds it only for themselves, this season", signed by every owner. It is bound to
 * the exact owner set and threshold at signing time (ownersHash), and the indexer records when it was signed.
 */
export type Attestation = { owners: string[]; threshold: number; ownersHash: string; signedBy: string[]; signedAt: number };

/** What the indexer knows about an address (v3.2). */
export type AddressInfo = {
  hasCode: boolean; // any code at the address
  is7702: boolean; // an EOA whose code is an EIP-7702 delegation (0xef0100 prefix): still one key
  ownersHash?: string; // multi-owner accounts: the CURRENT owner set + threshold (Safe getOwners() / getThreshold())
  ownersChangedAt?: number; // when the owner set or threshold last changed (AddedOwner / RemovedOwner / ChangedThreshold)
  attestation?: Attestation; // the latest attestation submitted for the account, if any
};

/**
 * v3.2: an attestation counts only while the account still has exactly the owner set and threshold it was signed under:
 * signed by every owner of that set, that set is the current one, and it has not changed since the signing (so
 * A -> A+custodian -> A does not revive it). Any owner or threshold change voids it from that moment; a new attestation
 * by the new owner set is needed. It proves who controls the account, not who owns the tokens in it: a custodian can
 * sign it falsely, and nothing on chain can tell (see PHASES.md and the false-attestation property test).
 */
export function attestationValid(i: AddressInfo): boolean {
  const a = i.attestation;
  if (!a || i.ownersHash === undefined) return false;
  let hash: string;
  try {
    hash = ownersHash(a.owners, a.threshold);
  } catch {
    return false;
  }
  if (hash !== a.ownersHash || a.ownersHash !== i.ownersHash) return false;
  if (i.ownersChangedAt !== undefined && i.ownersChangedAt > a.signedAt) return false;
  const signed = new Set(a.signedBy.map(key));
  return a.owners.every((o) => signed.has(key(o)));
}

/** v3.2 classification: EOA and 7702 = wallet; any other contract = shared unless it has a valid attestation. */
export function classify(i: AddressInfo): Kind {
  if (!i.hasCode || i.is7702) return 'wallet';
  return attestationValid(i) ? 'wallet' : 'shared';
}

/**
 * When an address changes class (an owner change voids its attestation, or a new attestation is accepted), the tokens
 * it holds are treated as if they moved at that moment. wallet -> shared: like a deposit into a shared contract, they
 * leave the ledger (their ages and First Light end). shared -> wallet: like tokens coming out of one, they are dated
 * `day`, without First Light; `onchainBalance` is the address's $EPH balance then.
 */
export function reclassify(l: Ledger, a: string, before: Kind, after: Kind, onchainBalance: bigint, day: number): void {
  if (before === after) return;
  if (after === 'shared') sell(l, a, balanceOf(l, a));
  else if (onchainBalance > 0n) buy(l, a, onchainBalance, day);
}
