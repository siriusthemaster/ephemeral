/**
 * Stealth address leak scan.
 *
 *   npm run scan                       # Ethereum mainnet, full history
 *   npm run scan -- --chain sepolia    # quick smoke test
 *   npm run scan -- --sample 500       # 500 stealth addresses spread over time
 *   npm run scan -- --fresh --to-block 23500000   # re-download a fixed range (reproducibility check)
 *
 * Needs ALCHEMY_KEY in .env (Pay As You Go plan). Writes out/summary.json and out/summary.md:
 * aggregate counts only. Raw chain data stays in .cache/ on your machine.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KV, readJson, writeJson } from './lib/cache.ts';
import {
  CHAINS,
  MAX_TRANSFER_PAGES,
  PAPER_CUTOFF_ISO,
  PAPER_ETHEREUM,
  SCAN_VERSION,
  TOPICS,
  UNIQUE_FEE_MAX,
  type ChainName,
} from './lib/config.ts';
import {
  blockAtOrAfter,
  fetchAllTransfers,
  fetchBlockTimes,
  fetchCodeKinds,
  fetchNoncesAt,
  fetchTxs,
  type CodeKind,
  finalizedBlock,
  type TransferPage,
  type TxLite,
} from './lib/data.ts';
import { decodeLogs, type PaymentLog } from './lib/decode.ts';
import { analyze, type Funding, type Payment, type Registration, type Withdrawal } from './lib/heuristics.ts';
import { scanLogs, type RawLog } from './lib/logs.ts';
import { fingerprint, METHOD_NOTES, toMarkdown, type Summary } from './lib/report.ts';
import { Rpc } from './lib/rpc.ts';
import { hex, hexToNumber } from './lib/util.ts';

export interface ScanOptions {
  chain: ChainName;
  rpcUrl: string;
  toBlock?: bigint;
  fresh?: boolean;
  cacheDir: string;
  outDir: string;
  concurrency: number;
  sample?: number;
  logSpan?: bigint;
  log?: (msg: string) => void;
}

interface Meta {
  version: number;
  params: string;
  toBlock: string;
  cutoffBlock?: string;
}

/** Evenly spaced pick of n items, deterministic. */
function spread<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const step = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * step)] as T);
}

