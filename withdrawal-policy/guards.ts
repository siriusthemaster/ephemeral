// The ephemeral client's src/lib/guards.ts as of client 0.2.19-beta (ephemeral-client commit 2d12269), with two
// additions made here first, each marked "this module": the EIP-4788 and EIP-2935 system contracts are unspendable
// (bug bounty, 22 Nov), and a token withdrawal without its token contract blocks (bug bounty, 3 Nov). Everything else
// is the client's code as it ships (bug bounty, 24 Nov: this copy had fallen behind the client).
//
// Withdrawal policy engine: the checks behind H1 to H5 and the timing advice. Pure (no network): easy to test.
// Closed by default: the key wallet (H1, also the registrant) and the payer (H2) are blocked as destinations, and when
// either one is not known yet the withdrawal stays blocked until it is. Since 0.2.9 the payers and the asset come from
// the chain (src/lib/funding.ts), never from announcement metadata alone. Since 0.2.10 a known payer always blocks
// (no setting, like H1), and H5 checks where the ETH for a token payment's gas came from.
import { isAddress, type Hex } from 'viem';

export type Level = 'block' | 'warn' | 'ok' | 'info';
export type Check = { id: string; level: Level; text: string };

/**
 * What a rule does when it fires. H1 (key wallet or registrant) has no setting: it always blocks. Since 0.2.10 H2 has
 * none either: a known payer as the destination always blocks, as the docs say ("the payer is never a destination").
 * The type stays so older callers still compile; `H2: 'warn'` is ignored.
 */
export type Policy = { H2: 'block' | 'warn' };
export const DEFAULT_POLICY: Policy = Object.freeze({ H2: 'block' }) as Policy;

/** The policy in plain words, for the UI. One source of truth with the checks below. */
export const POLICY: { id: string; level: 'block' | 'warn' | 'fixed'; title: string; text: string }[] = [
  { id: 'H1', level: 'block', title: 'Your key wallet', text: 'The wallet that signs your keys (and registers them) is never a destination.' },
  {
    id: 'H2',
    level: 'block',
    title: 'The payer',
    text: 'The address that paid you is never a destination, read from the payment on chain and not only from the announcement. Withdraw stays locked until the payer is known.',
  },
  { id: 'H3', level: 'warn', title: 'Collecting', text: 'Another of your payment addresses, or a destination you already used, needs your confirmation.' },
  { id: 'H4', level: 'fixed', title: 'Fee', text: 'Always the network standard fee, never a custom one that fingerprints you.' },
  {
    id: 'H5',
    level: 'block',
    title: 'Gas',
    text: 'A token payment with no ETH for gas is not topped up from a wallet linked to you, and one whose ETH for gas came from a wallet linked to you is not withdrawn. A payment whose asset cannot be read from the chain counts as a token payment.',
  },
  { id: 'time', level: 'warn', title: 'Timing', text: 'Received less than an hour ago: waiting makes the payment and the withdrawal harder to pair.' },
];

