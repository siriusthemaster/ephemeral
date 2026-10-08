# Withdrawal policy (H1–H5)

The checks the ephemeral client runs before every withdrawal from a stealth address. Pure TypeScript, no network, about 90 lines: `guards.ts`.

| Check | Level | Why (mainnet scan of 25,645 stealth addresses) |
| --- | --- | --- |
| H1 registrant reuse: destination = the wallet that created your stealth keys | block | 9,709 traced single withdrawals |
| H2 round trip: destination = the payer | warn | 426 traced single withdrawals |
| H3 collector: destination = another of your stealth addresses, or a destination another payment of yours already went to. Past destinations are rebuilt from public chain history each time the wallet opens, so the warning survives reloads and devices; nothing is stored | warn | 45.68% of single withdrawals, 3,786 clusters |
| H4 fee fingerprint | fee always the network standard | 1,024 transactions in 463 groups |
| H5 gas funding: token payment with no ETH for gas | block (fund it privately, or buy with gas included via `router/`) | 0 of 2 token-only addresses paid their own gas |
| Timing: received less than an hour ago | warn | a fast withdrawal pairs easily with its payment |

`destinationsFromHistory(own, history)` turns the transfers your stealth addresses sent (read from a block explorer; the client uses Blockscout's public API) into the past destinations H3 checks against.

The client never offers the key wallet as a destination and has no sweep-all button.

Run the tests (Node 22+, `viem` installed):
```
npm i viem && node --experimental-strip-types --test guards.test.ts
```

Study and numbers: the leak study in this repo. MIT.
