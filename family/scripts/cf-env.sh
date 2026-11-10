# Sourced by deploy.sh and setup-access.sh.
# Pulls the Cloudflare credentials out of 1Password via a service account and
# exports them the way wrangler and the Cloudflare API expect. Nothing is printed.

OP_ITEM="${OP_ITEM:-op://Claude-Deploy/Cloudflare Move Board}"

# Fallback: if the token and account id are already in the environment (set as
# secret environment variables on the Claude Code cloud environment), use them
# and skip 1Password entirely.
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ] && [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID WRANGLER_SEND_METRICS=false CI=1
  echo "Cloudflare credentials taken from environment variables (token length ${#CLOUDFLARE_API_TOKEN}, account ${CLOUDFLARE_ACCOUNT_ID:0:4}…)."
  return 0 2>/dev/null || exit 0
fi

if ! command -v op >/dev/null 2>&1; then
  echo "1Password CLI (op) is not installed. Run: bash scripts/install-op.sh" >&2
  exit 1
fi
if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  echo "OP_SERVICE_ACCOUNT_TOKEN is not set. Add it to the Claude Code cloud environment (Settings → Environment variables) and start a new session." >&2
  exit 1
fi

CLOUDFLARE_API_TOKEN="$(op read "$OP_ITEM/credential")" || { echo "Could not read $OP_ITEM/credential from 1Password." >&2; exit 1; }
CLOUDFLARE_ACCOUNT_ID="$(op read "$OP_ITEM/account_id")" || { echo "Could not read $OP_ITEM/account_id from 1Password." >&2; exit 1; }
export CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
# wrangler must never fall back to an interactive browser login
export WRANGLER_SEND_METRICS=false CI=1

if [ -z "$CLOUDFLARE_API_TOKEN" ] || [ -z "$CLOUDFLARE_ACCOUNT_ID" ]; then
  echo "1Password returned an empty credential or account_id." >&2
  exit 1
fi
echo "Cloudflare credentials loaded from 1Password (token length ${#CLOUDFLARE_API_TOKEN}, account ${CLOUDFLARE_ACCOUNT_ID:0:4}…)."
