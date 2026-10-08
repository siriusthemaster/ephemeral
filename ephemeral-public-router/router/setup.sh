#!/usr/bin/env bash
# One-time setup: fetches forge-std and Uniswap v4-core (pinned, plain git clones into lib/), then builds and tests.
set -euo pipefail
cd "$(dirname "$0")"

FORGE_STD_COMMIT=0258fe875e1d8e207c1eb7175e542ea32356773c   # forge-std 1.17.0
V4_CORE_TAG=v4.0.0                                          # Uniswap v4 as deployed on mainnet

mkdir -p lib
[ -d lib/forge-std ] || git clone -q https://github.com/foundry-rs/forge-std lib/forge-std
git -C lib/forge-std checkout -q "$FORGE_STD_COMMIT"
[ -d lib/v4-core ] || git clone -q https://github.com/uniswap/v4-core lib/v4-core
git -C lib/v4-core checkout -q "$V4_CORE_TAG"
git -C lib/v4-core submodule update --init -q lib/solmate

forge build
forge test -vv
