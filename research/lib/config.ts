import { parseAbiItem, toEventSelector } from 'viem';

export type ChainName = 'mainnet' | 'sepolia';

export interface ChainConfig {
  name: ChainName;
  chainId: number;
  alchemySubdomain: string;
  /** Umbra (ScopeLift). Source: umbra-js/src/classes/Umbra.ts */
  umbra: string;
  /** Umbra StealthKeyRegistry. Source: umbra-js/src/classes/StealthKeyRegistry.ts */
  umbraRegistry: string;
  /** ERC-5564 singleton announcer and ERC-6538 registry. Source: stealth-address-sdk/src/config */
  announcer: string;
  registry6538: string;
  umbraStartBlock: bigint;
  erc5564StartBlock: bigint;
  erc6538StartBlock: bigint;
  /** alchemy_getAssetTransfers categories for outgoing/incoming value. `internal` is mainnet-only. */
  transferCategories: string[];
  fundingCategories: string[];
}

const SHARED = {
  umbra: '0xfb2dc580eed955b528407b4d36ffafe3da685401',
  umbraRegistry: '0x31fe56609c65cd0c510e7125f051d440424d38f3',
  announcer: '0x55649e01b5df198d18d95b5cc5051630cfd45564',
  registry6538: '0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6538',
} as const;

export const CHAINS: Record<ChainName, ChainConfig> = {
  mainnet: {
    name: 'mainnet',
    chainId: 1,
    alchemySubdomain: 'eth-mainnet',
    ...SHARED,
    umbraStartBlock: 12_343_914n,
    erc5564StartBlock: 20_042_207n,
    erc6538StartBlock: 20_042_207n,
    transferCategories: ['external', 'internal', 'erc20', 'erc721', 'erc1155'],
    fundingCategories: ['external', 'internal'],
  },
  sepolia: {
    name: 'sepolia',
    chainId: 11_155_111,
    alchemySubdomain: 'eth-sepolia',
    ...SHARED,
    umbraStartBlock: 3_590_825n,
    erc5564StartBlock: 5_486_597n,
    erc6538StartBlock: 5_538_412n,
    transferCategories: ['external', 'erc20', 'erc721', 'erc1155'],
    fundingCategories: ['external'],
  },
};

/** Umbra uses this placeholder as the token address of native ETH payments. */
export const ETH_PLACEHOLDER = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

export const EVENTS = {
  umbraAnnouncement: parseAbiItem(
    'event Announcement(address indexed receiver, uint256 amount, address indexed token, bytes32 pkx, bytes32 ciphertext)',
  ),
  umbraTokenWithdrawal: parseAbiItem(
    'event TokenWithdrawal(address indexed receiver, address indexed acceptor, uint256 amount, address indexed token)',
  ),
  umbraStealthKeyChanged: parseAbiItem(
    'event StealthKeyChanged(address indexed registrant, uint256 spendingPubKeyPrefix, uint256 spendingPubKey, uint256 viewingPubKeyPrefix, uint256 viewingPubKey)',
  ),
  erc5564Announcement: parseAbiItem(
    'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
  ),
  erc6538MetaAddressSet: parseAbiItem(
    'event StealthMetaAddressSet(address indexed registrant, uint256 indexed schemeId, bytes stealthMetaAddress)',
  ),
} as const;

export const TOPICS = {
  umbraAnnouncement: toEventSelector(EVENTS.umbraAnnouncement),
  umbraTokenWithdrawal: toEventSelector(EVENTS.umbraTokenWithdrawal),
  umbraStealthKeyChanged: toEventSelector(EVENTS.umbraStealthKeyChanged),
  erc5564Announcement: toEventSelector(EVENTS.erc5564Announcement),
  erc6538MetaAddressSet: toEventSelector(EVENTS.erc6538MetaAddressSet),
} as const;

/** ERC-5564 metadata: byte 0 view tag, bytes 1-4 selector. 0xeeeeeeee marks native ETH. */
export const ETH_SELECTOR = 'eeeeeeee';

/** Selectors that mark a token payment in ERC-5564 metadata (ERC-20, ERC-721, ERC-1155 transfers). */
export const TOKEN_SELECTORS = new Set([
  'a9059cbb', // transfer(address,uint256)
  '23b872dd', // transferFrom(address,address,uint256)
  '42842e0e', // safeTransferFrom(address,address,uint256)
  'b88d4fde', // safeTransferFrom(address,address,uint256,bytes)
  'f242432a', // safeTransferFrom(address,address,uint256,uint256,bytes)
]);

/** Bump when cached data formats or fetch parameters change; a mismatch clears the cache. */
export const SCAN_VERSION = 3;

/** Pages of 1,000 transfers read per address before the lookup is marked truncated. */
export const MAX_TRANSFER_PAGES = 10;

/** Kovács & Seres treat a priority fee as "unique" when at most this many withdrawals use it. */
export const UNIQUE_FEE_MAX = 5;

/**
 * The 2023 study was posted in August 2023. For the comparable figure we look at the chain as of
 * this date: Umbra payments, Umbra registrations and withdrawals before it.
 */
export const PAPER_CUTOFF_ISO = '2023-07-01T00:00:00Z';

/** The paper's Ethereum figure: H1 or H2 over all withdrawn stealth payments, 4,696 of 9,680. */
export const PAPER_ETHEREUM = { linked: 4_696, withdrawn: 9_680, pct: 48.51 } as const;
