// Receiver test for StealthBuy, on a local anvil chain only (chain id 31337). Run it with ./run.sh.
//
// 1. The receiver signs the frozen key message: ERC-5564 scheme-1 spending + viewing keys, and a stealth meta-address.
// 2. A buyer (another account) knows only that meta-address. It derives a one-time stealth address and calls
//    StealthBuy.buy with a small swap and a 0.001 ETH gas tip. A second buy for someone else is the decoy.
// 3. The receiver finds the payment from the Announcer's logs alone, with its viewing private key and spending public key.
// 4. The receiver derives the stealth private key and moves the tokens, then the leftover ETH, to a brand-new address.
//    Gas comes ONLY from the tip: every ETH movement into the stealth address, top-level or internal, is traced and
//    there is exactly one, the tip inside the buy transaction.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  formatEther,
  getAddress,
  http,
  isAddressEqual,
  parseAbiItem,
  parseEther,
  size,
  toHex,
  type Address,
  type Hex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import {
  KEY_MESSAGE_V1,
  SCHEME_ID,
  generateStealthAddress,
  keysFromSignature,
  metaAddressOf,
  parseMetaAddress,
  parseMetadata,
  stealthAddressFor,
  stealthPrivateKey,
  viewTagMatch,
  type GeneratedStealth,
  type StealthKeys,
} from './stealth.ts';

type Deployment = {
  chainId: number;
  startBlock: number;
  announcer: Address;
  poolManager: Address;
  token: Address;
  stealthBuy: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const dep = JSON.parse(readFileSync(new URL('./local.json', import.meta.url), 'utf8')) as Deployment;
const transport = http(RPC);
const pub = createPublicClient({ chain: foundry, transport });
assert.equal(await pub.getChainId(), 31337, 'local anvil chain only');
assert.equal(dep.chainId, 31337);

const TIP = parseEther('0.001'); // the bundled gas
const SWAP = parseEther('0.05'); // the ETH swapped for the token
const TRANSFER_SELECTOR = '0xa9059cbb';
const poolKey = {
  currency0: '0x0000000000000000000000000000000000000000',
  currency1: dep.token,
  fee: dep.fee,
  tickSpacing: dep.tickSpacing,
  hooks: dep.hooks,
} as const;
const announcementEvent = parseAbiItem(
  'event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)',
);
const stealthBuyAbi = [
  {
    type: 'function',
    name: 'buy',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'key',
        type: 'tuple',
        components: [
          { name: 'currency0', type: 'address' },
          { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' },
          { name: 'tickSpacing', type: 'int24' },
          { name: 'hooks', type: 'address' },
        ],
      },
      {
        name: 's',
        type: 'tuple',
        components: [
          { name: 'stealthAddress', type: 'address' },
          { name: 'ephemeralPubKey', type: 'bytes' },
          { name: 'viewTag', type: 'bytes1' },
          { name: 'minOut', type: 'uint256' },
          { name: 'gasTip', type: 'uint256' },
        ],
      },
      { name: 'hookData', type: 'bytes' },
    ],
    outputs: [{ name: 'tokensOut', type: 'uint256' }],
  },
] as const;

const ethOf = (address: Address) => pub.getBalance({ address });
const nonceOf = (address: Address) => pub.getTransactionCount({ address });
const tokensOf = (address: Address) =>
  pub.readContract({ address: dep.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] });

// Anvil's unlocked accounts: #1 is the receiver, #2 the buyer, #3 the decoy receiver. #0 deployed the contracts.
const [, receiverEOA, buyerEOA, decoyEOA] = await createWalletClient({ chain: foundry, transport }).getAddresses();

// ------------------------------------------------------------------------------------------------ receiver: keys
/** One signature of the frozen message -> spending and viewing keys (ERC-5564 scheme 1). Signed twice: must be equal. */
async function keysOf(account: Address): Promise<StealthKeys> {
  const w = createWalletClient({ chain: foundry, transport, account });
  const a = await w.signMessage({ message: KEY_MESSAGE_V1 });
  const b = await w.signMessage({ message: KEY_MESSAGE_V1 });
  assert.equal(a, b, 'deterministic signature, so the keys can be recreated');
  return keysFromSignature(a);
}
const keys = await keysOf(receiverEOA);
const metaAddress = metaAddressOf(keys); // all the buyer ever gets (in practice: from ERC-6538, ENS or a st:eth: link)
assert.equal(size(metaAddress), 66);

