/**
 * Linkability heuristics for stealth payments, after Kovács & Seres,
 * "Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum" (2023), arXiv:2308.01703.
 *
 * H1 registrant reuse     a withdrawal goes to an address that registered stealth keys   -> stealth linked to identity
 * H2 same sender/receiver the paid asset goes back to the payment's sender             -> stealth linked to identity
 * H3 collector pattern    several stealth addresses withdraw to the same recipient     -> stealth addresses clustered
 * H4 unique priority fee  withdrawals share a rarely used maxPriorityFeePerGas         -> stealth addresses clustered
 * H5 gas funding (ours)   gas ETH came from a registrant or from the final recipient   -> stealth linked to identity
 *
 * The paper's Ethereum figure (48.5%) is |H1 or H2| over all withdrawn stealth payments, where H1/H2
 * only consider payments emptied in a single withdrawal. `paperPct` reproduces exactly that.
 *
 * Pure functions only. Output is aggregate counts; no address ever leaves this module.
 */
import type { Asset } from './decode.ts';
import { pct } from './util.ts';

export interface Payment {
  source: 'umbra' | 'erc5564';
  stealth: string;
  sender: string;
  block: number;
  timestamp: number;
  asset: Asset;
  token: string | null;
  txHash: string;
}

/** eth = ETH left the stealth address; token = ERC-20/721/1155 left it; umbra-token = Umbra TokenWithdrawal */
export type WithdrawalKind = 'eth' | 'token' | 'umbra-token';

export interface Withdrawal {
  stealth: string;
  txHash: string;
  block: number;
  to: string;
  kind: WithdrawalKind;
  token: string | null;
  /** signer of the withdrawal transaction */
  txFrom: string;
  txType: number;
  /** maxPriorityFeePerGas in wei, null for legacy transactions */
  priorityFee: string | null;
}

export interface Funding {
  stealth: string;
  txHash: string;
  block: number;
  from: string;
}

export interface Registration {
  registrant: string;
  block: number;
  registry: 'umbra' | 'erc6538';
}

export interface Dataset {
  payments: Payment[];
  withdrawals: Withdrawal[];
  fundings: Funding[];
  registrations: Registration[];
  /** addresses with contract code: stealth smart accounts, recipients, funders */
  contracts: Set<string>;
  /** EIP-7702 delegated EOAs: a relayer may submit their transactions, so they count as smart accounts */
  delegated: Set<string>;
  /** "stealth" addresses that had sent transactions before their first payment: not fresh, left out */
  preUsed: Set<string>;
}

export interface AnalyzeOptions {
  uniqueFeeMax: number;
  /** first block on or after PAPER_CUTOFF_ISO */
  cutoffBlock: number;
}

interface Scope {
  sources: ReadonlySet<Payment['source']>;
  registries: ReadonlySet<Registration['registry']>;
  /** only stealth addresses whose first payment is in [firstFrom, firstBefore) */
  firstFrom?: number;
  firstBefore?: number;
  /** ignore payments, withdrawals, fundings and registrations at or after this block */
  asOfBlock?: number;
}

export interface Measure {
  stealthAddresses: number;
  withdrawn: number;
  singleWithdrawal: number;
  h1Single: number;
  h2Single: number;
  /** |H1 or H2| over withdrawn, single withdrawals only: the paper's metric */
  paperLinked: number;
  paperPct: number;
  h1Any: number;
  h2Any: number;
  needingOwnGas: number;
  h5: number;
  /** H1 or H2 over any withdrawal, or H5: our wider measure */
  identityLinked: number;
  identityPct: number;
}

export interface Analysis {
  /** Umbra only, Umbra registry, the chain as of the cutoff: compare with 48.51% */
  paperComparable: Measure;
  /** everything: Umbra + ERC-5564, both registries, full history */
  all: Measure;
  /** stealth addresses first paid after the cutoff */
  sinceCutoff: Measure;
  byYear: Record<string, Measure>;
  h3: { clusteredStealth: number; clusters: number; largestCluster: number; pctOfSingle: number };
  h4: { eligibleTxs: number; uniqueFeeValues: number; linkedStealth: number; groups: number };
}

