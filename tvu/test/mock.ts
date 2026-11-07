import { decodeFunctionData, encodeFunctionResult } from 'viem';
import { ANNOUNCER, ANNOUNCER_TOPIC0, EXCLUDED_CALLERS, MULTICALL3, UMBRA, UMBRA_TOPIC0, type ChainCfg } from '../config.ts';
import { RpcError, type Rpc } from '../rpc.ts';
import { ABI } from '../value.ts';

export const addr = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
const pad = (a: string): string => '0x' + a.replace(/^0x/, '').padStart(64, '0');
export const ETH = 10n ** 18n;
export const USDC = addr(0xc0ffee);

export const testChain: ChainCfg = {
  key: 'ethereum',
  chainId: 1,
  native: 'eth',
  umbraStart: 100,
  announcerStart: 100,
  rpcs: ['mock'],
  tokens: [{ symbol: 'USDC', symbolMatch: 'USDC', address: USDC, decimals: 6, kind: 'usd' }],
};

export const umbraLog = (stealth: string, block: number) => ({
  address: UMBRA,
  blockNumber: '0x' + block.toString(16),
  topics: [UMBRA_TOPIC0, pad(stealth), pad(addr(0xeee))],
});
export const annLog = (stealth: string, caller: string, block: number) => ({
  address: ANNOUNCER,
  blockNumber: '0x' + block.toString(16),
  topics: [ANNOUNCER_TOPIC0, pad(addr(1)), pad(stealth), pad(caller)],
});
export const ROUTER = EXCLUDED_CALLERS[0];

export class MockChain implements Rpc {
  logs: ReturnType<typeof umbraLog>[] = [];
  head = 1000;
  maxRange = 10_000_000;
  eth = new Map<string, bigint>();
  usdc = new Map<string, bigint>();
  umbraUsdc = 0n;
  codes = new Map<string, string>();
  nonces = new Map<string, number>();
  stats = { logCalls: 0, rangeErrors: 0, ethCalls: 0, maxSubcalls: 0 };

  async call<T>(method: string, params: unknown[]): Promise<T> {
    return (await this.one(method, params)) as T;
  }
  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    return Promise.all(calls.map((c) => this.one(c.method, c.params)));
  }
  private async one(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case 'eth_blockNumber':
        return '0x' + this.head.toString(16);
      case 'eth_getBlockByNumber':
        return { timestamp: '0x' + (1_800_000_000).toString(16) };
      case 'eth_getLogs': {
        this.stats.logCalls++;
        const f = params[0] as { fromBlock: string; toBlock: string };
        const from = Number(BigInt(f.fromBlock));
        const to = Number(BigInt(f.toBlock));
        if (to - from + 1 > this.maxRange) {
          this.stats.rangeErrors++;
          throw new RpcError(-32005, 'query exceeds max block range');
        }
        return this.logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
      }
      case 'eth_getCode':
        return this.codes.get(params[0] as string) ?? '0x';
      case 'eth_getTransactionCount':
        return '0x' + (this.nonces.get(params[0] as string) ?? 0).toString(16);
      case 'eth_call':
        return this.multicall((params[0] as { data: `0x${string}` }).data);
    }
    throw new Error('mock: unknown method ' + method);
  }
  private multicall(data: `0x${string}`): string {
    this.stats.ethCalls++;
    const { args } = decodeFunctionData({ abi: ABI, data }) as unknown as { args: [{ target: string; callData: `0x${string}` }[]] };
    this.stats.maxSubcalls = Math.max(this.stats.maxSubcalls, args[0].length);
    const out = args[0].map((c) => {
      const t = c.target.toLowerCase();
      const d = decodeFunctionData({ abi: ABI, data: c.callData });
      let ret: `0x${string}`;
      if (d.functionName === 'getEthBalance') {
        if (t !== MULTICALL3) return { success: false, returnData: '0x' as const };
        ret = encodeFunctionResult({ abi: ABI, functionName: 'getEthBalance', result: this.eth.get((d.args as unknown as string[])[0]!.toLowerCase()) ?? 0n });
      } else if (d.functionName === 'balanceOf') {
        const who = (d.args as unknown as string[])[0]!.toLowerCase();
        ret = encodeFunctionResult({ abi: ABI, functionName: 'balanceOf', result: who === UMBRA ? this.umbraUsdc : this.usdc.get(who) ?? 0n });
      } else if (d.functionName === 'symbol') {
        ret = encodeFunctionResult({ abi: ABI, functionName: 'symbol', result: 'USDC' });
      } else if (d.functionName === 'decimals') {
        ret = encodeFunctionResult({ abi: ABI, functionName: 'decimals', result: 6 });
      } else return { success: false, returnData: '0x' as const };
      return { success: true, returnData: ret };
    });
    return encodeFunctionResult({ abi: ABI, functionName: 'aggregate3', result: out });
  }
}