// ------------------------------------------------------------------------------------------------ buyer: knows the meta-address only
const buyer = createWalletClient({ chain: foundry, transport, account: buyerEOA });

async function stealthBuy(g: GeneratedStealth) {
  const s = {
    stealthAddress: g.stealthAddress,
    ephemeralPubKey: g.ephemeralPublicKey,
    viewTag: toHex(g.viewTag, { size: 1 }),
    minOut: 0n,
    gasTip: TIP,
  };
  const value = SWAP + TIP;
  const { result: quoted } = await pub.simulateContract({
    account: buyerEOA, address: dep.stealthBuy, abi: stealthBuyAbi, functionName: 'buy', args: [poolKey, s, '0x'], value,
  });
  const hash = await buyer.writeContract({
    address: dep.stealthBuy, abi: stealthBuyAbi, functionName: 'buy', args: [poolKey, { ...s, minOut: (quoted * 99n) / 100n }, '0x'], value,
  });
  const r = await pub.waitForTransactionReceipt({ hash });
  assert.equal(r.status, 'success', 'buy succeeded');
  return { hash, quoted };
}

// decoy: the same buyer buys for somebody else first, so the receiver's scan has an announcement that is not theirs
const decoyKeys = await keysOf(decoyEOA);
const decoy = await stealthBuy(generateStealthAddress(parseMetaAddress(metaAddressOf(decoyKeys))));

const g = generateStealthAddress(parseMetaAddress(metaAddress));
const stealth = getAddress(g.stealthAddress);
// before the buy the stealth address is untouched: no ETH, no tokens, no transactions, no code
assert.equal(await ethOf(stealth), 0n, 'stealth address starts with 0 ETH');
assert.equal(await nonceOf(stealth), 0, 'stealth address starts with nonce 0');
assert.equal(await tokensOf(stealth), 0n);
assert.equal((await pub.getCode({ address: stealth })) ?? '0x', '0x');
const buy = await stealthBuy(g);
assert.equal(await ethOf(stealth), TIP, 'right after the buy the stealth address holds exactly the tip');
assert.equal(await tokensOf(stealth), buy.quoted, 'tokens landed on the stealth address');
assert.equal(await ethOf(dep.stealthBuy), 0n, 'the router keeps nothing');

// ------------------------------------------------------------------------------------------------ receiver: discovery from chain logs only
/** Scans every Announcement since `fromBlock`; needs only the viewing private key and the spending public key. */
async function discover(k: Pick<StealthKeys, 'viewingPrivateKey' | 'spendingPublicKey'>, fromBlock: bigint) {
  const logs = await pub.getLogs({ address: dep.announcer, event: announcementEvent, fromBlock, toBlock: 'latest', strict: true });
  const mine = [];
  for (const l of logs) {
    const { schemeId, stealthAddress, caller, ephemeralPubKey, metadata } = l.args;
    if (schemeId !== SCHEME_ID || size(metadata) < 1) continue;
    const meta = parseMetadata(metadata);
    const hashed = viewTagMatch(k.viewingPrivateKey, ephemeralPubKey, meta.viewTag); // drops 255/256 of the others
    if (!hashed) continue;
    if (!isAddressEqual(stealthAddressFor(k.spendingPublicKey, hashed), stealthAddress)) continue;
    mine.push({ stealthAddress, caller, ephemeralPubKey, metadata, meta, tx: l.transactionHash });
  }
  return { checked: logs.length, mine };
}
const { checked, mine } = await discover(keys, BigInt(dep.startBlock));
assert.ok(checked >= 2, 'the scan saw the decoy announcement too');
assert.equal(mine.length, 1, 'exactly one announcement is ours');
const hit = mine[0];
assert.ok(isAddressEqual(hit.stealthAddress, stealth), 'found exactly this stealth address');
assert.equal(hit.tx, buy.hash, 'announced in the buy transaction');
assert.ok(isAddressEqual(hit.caller, dep.stealthBuy), 'announced by StealthBuy');
// 57-byte ERC-5564 token metadata: view tag | transfer selector | token | amount
assert.equal(size(hit.metadata), 57, '57-byte metadata');
assert.equal(hit.meta.selector, TRANSFER_SELECTOR);
assert.ok(isAddressEqual(hit.meta.token!, dep.token), 'metadata names the token');
assert.equal(hit.meta.amount, buy.quoted, 'metadata carries the amount');
assert.equal(await tokensOf(stealth), hit.meta.amount, 'the announced amount is on the address');
// the decoy receiver's keys find its payment and not ours
const { checked: decoyChecked, mine: decoyMine } = await discover(decoyKeys, BigInt(dep.startBlock));
assert.equal(decoyChecked, checked);
assert.equal(decoyMine.length, 1, 'the decoy receiver finds only its own payment');
assert.ok(!isAddressEqual(decoyMine[0].stealthAddress, stealth));

