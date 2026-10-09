# Private receipts for CLAY Figure payouts on Solana (design sketch)

> **Not audited. A sketch: no Solana code exists yet.** It adapts StealthPayout, an EVM toy we wrote (MIT, unaudited,
> not deployed). Do not move real funds with anything built from this before an independent review.

**Assumes** each round's burn share is split equally across the 256 Figures (if not, use StealthPayout v2's
denomination notes). We have not reviewed Clay's claim program.

## 1. What the receipt proves, and what stays private

Each opted-in Figure's share goes to a **fresh one-time address** (a note) derived from its holder's registered keys,
and Clay commits on chain, that round, a Merkle root over `leaf = H(id, N, P, R, amount, salt)`, one leaf per note. To
**one verifier the holder picks**, a receipt (salt, Merkle path, signed statement with the verifier's name and a fresh
challenge) proves: payment **P** settled **Figure #id's share for round N**, the **exact amount**, and that the leaf is
in **the root Clay committed**. A signature by P's one-time key shows the prover controls P; an optional second
signature by the wallet that held #id at the snapshot ties in ownership.

| Stays private (from observers) | Does **not** stay private |
| --- | --- |
| Which wallet received Figure #id's share | Round total, note count, amount, root |
| Other holders' notes and receipts | **Clay, as payer, knows the mapping** (it derives every P) |
| Which leaf is whose (secret salt) | Who opted in, and how many Figures each holds |
| | **Merging notes re-links them** (merge k notes: k is your public Figure count) |
| | **Timing**: notes land together; sweeping soon after pairs you with the round |

Anonymity set: the opted-in Figures of that round. The receipt is a signature, so it convinces anyone it is forwarded to.

## 2. Solana adaptation

```
holder: spending b, B = b·G   viewing v, V = v·G   meta-key (B, V), registered once
payer:  r random, R = r·G, S = r·V                (ECDH; holder recomputes S = v·R)
        h = H("clay.v1" | S | R) mod l, P = B + h·G  (P: an ordinary ed25519 pubkey, the note's address)
        tag = H("clay.tag" | S)[0], salt = H("clay.salt" | S)
holder: one-time key p = b + h mod l
```

- ECDH in the prime-order group (Ristretto255, or Edwards with subgroup checks), so small-order points leak nothing; P
  stays an Edwards point, a normal Solana address. Salt from S: holders rebuild receipts; Clay keeps nothing.