export async function runScan(o: ScanOptions): Promise<Summary> {
  const log = o.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const cfg = CHAINS[o.chain];
  const dir = join(o.cacheDir, cfg.name);
  const rpc = new Rpc(o.rpcUrl, { maxBatch: 50 });

  const chainId = hexToNumber(await rpc.call<string>('eth_chainId', []));
  if (chainId !== cfg.chainId) throw new Error(`RPC is on chain ${chainId}, expected ${cfg.chainId} (${cfg.name})`);

  // The cache is only valid for the same code version, fetch parameters and end block.
  const params = createHash('sha256')
    .update(
      JSON.stringify({
        cfg: { ...cfg, umbraStartBlock: String(cfg.umbraStartBlock), erc5564StartBlock: String(cfg.erc5564StartBlock), erc6538StartBlock: String(cfg.erc6538StartBlock) },
        MAX_TRANSFER_PAGES,
        TOPICS,
        PAPER_CUTOFF_ISO,
      }),
    )
    .digest('hex')
    .slice(0, 16);
  let meta = o.fresh ? undefined : readJson<Meta>(join(dir, 'meta.json'));
  if (meta && (meta.version !== SCAN_VERSION || meta.params !== params || (o.toBlock !== undefined && BigInt(meta.toBlock) !== o.toBlock))) {
    log('Cache was made with other settings or another end block; starting clean.');
    meta = undefined;
  }
  if (!meta) {
    rmSync(dir, { recursive: true, force: true });
    const toBlock = o.toBlock ?? (await finalizedBlock(rpc));
    meta = { version: SCAN_VERSION, params, toBlock: toBlock.toString() };
    writeJson(join(dir, 'meta.json'), meta);
  }
  const toBlock = BigInt(meta.toBlock);
  const tag = hex(toBlock);
  if (meta.cutoffBlock === undefined) {
    const cutoff = await blockAtOrAfter(rpc, Date.parse(PAPER_CUTOFF_ISO) / 1000, cfg.umbraStartBlock, toBlock);
    meta = { ...meta, cutoffBlock: cutoff.toString() };
    writeJson(join(dir, 'meta.json'), meta);
  }
  const cutoffBlock = Number(meta.cutoffBlock);
  log(`Chain ${cfg.name}, scanning to finalized block ${toBlock} (paper cutoff at block ${cutoffBlock}).`);

  // 1. Logs: Umbra + its registry, then the ERC-5564 announcer + ERC-6538 registry.
  const getLogs = async (name: string, addresses: string[], topic0s: string[], from: bigint): Promise<RawLog[]> => {
    const file = join(dir, `logs-${name}.json`);
    const cached = readJson<RawLog[]>(file);
    if (cached) return cached;
    if (from > toBlock) return [];
    log(`Reading ${name} logs from block ${from}...`);
    let lastPct = -10;
    const logs = await scanLogs(rpc, {
      addresses,
      topic0s,
      from,
      to: toBlock,
      initialSpan: o.logSpan,
      onProgress: (done, total, count) => {
        const p = Number((done * 100n) / total);
        if (p >= lastPct + 10 || done === total) {
          lastPct = p;
          log(`  ${name}: ${p}% of blocks, ${count} logs`);
        }
      },
    });
    writeJson(file, logs);
    return logs;
  };
  const umbraLogs = await getLogs(
    'umbra',
    [cfg.umbra, cfg.umbraRegistry],
    [TOPICS.umbraAnnouncement, TOPICS.umbraTokenWithdrawal, TOPICS.umbraStealthKeyChanged],
    cfg.umbraStartBlock,
  );
  const ercLogs = await getLogs(
    'erc5564',
    [cfg.announcer, cfg.registry6538],
    [TOPICS.erc5564Announcement, TOPICS.erc6538MetaAddressSet],
    cfg.erc5564StartBlock < cfg.erc6538StartBlock ? cfg.erc5564StartBlock : cfg.erc6538StartBlock,
  );
  const decoded = decodeLogs([...umbraLogs, ...ercLogs], cfg);
  log(
    `Decoded ${decoded.payments.length} payments, ${decoded.tokenWithdrawals.length} Umbra token withdrawals, ` +
      `${decoded.registrations.length} registrations (${decoded.skipped} logs skipped).`,
  );

  // 2. Optional sample: stealth addresses spread evenly over time.
  let paymentLogs: PaymentLog[] = decoded.payments;
  let tokenWithdrawals = decoded.tokenWithdrawals;
  if (o.sample) {
    const keep = new Set(spread([...new Set(paymentLogs.map((p) => p.stealth))], o.sample));
    paymentLogs = paymentLogs.filter((p) => keep.has(p.stealth));
    tokenWithdrawals = tokenWithdrawals.filter((w) => keep.has(w.stealth));
    log(`Sample: ${keep.size} stealth addresses, ${paymentLogs.length} payments.`);
  }
  const stealths = [...new Set(paymentLogs.map((p) => p.stealth))];

  // 3. Who sent each payment, and when.
  const txs = new KV<TxLite>(join(dir, 'txs.json'));
  await fetchTxs(rpc, paymentLogs.map((p) => p.txHash), txs, o.concurrency);
  const blockTimes = new KV<number>(join(dir, 'blocktimes.json'));
  await fetchBlockTimes(rpc, paymentLogs.filter((p) => p.blockTimestamp === undefined).map((p) => p.blockNumber), blockTimes, o.concurrency);
  const payments: Payment[] = paymentLogs.map((p) => ({
    source: p.source,
    stealth: p.stealth,
    sender: txs.get(p.txHash)?.from ?? '',
    block: p.blockNumber,
    timestamp: p.blockTimestamp ?? blockTimes.get(String(p.blockNumber)) ?? 0,
    asset: p.asset,
    token: p.token,
    txHash: p.txHash,
  }));

  // 4. Fresh? A real stealth address has sent nothing before its first payment. Addresses that had
  //    (test or spam announcements to used wallets) are left out and counted under quality.
  const firstBlockOf = new Map<string, number>();
  for (const p of paymentLogs) firstBlockOf.set(p.stealth, Math.min(p.blockNumber, firstBlockOf.get(p.stealth) ?? Infinity));
  const nonceAt = new KV<number>(join(dir, 'nonce-before-payment.json'));
  const nonceKey = (s: string) => `${s}@${(firstBlockOf.get(s) as number) - 1}`;
  await fetchNoncesAt(rpc, stealths.map(nonceKey), nonceAt, o.concurrency);
  const preUsed = new Set(stealths.filter((s) => (nonceAt.get(nonceKey(s)) ?? 0) > 0));

  // 5. Every stealth address's outgoing transfers. No shortcut on the current nonce: gasless
  //    (relayed or permit) withdrawals leave it at zero.
  const codeKind = new KV<CodeKind>(join(dir, 'code.json'));
  await fetchCodeKinds(rpc, stealths, tag, codeKind, o.concurrency);
  const outgoing = new KV<TransferPage>(join(dir, 'transfers-out.json'), 200);
  log(`Reading outgoing transfers of ${stealths.length} stealth addresses...`);
  await fetchAllTransfers(rpc, stealths, 'from', cfg.transferCategories, cfg.umbraStartBlock, toBlock, outgoing, o.concurrency, 'outgoing transfers');

  const raw: Omit<Withdrawal, 'txFrom' | 'txType' | 'priorityFee'>[] = [];
  for (const s of stealths) {
    for (const t of outgoing.get(s)?.transfers ?? []) {
      if (!t.to) continue;
      const kind = t.category === 'external' || t.category === 'internal' ? 'eth' : 'token';
      raw.push({ stealth: s, txHash: t.hash, block: t.block, to: t.to, kind, token: kind === 'token' ? t.token : null });
    }
  }
  for (const w of tokenWithdrawals) {
    raw.push({ stealth: w.stealth, txHash: w.txHash, block: w.blockNumber, to: w.acceptor, kind: 'umbra-token', token: w.token });
  }
  await fetchTxs(rpc, raw.map((w) => w.txHash), txs, o.concurrency);
  const withdrawals: Withdrawal[] = raw.map((w) => {
    const tx = txs.get(w.txHash);
    return { ...w, txFrom: tx?.from ?? '', txType: tx?.type ?? 0, priorityFee: tx?.priorityFee ?? null };
  });

  // 6. H5: token-only stealth addresses that signed a transaction needed gas. Where did it come from?
  const assetsBy = new Map<string, Set<string>>();
  for (const p of payments) {
    const set = assetsBy.get(p.stealth) ?? new Set<string>();
    set.add(p.asset);
    assetsBy.set(p.stealth, set);
  }
  const selfSigned = new Set(withdrawals.filter((w) => w.txFrom === w.stealth).map((w) => w.stealth));
  const needGas = [...selfSigned].filter((s) => {
    const a = assetsBy.get(s);
    return a !== undefined && !a.has('ETH') && a.has('TOKEN'); // same primary-asset rule as the analysis
  });
  const incoming = new KV<TransferPage>(join(dir, 'transfers-in.json'), 200);
  await fetchAllTransfers(rpc, needGas, 'to', cfg.fundingCategories, cfg.umbraStartBlock, toBlock, incoming, o.concurrency, 'gas funding');
  const fundings: Funding[] = [];
  for (const s of needGas) for (const t of incoming.get(s)?.transfers ?? []) fundings.push({ stealth: s, txHash: t.hash, block: t.block, from: t.from });

  // 7. Contracts among recipients and funders (excluded from H3 and H5).
  await fetchCodeKinds(rpc, [...new Set([...withdrawals.map((w) => w.to), ...fundings.map((f) => f.from)])], tag, codeKind, o.concurrency);
  const contracts = new Set<string>();
  const delegated = new Set<string>();
  for (const [addr, kind] of codeKind.entries()) {
    if (kind === 'contract') contracts.add(addr);
    else if (kind === 'delegated') delegated.add(addr);
  }

  // 8. Analyze and write aggregate output.
  const registrations: Registration[] = decoded.registrations.map((r) => ({ registrant: r.registrant, block: r.blockNumber, registry: r.registry }));
  const results = analyze(
    { payments, withdrawals, fundings, registrations, contracts, delegated, preUsed },
    { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock },
  );
  const byYear: Record<string, number> = {};
  for (const p of payments) {
    const y = String(new Date(p.timestamp * 1000).getUTCFullYear());
    byYear[y] = (byYear[y] ?? 0) + 1;
  }
  // Count only lookups made for this run, so a cache left by another run cannot change the result.
  const truncated =
    stealths.filter((s) => outgoing.get(s)?.truncated).length + needGas.filter((s) => incoming.get(s)?.truncated).length;
  const umbraRegs = new Set(registrations.filter((r) => r.registry === 'umbra').map((r) => r.registrant));
  const ercRegs = new Set(registrations.filter((r) => r.registry === 'erc6538').map((r) => r.registrant));

  const body = {
    chain: cfg.name,
    chainId: cfg.chainId,
    blocks: {
      umbraFrom: cfg.umbraStartBlock.toString(),
      erc5564From: cfg.erc5564StartBlock.toString(),
      cutoff: String(cutoffBlock),
      to: toBlock.toString(),
    },
    sample: o.sample ?? null,
    method: {
      reference: 'arXiv:2308.01703',
      paperEthereum: PAPER_ETHEREUM,
      uniqueFeeMax: UNIQUE_FEE_MAX,
      paperCutoff: PAPER_CUTOFF_ISO,
      unitOfAnalysis: 'stealth address',
      notes: METHOD_NOTES,
    },
    payments: {
      total: payments.length,
      umbra: payments.filter((p) => p.source === 'umbra').length,
      erc5564: payments.filter((p) => p.source === 'erc5564').length,
      eth: payments.filter((p) => p.asset === 'ETH').length,
      token: payments.filter((p) => p.asset === 'TOKEN').length,
      unknown: payments.filter((p) => p.asset === 'UNKNOWN').length,
      byYear: Object.fromEntries(Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b))),
    },
    registrants: { umbraRegistry: umbraRegs.size, erc6538: ercRegs.size, total: new Set([...umbraRegs, ...ercRegs]).size },
    results,
    quality: { undecodedLogs: decoded.skipped, truncatedTransferLookups: truncated, notFreshStealthAddresses: preUsed.size },
  };
  const summary: Summary = {
    generatedAt: new Date().toISOString(),
    ...body,
    fingerprint: fingerprint(body),
    rpc: { ...rpc.stats },
  };
  mkdirSync(o.outDir, { recursive: true });
  writeJson(join(o.outDir, 'summary.json'), summary);
  writeFileSync(join(o.outDir, 'summary.md'), toMarkdown(summary));
  return summary;
}

