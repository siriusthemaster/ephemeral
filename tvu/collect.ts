/**
 * TVU collector. Usage: node --import tsx tvu/collect.ts --data <dir> [--budget-minutes 300] [--no-publish]
 *
 * <dir> holds checkpoint files, tvu.json (previous and new) and sector.json (cross check).
 * Publishes tvu.json only when every chain has been scanned up to its head. Otherwise the checkpoint is saved
 * and nothing about TVU is written.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CHAINS, RULES, rpcUrls, SECTOR_URL, type ChainCfg } from './config.ts';
import { loadCheckpoint, saveCheckpoint, skipHash, type ChainState } from './checkpoint.ts';
import { buildTvu, sanityCheck, type ChainResult, type Tvu } from './output.ts';
import { fetchPrices } from './prices.ts';
import { FallbackRpc, type Rpc } from './rpc.ts';
import { scanChain } from './scan.ts';
import { applyFilters, readBalances, readUmbraPending, verifyTokens, type Prices } from './value.ts';

export interface Deps {
  makeRpc(c: ChainCfg): Promise<Rpc>;
  prices(): Promise<Prices>;
  sector(): Promise<{ chains?: Record<string, { umbra?: number; erc5564?: number }> } | null>;
  now(): number;
  log(m: string): void;
}

export interface RunOpts {
  dataDir: string;
  budgetMs: number;
  publish: boolean;
  chains?: ChainCfg[];
  saveEveryMs?: number;
}

export interface RunResult {
  complete: boolean;
  published: boolean;
  tvu: Tvu | null;
}

const hexNum = (h: string): number => Number(BigInt(h));

export async function run(o: RunOpts, d: Deps): Promise<RunResult> {
  const chains = o.chains ?? CHAINS;
  const deadline = d.now() + o.budgetMs;
  const states = loadCheckpoint(o.dataDir, chains.map((c) => c.key));
  const rpcs: Record<string, Rpc> = {};
  const heads: Record<string, number> = {};
  for (const c of chains) {
    rpcs[c.key] = await d.makeRpc(c);
    heads[c.key] = hexNum(await rpcs[c.key]!.call<string>('eth_blockNumber', [])) - RULES.confirmations;
  }
  const complete: Record<string, boolean> = {};
  const save = (): void => saveCheckpoint(o.dataDir, states, complete);
  let lastSave = d.now();

  // 1. addresses, all chains in parallel
  await Promise.all(
    chains.map(async (c) => {
      const s = states[c.key] as ChainState;
      const start = Math.min(c.umbraStart, c.announcerStart);
      const before = s.lastBlock;
      complete[c.key] = await scanChain(rpcs[c.key]!, s, {
        start,
        head: heads[c.key]!,
        stop: () => d.now() > deadline,
        onProgress: () => {
          if (d.now() - lastSave > (o.saveEveryMs ?? 300_000)) {
            lastSave = d.now();
            save();
          }
        },
      });
      d.log(`${c.key}: scanned to block ${s.lastBlock} of ${heads[c.key]} (${before === 0 ? 'fresh' : 'resumed from ' + before}), ${s.addresses.size} addresses, complete=${complete[c.key]}`);
    }),
  );
  save();
  if (!chains.every((c) => complete[c.key])) {
    d.log('backfill not finished: checkpoint saved, TVU not published');
    return { complete: false, published: false, tvu: null };
  }

  // 2. cross check against sector.json (ephemeral routers are left out of both sides)
  const sector = await d.sector().catch(() => null);
  for (const c of chains) {
    const s = states[c.key] as ChainState;
    const ref = sector?.chains?.[c.key];
    d.log(`cross check ${c.key}: umbra ${s.umbra} vs sector ${ref?.umbra ?? 'n/a'}, erc5564 ${s.erc5564} vs sector ${ref?.erc5564 ?? 'n/a'}`);
  }

  // 3. prices first: no price, no publish
  const prices = await d.prices();
  d.log(`prices ETH ${prices.eth} POL ${prices.pol}`);

  // 4. value
  const results: ChainResult[] = [];
  const outliers = { count: 0, usd: 0 };
  let asOfSec = Infinity;
  for (const c of chains) {
    const rpc = rpcs[c.key]!;
    const s = states[c.key] as ChainState;
    const blockNum = heads[c.key]!;
    const block = '0x' + blockNum.toString(16);
    const blk = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [block, false]);
    asOfSec = Math.min(asOfSec, hexNum(blk.timestamp));
    const tokens = await verifyTokens(rpc, c, block, d.log);
    const addrs = [...s.addresses].filter((a) => !s.skip.has(skipHash(a))).sort();
    const vals = await readBalances(rpc, c, tokens, addrs, prices, block);
    const f = await applyFilters(rpc, vals, prices, block);
    const umbraPending = await readUmbraPending(rpc, tokens, prices, block);
    outliers.count += f.outliers.count;
    outliers.usd += f.outliers.usd;
    const r: ChainResult = {
      key: c.key,
      native: f.kept.reduce((x, v) => x + v.nativeUsd, 0),
      tokens: f.kept.reduce((x, v) => x + v.tokensUsd, 0),
      umbraPending,
      addresses: addrs.length,
    };
    results.push(r);
    d.log(`${c.key}: ${addrs.length} addresses, ${vals.length} with value, outliers ${f.outliers.count} (${Math.round(f.outliers.usd)} USD), native ${Math.round(r.native)}, tokens ${Math.round(r.tokens)}, umbra pending ${Math.round(r.umbraPending)}`);
  }

  // 5. build, check, publish
  const tvu = buildTvu(results, outliers, prices, asOfSec);
  const prevPath = join(o.dataDir, 'tvu.json');
  const prev = existsSync(prevPath) ? (JSON.parse(readFileSync(prevPath, 'utf8')) as Tvu) : null;
  sanityCheck(tvu, prev, process.env.TVU_ALLOW_JUMP === '1');
  d.log('summary ' + JSON.stringify({ totalUsd: tvu.totalUsd, parts: tvu.parts, byChain: tvu.byChain, excludedOutliers: tvu.excludedOutliers }));
  if (!o.publish) return { complete: true, published: false, tvu };
  writeFileSync(prevPath, JSON.stringify(tvu, null, 1) + '\n');
  return { complete: true, published: true, tvu };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (n: string, def?: string): string | undefined => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : def;
  };
  const dataDir = arg('--data', 'data') as string;
  const budgetMin = Number(arg('--budget-minutes', '300'));
  const publish = !args.includes('--no-publish');
  const res = await run(
    { dataDir, budgetMs: budgetMin * 60_000, publish },
    {
      async makeRpc(c) {
        const r = new FallbackRpc(rpcUrls(c));
        await r.verifyChain(c.chainId);
        return r;
      },
      prices: () => fetchPrices(fetch, (m) => console.log(m)),
      sector: async () => (await fetch(SECTOR_URL)).json() as never,
      now: () => Date.now(),
      log: (m) => console.log(m),
    },
  );
  if (res.tvu && !publish) writeFileSync(join(dataDir, 'tvu.preview.json'), JSON.stringify(res.tvu, null, 1) + '\n');
  console.log(res.published ? 'published tvu.json' : res.complete ? 'complete, not published' : 'incomplete');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