// ------------------------------------------------------------------------------------------------ receiver: spend with the tip only
const pk = stealthPrivateKey(keys.spendingPrivateKey, keys.viewingPrivateKey, hit.ephemeralPubKey);
const stealthAccount = privateKeyToAccount(pk);
assert.equal(stealthAccount.address, stealth, 'the derived private key controls the stealth address');
// a local account: transactions are signed here with the derived key and sent raw (no unlocked or impersonated account)
const spender = createWalletClient({ chain: foundry, transport, account: stealthAccount });
const fresh = privateKeyToAccount(generatePrivateKey()).address;
assert.equal(await ethOf(fresh), 0n);
assert.equal(await nonceOf(fresh), 0);

/** maxFeePerGas = maxPriorityFeePerGas = price, so the price paid is exactly `price` (it is above any next base fee). */
async function price() {
  const { baseFeePerGas } = await pub.getBlock({ blockTag: 'latest' });
  return 2n * baseFeePerGas! + 1n;
}

// 1) the whole token balance
const ethBeforeSpend = await ethOf(stealth);
assert.equal(ethBeforeSpend, TIP, 'before the spend the stealth address holds exactly the tip, nothing else');
assert.equal(await nonceOf(stealth), 0);
const amount = await tokensOf(stealth);
const p1 = await price();
const gas1 =
  ((await pub.estimateContractGas({ account: stealth, address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [fresh, amount] })) *
    12n) /
  10n;
assert.ok(gas1 * p1 <= ethBeforeSpend, 'worst-case fee of the token transfer fits inside the tip');
const spendTx = await spender.writeContract({
  address: dep.token, abi: erc20Abi, functionName: 'transfer', args: [fresh, amount], gas: gas1, maxFeePerGas: p1, maxPriorityFeePerGas: p1,
});
const r1 = await pub.waitForTransactionReceipt({ hash: spendTx });
assert.equal(r1.status, 'success', 'token transfer from the stealth address succeeded');
// the fee is checked on the balance itself (anvil's receipt.effectiveGasPrice ignores the maxFeePerGas cap)
const fee1 = r1.gasUsed * p1;
assert.equal(await ethOf(stealth), TIP - fee1, 'gas was paid out of the tip, at exactly the price set');
assert.equal(await tokensOf(fresh), amount, 'all tokens at the fresh address');
assert.equal(await tokensOf(stealth), 0n);

// 2) the leftover ETH: balance minus the exact fee of a plain transfer
const left = await ethOf(stealth);
const p2 = await price();
const fee2 = 21_000n * p2;
assert.ok(left > fee2, 'enough tip left to sweep');
const sweepTx = await spender.sendTransaction({ to: fresh, value: left - fee2, gas: 21_000n, maxFeePerGas: p2, maxPriorityFeePerGas: p2 });
const r2 = await pub.waitForTransactionReceipt({ hash: sweepTx });
assert.equal(r2.status, 'success');
assert.equal(r2.gasUsed, 21_000n);
assert.equal(await ethOf(stealth), 0n, 'stealth address left with exactly 0 ETH');
assert.equal(await ethOf(fresh), left - fee2);
assert.equal(await tokensOf(fresh), buy.quoted, 'the fresh address holds every token bought');
assert.equal(await nonceOf(stealth), 2, 'the stealth address sent exactly two transactions');

