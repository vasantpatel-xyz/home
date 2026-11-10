#!/usr/bin/env bash
# Runs the local end-to-end test (needs node 20+, wrangler from npm ci, and playwright with chromium).
set -euo pipefail
cd "$(dirname "$0")/.."
[ -x node_modules/.bin/wrangler ] || npm ci --no-audit --no-fund --silent
node scripts/bundle-assets.mjs
node scripts/test-local.mjs