interface StealthView {
  addr: string;
  firstBlock: number;
  firstTs: number;
  senders: Set<string>;
  tokens: Set<string>;
  /** tokens paid straight to the stealth address (ERC-5564). Umbra token payments sit in the Umbra contract instead and
   *  leave only through TokenWithdrawal, so a direct transfer of the same token is not that payment leaving. */
  directTokens: Set<string>;
  paymentTxs: Set<string>;
  /** first payment block of each paid asset ('eth' or the token contract): an asset that left before its own payment
   *  arrived is not that payment leaving (bug bounty 3 Nov) */
  firstOf: Map<string, number>;
  assets: Set<Asset>;
  primary: Asset;
  /** accepted withdrawals, in scope */
  accepted: Withdrawal[];
}

function primaryAsset(assets: Set<Asset>): Asset {
  if (assets.has('ETH')) return 'ETH';
  if (assets.has('TOKEN')) return 'TOKEN';
  return 'UNKNOWN';
}

/** A withdrawal that decides "withdrawn": any asset that was paid in left (bug bounty F34, 29 Oct; EPH-17, 3 Nov).
 *  ETH for an ETH payment, the paid token contract for a token payment. Before, an address paid in both counted only
 *  ETH, so a token exit from it (and its H1, H2 and identity links) dropped out, and one wei of ETH with its own
 *  announcement from a stranger could hide a token payment's withdrawal. For a token paid through Umbra only its
 *  TokenWithdrawal counts: the tokens wait in the Umbra contract, so a direct transfer of the same token from the
 *  stealth address moves other tokens and must not break single-withdrawal status. An address whose only payments
 *  have an unknown asset counts any exit. */
function isPrimary(w: Withdrawal, v: StealthView): boolean {
  if (w.kind === 'eth') return (v.assets.has('ETH') && afterPaid(w, v, 'eth')) || onlyUnknown(v);
  if (w.token !== null && v.tokens.has(w.token))
    return (w.kind === 'umbra-token' || v.directTokens.has(w.token)) && afterPaid(w, v, w.token);
  return onlyUnknown(v);
}
/** The withdrawal comes after the first payment of that asset (bug bounty 3 Nov: a token relayed out before its own
 *  payment arrived counted as that payment's withdrawal). */
const afterPaid = (w: Withdrawal, v: StealthView, key: string): boolean => w.block > (v.firstOf.get(key) ?? v.firstBlock);
const onlyUnknown = (v: StealthView): boolean => v.assets.size === 1 && v.assets.has('UNKNOWN');

/** Any asset that was paid in left. An unknown asset (metadata with an unknown selector) cannot be ruled out. */
function isPaidAsset(w: Withdrawal, v: StealthView): boolean {
  if (v.assets.has('UNKNOWN')) return true;
  if (w.kind === 'eth') return v.assets.has('ETH') && afterPaid(w, v, 'eth');
  // the same rule as isPrimary: for a token paid through Umbra only its TokenWithdrawal moves the paid tokens, so a
  // direct transfer of that token to the payer is no round trip (bug bounty 3 Nov, H2-any)
  return w.token !== null && v.tokens.has(w.token) && (w.kind === 'umbra-token' || v.directTokens.has(w.token)) && afterPaid(w, v, w.token);
}

