# StealthBuy: buy on Uniswap v4 straight into an ERC-5564 stealth address

`src/StealthBuy.sol`, about 150 lines. No owner, no settings, no fee. Its only state is a record of the stealth addresses it has paid.

```solidity
function buy(PoolKey calldata key, Stealth calldata s, bytes calldata hookData) external payable returns (uint256 amountOut);
struct Stealth { address stealthAddress; bytes ephemeralPubKey; bytes1 viewTag; uint256 minOut; uint256 gasTip; }
```
`msg.value` = ETH to swap + `gasTip`. In one transaction it:
1. checks that this router never paid the stealth address before and that the address is fresh (below), then swaps ETH for the token on any native-ETH v4 pool (exact input; the pool's own fee and hook apply as for anyone);
2. has the PoolManager pay the tokens **directly to the stealth address**;
3. sends `gasTip` ETH (max 0.01) to the same address, so the receiver can move the tokens without funding that address from a wallet linked to them (leak H5);
4. announces through the canonical ERC-5564 Announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`) with standard token metadata: view tag, `0xa9059cbb`, token, amount (57 bytes), so any ERC-5564 wallet that scans finds it;
5. refunds ETH the pool did not take, and reverts below `minOut`.

What it does **not** do: hide the buyer. The buyer's address is the sender of the transaction. Buying for yourself from a known wallet links you to the stealth address unless the ETH comes from a private source. What it gives is a clean receiving side: a one-time address with gas already on it.

## One-time address: use record and fresh address guard
A stealth address is used once. Two checks, both before the swap:
- **Use record.** `used(address)` is a lasting record of every stealth address this router has paid. `buy` reverts with `StealthAddressUsed()` if the address is in it, and otherwise writes it there before any external call. It stays there after the receiver empties the address, so the same buy sent again after a full drain still reverts. A buy that reverts for any reason (slippage, a bad pool) leaves no record. Cost: 22,389 gas per buy (one new storage slot), measured on a first `buy()` as its own transaction (`forge test --isolate`): with a tip 183,319 → 205,708, without 151,117 → 173,506.
- **Fresh address guard.** `buy` reverts with `StealthAddressNotFresh()` if the stealth address already has code (including an EIP-7702 delegation), any ETH, or any balance of the token being bought. About 1.7k gas with a tip and 4.2k without (mostly the first, cold access to the address).

The record is per router deployment: another StealthBuy deployment keeps its own and does not know what this one paid. Across deployments only the fresh address guard applies, and only until the address is emptied. So the record is a backstop, not the rule: a client must still generate a new ephemeral key, and so a new stealth address, for every buy, and never resend a prepared buy.

Found on mainnet on 8 Oct by the Claus Lab review (@contractclaus): one prepared buy command ran twice. Transactions [`0xede5bae7aa9c4e924cb93d244dc5c3d3ec40e2ec9f7781825a47a7ea72984781`](https://etherscan.io/tx/0xede5bae7aa9c4e924cb93d244dc5c3d3ec40e2ec9f7781825a47a7ea72984781) (router `0xEed5…`) and [`0xc490402846003d47db595343ea32f93496a11299958bf23d2109766cf6cce0c8`](https://etherscan.io/tx/0xc490402846003d47db595343ea32f93496a11299958bf23d2109766cf6cce0c8) (router `0x2311…`) used the same stealth address `0xF9C511c925F2873457f6ef86A5d26846AD78145F` and the same ephemeral public key `0x0306be1d…64ed`; the address already held the first 0.001 ETH tip when the second buy landed. Two payments on one one-time address are linked to each other. With these checks, the second buy reverts on any router deployed from this version: through the same router because of the use record, through another one because the address still holds the first payment. Sent again after the receiver emptied the address, it still reverts on the router that paid it (use record; Claus Lab review, 9 Oct: "'One-time' needs a lasting use record, not just empty balances"), but another deployment would accept it, hence the rule above. Routers deployed before these changes have neither check.

The withdrawal side is in `../withdrawal-policy/`: the checks (H1–H5) the ephemeral client runs before anything leaves a stealth address.

## Tests
```
./setup.sh          # pins forge-std 1.17.0 and Uniswap v4-core v4.0.0 into lib/, builds, runs the tests
forge test -vv      # 21 tests
```
On fresh v4-core pools (no dependency on any other ephemeral contract): delivery to the stealth address with gas and exact accounting (fuzzed), ERC-5564 announcement format, slippage guard, input checks, token/token pools rejected, the use record (the same buy replayed; replayed after the receiver drained every token and every wei of ETH from the address; a second buy of another token with no tip; a reverted buy leaves no record; a buy re-entering from the refund to the same address finds it used; a second deployment keeps its own record), the fresh address guard (the same buy through a second router; 1 wei of ETH or of the token already there; code or an EIP-7702 delegation on the address; a fresh address still works), re-entrancy from the stealth address (code deployed there mid-swap by a hook) and from the buyer's refund, exact refund on a partial fill, hooks that take a token-side fee (the announced amount is what arrived) or try to leave the caller owed ETH (reverts).

## Receiver test (e2e)
The receiving side, end to end, with real keys: `e2e/receiver.e2e.ts`. It proves the receiver can **find** a StealthBuy payment and **spend** it using only the gas bundled in the buy, with no top-up from any known wallet.

1. The receiver signs the key message with an account and derives ERC-5564 scheme-1 spending and viewing keys and a meta-address (`e2e/stealth.ts`).
2. A buyer, knowing only that meta-address, generates a stealth address and calls `buy` with a 0.05 ETH swap and a 0.001 ETH tip (plus a decoy buy for someone else). The stealth address has 0 ETH and nonce 0 before.
3. The receiver scans the Announcer's `Announcement` logs with its viewing key (view tag, then the address check) and finds exactly its payment; token and amount come from the 57-byte metadata.
4. With the derived stealth private key it sends all tokens to a brand-new address, then the leftover ETH, with the fee price set so the cost fits inside the tip. The stealth address ends at exactly 0 ETH.
5. Audit: every call frame of every block since setup is traced (`trace_block`). The only ETH that ever reached the stealth address is the tip, sent by the router inside the buy transaction; no transaction was ever sent to it.

It runs on a local anvil chain only (chain id 31337), against plain Uniswap v4: `script/LocalSetup.s.sol` deploys a fresh v4-core PoolManager, a mock token, a native-ETH/token pool without a hook, the Announcer code at its canonical address, and StealthBuy. No key is stored anywhere; anvil's unlocked accounts sign.
```
./setup.sh                      # once: lib/ (forge-std, v4-core)
cd e2e && npm i && cd ..        # once: viem, @noble/curves, tsx
e2e/run.sh                      # all four scenarios, each on a fresh anvil (free port): sets up, runs the test, stops anvil
```
Negative case: `SCENARIO=topup` runs the same flow, but right after the buy the receiver's usual wallet sends exactly 12,345 wei to the stealth address; it passes only if the funding audit reports that extra inflow, naming the transaction and the amount.
Replay: `SCENARIO=replay` sends the very same prepared buy a second time, right after the first (the 8 Oct mainnet case). It passes only if that second transaction is mined and reverts with `StealthAddressUsed`, costs the buyer only gas, announces nothing, and the rest of the flow, funding audit included, stays tip-only.
Replay after drain: `SCENARIO=replay-drain` runs the whole flow first, so the receiver has moved every token and every wei of ETH to a fresh address and the stealth address is empty (0 ETH, 0 tokens, no code). Then the very same prepared buy is sent again. It passes only if that transaction is mined and reverts with `StealthAddressUsed`, moves nothing, announces nothing, and the funding audit stays tip-only.
Run one scenario alone with `SCENARIO=tip-only`, `SCENARIO=topup`, `SCENARIO=replay` or `SCENARIO=replay-drain e2e/run.sh`.
`RPC_URL=http://127.0.0.1:8545 e2e/run.sh` uses an anvil you already run instead.

## Status
Unaudited. Two test deployments of the earlier version (without the fresh address guard or the use record) ran on mainnet on 8 Oct against a canary token, for the receipt flow above; no production deployment yet. Deploy script: `script/DeployStealthBuy.s.sol` (mainnet PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`). Issues and PRs welcome. MIT.
