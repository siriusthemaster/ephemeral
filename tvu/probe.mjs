// temporary probe of public RPC endpoints (removed before merge)
const U = '0xfb2dc580eed955b528407b4d36ffafe3da685401';
const T0 = '0x29877766fa2bfe3b90008d6d92f965eca91cbc5757ed775740e460799fb92219';
const starts = { 1: 12343914, 42161: 7285883, 10: 4069556, 137: 20750142, 8453: 10761374, 100: 28237950 };
const bs = { 1: 'eth', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 8453: 'base', 100: 'gnosis' };
const urls = {
  1: ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://rpc.ankr.com/eth', 'https://1rpc.io/eth', 'https://eth.drpc.org', 'https://cloudflare-eth.com', 'https://eth.merkle.io', 'https://eth-mainnet.public.blastapi.io'],
  42161: ['https://arbitrum-one-rpc.publicnode.com', 'https://arb1.arbitrum.io/rpc', 'https://rpc.ankr.com/arbitrum', 'https://1rpc.io/arb', 'https://arbitrum.drpc.org', 'https://arbitrum.meowrpc.com', 'https://arbitrum-one.public.blastapi.io'],
  10: ['https://optimism-rpc.publicnode.com', 'https://mainnet.optimism.io', 'https://rpc.ankr.com/optimism', 'https://1rpc.io/op', 'https://optimism.drpc.org', 'https://optimism.meowrpc.com'],
  137: ['https://polygon-bor-rpc.publicnode.com', 'https://polygon-rpc.com', 'https://rpc.ankr.com/polygon', 'https://1rpc.io/matic', 'https://polygon.drpc.org', 'https://polygon.meowrpc.com'],
  8453: ['https://base-rpc.publicnode.com', 'https://mainnet.base.org', 'https://rpc.ankr.com/base', 'https://1rpc.io/base', 'https://base.drpc.org', 'https://base.meowrpc.com', 'https://base-mainnet.public.blastapi.io'],
  100: ['https://gnosis-rpc.publicnode.com', 'https://rpc.gnosischain.com', 'https://rpc.ankr.com/gnosis', 'https://1rpc.io/gnosis', 'https://gnosis.drpc.org', 'https://gnosis.meowrpc.com'],
};
for (const id of Object.keys(urls)) urls[id].unshift(`https://${bs[id]}.blockscout.com/api/eth-rpc`);
async function rpc(url, body) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 25000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: c.signal });
    const x = await r.text();
    try { return JSON.parse(x); } catch { return { error: { message: `HTTP ${r.status} ${x.slice(0, 80)}` } }; }
  } catch (e) { return { error: { message: String(e.message || e).slice(0, 80) } }; } finally { clearTimeout(t); }
}
const h = (n) => '0x' + n.toString(16);
for (const [id, list] of Object.entries(urls)) {
  for (const url of list) {
    const out = [];
    const head = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });
    const hn = head.result ? Number(BigInt(head.result)) : 0;
    out.push('head ' + (hn || head.error?.message));
    const old = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: h(starts[id]), toBlock: h(starts[id] + 20000), address: U, topics: [T0] }] });
    out.push('old20k ' + (old.result ? old.result.length + ' logs' : old.error?.message));
    if (hn) {
      const rec = await rpc(url, { jsonrpc: '2.0', id: 1, method: 'eth_getLogs', params: [{ fromBlock: h(hn - 1000000), toBlock: h(hn - 12), address: U, topics: [T0] }] });
      out.push('recent1M ' + (rec.result ? rec.result.length + ' logs' : rec.error?.message));
    }
    const b = await rpc(url, [{ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [U, 'latest'] }, { jsonrpc: '2.0', id: 2, method: 'eth_getCode', params: [U, 'latest'] }]);
    out.push('batch ' + (Array.isArray(b) ? 'ok' : b.error?.message));
    console.log(`PROBE ${id} ${url} | ${out.join(' | ')}`);
  }
}
