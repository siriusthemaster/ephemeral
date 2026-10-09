# StealthPayout: one reward epoch, equal payments, fresh stealth addresses

v1 (below) pays equal rewards per NFT. **[v2](#v2-unequal-debts-denomination-notes)** pays unequal debts (holding-time
weighted, previous owners included) as denomination notes. Both are in the same contract and share one epoch log.

> **Toy, unaudited, not deployed.** A public design sketch with tests, written to answer a question. Do not send real
> funds through it before an independent review. MIT.

## The question (@contractclaus)

An AI-agent token pays ETH rewards every day to the owners of about 195 NFT vaults, from a public reward ledger.

1. *"Our reward ledger is public. A fresh address alone doesn't hide whose balance got cleared. I'd start with a toy
   payout that breaks that link while keeping everyone's earned rewards intact."*
2. *"That proves money reached an address, not that the right person's debt was settled. I'd want a proof linking the
   payment to a hidden entitlement. Public balance changes or distinctive amounts could still reveal the holder."*
3. *"Sorted payments avoid leaking NFT order. But my rewards follow holding time, including previous owners. Grouping
   exact amounts can leave one holder identifiable. The root also trusts the payer's mapping. The next toy needs to
   preserve unequal debts without exposing them."* (9 Oct, 06:40 UTC). Answered by [v2](#v2-unequal-debts-denomination-notes).
4. *"Show guessing success per holder, not just the 3.1% average. Include carry across epochs too, and report payment
   delays alongside privacy gains."* Answered in [per holder, across epochs, delay](#per-holder-across-epochs-and-what-rounding-costs).

## The answer in one paragraph

Rewards per NFT are equal within an epoch, so there is nothing per holder to clear. The operator settles **one epoch for
all registered NFTs in one transaction**, the **same amount to every NFT**, each payment to a **fresh ERC-5564 stealth
address** made from the owner's public meta-address, each announced through the canonical Announcer so the owner's
wallet finds it with its viewing key. The ledger records *"epoch N settled: count, amountEach, totalPaid, root"*, never
a per-holder debit. An owner of 3 NFTs gets 3 ordinary-looking payments to 3 unrelated addresses. In the same
transaction the operator commits to a Merkle root of hiding commitments `H(nftId, epoch, stealthAddress, salt)`, so a
holder can later prove to **one verifier of their choice**, and to nobody else, that a given payment settled a given
NFT's reward.

## The contract: `src/StealthPayout.sol`

```solidity
function settle(uint256 epoch, bytes32 commitmentsRoot, Recipient[] calldata rs) external payable;
struct Recipient { address stealthAddress; bytes ephemeralPubKey; bytes1 viewTag; }
event EpochSettled(address indexed payer, uint256 indexed epoch, uint256 count, uint256 amountEach, bytes32 commitmentsRoot);
```

- `amountEach = msg.value / rs.length`, and the call **reverts on any remainder** or a zero amount: no recipient can get
  a distinctive amount. Dust stays with the operator for the next epoch.
