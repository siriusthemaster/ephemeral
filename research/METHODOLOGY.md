# Methodology

Reference: Kovács, Seres. *Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum*, 2023, [arXiv:2308.01703](https://arxiv.org/abs/2308.01703).

Their Ethereum figure is **48.51%: 4,696 of 9,680 withdrawn Umbra stealth payments linked by H1 or H2** (H1 alone: 4,671, 48.25%). The same metric is reported for Arbitrum (65.7%), Optimism (52.6%) and Polygon (25.8%).

## What we report

| Field | Scope | Use |
| --- | --- | --- |
| `paperComparable` | Umbra payments, Umbra registrations and withdrawals before 2023-07-01 | should land near 48.51%: checks that this pipeline matches the paper |
| `sinceCutoff` | Umbra + ERC-5564, first paid on or after 2023-07-01 | the leak rate since the study |
| `all` | everything, full history | totals |
| `byYear` | by year of first payment | the trend |

Each scope reports `paperPct` (the paper's metric) and `identityPct` (wider: H1 or H2 over any withdrawal, plus H5).

## Data

| Step | Source | RPC method |
| --- | --- | --- |
| Payments | Umbra `Announcement`, ERC-5564 `Announcement` | `eth_getLogs` |
| Registrations | Umbra `StealthKeyChanged`, ERC-6538 `StealthMetaAddressSet` | `eth_getLogs` |
| Relayed Umbra token withdrawals | Umbra `TokenWithdrawal` (`acceptor` = recipient) | `eth_getLogs` |
| Payment sender | `from` of the payment transaction | `eth_getTransactionByHash` |
| Withdrawals | outgoing ETH, internal (mainnet), ERC-20, ERC-721, ERC-1155 transfers of every stealth address | `alchemy_getAssetTransfers` |
| Signer, type, fee | `from`, `type`, `maxPriorityFeePerGas` of each withdrawal | `eth_getTransactionByHash` |
| Gas funding (H5) | incoming ETH of token-only stealth addresses | `alchemy_getAssetTransfers` |
| Freshness | nonce of each stealth address just before its first payment | `eth_getTransactionCount` |
| Contracts | stealth addresses, recipients and funders with code (EIP-7702 delegation told apart) | `eth_getCode` |
| Cutoff block | first block on or after 2023-07-01, by binary search | `eth_getBlockByNumber` |

The scan ends at the `finalized` block, so a lagging transfer index cannot change a fixed range later. ERC-5564 metadata gives the asset: selector `0xeeeeeeee` is ETH, known ERC-20/721/1155 transfer selectors are tokens (bytes 5–24 are the token contract), anything else is unknown.

## Definitions

- **Unit of analysis:** the stealth address. Several payments to one stealth address count once.
- **Fresh:** a real stealth address has sent nothing before its first payment. Announced addresses that had (test or spam announcements to used wallets) are left out and counted in `quality.notFreshStealthAddresses`.
- **Owned withdrawal:** a transfer out of the stealth address at or after its first payment, outside the payment transaction, that the owner made: signed by the stealth address, an Umbra `TokenWithdrawal`, any transfer of a smart-account or EIP-7702 delegated stealth address, or a relayed move (permit, relayer) of the token that was paid in. A scammer's fake-token transfer "from" the address does not count; nor does history from before the first payment.
- **Withdrawn:** the paid asset left: ETH for an ETH payment, the token for a token payment.
- **Single withdrawal:** the paid asset left in exactly one transaction. A later sweep of leftover gas does not break it. The paper counts payments emptied in one transaction; we do not check the remaining balance.
- **H1, registrant reuse:** a recipient is a registrant. For `paperComparable`, only Umbra registrations before the cutoff; elsewhere, both registries.
- **H2, same sender and receiver:** a recipient is the `from` of a payment to that stealth address. The paper states the single-withdrawal rule for H1; we apply it to H2 too (H2 adds few links either way).
- **Paper metric:** H1 or H2 on the single withdrawal, over all withdrawn.
- **H3, collector pattern:** single withdrawals with one recipient, grouped by recipient; groups of two or more are clusters. Contract recipients (routers, the Umbra contract) are excluded to avoid false clusters.
- **H4, unique priority fee:** fee-market withdrawals (type 2 or later) signed by the stealth address. A `maxPriorityFeePerGas` used by at most five such transactions is unique; stealth addresses sharing one are clustered. The paper excluded all token payments; here self-signed token withdrawals are included, relayed ones are not.
- **H5, gas funding (ours):** a token-only stealth address that signed its own transaction needed ETH first. If ETH arrived between its first payment and its first signed transaction, from a registrant, or from an address the funds later went to, it is linked. ETH from the payer or from contracts does not count.
- **Linked to an identity (wider):** H1 or H2 on any owned withdrawal, or H5. H3 and H4 shrink the anonymity set but name no one.

## Reproducibility

The first run stores the end block, the cutoff block, a code version and a hash of the fetch settings in `.cache/<chain>/meta.json`. A different version, setting or `--to-block` starts clean. `--fresh --to-block <same block>` downloads everything again; the `fingerprint` in the summary must match the first run.

## Limits

- Implementations that never announce on-chain are invisible here.
- Exchange deposit addresses count as ordinary recipients.
- At most 10,000 transfers are read per address; the summary counts truncated lookups.
- These are lower bounds: real analysts also use timing, amounts and off-chain data.

## Privacy

The scan writes aggregate counts only. It never outputs which address was linked to whom, and we do not publish such lists. The raw cache in `.cache/` is public chain data and stays on the machine that ran the scan.
