#!/usr/bin/env bash
# Deploys the Move Board worker to Cloudflare.
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

echo "Deploying worker…"
npx wrangler deploy

DOMAIN="$(grep -oE 'pattern *= *"[^"]+"' wrangler.toml | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
echo
echo "Deployed. Smoke test:"
for i in 1 2 3 4 5 6; do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/healthz" || true)"
  if [ "$code" = "200" ]; then echo "  https://$DOMAIN/healthz -> 200 OK"; break; fi
  echo "  https://$DOMAIN/healthz -> $code (DNS/cert may still be propagating, retry $i/6)"; sleep 10
done
home="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" || true)"
case "$home" in
  503) echo "  https://$DOMAIN/ -> 503 (expected until setup-access.sh has run)";;
  302) echo "  https://$DOMAIN/ -> 302 redirect to the Cloudflare Access login (login gate is live)";;
  *)   echo "  https://$DOMAIN/ -> $home";;
esac
echo
echo "Next: bash scripts/setup-access.sh you@example.com partner@example.com"
