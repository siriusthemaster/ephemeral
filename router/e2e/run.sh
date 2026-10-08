#!/usr/bin/env bash
# Receiver test on a local anvil chain: plain Uniswap v4 + StealthBuy, real ERC-5564 keys, no public network.
#   e2e/run.sh                                  starts its own anvil on a free port, stops it afterwards
#   RPC_URL=http://127.0.0.1:8545 e2e/run.sh    uses an anvil you already run (must be chain id 31337)
# Needs: ./setup.sh done once (lib/), Foundry (anvil, cast, forge) on PATH, `npm i` in e2e/.
# FORGE_FLAGS is passed to `forge script` (e.g. FORGE_FLAGS="--offline").
set -euo pipefail
cd "$(dirname "$0")/.."

for bin in anvil cast forge node; do command -v "$bin" >/dev/null || { echo "e2e: $bin not found on PATH" >&2; exit 1; }; done
[ -d lib/v4-core ] || { echo "e2e: run ./setup.sh first (fetches lib/)" >&2; exit 1; }
[ -x e2e/node_modules/.bin/tsx ] || { echo "e2e: run 'cd e2e && npm i' first" >&2; exit 1; }

if [ -z "${RPC_URL:-}" ]; then
  PORT=$(node -e 'const s=require("net").createServer().listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  RPC_URL="http://127.0.0.1:$PORT"
  anvil --port "$PORT" --silent &
  ANVIL_PID=$!
  trap 'kill "$ANVIL_PID" 2>/dev/null; wait "$ANVIL_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 100); do cast chain-id --rpc-url "$RPC_URL" >/dev/null 2>&1 && break; sleep 0.1; done
fi
[ "$(cast chain-id --rpc-url "$RPC_URL")" = 31337 ] || { echo "e2e: $RPC_URL is not a local anvil chain (31337)" >&2; exit 1; }

# deployer = anvil's first unlocked account (no key is used or stored anywhere)
SENDER=$(cast rpc eth_accounts --rpc-url "$RPC_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[0]))')
rm -f e2e/local.json
# shellcheck disable=SC2086
# --slow: one transaction at a time (anvil can leave concurrently sent transactions pending)
forge script script/LocalSetup.s.sol --rpc-url "$RPC_URL" --broadcast --slow --unlocked --sender "$SENDER" -q ${FORGE_FLAGS:-}
[ -f e2e/local.json ] || { echo "e2e: setup did not write e2e/local.json" >&2; exit 1; }

cd e2e
RPC_URL="$RPC_URL" ./node_modules/.bin/tsx receiver.e2e.ts