// ---------------------------------------------------------------------------------------------
// CLI

function loadDotEnv(file = '.env'): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && m[1] && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
}

/** --name value or --name=value */
function arg(name: string): string | undefined {
  const argv = process.argv;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === `--${name}`) return argv[i + 1];
    if (a.startsWith(`--${name}=`)) return a.slice(name.length + 3);
  }
  return undefined;
}

function positiveInt(name: string, value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`--${name} must be a whole number from 1 to ${max}`);
  return n;
}

async function main(): Promise<void> {
  loadDotEnv();
  const chain = (arg('chain') ?? 'mainnet') as ChainName;
  if (!(chain in CHAINS)) throw new Error(`Unknown chain "${chain}". Use mainnet or sepolia.`);
  const key = process.env.ALCHEMY_KEY?.trim();
  const rpcUrl = process.env.RPC_URL?.trim() || (key ? `https://${CHAINS[chain].alchemySubdomain}.g.alchemy.com/v2/${key}` : '');
  if (!rpcUrl) throw new Error('Set ALCHEMY_KEY in .env (copy .env.example to .env).');
  const toBlockArg = arg('to-block');
  if (toBlockArg !== undefined && !/^\d+$/.test(toBlockArg)) throw new Error('--to-block must be a block number');
  const started = Date.now();
  const s = await runScan({
    chain,
    rpcUrl,
    toBlock: toBlockArg ? BigInt(toBlockArg) : undefined,
    fresh: process.argv.includes('--fresh'),
    cacheDir: arg('cache') ?? '.cache',
    outDir: arg('out') ?? 'out',
    concurrency: positiveInt('concurrency', arg('concurrency'), 8, 64),
    sample: arg('sample') !== undefined ? positiveInt('sample', arg('sample'), 0, 10_000_000) : undefined,
  });
  process.stdout.write('\n' + toMarkdown(s) + '\n');
  process.stdout.write(`Done in ${Math.round((Date.now() - started) / 1000)}s · ${s.rpc.calls} RPC calls · fingerprint ${s.fingerprint}\n`);
  process.stdout.write('Wrote out/summary.json and out/summary.md (aggregate only, safe to share).\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e: unknown) => {
    process.stderr.write(`\nScan failed: ${e instanceof Error ? e.message : String(e)}\n`);
    process.stderr.write('Re-running resumes from .cache/. Send this message if it keeps failing.\n');
    process.exit(1);
  });
}
