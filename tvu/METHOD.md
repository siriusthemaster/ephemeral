# Total value unlinked: how it is counted

Total value unlinked (TVU) is the value that sits today on stealth addresses created through the open stealth payment contracts, all protocols combined. It is read from public chains by the code in this folder and published daily as `tvu.json` on the `stats-data` branch.

## What is read

Chains: Ethereum, Arbitrum, Optimism, Polygon, Base, Gnosis.

1. **Addresses.** Every stealth address announced by the Umbra contract (`0xFb2dc580Eed955B528407b4d36FfaFe3da685401`, Announcement event, the receiver) and by the ERC-5564 announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, Announcement event, the stealth address), from the first block of each contract to a block 12 behind the head. The scan is incremental and resumable.
2. **Value now.** The native balance of each address and the balance of a short list of major tokens (USDC, bridged USDC where common, USDT, DAI, WETH, WXDAI on Gnosis; list in `config.ts`). Balances are read with Multicall3 at the latest block, in batches. Every address with value is then read a second time, in a random order, after the Umbra read, and the smaller of its two reads counts: funds that move one way between announced addresses (or into Umbra) while the run reads count at most once (bug bounty, 8 Nov). Then the largest holders (up to about 80, as many as fit in one call) and the Umbra contract are read a third time, all in one Multicall3 call, so at one block, and each keeps the smallest of its reads: a pot moved back and forth between two of them on every block, which could sit at each for both of its reads, counts at one place only (bug bounty, 9 Nov). If a node refuses that call as too heavy, half as many of the largest holders are read together.
3. **Pending Umbra payments.** Umbra keeps payments inside its own contract until the stealth owner withdraws them. The balance of the Umbra contract in the same token list is reported as its own part (`umbraPendingTokens`), and its native balance (ETH, POL or xDAI payments waiting there) as another (`umbraPendingNative`, since 9 Nov, bug bounty: it was not read).
4. **Prices.** Coinbase spot for ETH-USD and POL-USD, Kraken as fallback. xDAI and the stablecoins in the list count as 1 USD, WETH as ETH. If no price can be read, nothing is published.

Not counted: any token outside the list, NFTs, and anything that is not an announced address.

## Rules that keep spoofed numbers out

Anyone can announce any address, so an announcement alone proves nothing about the address. These rules are applied to every address that holds value:

- An address with contract code is left out (EIP-7702 delegation markers count as ordinary accounts).
- An address whose current nonce is above 1000 is left out.
- An address worth more than 250 ETH at the current ETH price is left out.

The number and the USD value of the addresses left out by these rules are published as `excludedOutliers`. The addresses themselves are not.

Announcements whose caller is one of the routers listed in `EXCLUDED_CALLERS` (`config.ts`, same list as `excluded.erc5564Callers` in `sector.json`) are never counted. An address counts when any other caller (or Umbra) announced it, also when a router announced it too: since 8 Nov a router announcement no longer takes an address out (bug bounty: anyone can make a router announce somebody else's address). No figure about router announcements is published.

## Checks before publishing

- Every number is finite and not negative; the parts add up to the total and the chains add up to the total.
- No chain moves by more than 5x against the previous file. The check is skipped only when both values are below 1,000 USD; a chain that falls from above 1,000 USD to near zero is the shape of a failed read and stops the publish until someone checks it and runs once with `TVU_ALLOW_JUMP=1` (9 Nov: this line used to say "only when both values are above 1,000 USD", which is not what the check does).
- All chains must be scanned up to their head. A run that ends in the middle of the first scan saves its progress and publishes nothing.

## Cross check

The collector logs the all time number of Umbra and ERC-5564 announcements it saw per chain next to `chains.<chain>.umbra` and `chains.<chain>.erc5564` from `sector.json`. They should be close; small differences come from the block each is read at.

## Output

`tvu.json`: `schema`, `asOf` (block time of the oldest chain read), `label`, `totalUsd`, `parts`, `byChain`, `prices`, `rules`, `excludedOutliers`, `method`. The site hides the number if the file is missing, invalid, older than 3 days or its schema is not 1.

## Limits

Token balances use a fixed list and stablecoins are counted at 1 USD. A stealth address on two chains is two addresses. Public RPC endpoints can lag; addresses are scanned up to 12 blocks behind the head, and values are read at the latest block, so a run is not one snapshot: `asOf` is the time the value reads began. Funds that leave an address during the run may count nowhere (the smallest read counts). Funds moved back and forth between two addresses on every block while the run reads count at most once when both are among the largest holders read together; below them such a bounce can still count a small pot twice, bounded by those holders' size.

Anyone can announce an address and fund it, so the rules above keep single addresses out of the number, not capital: whoever parks their own funds in many fresh announced addresses, or in Umbra, raises the total for as long as the funds stay there. That is what the number measures (value sitting where a stealth owner can take it), and it is why the parts and the address count are published next to it. The Umbra part is the balance of the Umbra contract and has no per-address cap. A move of more than 5x in a day on one chain stops the publish (bug bounty, 7 Nov).

## Running it

`node --import tsx tvu/collect.ts --data <dir> [--budget-minutes 300] [--no-publish]`, or the `tvu` workflow (daily 00:40 UTC, or run it by hand). The first scan of all chains takes several runs on free public endpoints: progress is saved in `checkpoint.json` and the `*.addr.gz` and `*.skip.gz` files on the `stats-data` branch and the next run continues from there. Nothing about TVU is published until every chain is complete. The workflow writes `tvu.json` only when the repository variable `TVU_PUBLISH` is `1`; until then each run prints the summary line in its log and still saves the checkpoint, also after a failed run. Set the repository secrets `RPC_ETHEREUM`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `RPC_POLYGON`, `RPC_BASE`, `RPC_GNOSIS` (one URL, or several separated by commas) to use your own endpoints first; a keyed endpoint makes the first scan much faster. Use secrets, not variables: GitHub masks secrets in the public run log, and the log shows only the host of each endpoint.
