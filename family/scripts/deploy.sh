#!/usr/bin/env bash
# Deploys the family site worker to Cloudflare.
#   bash scripts/deploy.sh
# Credentials come from 1Password (see scripts/cf-env.sh). Safe to re-run.
set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck source=cf-env.sh
. scripts/cf-env.sh

if [ ! -x node_modules/.bin/wrangler ]; then
  echo "Installing wrangler…"
  npm ci --no-audit --no-fund --silent
fi

echo "Bundling pages…"
node scripts/bundle-assets.mjs
echo "Deploying worker…"
npx wrangler deploy

# Optional: Resend key for the daily digest email. Lives in 1Password as item "Resend"
# (field "credential") in the same vault. Skipped quietly when the item does not exist.
RESEND_ITEM="${OP_RESEND_ITEM:-op://Claude-Deploy/Resend/credential}"
if key="${RESEND_API_KEY:-$(command -v op >/dev/null 2>&1 && op read "$RESEND_ITEM" 2>/dev/null)}" && [ -n "$key" ]; then
  printf '%s' "$key" | npx wrangler secret put RESEND_API_KEY >/dev/null && echo "RESEND_API_KEY secret set (digest email enabled)."
  unset key
else
  echo "No Resend key at $RESEND_ITEM — the daily digest email stays off. Add the item and re-run deploy.sh to enable it."
fi

DOMAINS="$(grep -oE 'pattern *= *"[^"]+"' wrangler.toml | sed -E 's/.*"([^"]+)"/\1/')"
echo
echo "Deployed. Smoke test:"
for d in $DOMAINS; do
  for i in 1 2 3 4 5 6; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$d/healthz" || true)"
    case "$code" in
      200) echo "  https://$d/healthz -> 200 OK"; break;;
      302) echo "  https://$d/healthz -> 302 (Cloudflare Access is in front of the whole site: good)"; break;;
      *)   echo "  https://$d/healthz -> $code (DNS/cert may still be propagating, retry $i/6)"; sleep 10;;
    esac
  done
done
home="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$(printf '%s\n' "$DOMAINS" | head -1)/" || true)"
case "$home" in
  503) echo "  home -> 503 (expected until setup-access.sh has run)";;
  302) echo "  home -> 302 redirect to the Cloudflare Access login (login gate is live)";;
  *)   echo "  home -> $home";;
esac
echo
echo "Next: bash scripts/setup-access.sh you@example.com partner@example.com   (everyone who may open the site)"
