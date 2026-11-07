# Total value unlinked: how it is counted

Total value unlinked (TVU) is the value that sits today on stealth addresses created through the open stealth payment contracts, all protocols combined. It is read from public chains by the code in this folder and published daily as `tvu.json` on the `stats-data` branch.

## What is read

Chains: Ethereum, Arbitrum, Optimism, Polygon, Base, Gnosis.

1. **Addresses.** Every stealth address announced by the Umbra contract (`0xFb2dc580Eed955B528407b4d36FfaFe3da685401`, Announcement event, the receiver) and by the ERC-5564 announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, Announcement event, the stealth address), from the first block of each contract to a block 12 behind the head. The scan is incremental and resumable.
2. **Value now.** The native balance of each address and the balance of a short list of major tokens (USDC, bridged USDC where common, USDT, DAI, WETH, WXDAI on Gnosis; list in `config.ts`). Balances are read with Multicall3 at one block per chain.
3. **Pending token payments.** Umbra keeps token payments inside its own contract until the stealth owner withdraws them. The balance of the Umbra contract in the same token list is reported as its own part (`umbraPendingTokens`).
4. **Prices.** Coinbase spot for ETH-USD and POL-USD, Kraken as fallback. xDAI and the stablecoins in the list count as 1 USD, WETH as ETH. If no price can be read, nothing is published.

Not counted: any token outside the list, NFTs, and anything that is not an announced address.

## Rules that keep spoofed numbers out

Anyone can announce any address, so an announcement alone proves nothing about the address. These rules are applied to every address that holds value:

- An address with contract code is left out (EIP-7702 delegation markers count as ordinary accounts).
- An address whose current nonce is above 1000 is left out.
- An address worth more than 250 ETH at the current ETH price is left out.

The number and the USD value of the addresses left out by these rules are published as `excludedOutliers`. The addresses themselves are not.

Announcements whose caller is one of the routers listed in `EXCLUDED_CALLERS` (`config.ts`, same list as `excluded.erc5564Callers` in `sector.json`) are never counted, and an address announced by them stays out even if someone else announces it again. No figure about them is published.

## Checks before publishing

- Every number is finite and not negative; the parts add up to the total and the chains add up to the total.
- No chain moves by more than 5x against the previous file (only when both values are above 1,000 USD).
- All chains must be scanned up to their head. A run that ends in the middle of the first scan saves its progress and publishes nothing.

## Cross check

The collector logs the all time number of Umbra and ERC-5564 announcements it saw per chain next to `chains.<chain>.umbra` and `chains.<chain>.erc5564` from `sector.json`. They should be close; small differences come from the block each is read at.

## Output

`tvu.json`: `schema`, `asOf` (block time of the oldest chain read), `label`, `totalUsd`, `parts`, `byChain`, `prices`, `rules`, `excludedOutliers`, `method`. The site hides the number if the file is missing, invalid, older than 3 days or its schema is not 1.

## Limits

Token balances use a fixed list and stablecoins are counted at 1 USD. A stealth address on two chains is two addresses. Public RPC endpoints can lag; the read block is 12 behind the head.

## Running it

`node --import tsx tvu/collect.ts --data <dir> [--budget-minutes 300] [--no-publish]`, or the `tvu` workflow (daily 00:40 UTC, or run it by hand). The first scan of all chains takes several runs on free public endpoints: progress is saved in `checkpoint.json` and the `*.addr.gz` and `*.skip.gz` files on the `stats-data` branch and the next run continues from there. Nothing about TVU is published until every chain is complete. Set the repository secrets `RPC_ETHEREUM`, `RPC_ARBITRUM`, `RPC_OPTIMISM`, `RPC_POLYGON`, `RPC_BASE`, `RPC_GNOSIS` (one URL, or several separated by commas) to use your own endpoints first; a keyed endpoint makes the first scan much faster. Use secrets, not variables: GitHub masks secrets in the public run log, and the log shows only the host of each endpoint.
