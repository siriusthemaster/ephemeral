import { createHash } from 'node:crypto';
import { PAPER_ETHEREUM } from './config.ts';
import type { Analysis, Measure } from './heuristics.ts';

export interface Summary {
  generatedAt: string;
  chain: string;
  chainId: number;
  blocks: { umbraFrom: string; erc5564From: string; cutoff: string; to: string };
  sample: number | null;
  method: {
    reference: string;
    paperEthereum: typeof PAPER_ETHEREUM;
    uniqueFeeMax: number;
    paperCutoff: string;
    unitOfAnalysis: string;
    notes: string[];
  };
  payments: {
    total: number;
    umbra: number;
    erc5564: number;
    eth: number;
    token: number;
    unknown: number;
    byYear: Record<string, number>;
  };
  registrants: { umbraRegistry: number; erc6538: number; total: number };
  results: Analysis;
  quality: { undecodedLogs: number; truncatedTransferLookups: number; notFreshStealthAddresses: number };
  /** sha256 over everything except generatedAt and rpc stats: two scans of the same range must match */
  fingerprint: string;
  rpc: { calls: number; httpRequests: number; retries: number };
}

export const METHOD_NOTES = [
  'Aggregate counts only. No address, cluster or link is written to this file.',
  'Unit of analysis is the stealth address; several payments to one stealth address count once.',
  "paperPct reproduces the paper's metric: stealth addresses emptied in a single withdrawal that went to a registrant (H1) or back to the sender (H2), over all withdrawn. The paper reports 48.51% for Ethereum (4,696 of 9,680).",
  'paperComparable looks at the chain as of the cutoff: Umbra payments, Umbra registrations and withdrawals before it.',
  'Only withdrawals the owner made count: signed by the stealth address, an Umbra TokenWithdrawal, a smart-account or EIP-7702 delegated stealth address, or a relayed move of the token that was paid in; never before the first payment.',
  'Announced addresses that had sent transactions before their first payment are not fresh stealth addresses and are left out.',
  'A withdrawal is judged on the paid asset: an ETH payment by ETH leaving, a token payment by the token leaving; a leftover-gas sweep does not break a single withdrawal.',
  'identityPct is wider: H1 or H2 over any withdrawal, or H5.',
  'H3 ignores recipients that are contracts (routers, the Umbra contract) to avoid false clusters.',
  'H4 uses fee-market withdrawals the stealth address signed itself; the paper excluded all token payments, here self-signed token withdrawals are included.',
  'H5 is ours: token-only stealth addresses that paid their own gas, where the ETH arrived between the first payment and their first own transaction, from a registrant or from an address the funds later went to. ETH from the payer or from contracts does not count.',
];

export function fingerprint(s: Omit<Summary, 'fingerprint' | 'generatedAt' | 'rpc'>): string {
  return createHash('sha256').update(JSON.stringify(s)).digest('hex').slice(0, 16);
}

const n = (x: number) => x.toLocaleString('en-US');

const row = (label: string, m: Measure) =>
  `| ${label} | ${n(m.stealthAddresses)} | ${n(m.withdrawn)} | ${n(m.paperLinked)} | ${m.paperPct}% | ${m.identityPct}% |`;

export function toMarkdown(s: Summary): string {
  const r = s.results;
  return [
    `# Stealth address leak scan — ${s.chain}`,
    '',
    `Blocks ${s.blocks.umbraFrom}–${s.blocks.to}${s.sample ? ` · sample of ${s.sample} stealth addresses` : ''} · fingerprint \`${s.fingerprint}\``,
    '',
    `Method after Kovács & Seres (2023), ${s.method.reference}. Aggregate counts only.`,
    '',
    '| Scope | Stealth addresses | Withdrawn | Linked (H1 or H2) | Paper metric | Linked, wider (H1, H2 any, H5) |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    `| Paper, Ethereum 2023 (reported) | | ${n(PAPER_ETHEREUM.withdrawn)} | ${n(PAPER_ETHEREUM.linked)} | ${PAPER_ETHEREUM.pct}% | |`,
    row(`Umbra as of ${s.method.paperCutoff.slice(0, 10)} (comparable)`, r.paperComparable),
    row(`First paid since ${s.method.paperCutoff.slice(0, 10)}`, r.sinceCutoff),
    row('All, Umbra + ERC-5564', r.all),
    '',
    '## By year of first payment',
    '',
    '| Year | Stealth addresses | Withdrawn | Linked (H1 or H2) | Paper metric | Linked, wider |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(r.byYear).map(([y, m]) => row(y, m)),
    '',
    '## Each heuristic, all data',
    '',
    '| Heuristic | Count | Share |',
    '| --- | ---: | ---: |',
    `| H1 registrant reuse, single withdrawal | ${n(r.all.h1Single)} | of ${n(r.all.withdrawn)} withdrawn |`,
    `| H1 registrant reuse, any withdrawal | ${n(r.all.h1Any)} | |`,
    `| H2 same sender and receiver, single withdrawal | ${n(r.all.h2Single)} | |`,
    `| H2 same sender and receiver, any withdrawal | ${n(r.all.h2Any)} | |`,
    `| H3 collector pattern | ${n(r.h3.clusteredStealth)} in ${n(r.h3.clusters)} clusters (largest ${n(r.h3.largestCluster)}) | ${r.h3.pctOfSingle}% of single withdrawals |`,
    `| H4 unique priority fee | ${n(r.h4.linkedStealth)} in ${n(r.h4.groups)} groups | from ${n(r.h4.eligibleTxs)} eligible transactions |`,
    `| H5 gas funding (ours) | ${n(r.all.h5)} | of ${n(r.all.needingOwnGas)} that paid their own gas |`,
    '',
    `Data quality: ${n(s.quality.undecodedLogs)} undecoded logs, ${n(s.quality.truncatedTransferLookups)} truncated transfer lookups, ` +
      `${n(s.quality.notFreshStealthAddresses)} announced addresses left out because they had sent transactions before their first payment.`,
    '',
    '## Notes',
    '',
    ...s.method.notes.map((x) => `- ${x}`),
    '',
  ].join('\n');
}
