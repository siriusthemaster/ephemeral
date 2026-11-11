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
import { randomInt } from 'node:crypto';
import { loadCheckpoint, saveCheckpoint, type ChainState } from './checkpoint.ts';
import { buildTvu, sanityCheck, type ChainResult, type Tvu } from './output.ts';
import { fetchPrices } from './prices.ts';
import { FallbackRpc, type Rpc } from './rpc.ts';
import { scanChain } from './scan.ts';
import { applyFilters, CALLS_PER_BATCH, readBalances, readTogether, readUmbraPending, verifyTokens, type Prices } from './value.ts';

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
  scanPauseMs?: number;
}

export interface RunResult {
  complete: boolean;
  published: boolean;
  tvu: Tvu | null;
}

/** A copy in a random order (Fisher-Yates over crypto randomness): nobody can know which address is read when. */
const shuffled = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j] as T, a[i] as T];
  }
  return a;
};
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
      let lastLog = 0;
      const seenMsgs = new Set<string>();
      try {
        complete[c.key] = await scanChain(rpcs[c.key]!, s, {
          start,
          pauseMs: o.scanPauseMs,
          head: heads[c.key]!,
          stop: () => d.now() > deadline,
          onRangeError: (m, span) => {
            const key = m.slice(0, 60);
            if (seenMsgs.size < 8 && !seenMsgs.has(key)) {
              seenMsgs.add(key);
              d.log(`${c.key}: range of ${span} blocks refused: ${m.slice(0, 700)}`);
            }
          },
          onProgress: () => {
            if (d.now() - lastSave > (o.saveEveryMs ?? 300_000)) {
              lastSave = d.now();
              save();
            }
            if (d.now() - lastLog > 120_000) {
              lastLog = d.now();
              d.log(`${c.key}: progress block ${s.lastBlock} of ${heads[c.key]}, span ${s.span}, ${s.addresses.size} addresses`);
            }
          },
        });
      } catch (e) {
        complete[c.key] = false;
        d.log(`${c.key}: scan stopped by an error at block ${s.lastBlock}: ${e instanceof Error ? e.message : String(e)}`);
      }
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
    // Values are read at the latest block, batch by batch. A fixed block fails on public nodes without archive
    // state: the scan can take hours, and on Arbitrum even the minutes a rate-limited read waits are too long
    // ("Unknown state", 7 and 8 Nov). Addresses announced after the scan block are added by the next run.
    const block = 'latest';
    const blk = await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [block, false]);
    asOfSec = Math.min(asOfSec, hexNum(blk.timestamp));
    const tokens = await verifyTokens(rpc, c, block, d.log);
    // Every address an announcement by anyone but our routers named (bug bounty 8 Nov: a router announcement of
    // somebody else's address no longer takes it out of the number; `s.addresses` never holds router-only ones).
    const addrs = [...s.addresses].sort();
    const vals = await readBalances(rpc, c, tokens, addrs, prices, block);
    const f = await applyFilters(rpc, vals, prices, block);
    let umbra = await readUmbraPending(rpc, c, tokens, prices, block);
    // Every address with value is read a second time, after the Umbra read, in a random order, and the smaller of
    // its two reads counts (bug bounty 8 Nov). Read batch by batch, one pot moved from address to address while the
    // run reads was counted at every address it reached, and a balance moved into Umbra was counted twice. Now funds
    // that move during the run count at most once; funds that left during it may count nowhere (an undercount).
    const again = new Map((await readBalances(rpc, c, tokens, shuffled(f.kept.map((v) => v.address)), prices, block)).map((v) => [v.address, v]));
    const kept = f.kept.map((v) => ({
      address: v.address,
      nativeUsd: Math.min(v.nativeUsd, again.get(v.address)?.nativeUsd ?? 0),
      tokensUsd: Math.min(v.tokensUsd, again.get(v.address)?.tokensUsd ?? 0),
    }));
    // Then the largest holders and Umbra once more, all in ONE call, so at one block, and each keeps the smallest of
    // its reads (bug bounty 9 Nov: a pot moved back and forth between two addresses on every block could sit at each
    // of them for both of its reads and count twice). In one call a pot is at one place only. If the node refuses
    // the call as too heavy, half as many of the largest holders are read together.
    const per = 1 + tokens.length;
    const top = kept.filter((v) => v.nativeUsd + v.tokensUsd > 0).sort((x, y) => y.nativeUsd + y.tokensUsd - (x.nativeUsd + x.tokensUsd));
    for (let k = Math.min(top.length, Math.floor(CALLS_PER_BATCH / per) - 1); k >= 0; k = k === 0 ? -1 : Math.floor(k / 2)) {
      const together = await readTogether(rpc, c, tokens, top.slice(0, k).map((v) => v.address), prices, block);
      if (together === null) continue;
      for (const v of top.slice(0, k)) {
        const t = together.vals.get(v.address);
        v.nativeUsd = Math.min(v.nativeUsd, t?.nativeUsd ?? 0);
        v.tokensUsd = Math.min(v.tokensUsd, t?.tokensUsd ?? 0);
      }
      umbra = { native: Math.min(umbra.native, together.umbra.native), tokens: Math.min(umbra.tokens, together.umbra.tokens) };
      if (k < top.length) d.log(`${c.key}: the ${k} largest of ${top.length} holders read together`);
      break;
    }
    outliers.count += f.outliers.count;
    outliers.usd += f.outliers.usd;
    const r: ChainResult = {
      key: c.key,
      native: kept.reduce((x, v) => x + v.nativeUsd, 0),
      tokens: kept.reduce((x, v) => x + v.tokensUsd, 0),
      umbraPending: umbra.tokens,
      umbraNative: umbra.native,
      addresses: addrs.length,
    };
    results.push(r);
    d.log(`${c.key}: ${addrs.length} addresses, ${vals.length} with value, outliers ${f.outliers.count} (${Math.round(f.outliers.usd)} USD), native ${Math.round(r.native)}, tokens ${Math.round(r.tokens)}, umbra pending ${Math.round(r.umbraPending)} tokens, ${Math.round(r.umbraNative)} native`);
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
    { dataDir, budgetMs: budgetMin * 60_000, publish, scanPauseMs: 150 },
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
