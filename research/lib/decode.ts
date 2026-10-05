import { decodeEventLog, type Hex } from 'viem';
import { ETH_PLACEHOLDER, ETH_SELECTOR, EVENTS, TOKEN_SELECTORS, TOPICS } from './config.ts';
import type { RawLog } from './logs.ts';
import { hexToNumber, lc } from './util.ts';

export type Asset = 'ETH' | 'TOKEN' | 'UNKNOWN';

export interface PaymentLog {
  source: 'umbra' | 'erc5564';
  txHash: string;
  blockNumber: number;
  logIndex: number;
  blockTimestamp?: number;
  stealth: string;
  asset: Asset;
  /** token contract for token payments, when known */
  token: string | null;
}

export interface TokenWithdrawalLog {
  txHash: string;
  blockNumber: number;
  stealth: string;
  acceptor: string;
  token: string;
}

export interface RegistrationLog {
  registrant: string;
  blockNumber: number;
  registry: 'umbra' | 'erc6538';
}

export interface Decoded {
  payments: PaymentLog[];
  tokenWithdrawals: TokenWithdrawalLog[];
  registrations: RegistrationLog[];
  skipped: number;
}

/**
 * ERC-5564 metadata: byte 0 view tag, bytes 1-4 transfer selector, bytes 5-24 token contract.
 * 0xeeeeeeee is native ETH; known ERC-20/721/1155 transfer selectors are tokens; anything else is unknown.
 */
export function parseMetadata(metadata: string): { asset: Asset; token: string | null } {
  const h = lc(metadata.startsWith('0x') ? metadata.slice(2) : metadata);
  if (h.length < 10) return { asset: 'UNKNOWN', token: null };
  const selector = h.slice(2, 10);
  if (selector === ETH_SELECTOR) return { asset: 'ETH', token: null };
  if (!TOKEN_SELECTORS.has(selector)) return { asset: 'UNKNOWN', token: null };
  return { asset: 'TOKEN', token: h.length >= 50 ? '0x' + h.slice(10, 50) : null };
}

export function decodeLogs(
  logs: readonly RawLog[],
  addrs: { umbra: string; umbraRegistry: string; announcer: string; registry6538: string },
): Decoded {
  const out: Decoded = { payments: [], tokenWithdrawals: [], registrations: [], skipped: 0 };
  for (const log of logs) {
    const address = lc(log.address);
    const topic0 = lc(log.topics[0] ?? '');
    const txHash = lc(log.transactionHash);
    const blockNumber = hexToNumber(log.blockNumber);
    const blockTimestamp = log.blockTimestamp ? hexToNumber(log.blockTimestamp) : undefined;
    const topics = log.topics as [Hex, ...Hex[]];
    const data = log.data as Hex;
    try {
      if (address === addrs.umbra && topic0 === TOPICS.umbraAnnouncement) {
        const { args } = decodeEventLog({ abi: [EVENTS.umbraAnnouncement], data, topics });
        const isEth = lc(args.token) === ETH_PLACEHOLDER;
        out.payments.push({
          source: 'umbra',
          txHash,
          blockNumber,
          blockTimestamp,
          logIndex: hexToNumber(log.logIndex),
          stealth: lc(args.receiver),
          asset: isEth ? 'ETH' : 'TOKEN',
          token: isEth ? null : lc(args.token),
        });
      } else if (address === addrs.umbra && topic0 === TOPICS.umbraTokenWithdrawal) {
        const { args } = decodeEventLog({ abi: [EVENTS.umbraTokenWithdrawal], data, topics });
        out.tokenWithdrawals.push({ txHash, blockNumber, stealth: lc(args.receiver), acceptor: lc(args.acceptor), token: lc(args.token) });
      } else if (address === addrs.umbraRegistry && topic0 === TOPICS.umbraStealthKeyChanged) {
        const { args } = decodeEventLog({ abi: [EVENTS.umbraStealthKeyChanged], data, topics });
        out.registrations.push({ registrant: lc(args.registrant), blockNumber, registry: 'umbra' });
      } else if (address === addrs.announcer && topic0 === TOPICS.erc5564Announcement) {
        const { args } = decodeEventLog({ abi: [EVENTS.erc5564Announcement], data, topics });
        out.payments.push({
          source: 'erc5564',
          txHash,
          blockNumber,
          blockTimestamp,
          logIndex: hexToNumber(log.logIndex),
          stealth: lc(args.stealthAddress),
          ...parseMetadata(args.metadata),
        });
      } else if (address === addrs.registry6538 && topic0 === TOPICS.erc6538MetaAddressSet) {
        const { args } = decodeEventLog({ abi: [EVENTS.erc6538MetaAddressSet], data, topics });
        out.registrations.push({ registrant: lc(args.registrant), blockNumber, registry: 'erc6538' });
      } else {
        out.skipped++;
      }
    } catch {
      out.skipped++;
    }
  }
  return out;
}
