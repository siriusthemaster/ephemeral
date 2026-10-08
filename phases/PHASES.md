# Phases: Season 1 rules

Points for $EPH holders. Season 1: 15 Oct 2026 14:00 UTC to 13 Jan 2027 (90 days). Draft; final at launch.

Change 8 Oct: Unbroken no longer resets on any transfer out, so moving to a safer wallet costs nothing (thanks to Claus Lab for the review).

## Formula
```
Phases per wallet = Σ_days  base × tier × (1 + boosts)  +  trading Phases
base          = $EPH held ÷ 1,000 per day, from hourly balance snapshots (time-weighted)
tier          = step-up by share of the 1,000,000,000 supply held (table)
boosts        = sum of the boosts the wallet has (table), 0 to 2.0; Unbroken counts only on the wallet's lowest balance since it first received $EPH
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
| First Light | +0.50 | bought in the first hour and still holds at least that amount; kept in later seasons |
| Unbroken | +1.00 | on the tokens a wallet never let go of: its lowest balance since it first received $EPH. Selling or sending out costs the boost only on that amount; tokens received start their own count in the new wallet |

## Rewards at the end of the season
- **$TIDE airdrop:** 20% of $TIDE supply, pro rata by Phases.
- **First Light Pass:** wallets with at least 50,000 Phases. Half of the $TIDE presale is reserved for Pass holders, pro rata by Phases. First relayer slots go to Pass holders, in order of Phases.

## Why splitting a wallet does not pay
- base is linear in tokens × time, so splitting is neutral on base;
- the tier multiplier never decreases with balance, so every part of a split sits in the same tier or a lower one;
- boosts multiply each wallet's own base, so more wallets do not add boost;
- Unbroken is linear too: it sits on each wallet's lowest balance, so moving tokens to a safer wallet neither gains nor loses it;
- presale and airdrop are pro rata by Phases, not per wallet or per Pass.

So a split can tie or lose, never win. If you find a sequence that wins, open an issue.

## Known trade-offs
- Trading Phases are bought with fees (0.001 ETH for 100). Wash trading earns Phases at that price; the fees go to the treasury.
- Hourly snapshots: holding for a few hours earns a few hours of base, nothing more.
- Excluded wallets: protocol contracts (pool, hook, launcher, vesting), the team and treasury wallets.
