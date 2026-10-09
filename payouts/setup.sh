#!/usr/bin/env bash
# One-time setup: fetches forge-std (pinned, plain git clone into lib/), then builds and runs the Solidity tests.
# The TypeScript side (ts/) is separate: cd ts && npm i && npm test
set -euo pipefail
cd "$(dirname "$0")"

FORGE_STD_COMMIT=0258fe875e1d8e207c1eb7175e542ea32356773c   # forge-std 1.17.0

mkdir -p lib
[ -d lib/forge-std ] || git clone -q https://github.com/foundry-rs/forge-std lib/forge-std
git -C lib/forge-std checkout -q "$FORGE_STD_COMMIT"

forge build
forge test -vv
