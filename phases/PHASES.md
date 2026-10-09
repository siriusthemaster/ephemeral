# Phases: Season 1 rules

Points for $EPH holders. Season 1: 15 Oct 2026 14:00 UTC to 13 Jan 2027 (90 days). Draft; final at launch.

Changes 8 to 9 Oct, reviewed in public by Claus Lab:
- v2: Unbroken moved from wallets to tokens, so moving to a safer wallet costs nothing.
- v3: Claus Lab found that v2's wallet-wide reset on a sale could be dodged by moving a few tokens to a side wallet and selling there (the rest kept the boost). v3 drops wallet-wide resets entirely. Unbroken and First Light now follow each token's own history, and every step (buy, sell, transfer) is pro rata. Splitting before a sale gives exactly the same result as selling directly.
- v3.1 (9 Oct): Claus Lab asked about NFT minting and redemption. A contract that holds tokens for many people (NFT vault, staking, lending, exchange wallet, any other pool) is one address, so plain pro-rata transfers would let fresh tokens deposited next to aged ones come out aged. v3.1 treats shared contracts like the pool: tokens going in leave the ledger like a sale, tokens coming out start at day 0 without First Light. Wallets you control alone (EOA, Safe, ERC-4337 or EIP-7702 accounts) stay wallets.

## Formula
```
Phases per wallet = Σ_days  base × tier × (1 + boosts)  +  trading Phases
base          = $EPH held ÷ 1,000 per day, from hourly balance snapshots (time-weighted)
tier          = step-up by share of the 1,000,000,000 supply held (table)
boosts        = sum of the boosts the wallet has (table), 0 to 2.0; Unbroken and First Light count on the share of the wallet's tokens that carry them
trading Phases = 100 per 0.001 ETH of swap fees the wallet paid on the official pool
```

| Tier | Holds at least | Multiplier |
| --- | --- | --- |
| New Moon | 0 | ×1.00 |
| Crescent | 0.05% (500,000 EPH) | ×1.10 |
| First Quarter | 0.1% (1,000,000) | ×1.25 |
| Gibbous | 0.25% (2,500,000) | ×1.50 |
| Full Moon | 0.5% (5,000,000) | ×2.00 |
| Supermoon | 1% (10,000,000) | ×2.50 |
| Eclipse | 2% (20,000,000) | ×3.00 |

| Boost | Adds | Condition |
| --- | --- | --- |
| Stealth keys | +0.25 | stealth keys set up in the ephemeral app (pay link or ERC-6538 registry) |
| Private payment | +0.25 | sent or received at least one ephemeral payment |
| First Light | +0.50 | on tokens bought in the launch hour; they keep it when moved; a sale removes it pro rata; kept in later seasons |
| Unbroken | +1.00 | on tokens held without being sold: ramps from 0 to +1.00 over a token's first 7 days; tokens keep their age when moved; a sale removes tokens pro rata across their ages; rebought tokens start at day 0 |

## Rewards at the end of the season
- **$TIDE airdrop:** 20% of $TIDE supply, pro rata by Phases.
- **First Light Pass:** wallets with at least 50,000 Phases. Half of the $TIDE presale is reserved for Pass holders, pro rata by Phases. First relayer slots go to Pass holders, in order of Phases.

## Why splitting a wallet does not pay
- base is linear in tokens × time, so splitting is neutral on base;
- the tier multiplier never decreases with balance, so every part of a split sits in the same tier or a lower one;
- boosts multiply each wallet's own base, so more wallets do not add boost;
- Unbroken and First Light travel with the tokens, pro rata, and a sale removes tokens pro rata too, so splitting (before a sale or at any time) and moving to a safer wallet neither gain nor lose anything;
- presale and airdrop are pro rata by Phases, not per wallet or per Pass.

So a split can tie or lose, never win. If you find a sequence that wins, open an issue.

## Probes answered
- *Split before a sale* (Claus Lab, 8 Oct, against v2): move 1,000 of 100,000 to a side wallet and sell there. In v3 that equals selling 1,000 directly: the 99,000 left keep their age either way. Test: `Claus Lab finding (v2 split-before-sale)`.
- *Tiny buy in a fresh wallet, then transfer in tokens from a wallet that has sold* (Claus Lab, 8 Oct): every token keeps its own age, so the move neither adds nor removes Unbroken weight; the tiny buy starts at day 0.
- *NFT minting and redemption* (Claus Lab, 9 Oct): deposit fresh tokens into a vault that holds aged ones, then redeem. In v3 the redeemed tokens would have come out with a pro-rata share of the vault's ages. In v3.1 they come out dated that day, without First Light. Tests: `Claus Lab probe (NFT mint and redeem through a shared vault)` and a random-sequence property (no path through shared contracts raises the Unbroken weight or the First Light total).
- *Sell, rebuy, move everything:* the sold tokens are gone; the rebought ones start at day 0 and take 7 days to reach the full boost.

## Reference code
`unbroken.ts` is the Unbroken and First Light accounting the indexer runs on every $EPH transfer; `unbroken.test.ts` checks it: Claus Lab's split-before-sale case, and random chains of thousands of tiny transfers between mixed-age balances (the Unbroken weight, the First Light total and the supply stay exactly the same when tokens move; splitting before a sale never beats selling directly). Run: `node --experimental-strip-types --test unbroken.test.ts` (Node 22+).

## Known trade-offs
- Trading Phases are bought with fees (0.001 ETH for 100). Wash trading earns Phases at that price; the fees go to the treasury.
- Hourly snapshots: holding for a few hours earns a few hours of base, nothing more.
- Excluded wallets: protocol contracts (pool, hook, launcher, vesting), the team and treasury wallets.
- Shared custody costs age: putting $EPH into an NFT vault, staking or lending contract or an exchange counts as a sale for Unbroken and First Light; taking it out starts at day 0. Use a wallet you control alone (a Safe is fine) to keep the boost.
