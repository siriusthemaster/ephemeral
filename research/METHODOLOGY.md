# Methodology

Reference: Kovács, Seres. *Anonymity Analysis of the Umbra Stealth Address Scheme on Ethereum*, 2023, [arXiv:2308.01703](https://arxiv.org/abs/2308.01703).

Their Ethereum figure is **48.51%: 4,696 of 9,680 withdrawn Umbra stealth payments linked by H1 or H2** (H1 alone: 4,671, 48.25%). The same metric is reported for Arbitrum (65.7%), Optimism (52.6%) and Polygon (25.8%).

## What we report

| Field | Scope | Use |
| --- | --- | --- |
| `paperComparable` | Umbra payments, Umbra registrations, withdrawals and gas fundings before 2023-07-01; later data is ignored | should land near 48.51%: checks that this pipeline matches the paper |
| `sinceCutoff` | Umbra + ERC-5564, first paid on or after 2023-07-01 | the leak rate since the study |
| `all` | everything, full history | totals |
| `byYear` | by year of first payment | the trend |

Each scope reports `paperPct` (the paper's metric) and `identityPct` (wider: H1 or H2 over any withdrawal, plus H5).

## Data

| Step | Source | RPC method |
| --- | --- | --- |
| Payments | Umbra `Announcement`, ERC-5564 `Announcement` | `eth_getLogs` |
| ERC-5564 payment, asset | value that reached the announced address next to its announcement (ETH, internal on mainnet, ERC-20, ERC-721, ERC-1155) | `alchemy_getAssetTransfers` |
| Registrations | Umbra `StealthKeyChanged`, ERC-6538 `StealthMetaAddressSet` | `eth_getLogs` |
| Relayed Umbra token withdrawals | Umbra `TokenWithdrawal` (`acceptor` = recipient) | `eth_getLogs` |
| Payment sender | `from` of the transaction that moved the payment | `eth_getTransactionByHash` |
| Withdrawals | outgoing ETH, internal (mainnet), ERC-20, ERC-721, ERC-1155 transfers of every stealth address | `alchemy_getAssetTransfers` |
| Signer, type, fee | `from`, `type`, `maxPriorityFeePerGas` of each withdrawal | `eth_getTransactionByHash` |
| Gas funding (H5) | incoming ETH of token-only stealth addresses | `alchemy_getAssetTransfers` |
| Freshness | nonce of each stealth address just before its first payment | `eth_getTransactionCount` |
| Contracts | stealth addresses, recipients and funders with code (EIP-7702 delegation told apart) | `eth_getCode` |
| Cutoff block | first block on or after 2023-07-01, by binary search | `eth_getBlockByNumber` |

The scan ends at the `finalized` block, so a lagging transfer index cannot change a fixed range later. An ERC-5564 payment and its asset come from the chain, not from the announcement (31 Oct fix, bug bounty reports of 24 Oct). The Announcer is permissionless: anyone can announce any address with any metadata, and an announcement moves no value. Before, a zero-value announcement counted as a payment, and a stranger's "ETH" announcement turned a token-paid address into an ETH payment, which hid that token's H2 or H5 link. Now a payment is the value that reached the announced address in the announcement block or the 12 blocks after it, or before it: up to a day (7,200 blocks) before the first announcement of the address, since only the payer can know a fresh stealth address before it is announced and payers often send a few blocks ahead (mainnet has payments 4 and 6 blocks ahead), and 2 blocks before a later announcement. A token arriving there makes it a token payment, and ETH arriving with it is gas, but only a token bound to that announcement (bug bounty reports of 4 and 5 Nov): one that arrived in the same transaction as the announcement or as ETH the payer sent, one the announcement itself names, or, when the metadata names no token, one moved by a transaction the payer signed. The payer is the signer of the announcement's own transaction (6 Nov, bug bounty: a token contract can log any `from`, and a stranger can put a wei of ETH and dust in one transaction, so neither binds anything). Another announcement's claim binds nothing, since anyone can make one; each announcement is confirmed on its own. Unbound tokens next to ETH the payer sent are dust, counted in `quality.announcementTokenDust`, and the payment is ETH; when the payer sent no ETH the tokens stay the payment, so a stranger's wei cannot hide a token payment. Otherwise ETH arriving there makes it an ETH payment; otherwise the announcement is left out and counted in `quality.unfundedAnnouncements`. An address paid in more than one asset counts as withdrawn when any asset that was paid in left (bug bounty reports of 29 Oct and 3 Nov): before, only ETH counted there, so a token exit and its H1, H2 and identity links dropped out, and one wei of ETH with its own announcement could hide a token payment's withdrawal. H5 looks at every address with a token payment, also one paid ETH too; a payer's ETH is a payment, not a gas funding. Only ERC-5564 scheme 1 (secp256k1 with view tags) is read; announcements under another scheme id are left out and counted in `quality.otherSchemeAnnouncements`. Its sender is the sender of the transaction that moved the value. The metadata is only compared with that: `quality.announcementAssetMismatch` counts announcements that named another asset (selector `0xeeeeeeee` is ETH, the known ERC-20/721/1155 transfer selectors, ERC-1155 `safeBatchTransferFrom` `0x2eb2c2d6` included since 31 Oct, are tokens). Umbra announcements are taken as decoded: the Umbra contract emits them itself while it moves the funds.

## Definitions

- **Unit of analysis:** the stealth address. Several payments to one stealth address count once.
- **Fresh:** a real stealth address has sent nothing before its first payment. Announced addresses that had (test or spam announcements to used wallets) are left out and counted in `quality.notFreshStealthAddresses`. A transaction in the block of the first payment does not count as a withdrawal (the scan has no order inside a block, bug bounty, 30 Oct). A smart account or an EIP-7702 delegation makes ETH leaving the address owner-made, never a token event for a token it was not paid: anyone can emit such a log (bug bounty, 30 Oct).
- **Owned withdrawal:** a transfer out of the stealth address at or after its first payment, outside the payment transaction, that the owner made: signed by the stealth address, an Umbra `TokenWithdrawal`, ETH that left in a transaction the address did not sign (only code the owner's key put there can do that, a smart account or an EIP-7702 delegation, also one cleared before the scan's end block), or a relayed move (permit, relayer) of a paid token on the chain's list of known tokens (`RELAY_TOKENS` in `lib/config.ts`: USDC, USDT, DAI, WETH), whose transfers out of the address only the owner's signature can start. A scammer's fake-token transfer "from" the address does not count, also when the scammer sent dust of that token to the address with an announcement of his own, before the real payment, in its block or after it (bug bounty, 8, 9 and 10 Nov: which payment came first proves nothing, a stranger who sees the announcement can be first in the scan's order); nor does history from before the first payment. The cost: a relayed move of any other token is not counted as a withdrawal, an undercount.
- **Withdrawn:** the paid asset left: ETH for an ETH payment, the same token contract for a token payment. Another token leaving does not count. A token paid through Umbra waits in the Umbra contract, so only its `TokenWithdrawal` counts; a direct transfer of the same token from the stealth address moves other tokens (25 Oct fix: before, it could break single-withdrawal status; on the 26,176,190-block dataset it changed `singleWithdrawal` by 2 and no headline figure). Since 31 Oct no payment has an unknown asset (Umbra names its token, and an ERC-5564 asset comes from the chain); the rule that any owned withdrawal counts for an unknown asset stays as a fallback.
- **Single withdrawal:** the paid asset left in exactly one transaction. For a token payment, a later sweep of the leftover gas ETH does not break it (gas is not the paid asset). For an ETH payment the leftover is the paid asset itself, so a second ETH transaction out counts as a second withdrawal, as in the paper. The paper counts payments emptied in one transaction; we do not check the remaining balance. A transfer from the address to itself is no withdrawal, and an asset that left before its own payment arrived is not that payment leaving (7 Nov).
- **H1, registrant reuse:** a recipient is a registrant. For `paperComparable`, only Umbra registrations before the cutoff; elsewhere, both registries.
- **H2, same sender and receiver:** a recipient of a paid asset is the `from` of a payment to that stealth address. An unrelated token sent to the payer is not a round trip. The paper states the single-withdrawal rule for H1; we apply it to H2 too (H2 adds few links either way).
- **Paper metric:** H1 or H2 on the single withdrawal, over all withdrawn.
- **H3, collector pattern:** single withdrawals with one recipient, grouped by recipient; groups of two or more are clusters. Contract recipients (routers, the Umbra contract) are excluded to avoid false clusters. A recipient or gas funder counts as a contract when it has code at the end block and already had it at its first event (the first withdrawal to it or funding from it): a wallet whose contract was deployed later, at an address it already used, is a user's wallet (bug bounty, 9 Nov).
- **H4, unique priority fee:** fee-market withdrawals (type 2 or later) signed by the stealth address. A `maxPriorityFeePerGas` used by at most five such transactions is unique; stealth addresses sharing one are clustered. The paper excluded all token payments; here self-signed token withdrawals are included, relayed ones are not.
- **H5, gas funding (ours):** a token-only stealth address that signed its own transaction needed ETH first. If ETH arrived between its first payment and its first signed transaction, from a registrant, or from an address the funds later went to, it is linked. ETH from the payer or from contracts does not count.
- **Linked to an identity (wider):** H1 or H2 on any owned withdrawal, or H5. H3 and H4 shrink the anonymity set but name no one.

## Reproducibility

The first run stores the end block, the cutoff block, a code version and a hash of the fetch settings in `.cache/<chain>/meta.json`. A different version, setting or `--to-block` starts clean. The fetch settings include where the arrivals range starts (a day before the Announcer's first block), and the version is 7 since 9 Nov (bug bounty: a cache from before the 8 Nov window change stayed valid). `--fresh --to-block <same block>` downloads everything again; the `fingerprint` in the summary must match the first run.

## Limits

- Implementations that never announce on-chain are invisible here.
- Exchange deposit addresses count as ordinary recipients.
- At most 10,000 transfers are read per address; the summary counts truncated lookups.
- These are lower bounds: real analysts also use timing, amounts and off-chain data.
- A later announcement of an address only looks 2 blocks back for its payment (the first one looks back a day), so ETH topped up for gas after a first payment is not read as a new payment. What arrived before the first funded announcement or inside its own window (its block and the 12 after it) and stayed unclaimed, from a signer other than that announcement's own, is still in reach of a later one: a stranger who funds his own earlier announcement (1 wei, or dust of any token) cannot hide the payer's payment that way (bug bounty, 8 and 9 Nov). The cost: a second payment to a reused address that was sent long before its own announcement counts as unfunded.
- A token bound to an announcement only by its name (no transfer of it signed by the payer) does not beat ETH the payer sent itself, unless the token's own log names the payer as its sender (a permit or `transferWithAuthorization` relay): then those transfers are the payment and the payer's ETH is its gas (bug bounty, 9 Nov), and a stranger's dust of the same token is no second payment (bug bounty, 8 Nov).
- The payer is the signer of the announcement's transaction. When a relayer or a second wallet announces, the metadata names no token and the announcer's own ETH arrives next to a token another wallet sent, the ETH counts as the payment and the token as dust. A stranger's token or wei cannot change a payment that way, which is why it is read so strictly; metadata that names the token keeps it. When a shared agent signs the announcement (an ERC-4337 bundler, a relayer that announces for many users), that agent is read as the payer, and a stranger's transfer the same agent carries can bind as if the payer had made it (bug bounty, 8 Nov). In the mainnet census of that report such announcements were 11% of all and the funded addresses among them held about 3 USD; no flipped payment was found.
- An Umbra token withdrawal on behalf of the owner can pay part of the tokens to a sponsor; the TokenWithdrawal event names only the acceptor, so that leg is not read.
- Inside one block the scan has no transaction order: a gas funding in the same block as the address's first own transaction counts as before it.

## Privacy

The scan writes aggregate counts only. It never outputs which address was linked to whom, and we do not publish such lists. The raw cache in `.cache/` is public chain data and stays on the machine that ran the scan.