// ------------------------------------------------------------------------------------------------ audit: where did the stealth address's ETH come from?
// Every block since setup, every call frame (trace_block includes internal calls, self-destructs and rewards).
type Trace = {
  type: string;
  transactionHash: Hex | null;
  action: { from?: Address; to?: Address; value?: Hex; address?: Address; refundAddress?: Address; balance?: Hex; author?: Address };
  result?: { address?: Address } | null;
};
const rpc = pub.request as unknown as (a: { method: string; params: unknown[] }) => Promise<unknown>;
const head = await pub.getBlockNumber({ cacheTime: 0 }); // not viem's cached value: the audit must reach the last block
assert.ok(head >= r2.blockNumber, 'the audit covers the sweep');
const inflows: { tx: Hex | null; from?: Address; value: bigint; type: string }[] = [];
const txsTo: Hex[] = [];
const txsFrom: Hex[] = [];
for (let b = BigInt(dep.startBlock); b <= head; b++) {
  const block = await pub.getBlock({ blockNumber: b, includeTransactions: true });
  assert.ok(!isAddressEqual(block.miner, stealth), 'never a block producer');
  for (const w of block.withdrawals ?? []) assert.ok(!isAddressEqual(w.address, stealth), 'never a withdrawal recipient');
  for (const tx of block.transactions) {
    if (tx.to && isAddressEqual(tx.to, stealth)) txsTo.push(tx.hash);
    if (isAddressEqual(tx.from, stealth)) txsFrom.push(tx.hash);
  }
  for (const t of (await rpc({ method: 'trace_block', params: [toHex(b)] })) as Trace[]) {
    const a = t.action ?? {};
    const target = a.to ?? a.refundAddress ?? a.author ?? t.result?.address;
    const value = BigInt(a.value ?? a.balance ?? '0x0');
    if (target && isAddressEqual(target, stealth) && value > 0n)
      inflows.push({ tx: t.transactionHash, from: a.from ?? a.address, value, type: t.type });
  }
}
assert.deepEqual(txsTo, [], 'no transaction was ever sent to the stealth address');
assert.equal(inflows.length, 1, 'exactly one ETH transfer ever reached the stealth address');
assert.equal(inflows[0].tx, buy.hash, '... inside the buy transaction');
assert.ok(isAddressEqual(inflows[0].from!, dep.stealthBuy), '... from the StealthBuy router');
assert.equal(inflows[0].value, TIP, '... and it is the tip');
assert.deepEqual(txsFrom, [spendTx, sweepTx], 'the stealth address sent only the token spend and the sweep');
assert.equal(TIP, fee1 + fee2 + (left - fee2), 'ledger: tip = gas for both transactions + ETH swept');

const short = (h: Hex) => `${h.slice(0, 10)}…${h.slice(-6)}`;
console.log(`receiver test PASS (anvil ${RPC}, blocks ${dep.startBlock}..${head})
  receiver meta-address   st:eth:${metaAddress.slice(0, 14)}…  (anvil #1 signature, ERC-5564 scheme 1)
  decoy buy               ${short(decoy.hash)}  (another receiver)
  buy                     ${short(buy.hash)}  ${formatEther(SWAP)} ETH -> ${formatEther(buy.quoted)} TKN to ${stealth}, tip ${formatEther(TIP)} ETH
  discovered              1 of ${checked} announcements via view tag + viewing key; metadata 57 bytes: token ${dep.token}, amount ${formatEther(hit.meta.amount!)}
  token spend             ${short(spendTx)}  ${formatEther(amount)} TKN -> fresh ${fresh}, fee ${formatEther(fee1)} ETH from the tip
  ETH sweep               ${short(sweepTx)}  ${formatEther(left - fee2)} ETH -> fresh, fee ${formatEther(fee2)} ETH; stealth address now 0 ETH
  funding audit           only ETH ever received: ${formatEther(TIP)} ETH from StealthBuy in the buy tx (all call frames traced)`);
