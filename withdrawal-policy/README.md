# Withdrawal policy (H1–H5)

The checks the ephemeral client runs before every withdrawal from a stealth address. Pure TypeScript, no network, about 90 lines: `guards.ts`.

| Check | Level | Why (mainnet scan of 25,645 stealth addresses) |
| --- | --- | --- |
| H1 registrant reuse: destination = the wallet that created your stealth keys | block | 9,709 traced single withdrawals |
| H2 round trip: destination = the payer | warn | 426 traced single withdrawals |
| H3 collector: destination = another of your stealth addresses, or a destination another payment of yours already went to. Past destinations are rebuilt from public chain history each time the wallet opens, so the warning survives reloads and devices; nothing is stored. While that history is loading or cannot be read, H3 says "history incomplete" (warn), never "unused" | warn | 45.68% of single withdrawals, 3,786 clusters |
| H4 fee fingerprint | fee always the network standard | 1,024 transactions in 463 groups |
| H5 gas funding: token payment with no ETH for gas | block (fund it privately, or buy with gas included via `router/`) | 0 of 2 token-only addresses paid their own gas |
| Timing: received less than an hour ago | warn | a fast withdrawal pairs easily with its payment |

`destinationsFromHistory(own, history)` turns the transfers your stealth addresses sent (read from a block explorer; the client uses Blockscout's public API) into the past destinations H3 checks against.
`historyComplete` is a required input (pass `true` only when that history fully loaded); if a caller leaves it out anyway, it counts as incomplete and H3 warns (fail safe, from the Claus Lab review).

The client never offers the key wallet as a destination and has no sweep-all button.

Run the tests (Node 22+, `viem` installed):
```
npm i viem && node --experimental-strip-types --test guards.test.ts history.test.ts
```

Study and numbers: the leak study in this repo. MIT.

`history.ts` loads those past sends from Blockscout's public API. It compares each address's on-chain nonce with the transactions the explorer has indexed: if the explorer is behind (a withdrawal made minutes ago is not indexed yet), history counts as incomplete and H3 says so. Found on mainnet on 8 Oct: a second payment was withdrawn to the same fresh address a few minutes after the first, and H3 did not warn. Likely cause: the explorer had not indexed the first withdrawal yet. Fixes: the nonce check above (`history.test.ts` covers it), and the client now records a destination as soon as a token leaves, even if the leftover-ETH step fails.

Token transfers are checked against the node too (Claus Lab review, 9 Oct: "the tx count can match while the reused destination is still missing from history"). `history.ts` reads every ERC-20 `Transfer` log with `from` = the address straight from the node (`eth_getLogs`, topic 1 = the address, from its first payment block to the latest block, in ranges of 10,000 blocks, smaller if the node refuses), and looks each one up among the token transfers the explorer has indexed (same transaction hash and log index). One that the explorer does not show yet makes the history incomplete, and H3 says so. The nonce cannot catch this: a transaction can be indexed before its token transfer, and a transfer relayed for the address (permit, `transferWithAuthorization`) does not use its nonce. Without a node to compare against, or when it cannot be read, history also counts as incomplete. `history.test.ts` covers both cases: the transaction count matches but one relayed token transfer is not indexed yet (incomplete), and both are indexed (complete).