- p is a scalar, not a seed: it signs in expanded-key form (as in
  [Tor key blinding](https://spec.torproject.org/rend-spec/keyblinding-scheme.html)). Wallets cannot import it; the
  sweeper tool signs.
- **Prior Solana work** (not reviewed by us): [Onyx SDK](https://github.com/OnyxSDK/onyx) (spending + viewing keys, an
  Anchor announcement registry), [Wraith SDK](https://github.com/wraith-protocol/sdk) (ed25519 stealth module),
  [shredr.fun](https://gitea.com/toastx/shredr_fun) (hackathon, unaudited, fee relayer).

**Discovery without the ERC-5564 Announcer.** The payout program writes one **round account** per round: N, root,
total, count, amount and `(P, R, tag)` per note, sorted by P so position carries nothing. A wallet reads the whole
account (so the RPC learns nothing), skips 255 of 256 entries by tag, checks `B + H(v·R, R)·G == P` for the rest. 256
notes is about 16.6 KB, about 0.12 SOL rent, refunded on close. Memos or event logs also work but are harder to backfill.

**Fees.** A fresh account needs the rent-exempt minimum, **890,880 lamports (0.00089 SOL)** at 0 bytes today (read
`getMinimumBalanceForRentExemption(0)`); a transfer leaving it below fails. It is a floor, not a cost: the sweep closes
the note to zero. A share below floor plus sweep fee carries to the next round. At 1,232 bytes per transaction, about 15
notes fit with their announcements (estimate): 256 notes in about 18 transactions, the first fixing root and total.

**Claiming.** The holder sweeps each note with its one-time key to a fresh destination; a **relayer is fee payer**
(native on Solana), repaid from the note in the same transaction (10,000 lamports base for two signatures). The main
wallet never funds a note.

## 3. Rejecting a destination that does not match the holder's bound keys

**(a) Detect (toy).** A holder who finds no note for Figure #id disputes (#id, N), signed with the registered key; Clay
must open leaf #id (P, R, salt, path) by a deadline; the holder publishes **S = v·R with a DLEQ proof** (same v in
V = v·G and S = v·R). Anyone computes `P' = B + H(S, R)·G`: if P' ≠ P, or P was not paid, Clay misrouted, provably;
silence is public too. Cost: that one note is tied to the holder's viewing key (S is per note). Solana's Curve25519
syscalls could check the DLEQ on chain. This detects; it does not prevent.

**(b) Prevent.** The batch carries a ZK proof that each destination comes from *some* registered holder's keys, without
saying whose; the program verifies it before paying.

```
public: registryRoot of (id, B, V), N, amount, commitmentsRoot, all (P_j, R_j, tag_j); private: id_j, B_j, V_j, r_j, salt_j
1. (id_j, B_j, V_j) is a leaf of registryRoot                 (an entitled, registered Figure)
2. R_j = r_j·G and S_j = r_j·V_j
3. P_j = B_j + H(S_j, R_j)·G and tag_j = H(S_j)[0]             (derived from that Figure's bound keys, and findable)
4. H(id_j, N, P_j, R_j, amount, salt_j) is a leaf of commitmentsRoot
5. the id_j are distinct and count = registered Figures        (each Figure paid exactly once)
```

**Toy vs production.** Toy: misrouting detected by dispute; Clay knows the mapping. Production A: the circuit above;
misrouting rejected on chain, but ed25519 math inside a BN254 circuit is non-native and heavy (zkVM or custom
circuit); Clay still knows the mapping. Production B: pull claims, where a holder proves membership of a registered
commitment, reveals a nullifier `H(k, id, N)` and binds a destination of their choice; hashes only, and Clay no longer
knows the mapping. Groth16 verifies on Solana via alt_bn128 syscalls ([groth16-solana](https://docs.rs/groth16-solana):
under 200k compute units). Neither is built; proving cost is the open question.

## 4. Pilot: one round, opt-in holders

1. **Register.** Before round N's snapshot, each opting-in holder generates (B, V) locally and signs
   `clay-meta-v1 | N | Figure ids | B | V` with the wallet holding them. Clay publishes the list and checks ownership
   at the snapshot. Figures not opted in keep the current claim page.
2. **One batch.** Clay pays each registered Figure's share as a note, writes the round account, publishes the leaves.
   Same total as the claim page. Devnet dry run first, with one deliberately misrouted note to test the dispute.
3. **Receipts.** Holders scan, sweep each note separately via the relayer, and each shows one receipt to a verifier
   of their choice.

**Measure:** opt-in count (below about 10 Figures the set is weak), notes found by owners (target: all) and time to
find, sweep rate and timing, total cost against the claim path, receipts verified or rejected, merges observed, an
observer linkage test on public data (should be no better than chance), and holder friction (key backup, signing).

## 5. Limits

- **Not audited; a sketch.** The EVM toy it adapts is unaudited and not deployed.
- **Clay knows the mapping** (toy and A). **Root completeness is trusted** in the toy: caught only if the holder disputes.
- **Small or public sets hide little.** Registration is public; the set is the opted-in Figures.
- **Habits undo it:** never sweep to the Figure wallet or to Clay, never merge notes, spread sweeps out. The relayer
  sees what it sweeps.
- **Keys:** whoever holds v sees all your notes; losing b loses unswept notes. Meta-keys are public, so a future break
  of discrete log on Curve25519 would link past notes. Receipts are transferable.

---

### Reply summary (3 tweets, for @SiriusTheMaster)

**1/** Here is the sketch: github.com/siriusthemaster/ephemeral/blob/main/payouts/SOLANA_SKETCH.md. The receipt proves to one verifier the holder picks: payment P was Figure #id's
share for round N, the exact amount, and a leaf of the root Clay committed that round. Private: which wallet got it,
and everyone else's payouts.

**2/** Not private, stated plainly: round total and count, timing, who opted in, and Clay as payer knows the mapping.
Merging notes later re-links them. On Solana: ed25519 spending + viewing keys, a fresh address per note, a round
account with ephemeral key + view tag.

**3/** Wrong destinations: in the toy, a holder proves misrouting with a DLEQ proof against the committed note. To
prevent it, the batch carries a ZK proof that each destination comes from a registered holder's keys, without saying
whose. Pilot: 1 round, opt-in. Unaudited.