export type GuardInput = {
  destination: string;
  stealthAddress: Hex;
  /**
   * The wallet that signed the keys. Required: pass `undefined` while it is not known (no wallet connected). Then H1
   * cannot be checked and the withdrawal is blocked.
   */
  walletAddress: Hex | undefined;
  /**
   * Other wallets known to have published this meta-address in the ERC-6538 registry. `null` = the registry could not be
   * read (0.2.18): then H1 cannot rule out a registrant and blocks, and H5 blocks gas from an unchecked sender.
   */
  registrants?: Hex[] | null;
  /** The wallets connected in this tab (0.2.18). Withdrawing to one of them links the payment to you directly. */
  wallets?: Hex[];
  /**
   * Per address, lowercase key (0.2.18): true when the address has a stealth meta-address in the ERC-6538 registry,
   * false when the registry was read and it has none, missing when not read. Read for the destination and the gas senders.
   */
  registered?: Record<string, boolean | null | undefined>;
  /** Who sent the payment. Kept for older callers; merged into `payers`. */
  payer?: Hex;
  /**
   * Every address known to have paid, read from the chain (0.2.9): the sender of each transaction that sent ETH to the
   * payment address, the sender of each Transfer log to it and of the transaction that carried it, plus the caller and
   * the sender of every announcement for it. The announcement alone is not enough: a relayer or anyone else can call
   * the Announcer, so its caller need not be the address that funded the payment.
   */
  payers?: Hex[];
  /**
   * Required. True only once every payer has been read from the chain (every source of what the address received
   * found, and its sender read). False (or missing at runtime) = unknown, and H2 blocks (fail safe). True with no valid
   * address in `payer` or `payers` also counts as unknown and blocks.
   */
  payerKnown: boolean;
  /** True when ETH or a token came through a contract whose own funder cannot be read (0.2.12, N02; tokens 0.2.19): H2 blocks (0.2.19). */
  payerViaContract?: boolean;
  ownStealthAddresses: Hex[]; // every stealth address of ours we know about
  /**
   * True when `ownStealthAddresses` may miss older payments of yours: the scan looked back only a limited number of
   * days. H3 then cannot rule out that the destination is one of them, and warns "history incomplete".
   */
  ownPartial?: boolean;
  usedDestinations: Hex[]; // destinations other payments of yours were withdrawn to (rebuilt from chain history, plus this session)
  historyComplete: boolean; // true only once past withdrawals fully loaded; false while loading or unreadable. Missing = incomplete
  receivedAt?: number; // ms
  /** True when the arrival block was found but its time could not be read: the timing check warns (bug bounty 8 Nov). */
  receivedAtUnknown?: boolean;
  isToken: boolean;
  /**
   * True when what the payment address received could not be fully read from the chain (0.2.9): announcement metadata
   * is often too short to name the asset, and it is never trusted for it. Such a payment may hold a token, so H5 never
   * passes it silently: without ETH for gas it blocks like a token payment, with ETH it warns.
   * Since 0.2.12 the reason from paymentView ('unread', 'unseen', 'nft') counts as unknown too, not only `true`.
   */
  assetUnknown?: boolean | string | null;
  /**
   * For a token withdrawal (isToken): what the wallet confirmed about the token. `hasCode`: contract code at the token
   * address. `standardTransfer`: the token's move to this payment address left a standard ERC-20 Transfer log.
   * Not true = not confirmed (fail safe): missing or unconfirmed code blocks; no standard log warns and H3 is never ok.
   */
  token?: { hasCode?: boolean | null; standardTransfer?: boolean | null };
  hasGas: boolean;
  /**
   * For a token payment, or one whose asset is unknown: who sent the ETH on the payment address that pays the gas, read
   * from the chain (0.2.10, funding.ts gasSenders: every ETH sender and the sender of its transaction, except ETH that
   * came in the same transaction as the token). Holding ETH is not enough: when it came from the key wallet, a
   * registrant, another of your payment addresses or a destination your payments went to, H5 blocks; from the payer of
   * another payment of yours it warns. Missing or null = not read, and H5 warns.
   */
  gasFrom?: Hex[] | null;
  /** Every payer of your other payments (their funding payers). Gas from one of them links the two payments (0.2.10). */
  otherPayers?: Hex[];
  /** For a token withdrawal: the token contract. Sending the token to its own contract is blocked like a burn (0.2.10).
   *  This module: required for a token withdrawal, which blocks without it (cannot check). */
  tokenAddress?: Hex;
  now: number;
};

export const NON_STANDARD_TOKEN = 'Unknown or non-standard token: withdrawing it may link payments.';

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// Destinations nothing ever comes back from. Lowercase keys; a Map, so no key hits Object.prototype. Since 0.2.10 also
// the precompiles 0x…01 to 0x…11 (ecrecover to the BLS12-381 ones): no code, no owner, nothing sent there returns.
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
  // this module (bug bounty 22 Nov): the EIP-4788 beacon roots and EIP-2935 history storage system contracts. ETH sent
  // there reverts where they have code and is stuck where they have none, and a token sent there is stuck for good
  ['0x000f3df6d732807ef1319fb7b8bb8522d0beac02', 'the EIP-4788 beacon roots contract'],
  ['0x0000f90827f1c53a10cb7a02335b175320002935', 'the EIP-2935 history storage contract'],
]);
/** True for a destination nothing ever comes back from (the list above), in any letter case. */
export const isUnspendable = (a: unknown) => typeof a === 'string' && UNSPENDABLE.has(a.trim().toLowerCase());

export const H5_OWN_GAS = 'H5: pays its own gas.';
export const H2_VIA_CONTRACT =
  'H2: this payment came through a contract (for example a smart wallet, a multisig or a router), and who controls or funded it cannot be read from the chain. Any destination could be the payer, so Withdraw stays locked.';
export const H1_REGISTRY_UNREAD =
  'H1: the registry could not be read, so H1 cannot be checked. Withdraw stays locked until it can be read.';
export const H5_REGISTRY_UNREAD =
  'H5: the registry could not be read for where the ETH for gas on this payment came from, so H5 cannot be checked. Withdraw stays locked until it can be read.';


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

