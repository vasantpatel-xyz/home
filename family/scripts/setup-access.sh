#!/usr/bin/env bash
# Puts the family site behind a Cloudflare Access login (one-time PIN emailed to the
# addresses you list), then redeploys the worker with the Access audience so it
# can verify logins itself.
#   bash scripts/setup-access.sh a@example.com b@example.com
# Re-running replaces the allowed email list. Needs the API token to have
# "Access: Apps and Policies: Edit" and "Access: Organizations: Read".
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then echo "usage: $0 email [email ...]" >&2; exit 2; fi
for e in "$@"; do
  case "$e" in *@*.*) ;; *) echo "'$e' does not look like an email address" >&2; exit 2;; esac
done

# shellcheck source=cf-env.sh
. scripts/cf-env.sh

API="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID"
cf() { curl -sS --fail-with-body -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
die() { echo "ERROR: $*" >&2; exit 1; }

DOMAIN="$(grep -oE 'pattern *= *"[^"]+"' wrangler.toml | head -1 | sed -E 's/.*"([^"]+)"/\1/')"
[ -n "$DOMAIN" ] || die "could not read the route pattern from wrangler.toml"

# 1. Zero Trust team domain (e.g. myteam.cloudflareaccess.com)
org="$(cf "$API/access/organizations" 2>&1)" || die "could not read the Zero Trust organization. Token needs 'Access: Organizations, Identity Providers, and Groups: Read'. Response: $org"
TEAM="$(printf '%s' "$org" | jq -r '.result.auth_domain // empty')"
if [ -z "$TEAM" ]; then
  cat >&2 <<MSG
Zero Trust is not set up on this Cloudflare account yet.
Do this once in the dashboard (free plan is fine):
  Cloudflare dashboard → Zero Trust → pick a team name → Free plan → finish onboarding.
Then re-run: bash scripts/setup-access.sh $*
MSG
  exit 1
fi
echo "Zero Trust team domain: $TEAM"

# 2. Create or update the self-hosted Access application for the board domain
include="$(printf '%s\n' "$@" | jq -R 'select(length>0) | {email:{email:.}}' | jq -s .)"
body="$(jq -n --arg d "$DOMAIN" --argjson inc "$include" '{
  name: "Family site",
  type: "self_hosted",
  domain: $d,
  session_duration: "720h",
  auto_redirect_to_identity: false,
  app_launcher_visible: false,
  policies: [ { name: "Family", decision: "allow", include: $inc } ]
}')"

apps="$(cf "$API/access/apps?per_page=100")" || die "could not list Access apps. Token needs 'Access: Apps and Policies: Edit'."
APP_ID="$(printf '%s' "$apps" | jq -r --arg d "$DOMAIN" '[.result[]? | select(.domain==$d)][0].id // empty')"

if [ -n "$APP_ID" ]; then
  echo "Updating existing Access app $APP_ID for $DOMAIN"
  res="$(cf -X PUT "$API/access/apps/$APP_ID" --data "$body")" || die "update failed: $res"
else
  echo "Creating Access app for $DOMAIN"
  res="$(cf -X POST "$API/access/apps" --data "$body")" || die "create failed: $res"
fi
printf '%s' "$res" | jq -e '.success == true' >/dev/null || die "Cloudflare rejected the Access app: $(printf '%s' "$res" | jq -c '.errors')"
AUD="$(printf '%s' "$res" | jq -r '.result.aud')"
APP_ID="$(printf '%s' "$res" | jq -r '.result.id')"
echo "Access app $APP_ID ready. Allowed: $*"

# 3. Write the audience + team domain into wrangler.toml and redeploy
DIGEST="$(IFS=,; echo "$*")"
sed -i -E "s|^ACCESS_TEAM_DOMAIN *=.*|ACCESS_TEAM_DOMAIN = \"$TEAM\"|; s|^ACCESS_AUD *=.*|ACCESS_AUD = \"$AUD\"|; s|^DIGEST_TO *=.*|DIGEST_TO = \"$DIGEST\"|" wrangler.toml
grep -q "ACCESS_AUD = \"$AUD\"" wrangler.toml || die "failed to write ACCESS_AUD into wrangler.toml"
echo "wrangler.toml updated (commit this change)."

[ -x node_modules/.bin/wrangler ] || npm ci --no-audit --no-fund --silent
node scripts/bundle-assets.mjs
npx wrangler deploy

echo
echo "Done. Open https://$DOMAIN on your phone — you should get a Cloudflare login page asking for a one-time code."
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "https://$DOMAIN/" || true)"
echo "Unauthenticated check: https://$DOMAIN/ -> $code (302 = login gate is working)"