/** Group payments per stealth address and keep only withdrawals the owner actually made after being paid. */
function views(ds: Dataset, scope: Scope): StealthView[] {
  const byStealth = new Map<string, Payment[]>();
  for (const p of ds.payments) {
    if (!scope.sources.has(p.source)) continue;
    if (scope.asOfBlock !== undefined && p.block >= scope.asOfBlock) continue;
    const list = byStealth.get(p.stealth);
    if (list) list.push(p);
    else byStealth.set(p.stealth, [p]);
  }
  const wBy = new Map<string, Withdrawal[]>();
  for (const w of ds.withdrawals) {
    const list = wBy.get(w.stealth);
    if (list) list.push(w);
    else wBy.set(w.stealth, [w]);
  }
  const out: StealthView[] = [];
  for (const [addr, ps] of byStealth) {
    if (ds.preUsed.has(addr)) continue;
    const firstBlock = Math.min(...ps.map((p) => p.block));
    if (scope.firstFrom !== undefined && firstBlock < scope.firstFrom) continue;
    if (scope.firstBefore !== undefined && firstBlock >= scope.firstBefore) continue;
    const first = ps.find((p) => p.block === firstBlock) as Payment;
    const assets = new Set(ps.map((p) => p.asset));
    const firstOf = new Map<string, number>();
    for (const p of ps) {
      const key = p.asset === 'ETH' ? 'eth' : p.token;
      if (key !== null && p.asset !== 'UNKNOWN') firstOf.set(key, Math.min(p.block, firstOf.get(key) ?? Infinity));
    }
    const v: StealthView = {
      addr,
      firstBlock,
      firstTs: first.timestamp,
      senders: new Set(ps.map((p) => p.sender).filter((s) => s !== '')),
      tokens: new Set(ps.map((p) => p.token).filter((t): t is string => t !== null)),
      directTokens: new Set(ps.filter((p) => p.source !== 'umbra').map((p) => p.token).filter((t): t is string => t !== null)),
      paymentTxs: new Set(ps.map((p) => p.txHash)),
      firstOf,
      assets,
      primary: primaryAsset(assets),
      accepted: [],
    };
    const isSmartAccount = ds.contracts.has(addr) || ds.delegated.has(addr);
    // tokens the sender of the first payment paid in: a relayed move of one of them is the owner's (see below)
    const firstSenders = new Set(ps.filter((p) => p.block === firstBlock && p.sender !== '').map((p) => p.sender));
    const trusted = new Set(ps.filter((p) => p.token !== null && firstSenders.has(p.sender)).map((p) => p.token as string));
    for (const w of wBy.get(addr) ?? []) {
      // Not before the first payment, and not in its block: the scan has no transaction order inside a block, so a
      // transaction placed before the payment there would count as a withdrawal from a fresh address (F39, 30 Oct).
      if (v.paymentTxs.has(w.txHash) || w.block <= firstBlock) continue;
      // a transfer to itself moves nothing out (bug bounty 3 Nov: a self-transfer counted as a withdrawal and, for a
      // self-funded address, as an H2 round trip)
      if (w.to === addr) continue;
      if (scope.asOfBlock !== undefined && w.block >= scope.asOfBlock) continue;
      // Count only what the owner did: signed by the stealth address, an Umbra token withdrawal, a relayed move of a
      // token that was paid in with the address's first payment, or ETH leaving it in a transaction it did not sign.
      // A smart account or an EIP-7702 delegated address does not make every event owned: anyone can emit a
      // Transfer log "from" it in a fake token contract, and a delegation made later would make such an
      // earlier event look owner-made (bug bounty F38). ETH cannot be faked that way, a token never paid in can.
      // ETH that leaves without the address signing needs code at the address in that block, and only its key can
      // give it code: owned also when the delegation was cleared before the scan's end block, where the code is read
      // (bug bounty 8 Nov). A token paid in later by someone else can be a stranger's own dust whose contract then
      // logs a fake move "from" the address (bug bounty 8 Nov): a relayed move counts for a token of the first payment
      // or one the first payment's sender paid in.
      void isSmartAccount;
      const owned =
        w.kind === 'umbra-token' ||
        w.txFrom === addr ||
        (w.kind === 'token' && w.token !== null && v.tokens.has(w.token) && (v.firstOf.get(w.token) === firstBlock || trusted.has(w.token))) ||
        w.kind === 'eth';
      if (owned) v.accepted.push(w);
    }
    out.push(v);
  }
  return out;
}

function registrants(ds: Dataset, scope: Scope): Set<string> {
  const set = new Set<string>();
  for (const r of ds.registrations) {
    if (!scope.registries.has(r.registry)) continue;
    if (scope.asOfBlock !== undefined && r.block >= scope.asOfBlock) continue;
    set.add(r.registrant);
  }
  return set;
}

const stealthSets = new WeakMap<object, { n: number; set: Set<string> }>();
/** A contract among recipients and funders that H3 and H5 leave out (routers, bridges, hot wallets). A stealth address
 *  with code (a smart account or a delegation) is ours to measure, not such a contract (bug bounty 8 Nov, Znax). */
function foreignContract(ds: Dataset, a: string): boolean {
  if (!ds.contracts.has(a)) return false;
  let c = stealthSets.get(ds.payments);
  if (!c || c.n !== ds.payments.length) stealthSets.set(ds.payments, (c = { n: ds.payments.length, set: new Set(ds.payments.map((p) => p.stealth)) }));
  return !c.set.has(a);
}