- For every recipient: one announcement through the Announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`, set in the
  constructor) with scheme 1 and the 57-byte ETH metadata `viewTag | 0xeeeeeeee | 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE | amount`,
  then `amountEach` ETH.
- The transaction input holds only `epoch`, the root and `(stealthAddress, ephemeralPubKey, viewTag)` triples. No
  meta-address, no NFT id, no owner wallet.
- Checks, all before anything is paid: at least one recipient, non-zero root, no zero address, a 33-byte compressed key
  (prefix `02`/`03`), **stealth addresses strictly ascending**, and the epoch not yet settled **by the same caller**.
  Each payer has its own epoch log (`commitmentsRootOf[payer][epoch]`), so anyone can use one deployment.
- No owner, no admin, no fee, no upgrade. State: the epoch log, and `parked` (below). No `receive()`: ETH only comes in
  through `settle`.

**Why ascending order is enforced.** NFT ownership is public. If payments were listed in NFT-id order, position *i*
would give away NFT *i*'s owner. Sorting by stealth address (random-looking) makes the order carry nothing, and it rules
out the same address appearing twice, which would give it a 2x balance.

**A recipient that refuses ETH does not block the others.** A fresh stealth address has no code and always accepts.
But a holder can derive the key of their stealth address from the *pending* settle transaction (with their viewing key)
and front-run it with an EIP-7702 delegation to code that reverts. With revert-all semantics one holder could then
cancel everyone's payout, every day. So each payment is sent with a fixed 10,000 gas, copying no return data; if it
fails, the amount is **parked** for that address (still announced, so its owner finds it), and the others are paid.
Parked funds leave by `release(addr)` (anyone pushes them to `addr`, with all gas, e.g. a relayer or the operator next
epoch) or `withdrawParked(to)` (the address itself, if it has code). Everyone's earned reward stays intact.

**Re-entrancy.** Checks, then the epoch log and event, then the payments. A transient-storage lock (EIP-1153) covers
`settle`, `release` and `withdrawParked`. The only write after a call is the parking credit, made only when that call
failed, and a failed call's own state changes (any re-entry included) are rolled back.

## What an observer sees, and what the holder can prove

| | Observer (public chain + ledger + every public meta-address + NFT ownership) | Owner (viewing key) | A verifier the owner picks |
| --- | --- | --- | --- |
| That epoch N was paid, how many NFTs, how much each | yes | yes | yes |
| The n fresh addresses and that each got exactly `amountEach` | yes | yes | yes |
| Which of those addresses belong to which owner or NFT | **no** (needs a viewing private key) | only its own | only the one payment shown |
| Which NFT a leaf of the root belongs to | **no** (32-byte secret salt) | its own | the one opened to it |
| That the payment settled NFT #id's reward for epoch N | no | yes | **yes**: leaf opens, is in the settled root, signed by the stealth key |
| That the prover owned NFT #id | no | yes | optional: a second signature by the owner wallet, then the verifier checks `ownerOf(id)` at the snapshot |

`ts/payout-plan.test.ts` plays the observer: with every owner's public meta-address and all NFT ownership it tries
hashing public keys in place of the shared secret, 32 guessed viewing keys per owner (view tags match about 1 in 256 by
chance; the address check never does), and every NFT id with every paid address and every guessable salt against the
published leaves. Zero links. Control: the same brute force with a guessable salt (`salt = nftId`) links all 12
payments, which is why the salt must be secret. Each owner's viewing key finds exactly its own payments.

## Anonymity set

**The registered owners paid in the same batch**, and no more. Weighted by NFTs held: before anything is spent, a given
payment belongs to an owner of *k* of the *n* NFTs with probability *k/n*. With 150 registered NFTs among 40 owners, a
holder of 30 owns any given payment with probability 1/5, and the observer still cannot tell which 30.

Owners who never registered a meta-address cannot be paid privately. Pay them publicly in a separate transaction, the
same `amountEach` per NFT. Each one shrinks the set, and the ledger shows exactly who is in it (all owners minus the
publicly paid ones). A batch with 3 registered owners hides among 3.

## The private proof of entitlement (`ts/proof.ts`)

1. **Commit** (operator, on chain). `leaf = keccak256(keccak256(abi.encode(nftId, epoch, stealthAddress, salt)))`, one per
   payment; the Merkle root (sorted pairs, OpenZeppelin-compatible) goes into `settle`. The leaves can be published:
   each hides its NFT behind the salt.
2. **Salt.** By default `keccak256("StealthPayout.salt.v1" || hashedSecret)`, from the ERC-5564 shared secret that only
   the operator and the owner can compute. The owner's wallet rebuilds every receipt from the chain and the published
   leaves (`findMyPayouts`), with no private delivery. `randomSalt` is the alternative; then receipts must be delivered.
3. **Prove** (holder, off chain, to one verifier). Reveal `nftId` and `salt` to that verifier only, plus the Merkle path,
   and sign an EIP-712 statement with the **stealth address's private key**: payer, epoch, NFT, stealth address,
   amount, leaf, root, the verifier's name and a fresh challenge from the verifier, under the chain id and contract.
   Optionally also sign with the owner wallet.
4. **Verify** (`verifyEntitlement`, pure). Verifier name and challenge (no replay), chain and contract, payer, epoch,
   root and amount against what it read on chain, the address was paid in that epoch, the leaf opens to
   `(nftId, epoch, address, salt)`, the leaf is in the root, the signature recovers the stealth address (and the owner
   wallet if named).

What it settles: the operator committed, in the same transaction that paid, that this payment was NFT #id's reward,
and the prover controls the address that received it. A holder whose NFT was skipped, or whose payment was committed
under another NFT id, sees it privately (`missing`, `unmatched`).

**A ZK version is future work**: prove membership in the root and control of the stealth key without revealing which
leaf, as a non-transferable (designated-verifier) proof, plus a public proof that the root has exactly one leaf per
eligible NFT and one per payment. This toy does not have that.

## Limits (read these)

- **The operator knows the mapping.** It generates every stealth address, so it knows NFT -> address. An AI agent that
  posts its reasoning or tool calls publicly must never log the plan's receipts. With the default salt, holders can
  rebuild their receipts, so the operator can discard them (and it never keeps ephemeral private keys) once the
  transaction confirms. An operator-blind design (holders claim from a shielded pool with nullifiers) is future work.
- **Spending habits undo it (H1-H5 still apply).** Everything above holds until the money moves. Per the ephemeral
  withdrawal policy: H1 never withdraw to the wallet that created your stealth keys; H2 never back to the payer; H3
  never merge payments into one destination: **the number of equal payouts you merge equals your NFT count, which is
  public**, and if your count is unique that names you; H4 pay the network-standard fee; H5 gas: not an issue here (the
  payment is ETH and pays its own gas).
- **Timing.** All payments land at the same moment every day. Spending soon after, or at the same hour every day, pairs
  with the payout and with your other days. Spread spends out.
- **Equal amounts only within a batch.** If NFTs earn different rewards, do not settle one batch per exact amount (in
  the 200-holder fixture below, 109 of 200 holders would be alone in their batch): use v2's denomination notes.
- **Public facts remain public.** The count per epoch, the publicly paid NFTs, parked payments (`Parked` event) and
  where a parked payment is withdrawn to.
- **The proof is transferable.** A signature convinces anyone it is shown to. "Only the chosen verifier" relies on
  that verifier not forwarding it. A designated-verifier or ZK proof would fix this.
- **The root is trusted for completeness.** The contract cannot check the root against the payments without revealing
  them. Holders detect their own omissions privately; nobody can prove publicly that every NFT was paid exactly once.
- **Viewing keys.** Whoever holds an owner's viewing key (a scanning service) sees all their payments and, through the
  default salt, which NFT each one was for.
- **Not post-quantum.** secp256k1 ECDH. Meta-addresses are public, so a future quantum computer could recover viewing
  keys and link every past payment ("harvest now, decrypt later").
- **Toy.** Unaudited, not deployed, no formal analysis.

## Gas (from `forge test -vv`, `test_gasPerRecipient`)

| Recipients | Execution | Calldata | Transaction total (with 21,000) | Per recipient |
| ---: | ---: | ---: | ---: | ---: |
| 10 | 466,675 | 16,880 | 504,555 | 50,455 |
| 100 | 4,302,040 | 159,620 | 4,482,660 | 44,826 |
| 200 | 8,593,654 | 318,280 | 8,932,934 | 44,664 |

About **44,500 gas per extra recipient**, of which 25,000 is the new-account surcharge for sending ETH to an address that
has never been used. That is the price of a fresh address; reusing addresses would save it and link the payments.
About 195 NFTs is roughly 8.7M gas per daily settlement, in one transaction, well under a block: 0.0087 ETH at
1 gwei, 0.000087 ETH at 0.01 gwei. A parked payment adds up to 10,000 gas plus one storage write.

## Plugging it in (3 steps)

1. **Holders register a meta-address.** In the ERC-6538 registry or the project's app (it is public by design). The
   agent's snapshot maps NFT -> owner -> meta-address.
2. **Each epoch the agent settles.** `planEpoch({ epoch, amountEach, entitlements })` for the registered NFTs, then send
   `settleCalldata(plan)` with `value = plan.value`; pay unregistered NFTs publicly, same `amountEach`. Publish
   `plan.leaves`, and record on the ledger: epoch, count, amountEach, totalPaid, root, transaction. Never publish
   `plan.receipts`.
3. **Holders' wallets do the rest.** Scan the announcements with the viewing key (`findMyPayouts`), spend each payment
   separately under H1-H5, and when someone needs proof of one payment, `proveEntitlement` for that verifier only.

## v2: unequal debts (denomination notes)

### The problem, in Claus's words

> "Sorted payments avoid leaking NFT order. But my rewards follow holding time, including previous owners. Grouping
> exact amounts can leave one holder identifiable. The root also trusts the payer's mapping. The next toy needs to
> preserve unequal debts without exposing them."

The ledger is public and so is NFT ownership history, so an observer can recompute every holder's exact debt for the
epoch. Any payment of a holder's exact amount names that holder. One batch per amount class does not help: in the
200-holder fixture, 109 holders have an amount nobody else has.

What v2 hides is **which payment settled which debt**. It does not hide debts your public ledger already shows (if the
ledger published only totals, the chain would show a histogram of notes per denomination, not anyone's debt).

### Design

1. **Round down, carry the rest (public rule).** Each ledger line `(epoch, owner, debt)` plus the owner's carry from the
   last epoch is rounded **down** to a public base unit; the remainder (`< base`) carries to the owner's next line.
   `paid + carryOut == debt + carryIn` to the wei, so cumulative payouts stay exact. Carries are a function of the
   public ledger, so anyone can recompute them.
2. **Split into notes of `base * 2^k`, with a cap.** The rounded amount is written in binary, but only up to a top
   denomination `2^kmax`: the largest `k` such that at least `minCrowd` holders get a note of it, with every lower
   denomination that is used also shared by at least `minCrowd` holders. Above the cap a holder gets several notes of
   the top denomination (`100 units, kmax 3 -> 4 + 12 x 8`). Without the cap the largest holders get high notes nobody
   else gets, and such a note names its holder (fixture: min crowd 1, 5 holders below 20).
3. **Every note to its own fresh stealth address** of that holder (ERC-5564, announced as in v1).
4. **One equal-amount group per denomination** in one call, `settleNotes(epoch, root, declaredTotal, groups)`:
   - groups strictly ascending by `amountEach` (distinct denominations), each non-empty, addresses strictly ascending
     inside a group, **no address twice in the transaction** (transient-storage mark per address; ascending order alone
     only rules out repeats within a group, and a repeat across groups would give one address a distinctive 1 + 4 sum);
   - `msg.value == sum(amountEach * count)`, and the parts of an epoch add up to exactly `declaredTotal`, the public
     ledger's payout for the epoch. Emitted: `NotesSettled(payer, epoch, root, declaredTotal, paid, notes, outstanding)`
     and one `NoteGroup(payer, epoch, amountEach, count)` per group;
   - same epoch log as v1 (`commitmentsRootOf[payer][epoch]`): an id is settled once, by `settle` or `settleNotes`;
   - same bounded push, parking, `release` / `withdrawParked` and transient re-entrancy lock as v1.
5. **Parts.** An epoch that does not fit one transaction (EIP-7825 caps a transaction at 2^24 gas on Ethereum since
   Fusaka; check your L2) is paid in several `settleNotes` calls with the same root and declared total. The first fixes
   both; the contract tracks `outstanding` and rejects a part that does not match (`PartMismatch`) or overpays
   (`ExceedsDeclared`). `ts/notes.ts` `splitParts(plan, MAX_NOTES_PER_TX = 300)`.
6. **Commitments.** One leaf per note:
   `keccak256(keccak256(abi.encode(epoch, owner, debt, carryIn, stealthAddress, denomination, salt)))`, salt from the
   ERC-5564 shared secret (`"StealthPayout.note.v2"`), so the holder rebuilds every leaf from public data. All of a
   holder's notes commit the same `(owner, debt, carryIn)`, so they can show that the notes add up to exactly
   `floor((debt + carryIn) / base) * base`.

**Changes from the brief, and why.**
- *A new `settleNotes`, not `epochId = epoch * 256 + i` or Multicall3.* Through Multicall3 `msg.sender` is Multicall3,
  so every user would share one epoch log and anyone could take your epoch ids. Packed ids live in the same log as v1
  ids (v1 epoch 1792 = v2 epoch 7, denomination 0), give one root per denomination (a holder's proof would span
  several), and separate calls cannot check the total on chain. One call per epoch (or per part) keeps one id, one root
  and one declared total, checked on chain.
- *Leaves per ledger line (owner), not per NFT.* With previous owners, one NFT owes two people in one epoch, so the NFT
  id is not a key; a per-NFT carry would strand up to `base - 1` wei with every seller; and one decomposition per holder
  needs fewer notes than one per NFT. The verifier checks the committed debt against the owner's public ledger line
  (the sum of their NFT shares), so the NFT id is not needed. `carryIn` is in the leaf so the rounding can be checked.

### What each party sees

| | Observer (chain + ledger + ownership history + every meta-address) | Holder (viewing key) | A verifier the holder picks | Anyone (public audit) |
| --- | --- | --- | --- | --- |
| Each holder's debt | yes (public ledger, as before) | yes | yes | yes |
| Notes per denomination | yes, and it is implied by the ledger anyway | yes | yes | yes: checks it equals what the ledger implies |
| Which holder a note belongs to | **no**: one of >= 31 holders (fixture); per holder the best observer is right 1.3% of the time at the median, 14.8% for the 16-NFT holder ([below](#per-holder-across-epochs-and-what-rounding-costs)), as long as notes of different epochs never meet | its own | only the shown holder's | no |
| That the epoch paid exactly the ledger | yes (it can run the audit) | yes | yes | **yes**: declared total on chain == ledger, every denomination count == ledger (`auditNotesEpoch`) |
| That my notes settled exactly my debt | no | yes (`findMyNotes`: `complete`) | **yes** (`verifyDebtSettled`) | no |
| That every note went to the right holder | no | only its own | only the shown holder's | **no**: needs the ZK statement below |

### Numbers (200 holders, `ts/notes-fixture.ts`)

The world: 306 NFTs, weight `min(holding days, 180)` counted from mint (previous owners' time counts), 0.2 ETH per
epoch. 190 current owners (one with 16 NFTs, a few with 4 to 8, most with 1 or 2) and 10 previous owners who sold
during the epoch and are owed their share of the day: 200 ledger lines, debts from 0.0000057 to 0.0113 ETH (median
0.00102). `minCrowd = 20`. Reproduce: `node --experimental-strip-types notes-fixture.ts report`.

| base unit | kmax | holders paid | notes | crowd min / median | bits min / median | best guess | unique totals if merged (H3) | merged crowd median |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1e12 wei | 10 | 200 | 879 | 52 / 63 | 6.0 / 25.6 | 2.4% | 105 | 1 |
| 1e13 wei | 7 | 199 | 743 | 37 / 75 | 6.0 / 26.5 | 2.0% | 60 | 2 |
| **1e14 wei (default)** | **4** | **178** | **359** | **31 / 57** | **5.4 / 12.7** | **3.1%** | **9** | **12** |

- **crowd**: a note of denomination k could be any of the distinct holders who got a k note; per holder, the smallest
  crowd among their notes. Without the cap: min 1. With exact amounts: 109 holders alone.
- **bits**: log2 of the candidate note sets for a holder given their (public) pattern, `prod_k C(C_k, m_ik)`.
- **best guess**: the share of all notes an observer gets right when it labels every note with its most likely holder
  (the biggest holder of that denomination). An average over notes: per holder, see the next section.
- The rule-agnostic count asked for, subsets of the batch that add up to a holder's payout, is min 2^5.8, median
  2^39.1 at 1e14 (`log2SubsetsSumming`, checked against brute force). It overstates the protection: the rule is public,
  so the observer knows each holder's pattern. Use crowd and bits.
- At 1e14 the 22 holders who owe less than one unit (0.0001 ETH) get nothing this epoch and carry it. The top
  denomination (16 units) is whale-heavy: the 16-NFT holder has 17% of those notes.
- A coarser base unit means fewer notes **and** a smaller merge leak (more holders share a rounded total). It costs only
  a deferral of less than one base unit per holder, which carries.
- **Carry**: over 30 simulated epochs with daily sales and new buyers (244 owners), every owner's cumulative
  `paid + carry == cumulative debt` to the wei, carry < base at every step, and every denomination of every epoch was
  shared by >= 20 holders.

### Per holder, across epochs, and what rounding costs

> "Show guessing success per holder, not just the 3.1% average. Include carry across epochs too, and report payment
> delays alongside privacy gains." (@contractclaus)

Code: `ts/notes-anonymity.ts` (`holderSuccess`), `ts/notes-epochs.ts` (`successOverRun`, `linkedSuccess`,
`paymentDelays`), tests in `ts/notes-epochs.test.ts`. Reproduce: `node --experimental-strip-types notes-fixture.ts holders`
and `... epochs`.

**Per holder, one epoch** (200-holder world, base 1e14, the 178 holders paid). The observer targets one holder and knows
their public pattern: `m_k` notes of denomination k, among the `C_k` notes of k in the batch. Within a denomination the
notes are interchangeable without the holder's viewing key, so each is theirs with probability `m_k / C_k` and no
strategy does better (checked against an enumeration of every assignment and every observer choice).

| | min | p10 | median | p90 | max |
| --- | ---: | ---: | ---: | ---: | ---: |
| Per note: share of the holder's notes the best observer attributes correctly | 0.9% | 1.0% | **1.3%** | 2.0% | **14.8%** |
| Most exposed note, `max_k m_k / C_k` | 0.9% | 1.1% | 1.8% | 2.4% | 16.7% |
| Whole note set recovered, `prod_k 1 / C(C_k, m_k)` | 2^-30.5 | 2^-18.3 | 2^-12.7 | 1.8% | 2.4% |

| Most exposed holders | Per note | Why |
| --- | ---: | --- |
| owner #0 (16 NFTs) | 14.8% | 113 units = 1x1u + 7x16u: **7 of the 42 top (16u) notes**, a group only 31 holders share |
| owner #3 (6 NFTs) | 5.8% | 49 units = 1x1u + 3x16u: 3 of the 42 top notes |
| owner #8 (4 NFTs) | 3.5% | 34 units = 1x2u + 2x16u: 2 of the 42 top notes |
| owner #2 (7 NFTs) | 3.1% | 38 units = 1x2u + 1x4u + 2x16u |
| owner #4 (5 NFTs) | 2.9% | 42 units = 1x2u + 1x8u + 2x16u |

- The 3.1% average hid a tail, and the tail is the top denomination: all five are above the cap with several top notes.
  A crowd of >= 20 holders does not bound the risk per note at 1/20; the holder's share of the group's **notes** does.
- Whole sets go the other way: the 16-NFT holder's 8 notes are the hardest set to recover (2^-30.5); the easiest is a
  single 16u note (1 in 42).
- If the tail matters: one step lower cap (8u top) puts the 16-NFT holder at 7.5% for 401 notes instead of 359. A rule
  "no holder above x% of any denomination" could pick the cap; not implemented.

**Across epochs** (30 epochs of the world with carry, 2 to 6 sales a day, 244 owners, base 1e14). Cells: median / p90 of
the probability the observer puts on the right holder; "named": holders with no other candidate left.

| What links the epochs | 1 epoch | 3 | 10 | 30 |
| --- | ---: | ---: | ---: | ---: |
| Nothing: every note spent on its own (per-note success, as above) | 1.3% / 2.0% | 1.2% / 1.7% | 1.2% / 1.7% | 1.1% / 1.6% |
| Carry schedule: one destination, only *which epochs* it received something | 0.6% / 0.6% | 0.6% / 11% | 0.6% / 50%, 16 named | 0.7% / 100%, 43 of 238 named |
| Recurring denominations: one random note per paid epoch to one destination | 1.4% / 3.2% | 7.7% / 30% | **65%** / 100%, 46 named | **100%**, 172 of 238 named |
| Merged totals: every epoch's notes swept to one destination (H3 broken daily) | 8.3% / 50%, 9 named | 33% / 100% | 100%, 139 named | 100%, 204 of 238 named |

- **Without a link, more epochs give nothing.** Every note goes to a fresh address from a fresh random ephemeral key, so
  the epochs' assignments are independent. Carries and recurring patterns are functions of the public ledger, which
  the observer already has; they tie no note to another.
- **With a link, success rises fast.** A holder whose notes of different epochs meet (one sweep wallet, one exchange
  deposit address) is fingerprinted by the sequence: the carry decides in which epochs a small holder is paid at all,
  and a stable debt repeats its pattern. H1-H3 therefore hold **across epochs**: notes of different epochs must never
  share a destination. (Unequal debts are what make the sequence a fingerprint: with v1's equal payments, every holder
  is paid the same amount every epoch, so one payment per epoch to one place shows only that its owner holds an NFT.)

**Payment delay vs privacy** (same 30 epochs). Each wei of debt waits from the epoch it accrues to the epoch a note pays
it (first in, first out). In wei, what waits is the carry, always below one base unit.

| Base unit | Notes / epoch | Per note over 30 epochs: median / max holder | Merged totals unique (epoch 0) | 10 linked epochs (one note each): median | Delay per holder, epochs (wei-weighted mean): median / p90 / max | Longest wait while accruing | Carry per holder: median of means / max |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1e13 wei | 723 | 1.1% / 7.8% | 60 of 199 | 70% | 0.00 / 0.03 / 0.16 | 1 epoch | 0.0000049 / < 0.00001 ETH |
| **1e14 wei** | **385** | **1.1% / 10.9%** | **9 of 178** | **65%** | **0.05 / 0.25 / 1.07** | **5** (15 holders > 1) | **0.000049 / < 0.0001 ETH** |
| 1e15 wei | 151 | 0.9% / 9.8% | 1 of 102 | 33% | 0.41 / 2.17 / 5.28 | 18 (156 holders > 1) | 0.00047 / < 0.001 ETH |

- A coarser unit buys a smaller merge leak and slower linking, and fewer notes (gas). It does **not** lower per-note
  success: that is set by the holder's share of the top group, which the cap decides.
- It costs delay: at 1e14 about 5% of the median holder's debt waits one more epoch; the smallest holders (owed less
  than a unit a day) wait up to `ceil((base - 1) / their smallest epoch debt)` epochs (tested). At 1e15 only 102 of the
  200 holders are paid in epoch 0.
- Owners who stop accruing (sold everything) keep their carry until they accrue again: up to 29 epochs in this run. The
  payer holds back about half a unit per owner: 0.012 ETH at 1e14 (6% of a day's pool), 0.12 ETH at 1e15.
- 1e14 stays the default: a 0.05-epoch median delay for 9 unique merged totals instead of 60.

### The root still trusts the payer's mapping: what is checkable without ZK, and what is not

- **Anyone**: `declaredTotal` (on chain, enforced against `msg.value` and the parts) equals the ledger's payout, the epoch
  is complete (`outstanding == 0`), and the multiset of notes equals what the public rule gives for the public ledger.
  A wrong total, a skipped or extra note or a wrong denomination is caught publicly (`auditNotesEpoch`).
- **Each holder**: their notes open to their own ledger line and add up exactly (`findMyNotes`). A **misstated debt** in
  their leaves is provable to a verifier: the notes verify against what the payer committed on chain and fail only on
  the public ledger (tested).
- **Not checkable**: a note sent to the wrong person with the multiset unchanged (the payer pays one of frank's notes to
  its own address under a made-up leaf). The public audit passes; frank sees a shortfall privately but cannot prove an
  omission. Binding every leaf to the public ledger without revealing the mapping needs a ZK proof (future work):

```
public:  commitmentsRoot, ledgerRoot (epoch's lines (owner, debt, carryIn) + each owner's meta-address (S, V)), base,
         the paid notes (stealthAddress_j, ephemeralPubKey_j, amount_j);  private: per note j: line i(j), salt_j, r_j
