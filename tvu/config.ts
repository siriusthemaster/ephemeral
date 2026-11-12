/**
 * Total value unlinked (TVU): configuration. See METHOD.md for the rules.
 * Everything that decides what is counted lives here or in METHOD.md, nothing is hidden in the code.
 */

export type ChainKey = 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | 'base' | 'gnosis';
export type PriceKind = 'usd' | 'eth';

export interface TokenCfg {
  symbol: string;
  /** Symbol must contain this text (case insensitive), checked on chain at run time. */
  symbolMatch: string;
  address: string;
  decimals: number;
  /** usd: stablecoin counted at 1 USD. eth: wrapped ether counted at the ETH price. */
  kind: PriceKind;
}

export interface ChainCfg {
  key: ChainKey;
  chainId: number;
  /** native asset price: eth = ETH-USD, pol = POL-USD, usd = xDAI at 1 USD */
  native: 'eth' | 'pol' | 'usd';
  /** First block to scan for Umbra and for the ERC-5564 announcer. */
  umbraStart: number;
  announcerStart: number;
  rpcs: string[];
  tokens: TokenCfg[];
}

/** Ephemeral routers. Announcements called by these are never counted. Same list as excluded.erc5564Callers in stats-data/sector.json. */
export const EXCLUDED_CALLERS = [
  '0xeed50c2f906af5e53f851d21be79dd66faddde37',
  '0x2311918fcd469848b99e787541720cc12a4f4123',
] as const;

export const UMBRA = '0xfb2dc580eed955b528407b4d36ffafe3da685401';
export const ANNOUNCER = '0x55649e01b5df198d18d95b5cc5051630cfd45564';
export const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
export const UMBRA_TOPIC0 = '0x29877766fa2bfe3b90008d6d92f965eca91cbc5757ed775740e460799fb92219';
export const ANNOUNCER_TOPIC0 = '0x5f0eab8057630ba7676c49b4f21a0231414e79474595be8e4c432fbf6bf0f4e7';

export const RULES = {
  /** Addresses whose current nonce is above this are not fresh stealth addresses. */
  maxNonce: 1000,
  /** A single address worth more than this many ETH (at the ETH price) is treated as spoofed or not a stealth payment. */
  maxEthEquivalent: 250,
  excludeContracts: true,
  /** Reads happen this many blocks behind the head. */
  confirmations: 12,
  /** The previous file is compared per chain; a move beyond this factor stops the publish. */
  maxJumpFactor: 5,
  /** Jump check is skipped only when both values are below this many USD (a fall from above it still stops). */
  jumpFloorUsd: 1000,
  /** tvu.json older than this is hidden by the site (3 days). */
  maxAgeDays: 3,
} as const;

export const METHOD_URL = 'https://github.com/siriusthemaster/ephemeral/blob/main/tvu/METHOD.md';
export const SECTOR_URL = 'https://raw.githubusercontent.com/siriusthemaster/ephemeral/stats-data/sector.json';

// Umbra deploy blocks: Etherscan family contract creation lookups (getcontractcreation) for 0xFb2dc5...5401,
// 7 Nov 2026. Ethereum start is research/lib/config.ts (umbraStartBlock).
// Token addresses are the official deployments listed on the issuers' pages (Circle, Tether, Sky/MakerDAO) and
// each chain's canonical WETH; they are also checked on chain at every run (symbol and decimals), a token that
// does not match is skipped and logged.
const t = (symbol: string, address: string, decimals: number, kind: PriceKind = 'usd', symbolMatch = symbol): TokenCfg => ({
  symbol,
  symbolMatch,
  address: address.toLowerCase(),
  decimals,
  kind,
});