export function withdrawChecks(g: GuardInput, policy: Policy = DEFAULT_POLICY): Check[] {
  const out: Check[] = [];
  const dest = typeof g.destination === 'string' ? g.destination.trim() : '';
  // before any other check and in any letter case (an all-caps spelling would fail the strict checksum test below)
  const unspendable = UNSPENDABLE.get(dest.toLowerCase());
  if (unspendable) return [{ id: 'burn', level: 'block', text: `That is ${unspendable}. Funds sent there are lost for good.` }];
  // a token sent to its own contract is stuck there for good (0.2.10)
  if (g.isToken && same(dest, g.tokenAddress))
    return [{ id: 'burn', level: 'block', text: 'That is the token contract itself. Tokens sent there are lost for good.' }];
  // this module (bug bounty 3 Nov): fail closed like every other input, without the token contract the check above
  // cannot run
  if (g.isToken && (typeof g.tokenAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(g.tokenAddress) || /^0x0{40}$/.test(g.tokenAddress)))
    out.push({ id: 'token', level: 'block', text: 'Cannot check, token contract unknown. Withdraw stays locked until it is known.' });
  // strict: a mixed-case address with a wrong checksum is most likely a typo, so it is refused
  if (!isAddress(dest)) return [{ id: 'addr', level: 'block', text: 'Enter a valid Ethereum address.' }];
  if (same(dest, g.stealthAddress)) out.push({ id: 'self', level: 'block', text: 'That is the payment address itself.' });

  // H1 registrant reuse: the key wallet, a connected wallet, or any wallet that published this meta-address. Always blocks.
  const registrants = Array.isArray(g.registrants) ? g.registrants.filter((r): r is Hex => typeof r === 'string') : [];
  const wallets = Array.isArray(g.wallets) ? g.wallets.filter((w): w is Hex => typeof w === 'string') : [];
  // the registry read for one address (0.2.18): true = it has a meta-address registered, false = read and none
  const registeredOne = (a: string): boolean | null | undefined =>
    g.registered && typeof g.registered === 'object' && Object.prototype.hasOwnProperty.call(g.registered, a.toLowerCase())
      ? g.registered[a.toLowerCase()]
      : undefined;
  // both forms of the address (0.2.19, bug bounty #61, #118): an OP-stack alias and its L1 address. True when either is
  // registered; false only when both were read and have none.
  const registeredOf = (a: string): boolean | null | undefined => {
    const plain = registeredOne(a);
    if (plain === true || !/^0x[0-9a-fA-F]{40}$/.test(a)) return plain;
    const twin = registeredOne(l1Of(a));
    if (twin === true) return true;
    return plain === false && twin === false ? false : plain === null || twin === null ? null : undefined;
  };
  if (linked(typeof g.walletAddress === 'string' ? [g.walletAddress] : [], dest))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this is the wallet that created your stealth keys. Withdrawing here links the payment to you directly.',
    });
  else if (linked(wallets, dest))
    out.push({ id: 'H1', level: 'block', text: 'H1: this is your connected wallet. Withdrawing here links the payment to you directly.' });
  else if (linked(registrants, dest))
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this wallet published your meta-address in the registry. Withdrawing here links the payment to you directly.',
    });
  else if (registeredOf(dest) === true)
    out.push({
      id: 'H1',
      level: 'block',
      text: 'H1: this address has a stealth meta-address registered in the ERC-6538 registry. It may be the wallet that published yours, so withdrawing here could link the payment to you.',
    });
  else if (!g.walletAddress || !isAddress(g.walletAddress, { strict: false }))
    out.push({ id: 'H1', level: 'block', text: 'H1: your key wallet is not known, so this destination cannot be checked. Reconnect your wallet.' });
  else if (g.registrants === null && registeredOf(dest) !== false) out.push({ id: 'H1', level: 'block', text: H1_REGISTRY_UNREAD });
  else out.push({ id: 'H1', level: 'ok', text: 'H1: not your key wallet.' });

  // H2 round trip: the payer. Any known payer (payer or payers) blocks, with no setting, like H1 (0.2.10; before, an
  // integrator could relax a match to a warning). While the payer is unknown nothing can be ruled out: that blocks too.
  void policy;
  const payers = [g.payer, ...(Array.isArray(g.payers) ? g.payers : [])].filter((x): x is Hex => typeof x === 'string' && !!x);
  if (linked(payers, dest))
    out.push({ id: 'H2', level: 'block', text: 'H2: this address paid you. Sending the payment back links both ends.' });
  else if (g.payerKnown !== true)
    out.push({
      id: 'H2',
      level: 'block',
      text: 'H2: still reading who paid you. Withdraw unlocks once the payer is known and is not this address.',
    });
  // "known" with no payer address passed in: there is nothing to compare against, so it is not known
  else if (!payers.some((p) => isAddress(p, { strict: false })))
    out.push({
      id: 'H2',
      level: 'block',
      text: 'H2: the payer is not known, so this destination cannot be checked. Withdraw stays locked until the payer is known.',
    });
  // 0.2.19 (bug bounty #59, #48, #55): a payment that came through a contract blocks like an unknown payer. Whoever
  // controls or funded that contract (a smart wallet's owner, a multisig's signers) cannot be read from the chain, so no
  // destination can be ruled out as the payer, and the docs say the payer is never a destination. Before, it warned.
  else if (g.payerViaContract === true)
    out.push({
      id: 'H2',
      level: 'block',
      text: H2_VIA_CONTRACT,
    });
  else out.push({ id: 'H2', level: 'ok', text: 'H2: not the payer.' });

  // H3 collector
  if (g.ownStealthAddresses.some((a) => same(a, dest)))
    out.push({ id: 'H3', level: 'warn', text: 'H3: this is another of your stealth addresses. Merging payments links them.' });
  else if (g.usedDestinations.some((a) => same(a, dest)))
    out.push({
      id: 'H3',
      level: 'warn',
      text: 'H3: you already sent another payment to this address. Collecting payments in one place links them.',
    });
  // fail safe: false, or left out by a caller (undefined at runtime), is incomplete; so is a partial list of our addresses
  else if (g.historyComplete !== true || g.ownPartial === true)
    out.push({
      id: 'H3',
      level: 'warn',
      text: 'H3: history incomplete. Past withdrawals could not be read, so this destination cannot be confirmed as unused.',
    });
  // a token not confirmed as standard may move without a log the history can see: never "unused" (0.2.8). Without any
  // token check at all the token check below blocks the withdrawal outright.
  else if (g.isToken && g.token && g.token.standardTransfer !== true)
    out.push({
      id: 'H3',
      level: 'warn',
      text: 'H3: unknown or non-standard token. Its transfers may not show in public history, so this destination cannot be confirmed as unused.',
    });
  else out.push({ id: 'H3', level: 'ok', text: 'H3: a destination no other payment of yours went to.' });

  // H4 fee fingerprint
  out.push({ id: 'H4', level: 'ok', text: 'H4: fee set to the network standard, never custom.' });

  // H5 gas funding. A payment whose asset could not be read counts as a possible token payment (0.2.9). Holding ETH is
  // not enough for a token payment (0.2.10): where that ETH came from is checked against every wallet linked to you.
  const unknownAsset = g.assetUnknown === true || (typeof g.assetUnknown === 'string' && g.assetUnknown !== '');
  const tokenLike = g.isToken || unknownAsset;
  const gasRaw = Array.isArray(g.gasFrom) ? g.gasFrom.filter((x): x is Hex => typeof x === 'string') : null;
  const gasFrom = gasRaw ? (withL1(gasRaw) as Hex[]) : null;
  const ownOther = g.ownStealthAddresses.filter((a) => !same(a, g.stealthAddress));
  const mine: [string | undefined, string][] = [
    [g.walletAddress, 'your key wallet'],
    // gas from the destination itself: withdrawing there sends the payment back to whoever paid its gas (bug bounty 3 Nov)
    [dest, 'this destination'],
    ...wallets.map((w): [string, string] => [w, 'your connected wallet']),
    ...registrants.map((r): [string, string] => [r, 'a wallet that published your meta-address']),
    ...ownOther.map((a): [string, string] => [a, 'another of your payment addresses']),
    ...g.usedDestinations.map((a): [string, string] => [a, 'an address your payments were withdrawn to']),
  ];
  // both sides in both forms: gasFrom is de-aliased above, each linked address is de-aliased here (bug bounty 8 Nov)
  const linkedBy = gasFrom
    ? (mine.find(([a]) => linked(gasFrom, a))?.[1] ??
      (gasRaw!.some((a) => registeredOf(a) === true) ? 'a wallet with a stealth meta-address in the registry' : undefined))
    : undefined;
  // the registry could not be read: a gas sender not proved unregistered may be a registrant (0.2.18)
  const gasUnchecked = g.registrants === null && !!gasRaw && gasRaw.some((a) => registeredOf(a) !== false);
  // the payer of another payment of yours: links the two payments, unless it also paid this one (then it already does)
  const sharedPayer = gasFrom
    ? (g.otherPayers ?? []).some((p) => typeof p === 'string' && linked(gasFrom, p) && !linked(payers, p))
    : false;
  if (g.isToken && !g.hasGas)
    out.push({
      id: 'H5',
      level: 'block',
      text: 'H5: this payment holds a token but no ETH for gas. Do not fund it from a wallet linked to you.',
    });
  else if (unknownAsset && !g.hasGas)
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
  else if (tokenLike && gasUnchecked) out.push({ id: 'H5', level: 'block', text: H5_REGISTRY_UNREAD });
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
  else if (unknownAsset)
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: what this payment holds could not be fully read from the chain, so it may also hold a token. Never top it up with ETH from a wallet linked to you.',
    });
  // the gas sources are compared with the destinations of your past withdrawals: while that history is incomplete, a
  // clean answer would be a guess (0.2.12), as in H3
  else if (tokenLike && (g.historyComplete !== true || g.ownPartial === true))
    out.push({
      id: 'H5',
      level: 'warn',
      text: 'H5: history incomplete. Past withdrawals could not be read, so it cannot be confirmed that the ETH for gas on this payment did not come from an address your payments went to.',
    });
  else out.push({ id: 'H5', level: 'ok', text: H5_OWN_GAS });

  // token validation (0.2.8): the token address comes from the announcement, so nothing about it is trusted unread
  if (g.isToken) {
    if (g.token?.hasCode === false)
      out.push({ id: 'token', level: 'block', text: 'Token: there is no contract at the token address, so it cannot be withdrawn here.' });
    else if (g.token?.hasCode !== true)
      out.push({
        id: 'token',
        level: 'block',
        text: 'Token: the token contract could not be confirmed, so Withdraw stays off. Scan again, or set another RPC endpoint in Settings.',
      });
    else if (g.token.standardTransfer !== true) out.push({ id: 'token', level: 'warn', text: NON_STANDARD_TOKEN });
  }

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