1. every note j pays its line's owner: R_j = r_j*G and stealthAddress_j = addr(S_i + H(r_j*V_i)*G)
2. leaf_j = H(epoch, owner_i, debt_i, carryIn_i, stealthAddress_j, amount_j, salt_j), and these are exactly the root's leaves
3. for every line i: sum of amount_j over its notes == floor((debt_i + carryIn_i) / base) * base, per the public rule
4. carryIn_i == the previous epoch's carryOut_i (chained through the previous ledgerRoot)
5. verified in (or alongside) settleNotes: then the root binds every note to the right line and reveals nothing else
```
  Statement 1 needs secp256k1 arithmetic in the circuit (non-native, expensive). The payer is still the prover and still
  knows the mapping; an operator-blind design (holders claim from a shielded pool) remains future work.

### The proof: "these notes settled exactly my debt" (`ts/notes-proof.ts`)

The holder opens **all** their notes of the epoch to one verifier: address, denomination, salt and Merkle path per note,
an EIP-712 `DebtSettled` statement (payer, epoch, owner, debt, carryIn, paid, hash of the opened leaves, root, verifier,
challenge) signed by **every note's stealth key** and by the **owner wallet**. `verifyDebtSettled` checks verifier and
challenge, chain and contract, payer, epoch and root, `debt` against the public ledger line, `carryIn` against the
ledger (or `< base`), each note paid on chain with exactly its denomination, each leaf in the root, each signature, the
leaf hash, and `sum(notes) == floor((debt + carryIn) / base) * base`. It rejects a subset of the notes, a note of
another holder, a relabelled denomination, a duplicate, a foreign signature (tested). The verifier learns all of that
holder's notes of the epoch (needed for the sum) and the owner wallet; the proof is transferable, as in v1.

### Limits of v2 (in addition to v1's)

- **Merging still reveals the debt (H3).** Merge all of a day's notes and the total is your payout, which the public
  ledger names: at 1e14, 9 of 178 paid holders have a unique total, the median is shared by 12. Merging any two notes
  intersects their crowds. Spend notes **separately** (each is a standard amount and can pay as is), or send each through
  the withdrawal policy on its own; never sweep a day's notes into one address.
- **Notes of different epochs must never meet.** Unlinked, more epochs give an observer nothing; linked through one
  destination, the sequence names the median holder at 65% after 10 epochs and outright after 30 (one note per epoch),
  or after 10 if every epoch is merged. The carry schedule alone names 43 of 238 holders in 30 epochs.
- **Denominations are visible.** A note narrows its owner to the holders who got that denomination; the top one is
  whale-heavy (17% one holder in the fixture): that holder's notes are attributed correctly 14.8% of the time, against
  a median of 1.3%. The anonymity is bounded by how unequal the debts are.
- **Rounding delays payment.** At 1e14 the median holder's mean delay is 0.05 epoch; the smallest holders wait up to 5
  epochs, an owner who stops accruing keeps up to one unit until they accrue again.
- **Debts stay public** where the ledger publishes them; v2 hides the link, not the amounts owed.
- **Parts are not atomic.** If the payer stops between parts, `outstanding > 0` is public, and address uniqueness across
  parts in different transactions is checked off chain (the planner), not by the contract.
- **Carry for owners who stop accruing.** A seller who never accrues again keeps a carry below one base unit on the ledger;
  pay it with their next accrual or publicly (it is public anyway). Rounding it up to a note would overpay.
- **Cost.** Gas follows the note count: 359 notes here (2 per paid holder at the median, up to 8), against 306 payments
  if the same world were paid one equal payment per NFT with v1 (about 13.7M gas): about 1.2x.
- **Toy.** Unaudited, not deployed.

### Gas (`test/StealthPayoutNotes.t.sol`, `test_gas_notes200`)

| | Notes | Gas (incl. 21,000 and calldata) |
| --- | ---: | ---: |
| One note to a fresh address | 1 | about 45,000 (45,014 averaged over the epoch) |
| Worst case: the recipient burns its gas and the note parks | 1 | about 54,700 |
| 200 holders, whole epoch in one transaction | 359 | 16,160,085 |
| The same under EIP-7825 (2^24 per transaction): 2 parts | 305 + 54 | 13,817,634 + 2,442,834 |

Parts of at most 305 notes fit 2^24 gas even if every recipient burns its gas; `MAX_NOTES_PER_TX = 300` in TS. At
0.01 gwei a 200-holder epoch costs about 0.00016 ETH. The smallest note (0.0001 ETH) is about 220 times its own gas cost
at that price.

### Plugging it in (v2)

1. **Publish the rule**: base unit, `minCrowd`, and per epoch the ledger lines `(owner, debt)`; carries follow from them.
2. **Each epoch**: `planNotesEpoch({ epoch, base, minCrowd, holders })`, then for each `part` of
   `splitParts(plan, MAX_NOTES_PER_TX)` send `settleNotesCalldata(plan, part.groups)` with `value = part.value`.
   Publish `plan.leaves`; never publish `plan.receipts`.
3. **Anyone**: `auditNotesEpoch(expectedBatch(lines, base, minCrowd), summarizeParts(declaredTotal, NoteGroup events))`.
4. **Holders**: `findMyNotes` (check `complete`), spend each note separately, `proveDebtSettled` for one verifier when
   needed.

## Layout and tests

```
src/StealthPayout.sol          the contract: v1 settle, v2 settleNotes, parking (~290 lines with comments)
test/StealthPayout.t.sol       v1, 16 tests (one fuzzed): equal split, remainder, ERC-5564 format, events, input checks,
                               per-caller epochs, refusing / gas-burning / re-entrant recipients (as EIP-7702 code),
                               parked + release + withdraw, the TypeScript plan settled on chain, gas at 10/100/200
