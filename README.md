# ephemeral

Stealth payments for Ethereum, built on [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564).

Built in public. The first piece is a measurement: how often stealth payments on Ethereum can still be traced to their recipient. In 2023, Kovács & Seres, [*Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum*](https://arxiv.org/abs/2308.01703), linked 48.51% of withdrawn Umbra payments on Ethereum to their recipient. This scan reruns their heuristics on today's data, checks itself against their figure, and adds one heuristic of ours.

## What the scan measures

| | Heuristic | What it links |
| --- | --- | --- |
| H1 | Funds withdrawn to an address that registered stealth keys | stealth address → identity |
| H2 | Funds withdrawn back to the address that sent them | stealth address → identity |
| H3 | Several stealth addresses withdrawn to the same address | stealth addresses → one owner |
| H4 | Withdrawals sharing a rarely used `maxPriorityFeePerGas` | stealth addresses → one owner |
| H5 | Gas for a token-only stealth address paid by a registrant or by the final recipient (ours) | stealth address → identity |

Sources: the Umbra contract and its `StealthKeyRegistry`, the ERC-5564 `Announcer` singleton and the ERC-6538 registry. The summary reports the paper's metric for the chain as of mid-2023 (a self-check against 48.51%), for everything paid since, and per year. Definitions, choices and limits are in [research/METHODOLOGY.md](research/METHODOLOGY.md).

**Output is aggregate counts only.** `out/summary.json` and `out/summary.md` contain no address, cluster or link. Raw chain data stays in `.cache/` on the machine that ran the scan and is never published.

## Run it

You need Node 20+ and an [Alchemy](https://www.alchemy.com) key on the Pay As You Go plan. The free plan caps `eth_getLogs` at 10 blocks per call on Ethereum, which turns a history scan into days. A full mainnet scan costs a few dollars.

```bash
cp .env.example .env        # then put your key in .env: ALCHEMY_KEY=...
npm install
npm test                    # unit tests + an end-to-end scan against a fake node
npm run scan:sepolia        # smoke test on Sepolia
npm run scan                # Ethereum mainnet, full history
```

The first run fixes the end block at the latest finalized block (stored in `.cache/<chain>/meta.json`), so every later run reads the same range. An interrupted scan resumes from `.cache/`.

**Reproducibility check:** re-download the same range from scratch and compare fingerprints.

```bash
npm run scan -- --fresh --to-block <the block from the first run>
```

| Option | Default | Meaning |
| --- | --- | --- |
| `--chain` | `mainnet` | `mainnet` or `sepolia` |
| `--to-block` | finalized | last block to include |
| `--fresh` | off | delete the cache for this chain and download again |
| `--sample` | all | N stealth addresses spread evenly over time, for a quick look |
| `--concurrency` | 8 | parallel RPC requests |

## Contracts read

| Contract | Address | Scanned from block (mainnet) | Source |
| --- | --- | --- | --- |
| Umbra | `0xFb2dc580Eed955B528407b4d36FfaFe3da685401` | 12,343,914 | [umbra-js](https://github.com/ScopeLift/umbra-protocol/blob/master/umbra-js/src/classes/Umbra.ts) |
| Umbra StealthKeyRegistry | `0x31fe56609C65Cd0C510E7125f051D440424D38f3` | 12,343,914 | [umbra-js](https://github.com/ScopeLift/umbra-protocol/blob/master/umbra-js/src/classes/StealthKeyRegistry.ts) |
| ERC5564Announcer | `0x55649E01B5Df198D18D95b5cc5051630cfD45564` | 20,042,207 | [stealth-address-sdk](https://github.com/ScopeLift/stealth-address-sdk/tree/main/src/config) |
| ERC6538Registry | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` | 20,042,207 | [stealth-address-sdk](https://github.com/ScopeLift/stealth-address-sdk/tree/main/src/config) |

## What's in this repo

| Folder | What it is | Tests |
| --- | --- | --- |
| [`research/`](research/) | The scan above: how often ERC-5564 and Umbra payments can still be traced (H1 to H5) | `npm test` |
| [`router/`](router/) | StealthBuy: buy a token straight into a fresh stealth address (reverts if the address is not fresh or was ever used through this router), with receiver e2e tests: tip-only, a 12,345 wei top-up, a replayed buy, a replay after a full drain | `forge test`, `e2e/run.sh` |
| [`withdrawal-policy/`](withdrawal-policy/) | The client's guards against H1 to H5 when you withdraw; unknown or lagging history (tx count or token transfers) counts as incomplete | `node --test` |
| [`phases/`](phases/) | Season 1 points: Unbroken and First Light follow each token, reviewed in public by Claus Lab | `node --test` |
| [`payouts/`](payouts/) | StealthPayout (toy): pay many holders in one tx, each to a fresh stealth address. v1 equal amounts; v2 unequal debts as denomination notes. Private proof of entitlement | `forge test`, `node --test` |

Everything is MIT and unaudited unless a folder says otherwise. Found something? Open an issue.

## Roadmap

1. Explorer: public aggregate statistics for ERC-5564 on Ethereum and the leak rate over time. Checking your own stealth addresses happens only in your browser.
2. Client: send and receive with guards against H1–H5 on by default, and gas paid by a relayer so a stealth address never needs funding from your wallet.
3. Pay to an ENS name.

## License

MIT
