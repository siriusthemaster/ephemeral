/** Build tvu.json and check it before it is written. */
import { METHOD_URL, RULES, type ChainKey } from './config.ts';
import type { Prices } from './value.ts';

export interface ChainResult {
  key: ChainKey;
  native: number;
  tokens: number;
  umbraPending: number;
  /** native currency Umbra holds (bug bounty 9 Nov) */
  umbraNative: number;
  addresses: number;
}

export interface Tvu {
  schema: 1;
  asOf: string;
  label: 'all protocols combined';
  totalUsd: number;
  parts: { stealthNative: number; stealthTokens: number; umbraPendingTokens: number; umbraPendingNative: number };
  byChain: Record<string, { usd: number; addresses: number }>;
  prices: { ETH: number; POL: number };
  rules: { maxNonce: number; maxEthEquivalent: number; excludeContracts: boolean };
  excludedOutliers: { count: number; usd: number };
  method: string;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;

export function buildTvu(chains: ChainResult[], outliers: { count: number; usd: number }, prices: Prices, asOfSec: number): Tvu {
  const parts = { stealthNative: 0, stealthTokens: 0, umbraPendingTokens: 0, umbraPendingNative: 0 };
  const byChain: Tvu['byChain'] = {};
  for (const c of chains) {
    parts.stealthNative += c.native;
    parts.stealthTokens += c.tokens;
    parts.umbraPendingTokens += c.umbraPending;
    parts.umbraPendingNative += c.umbraNative;
    byChain[c.key] = { usd: r2(c.native + c.tokens + c.umbraPending + c.umbraNative), addresses: c.addresses };
  }
  const rounded = {
    stealthNative: r2(parts.stealthNative),
    stealthTokens: r2(parts.stealthTokens),
    umbraPendingTokens: r2(parts.umbraPendingTokens),
    umbraPendingNative: r2(parts.umbraPendingNative),
  };
  return {
    schema: 1,
    asOf: new Date(asOfSec * 1000).toISOString().replace(/\.\d+Z$/, 'Z'),
    label: 'all protocols combined',
    totalUsd: r2(parts.stealthNative + parts.stealthTokens + parts.umbraPendingTokens + parts.umbraPendingNative),
    parts: rounded,
    byChain,
    prices: { ETH: prices.eth, POL: prices.pol },
    rules: { maxNonce: RULES.maxNonce, maxEthEquivalent: RULES.maxEthEquivalent, excludeContracts: RULES.excludeContracts },
    excludedOutliers: { count: outliers.count, usd: r2(outliers.usd) },
    method: METHOD_URL,
  };
}

/** Throws with the reason when the file must not be published. */
export function sanityCheck(t: Tvu, prev: Tvu | null, allowJump = false): void {
  const nums: number[] = [t.totalUsd, ...Object.values(t.parts), t.excludedOutliers.usd, t.excludedOutliers.count, t.prices.ETH, t.prices.POL];
  for (const c of Object.values(t.byChain)) nums.push(c.usd, c.addresses);
  if (nums.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) throw new Error('sanity: a number is NaN, infinite or negative');
  const partsSum = Object.values(t.parts).reduce((s, n) => s + n, 0);
  if (Math.abs(t.totalUsd - partsSum) > 0.05 * Object.keys(t.parts).length) throw new Error('sanity: parts do not add up to the total');
  const sum = Object.values(t.byChain).reduce((s, c) => s + c.usd, 0);
  if (Math.abs(t.totalUsd - sum) > 0.05 * Object.keys(t.byChain).length) throw new Error('sanity: chains do not add up to the total');
  if (!prev || allowJump) return;
  for (const [k, c] of Object.entries(t.byChain)) {
    const p = prev.byChain?.[k]?.usd;
    if (typeof p !== 'number') continue;
    // skipped only when both values are below the floor: a chain that falls from above it to near zero is the shape
    // of a failed read and stops the publish (METHOD.md, Checks; bug bounty 9 Nov: the text said "both above")
    if (p < RULES.jumpFloorUsd && c.usd < RULES.jumpFloorUsd) continue;
    if (c.usd > p * RULES.maxJumpFactor || c.usd * RULES.maxJumpFactor < p)
      throw new Error(`sanity: ${k} moved from ${p} to ${c.usd}, more than ${RULES.maxJumpFactor}x (check it, then run once with TVU_ALLOW_JUMP=1)`);
  }
}