test/StealthPayoutNotes.t.sol  v2, 8 tests (one fuzzed): one group per denomination, input checks (incl. an address in
                               two groups), the epoch log shared with v1, parts (mismatch, overpay, completion), parking
                               and re-entry, the TypeScript notes plan settled on chain with its leaves, gas for 200 holders
test/fixtures/epoch7.json      v1 plan written by ts/fixture.ts (12 NFTs, 6 owners)
test/fixtures/notes8.json      v2 plan written by ts/notes-fixture.ts (7 owners incl. a previous owner, 21 notes) and
                               one holder's receipts, checked against Solidity's own encoding
test/fixtures/notes200.json    v2 200-holder epoch (denominations and counts) for the gas test
ts/stealth.ts                  ERC-5564 scheme 1 (same code as the ephemeral client)
ts/payout-plan.ts              v1 operator: planEpoch, settleCalldata; holder: findMyPayouts
ts/proof.ts                    v1 leaves, Merkle tree, proveEntitlement / verifyEntitlement
ts/notes.ts                    v2 rule (roundDown, topExponent, decompose, expectedBatch, withCarries), planNotesEpoch,
                               splitParts, settleNotesCalldata, findMyNotes, auditNotesEpoch
ts/notes-proof.ts              v2 proveDebtSettled / verifyDebtSettled
ts/notes-anonymity.ts          v2 observer metrics (crowd, bits, subset count, best guess, merge leak, per-holder success)
ts/notes-epochs.ts             v2 across epochs: success without a link, linked destinations, payment delay per holder
ts/notes-fixture.ts            v2 worlds (200 holders, 30-epoch history, the 7-owner fixture) and the reports
ts/*.test.ts                   32 tests (node:test): 13 v1, 19 v2
```

```
./setup.sh                     # pins forge-std 1.17.0 into lib/, builds, runs forge test -vv
cd ts && npm i && npm test     # Node 22.6+: node --experimental-strip-types --test *.test.ts
cd ts && npm run fixtures      # regenerates test/fixtures/*.json (the tests check they are up to date)
```

## Changes from the first sketch, and why

- **Ascending stealth addresses, enforced on chain.** The sketch did not fix an order; NFT-id order would have leaked
  owners through position (ownership is public), and a repeated address would have had a distinctive 2x balance.
- **Bounded push with a parked fallback instead of revert-all.** One holder could otherwise veto every epoch with an
  EIP-7702 front-run. Costs one extra mapping and two small functions.
- **The epoch log stores the root** (`commitmentsRootOf[payer][epoch]`) and the event names the payer, so a verifier can
  read the root directly.
- **Salt from the shared secret by default.** Holders rebuild receipts themselves, the operator need not keep or send
  them, and the leaves can be published. A guessable salt would let anyone open all leaves (there are only ~195 ids).
- **Proof bound to verifier, challenge, chain, contract, amount and root**, with an optional owner-wallet signature so
  "the right person" can be checked against `ownerOf`.