function measure(ds: Dataset, scope: Scope, only?: (v: StealthView) => boolean): Measure {
  const regs = registrants(ds, scope);
  const fundBy = new Map<string, Funding[]>();
  for (const f of ds.fundings) {
    const list = fundBy.get(f.stealth);
    if (list) list.push(f);
    else fundBy.set(f.stealth, [f]);
  }
  const m: Measure = {
    stealthAddresses: 0,
    withdrawn: 0,
    singleWithdrawal: 0,
    h1Single: 0,
    h2Single: 0,
    paperLinked: 0,
    paperPct: 0,
    h1Any: 0,
    h2Any: 0,
    needingOwnGas: 0,
    h5: 0,
    identityLinked: 0,
    identityPct: 0,
  };
  for (const v of views(ds, scope)) {
    if (only && !only(v)) continue;
    m.stealthAddresses++;
    const primaryTxs = new Set(v.accepted.filter((w) => isPrimary(w, v)).map((w) => w.txHash));
    if (primaryTxs.size === 0) continue;
    m.withdrawn++;
    const allDests = new Set(v.accepted.map((w) => w.to).filter((d) => d !== v.addr));
    // H2 is a round trip of the paid asset: an unrelated token sent to the payer does not count.
    const paidDests = new Set(v.accepted.filter((w) => isPaidAsset(w, v)).map((w) => w.to).filter((d) => d !== v.addr));

    let h1s = false;
    let h2s = false;
    if (primaryTxs.size === 1) {
      m.singleWithdrawal++;
      const tx = [...primaryTxs][0];
      const dests = v.accepted.filter((w) => w.txHash === tx && isPrimary(w, v)).map((w) => w.to);
      h1s = dests.some((d) => regs.has(d));
      h2s = dests.some((d) => v.senders.has(d));
    }
    if (h1s) m.h1Single++;
    if (h2s) m.h2Single++;
    if (h1s || h2s) m.paperLinked++;

    const h1a = [...allDests].some((d) => regs.has(d));
    const h2a = [...paidDests].some((d) => v.senders.has(d));
    if (h1a) m.h1Any++;
    if (h2a) m.h2Any++;

    // H5: a stealth address paid a token that signed its own transaction needed ETH for gas first. Every address
    // with a token payment counts, also one paid ETH too (F34): a payer's ETH is a payment, not a funding.
    let h5 = false;
    const selfBlocks = v.accepted.filter((w) => w.txFrom === v.addr).map((w) => w.block);
    // ETH that arrives inside one of its own transactions cannot have paid that transaction's gas (bug bounty 3 Nov)
    const selfTxs = new Set(v.accepted.filter((w) => w.txFrom === v.addr).map((w) => w.txHash));
    if (v.assets.has('TOKEN') && selfBlocks.length > 0) {
      m.needingOwnGas++;
      const firstSelf = Math.min(...selfBlocks);
      h5 = (fundBy.get(v.addr) ?? []).some(
        (f) =>
          f.block >= v.firstBlock &&
          f.block <= firstSelf &&
          (scope.asOfBlock === undefined || f.block < scope.asOfBlock) &&
          !v.paymentTxs.has(f.txHash) &&
          !selfTxs.has(f.txHash) &&
          f.from !== v.addr &&
          !v.senders.has(f.from) && // the payer topping up gas reveals nothing new
          !foreignContract(ds, f.from) && // routers, bridges, exchanges' hot contracts
          (regs.has(f.from) || allDests.has(f.from)),
      );
      if (h5) m.h5++;
    }
    if (h1a || h2a || h5) m.identityLinked++;
  }
  m.paperPct = pct(m.paperLinked, m.withdrawn);
  m.identityPct = pct(m.identityLinked, m.withdrawn);
  return m;
}

/** Destinations nobody can spend from: the zero address, 0x…dEaD, the precompiles 0x…01 to 0x…11 and 0x…0100
 *  (P256VERIFY), and the EIP-4788/7708 system address. Lower case. */
const SINKS = new Set<string>([
  '0x0000000000000000000000000000000000000000',
  '0x000000000000000000000000000000000000dead',
  '0x0000000000000000000000000000000000000100',
  '0xfffffffffffffffffffffffffffffffffffffffe',
  ...Array.from({ length: 0x11 }, (_, i) => `0x${'0'.repeat(38)}${(i + 1).toString(16).padStart(2, '0')}`),
]);
const isSink = (a: string): boolean => SINKS.has(a);

