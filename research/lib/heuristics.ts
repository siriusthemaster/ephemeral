/**
 * Linkability heuristics for stealth payments, after Kovács & Seres,
 * "Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum" (2023), arXiv:2308.01703.
 *
 * H1 registrant reuse     a withdrawal goes to an address that registered stealth keys   -> stealth linked to identity
 * H2 same sender/receiver the withdrawal goes back to the payment's sender              -> stealth linked to identity
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
  /** ignore withdrawals, fundings and registrations at or after this block */
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
  paymentTxs: Set<string>;
  primary: Asset;
  /** accepted withdrawals, in scope */
  accepted: Withdrawal[];
}

function primaryAsset(assets: Set<Asset>): Asset {
  if (assets.has('ETH')) return 'ETH';
  if (assets.has('TOKEN')) return 'TOKEN';
  return 'UNKNOWN';
}

function isPrimary(w: Withdrawal, primary: Asset): boolean {
  if (primary === 'ETH') return w.kind === 'eth';
  if (primary === 'TOKEN') return w.kind === 'token' || w.kind === 'umbra-token';
  return true;
}

/** Group payments per stealth address and keep only withdrawals the owner actually made after being paid. */
function views(ds: Dataset, scope: Scope): StealthView[] {
  const byStealth = new Map<string, Payment[]>();
  for (const p of ds.payments) {
    if (!scope.sources.has(p.source)) continue;
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
    const v: StealthView = {
      addr,
      firstBlock,
      firstTs: first.timestamp,
      senders: new Set(ps.map((p) => p.sender).filter((s) => s !== '')),
      tokens: new Set(ps.map((p) => p.token).filter((t): t is string => t !== null)),
      paymentTxs: new Set(ps.map((p) => p.txHash)),
      primary: primaryAsset(new Set(ps.map((p) => p.asset))),
      accepted: [],
    };
    const isSmartAccount = ds.contracts.has(addr) || ds.delegated.has(addr);
    for (const w of wBy.get(addr) ?? []) {
      if (v.paymentTxs.has(w.txHash) || w.block < firstBlock) continue;
      if (scope.asOfBlock !== undefined && w.block >= scope.asOfBlock) continue;
      // Count only what the owner did: signed by the stealth address, an Umbra token withdrawal,
      // a smart-account stealth address, or a relayed move of the very token that was paid in.
      const owned =
        w.kind === 'umbra-token' ||
        w.txFrom === addr ||
        isSmartAccount ||
        (w.kind === 'token' && w.token !== null && v.tokens.has(w.token));
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
    const primaryTxs = new Set(v.accepted.filter((w) => isPrimary(w, v.primary)).map((w) => w.txHash));
    if (primaryTxs.size === 0) continue;
    m.withdrawn++;
    const allDests = new Set(v.accepted.map((w) => w.to).filter((d) => d !== v.addr));

    let h1s = false;
    let h2s = false;
    if (primaryTxs.size === 1) {
      m.singleWithdrawal++;
      const tx = [...primaryTxs][0];
      const dests = v.accepted.filter((w) => w.txHash === tx && isPrimary(w, v.primary)).map((w) => w.to);
      h1s = dests.some((d) => regs.has(d));
      h2s = dests.some((d) => v.senders.has(d));
    }
    if (h1s) m.h1Single++;
    if (h2s) m.h2Single++;
    if (h1s || h2s) m.paperLinked++;

    const h1a = [...allDests].some((d) => regs.has(d));
    const h2a = [...allDests].some((d) => v.senders.has(d));
    if (h1a) m.h1Any++;
    if (h2a) m.h2Any++;

    // H5: a token-only stealth address that signed its own transaction needed ETH for gas first.
    let h5 = false;
    const selfBlocks = v.accepted.filter((w) => w.txFrom === v.addr).map((w) => w.block);
    if (v.primary === 'TOKEN' && selfBlocks.length > 0) {
      m.needingOwnGas++;
      const firstSelf = Math.min(...selfBlocks);
      h5 = (fundBy.get(v.addr) ?? []).some(
        (f) =>
          f.block >= v.firstBlock &&
          f.block <= firstSelf &&
          (scope.asOfBlock === undefined || f.block < scope.asOfBlock) &&
          !v.paymentTxs.has(f.txHash) &&
          f.from !== v.addr &&
          !v.senders.has(f.from) && // the payer topping up gas reveals nothing new
          !ds.contracts.has(f.from) && // routers, bridges, exchanges' hot contracts
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
    const primaryTxs = new Set(v.accepted.filter((w) => isPrimary(w, v.primary)).map((w) => w.txHash));
    if (primaryTxs.size !== 1) continue;
    single++;
    const tx = [...primaryTxs][0];
    const dests = new Set(v.accepted.filter((w) => w.txHash === tx && isPrimary(w, v.primary)).map((w) => w.to));
    if (dests.size !== 1) continue;
    const d = [...dests][0] as string;
    if (ds.contracts.has(d) || d === v.addr) continue;
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