/** How far back the payment scan looks, in days, or 'all' for every announcement since the Announcer went live. */
export type ScanRange = '7' | '30' | '90' | 'all';
/** Everything by default: a shorter range leaves older payments, and where they went, out of H3. */
export const DEFAULT_SCAN_RANGE: ScanRange = 'all';
export const SCAN_RANGES: { value: ScanRange; label: string }[] = [
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: 'all', label: 'Everything' },
];
/** The range as scan() takes it: a number of days, or null for everything. Anything unknown counts as everything. */
export const scanDays = (r: string): number | null => (r === '7' || r === '30' || r === '90' ? Number(r) : null);

/**
 * What H3 may rely on after a scan. A scan limited to the last N days leaves out older payments: their addresses are
 * missing from `ownStealthAddresses` and their withdrawals from `usedDestinations`, even when every withdrawal of
 * the payments it found was read. So only the full range ('all') with a fully loaded history counts as complete;
 * any other range marks both lists partial, and H3 warns "history incomplete" instead of calling a destination unused.
 */
export function scanCoverage(range: string, historyLoaded: boolean): { historyComplete: boolean; ownPartial: boolean } {
  const full = range === 'all';
  return { historyComplete: full && historyLoaded === true, ownPartial: !full };
}

export const blocking = (c: Check[]) => c.some((x) => x.level === 'block');
export const warnings = (c: Check[]) => c.filter((x) => x.level === 'warn');

/**
 * Right before a withdrawal is signed (0.2.11): `fresh` are the checks again, with the payment read once more from the
 * chain; `shown` are the ones on screen, whose warnings the user confirmed. null = go ahead. Anything that blocks now,
 * or a warning that was not on screen, stops the withdrawal with the reason: a payer whose payment arrived after the
 * list was read is caught here, not after the funds went back to it.
 */
export function recheck(shown: Check[], fresh: Check[]): string | null {
  const b = fresh.find((c) => c.level === 'block');
  if (b) return `Stopped before signing, nothing was sent. ${b.text}`;
  const confirmed = new Set(shown.filter((c) => c.level === 'warn').map((c) => `${c.id}|${c.text}`));
  const added = fresh.find((c) => c.level === 'warn' && !confirmed.has(`${c.id}|${c.text}`));
  if (added) return `Stopped before signing, nothing was sent: this payment changed since it was read. ${added.text} Check the list above and confirm again.`;
  return null;
}

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