const ALL_SOURCES = new Set<Payment['source']>(['umbra', 'erc5564']);
const ALL_REGISTRIES = new Set<Registration['registry']>(['umbra', 'erc6538']);

export function analyze(ds: Dataset, opts: AnalyzeOptions): Analysis {
  const allScope: Scope = { sources: ALL_SOURCES, registries: ALL_REGISTRIES };

  const paperComparable = measure(ds, {
    sources: new Set(['umbra']),
    registries: new Set(['umbra']),
    firstBefore: opts.cutoffBlock,
    asOfBlock: opts.cutoffBlock,
  });
  const all = measure(ds, allScope);
  const sinceCutoff = measure(ds, { ...allScope, firstFrom: opts.cutoffBlock });

  const years = new Set<string>();
  const allViews = views(ds, allScope);
  const yearOf = new Map(allViews.map((v) => [v.addr, String(new Date(v.firstTs * 1000).getUTCFullYear())]));
  for (const y of yearOf.values()) years.add(y);
  const byYear: Record<string, Measure> = {};
  for (const y of [...years].sort()) byYear[y] = measure(ds, allScope, (v) => yearOf.get(v.addr) === y);

  // H3: single-withdrawal stealth addresses grouped by their only (non-contract) recipient.
  const groups = new Map<string, number>();
  let single = 0;
  for (const v of allViews) {
    const primaryTxs = new Set(v.accepted.filter((w) => isPrimary(w, v)).map((w) => w.txHash));
    if (primaryTxs.size !== 1) continue;
    single++;
    const tx = [...primaryTxs][0];
    const dests = new Set(v.accepted.filter((w) => w.txHash === tx && isPrimary(w, v)).map((w) => w.to));
    if (dests.size !== 1) continue;
    const d = [...dests][0] as string;
    // a sink nobody owns (zero, 0x…dEaD, a precompile, the system address) collects nothing: two strangers burning
    // there are not one collector (bug bounty 3 Nov)
    if (foreignContract(ds, d) || d === v.addr || isSink(d)) continue;
    groups.set(d, (groups.get(d) ?? 0) + 1);
  }
  let clusteredStealth = 0;
  let clusters = 0;
  let largestCluster = 0;
  for (const n of groups.values()) {
    if (n < 2) continue;
    clusters++;
    clusteredStealth += n;
    largestCluster = Math.max(largestCluster, n);
  }

  // H4: withdrawals the stealth address signed itself, fee-market transactions only.
  const feeOfTx = new Map<string, string>();
  const stealthsOfTx = new Map<string, Set<string>>();
  for (const v of allViews) {
    for (const w of v.accepted) {
      if (w.txFrom !== v.addr || w.txType < 2 || w.priorityFee === null) continue;
      feeOfTx.set(w.txHash, w.priorityFee);
      const set = stealthsOfTx.get(w.txHash) ?? new Set<string>();
      set.add(v.addr);
      stealthsOfTx.set(w.txHash, set);
    }
  }
  const txsPerFee = new Map<string, number>();
  for (const fee of feeOfTx.values()) txsPerFee.set(fee, (txsPerFee.get(fee) ?? 0) + 1);
  const stealthsPerFee = new Map<string, Set<string>>();
  for (const [tx, fee] of feeOfTx) {
    if ((txsPerFee.get(fee) ?? 0) > opts.uniqueFeeMax) continue;
    const set = stealthsPerFee.get(fee) ?? new Set<string>();
    for (const s of stealthsOfTx.get(tx) ?? []) set.add(s);
    stealthsPerFee.set(fee, set);
  }
  const h4Linked = new Set<string>();
  let h4Groups = 0;
  for (const set of stealthsPerFee.values()) {
    if (set.size < 2) continue;
    h4Groups++;
    for (const s of set) h4Linked.add(s);
  }

  return {
    paperComparable,
    all,
    sinceCutoff,
    byYear,
    h3: { clusteredStealth, clusters, largestCluster, pctOfSingle: pct(clusteredStealth, single) },
    h4: { eligibleTxs: feeOfTx.size, uniqueFeeValues: stealthsPerFee.size, linkedStealth: h4Linked.size, groups: h4Groups },
  };
}
