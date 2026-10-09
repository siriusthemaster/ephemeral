# StealthPayout: one reward epoch, equal payments, fresh stealth addresses

> **Toy, unaudited, not deployed.** A public design sketch with tests, written to answer a question. Do not send real
> funds through it before an independent review. MIT.

## The question (@contractclaus)

An AI-agent token pays ETH rewards every day to the owners of about 195 NFT vaults, from a public reward ledger.

1. *"Our reward ledger is public. A fresh address alone doesn't hide whose balance got cleared. I'd start with a toy
   payout that breaks that link while keeping everyone's earned rewards intact."*
2. *"That proves money reached an address, not that the right person's debt was settled. I'd want a proof linking the
   payment to a hidden entitlement. Public balance changes or distinctive amounts could still reveal the holder."*

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
- **Equal amounts only within a batch.** If NFTs earn different rewards, settle one batch per amount class; each class
  is its own, smaller anonymity set.
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
| 10 | 466,333 | 16,880 | 504,213 | 50,421 |
| 100 | 4,299,898 | 159,620 | 4,480,518 | 44,805 |
| 200 | 8,589,512 | 318,280 | 8,928,792 | 44,643 |

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

## Layout and tests

```
src/StealthPayout.sol          the contract (~150 lines)
test/StealthPayout.t.sol       16 tests (one fuzzed): equal split, remainder, ERC-5564 format, events, input checks,
                               per-caller epochs, refusing / gas-burning / re-entrant recipients (as EIP-7702 code),
                               parked + release + withdraw, the TypeScript plan settled on chain, gas at 10/100/200
test/fixtures/epoch7.json      a plan written by ts/fixture.ts (12 NFTs, 6 owners); its leaf and metadata are checked
                               against Solidity's own encoding
ts/stealth.ts                  ERC-5564 scheme 1 (same code as the ephemeral client)
ts/payout-plan.ts              operator: planEpoch, settleCalldata; holder: findMyPayouts
ts/proof.ts                    leaves, Merkle tree, proveEntitlement / verifyEntitlement
ts/*.test.ts                   13 tests (node:test)
```

```
./setup.sh                     # pins forge-std 1.17.0 into lib/, builds, runs forge test -vv
cd ts && npm i && npm test     # Node 22.6+: node --experimental-strip-types --test *.test.ts
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
