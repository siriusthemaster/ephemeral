# StealthBuy: buy on Uniswap v4 straight into an ERC-5564 stealth address

`src/StealthBuy.sol`, about 130 lines. No owner, no state, no settings, no fee.

```solidity
function buy(PoolKey calldata key, Stealth calldata s, bytes calldata hookData) external payable returns (uint256 amountOut);
struct Stealth { address stealthAddress; bytes ephemeralPubKey; bytes1 viewTag; uint256 minOut; uint256 gasTip; }
```
`msg.value` = ETH to swap + `gasTip`. In one transaction it:
1. swaps ETH for the token on any native-ETH v4 pool (exact input; the pool's own fee and hook apply as for anyone);
2. has the PoolManager pay the tokens **directly to the stealth address**;
3. sends `gasTip` ETH (max 0.01) to the same address, so the receiver can move the tokens without funding that address from a wallet linked to them (leak H5);
4. announces through the canonical ERC-5564 Announcer (`0x55649E01B5Df198D18D95b5cc5051630cfD45564`) with standard token metadata: view tag, `0xa9059cbb`, token, amount (57 bytes), so any ERC-5564 wallet that scans finds it;
5. refunds ETH the pool did not take, and reverts below `minOut`.

What it does **not** do: hide the buyer. The buyer's address is the sender of the transaction. Buying for yourself from a known wallet links you to the stealth address unless the ETH comes from a private source. What it gives is a clean receiving side: a one-time address with gas already on it.

The withdrawal side is in `../withdrawal-policy/`: the checks (H1–H5) the ephemeral client runs before anything leaves a stealth address.

## Tests
```
./setup.sh          # pins forge-std 1.17.0 and Uniswap v4-core v4.0.0 into lib/, builds, runs the tests
forge test -vv      # 11 tests
```
On fresh v4-core pools (no dependency on any other ephemeral contract): delivery to the stealth address with gas and exact accounting (fuzzed), ERC-5564 announcement format, slippage guard, input checks, token/token pools rejected, re-entrancy from the stealth address and from the buyer's refund, exact refund on a partial fill, hooks that take a token-side fee (the announced amount is what arrived) or try to leave the caller owed ETH (reverts).

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
e2e/run.sh                      # starts anvil on a free port, sets up, runs the test, stops anvil
```
`RPC_URL=http://127.0.0.1:8545 e2e/run.sh` uses an anvil you already run instead.

## Status
Unaudited and not deployed yet. Deploy script: `script/DeployStealthBuy.s.sol` (mainnet PoolManager `0x000000000004444c5dc75cB358380D2e3dE08A90`). Issues and PRs welcome. MIT.