export const CHAINS: ChainCfg[] = [
  {
    key: 'ethereum',
    chainId: 1,
    native: 'eth',
    umbraStart: 12_343_914,
    announcerStart: 20_042_207,
    rpcs: ['https://eth.blockscout.com/api/eth-rpc', 'https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org'],
    tokens: [
      t('USDC', '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 6),
      t('USDT', '0xdAC17F958D2ee523a2206206994597C13D831ec7', 6),
      t('DAI', '0x6B175474E89094C44Da98b954EedeAC495271d0F', 18),
      t('WETH', '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 18, 'eth'),
    ],
  },
  {
    key: 'arbitrum',
    chainId: 42161,
    native: 'eth',
    umbraStart: 7_285_883,
    announcerStart: 7_285_883,
    rpcs: ['https://arb1.arbitrum.io/rpc', 'https://arbitrum-one-rpc.publicnode.com', 'https://arbitrum.drpc.org'],
    tokens: [
      t('USDC', '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 6),
      t('USDC.e', '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8', 6, 'usd', 'USDC'),
      t('USDT', '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', 6, 'usd', 'USD'),
      t('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18),
      t('WETH', '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1', 18, 'eth'),
    ],
  },
  {
    key: 'optimism',
    chainId: 10,
    native: 'eth',
    umbraStart: 4_069_556,
    announcerStart: 4_069_556,
    rpcs: ['https://mainnet.optimism.io', 'https://optimism-rpc.publicnode.com', 'https://optimism.drpc.org'],
    tokens: [
      t('USDC', '0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85', 6),
      t('USDC.e', '0x7F5c764cBc14f9669B88837ca1490cCa17c31607', 6, 'usd', 'USDC'),
      t('USDT', '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', 6, 'usd', 'USD'),
      t('DAI', '0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1', 18),
      t('WETH', '0x4200000000000000000000000000000000000006', 18, 'eth'),
    ],
  },
  {
    key: 'polygon',
    chainId: 137,
    native: 'pol',
    umbraStart: 20_750_142,
    announcerStart: 20_750_142,
    rpcs: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon.drpc.org', 'https://polygon-rpc.com'],
    tokens: [
      t('USDC', '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359', 6),
      t('USDC.e', '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174', 6, 'usd', 'USDC'),
      t('USDT', '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', 6, 'usd', 'USD'),
      t('DAI', '0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063', 18),
      t('WETH', '0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619', 18, 'eth'),
    ],
  },
  {
    key: 'base',
    chainId: 8453,
    native: 'eth',
    umbraStart: 10_761_374,
    announcerStart: 10_761_374,
    rpcs: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://base.drpc.org'],
    tokens: [
      t('USDC', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 6),
      t('USDbC', '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', 6, 'usd', 'USD'),
      t('USDT', '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', 6, 'usd', 'USD'),
      t('DAI', '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', 18),
      t('WETH', '0x4200000000000000000000000000000000000006', 18, 'eth'),
    ],
  },
  {
    key: 'gnosis',
    chainId: 100,
    native: 'usd',
    umbraStart: 28_237_950,
    announcerStart: 28_237_950,
    rpcs: ['https://rpc.gnosischain.com', 'https://gnosis-rpc.publicnode.com', 'https://gnosis.drpc.org'],
    tokens: [
      t('USDC', '0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83', 6),
      t('USDT', '0x4ECaBa5870353805a9F068101A40E0f32ed605C6', 6, 'usd', 'USD'),
      t('WXDAI', '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', 18, 'usd', 'XDAI'),
      t('WETH', '0x6A023CCd1ff6F2045C3309768eAd9E68F978f6e1', 18, 'eth'),
    ],
  },
];

// Public endpoint notes from a probe run on GitHub Actions (7 Nov 2026): most free endpoints refuse old or wide
// eth_getLogs (publicnode needs a token for archive reads, drpc allows 10,000 blocks, others return 403 or 429), so the
// list is short. Set RPC_<CHAIN> to a keyed endpoint to make the first scan much faster.
/** RPC_ETHEREUM etc. (comma separated) are tried before the built in public endpoints. */
export function rpcUrls(c: ChainCfg, env: Record<string, string | undefined> = process.env): string[] {
  const extra = (env[`RPC_${c.key.toUpperCase()}`] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return [...extra, ...c.rpcs];
}
