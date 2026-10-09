#!/usr/bin/env bash
# Receiver test on a local anvil chain: plain Uniswap v4 + StealthBuy, real ERC-5564 keys, no public network.
#   e2e/run.sh                                  runs all four scenarios, each on its own fresh anvil (free port, stopped afterwards)
#   SCENARIO=tip-only e2e/run.sh                positive only: the tip is the only ETH that reaches the stealth address
#   SCENARIO=topup e2e/run.sh                   negative only: the receiver's wallet adds 12,345 wei; the audit must flag it
#   SCENARIO=replay e2e/run.sh                  the same buy sent twice: the second must revert with StealthAddressUsed
#   SCENARIO=replay-drain e2e/run.sh            the same buy again after the receiver emptied the address: StealthAddressUsed
#   RPC_URL=http://127.0.0.1:8545 e2e/run.sh    uses an anvil you already run (must be chain id 31337);
#                                               each scenario then gets a fresh deployment and is audited from its first block
# Needs: ./setup.sh done once (lib/), Foundry (anvil, cast, forge) on PATH, `npm i` in e2e/.
# FORGE_FLAGS is passed to `forge script` (e.g. FORGE_FLAGS="--offline").
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in anvil cast forge node; do command -v "$bin" >/dev/null || { echo "e2e: $bin not found on PATH" >&2; exit 1; }; done
[ -d lib/v4-core ] || { echo "e2e: run ./setup.sh first (fetches lib/)" >&2; exit 1; }
[ -x e2e/node_modules/.bin/tsx ] || { echo "e2e: run 'cd e2e && npm i' first" >&2; exit 1; }

SCENARIOS=${SCENARIO:-tip-only topup replay replay-drain}
for s in $SCENARIOS; do
  case "$s" in
    tip-only | topup | replay | replay-drain) ;;
    *) echo "e2e: SCENARIO must be tip-only, topup, replay or replay-drain, not '$s'" >&2; exit 1 ;;
  esac
done

ANVIL_PID=
stop_anvil() {
  if [ -n "$ANVIL_PID" ]; then kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null || true; ANVIL_PID=; fi
}
trap stop_anvil EXIT

run_scenario() {
  local scenario=$1 rpc=${RPC_URL:-} port sender
  if [ -z "$rpc" ]; then
    port=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
    rpc="http://127.0.0.1:$port"
    anvil --port "$port" --silent &
    ANVIL_PID=$!
    for _ in $(seq 100); do cast chain-id --rpc-url "$rpc" >/dev/null 2>&1 && break; sleep 0.1; done
  fi
  [ "$(cast chain-id --rpc-url "$rpc")" = 31337 ] || { echo "e2e: $rpc is not a local anvil chain (31337)" >&2; exit 1; }

  # deployer = anvil's first unlocked account (no key is used or stored anywhere)
  sender=$(cast rpc eth_accounts --rpc-url "$rpc" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')
  rm -f e2e/local.json
  # shellcheck disable=SC2086
  # --slow: one transaction at a time (anvil can leave concurrently sent transactions pending)
  forge script script/LocalSetup.s.sol --rpc-url "$rpc" --broadcast --slow --unlocked --sender "$sender" -q ${FORGE_FLAGS:-}
  [ -f e2e/local.json ] || { echo "e2e: setup did not write e2e/local.json" >&2; exit 1; }

  (cd e2e && RPC_URL="$rpc" SCENARIO="$scenario" ./node_modules/.bin/tsx receiver.e2e.ts)
  stop_anvil
}

for s in $SCENARIOS; do
  echo "e2e: scenario $s"
  run_scenario "$s"
done
echo "e2e: PASS ($SCENARIOS)"
