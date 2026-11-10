# Move Board

A shared, phone-first checklist for the 13 → 51 Hartlander move. One Cloudflare
Worker serves the page and a tiny JSON API; the list lives in a Workers KV
namespace; Cloudflare Access (one-time PIN by email) decides who can open it.

```
phone ──HTTPS──▶ move.vasantpatel.xyz
                  │  Cloudflare Access: login by one-time PIN, allowed emails only
                  ▼
                Worker (src/worker.js)
                  ├─ verifies the Access JWT itself (signature, issuer, audience, expiry)
                  ├─ GET  /            → src/index.html
                  ├─ GET  /api/state   → { version, state, updatedAt, updatedBy }
                  ├─ PUT  /api/state   → saves if `version` matches, else 409 + current copy
                  └─ GET  /healthz     → "ok" (no login; used by the deploy smoke test)
                  ▼
                KV namespace MOVE_BOARD, key "state"
```

## Deploying

The deploy is meant to be run by a Claude Code session following
[CLAUDE.md](CLAUDE.md). Humans can run the same three scripts:

| Script | What it does |
|---|---|
| `scripts/install-op.sh` | Installs the 1Password CLI (`op`) via apt, falling back to a pinned zip. |
| `scripts/deploy.sh` | Reads the Cloudflare token + account id from 1Password, runs `wrangler deploy`, smoke-tests the domain. |
| `scripts/setup-access.sh a@x b@y` | Creates/updates the Cloudflare Access app for the domain with those emails, writes the Access audience into `wrangler.toml`, redeploys. |

Secrets come from 1Password via a service account: set `OP_SERVICE_ACCOUNT_TOKEN`
in the environment, and keep the Cloudflare token in vault `Claude-Deploy`, item
`Cloudflare Move Board`, fields `credential` and `account_id`. Nothing secret is
stored in this repo. The Cloudflare token needs:

- Account: Workers Scripts Edit · Workers KV Storage Edit · Access: Apps and Policies Edit · Access: Organizations, Identity Providers, and Groups Read
- Zone `vasantpatel.xyz`: Workers Routes Edit · DNS Edit · Zone Read

Network hosts the deploy touches: `api.cloudflare.com`, the npm registry,
`downloads.1password.com` or `cache.agilebits.com`, and `my.1password.com`.

## How the board behaves

- **Starting list** is `seed.json`, taken from the Claude artifact version of the board on 2026-11-10 including the three items already ticked. It is only used while KV is empty. After the first save, KV is the source of truth and editing `seed.json` changes nothing.
- **Saving**: each change is applied locally, then PUT with the version number last seen. If someone else saved first the server answers 409 with their copy, the page re-applies your pending changes on top and saves again. Tested in `scripts/test-local.mjs`.
- **Refresh**: the page re-fetches when it regains focus, comes back online, and every 60 s while visible.
- **Who changed it**: the Access login email is recorded on every save and shown under the list as "Last change by …".
- **Login gate**: the worker fails closed. With `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` empty it returns 503 for everything but `/healthz`; otherwise every request must carry a valid Access JWT (header or `CF_Authorization` cookie). `workers.dev` and preview URLs are disabled so the custom domain is the only way in.
- **Storage caveat**: KV is eventually consistent. Two people saving within the same second from different continents could still lose one tick. Fine for a household; not a general-purpose sync engine.

## Everyday maintenance

| Task | How |
|---|---|
| Change who can log in | `bash scripts/setup-access.sh` with the complete new email list, then commit `wrangler.toml`. |
| Redeploy after editing the page or worker | `bash scripts/deploy.sh` |
| Reset the board to the seed list | `source scripts/cf-env.sh && npx wrangler kv key delete --binding MOVE_BOARD --remote state` |
| Look at the raw saved data | `source scripts/cf-env.sh && npx wrangler kv key get --binding MOVE_BOARD --remote state` |
| Use a different hostname | Edit the `routes` pattern in `wrangler.toml`, run `deploy.sh`, then `setup-access.sh` again (the Access app is matched by domain). |
| Change the move date or title | Edit them in the saved state (they are `move` and `title` in the JSON) or reset to a changed `seed.json`. |

## Local development and tests

```bash
npm ci
npm run dev        # http://127.0.0.1:8787 with the login gate bypassed (ALLOW_UNAUTHENTICATED)
npm test           # boots wrangler dev three ways; 32 checks: API, 409 merge, page via Playwright, JWT verification, fail-closed
```

The test signs its own RS256 JWTs and points the worker at a local certs
endpoint via `ACCESS_CERTS_URL`, so Access verification is exercised offline.
Playwright with Chromium must be installed (it is in the Claude Code cloud container).

## Files

```
CLAUDE.md              step-by-step deploy instructions for a Claude Code session
README.md              this file
wrangler.toml          worker name, custom domain, KV binding, Access vars (filled by setup-access.sh)
package.json           pins wrangler; npm scripts dev / deploy / test
seed.json              the initial list
src/worker.js          API, Access JWT verification, page serving
src/index.html         the board (vanilla JS, no build step)
scripts/cf-env.sh      loads Cloudflare credentials from 1Password (sourced by the two scripts below)
scripts/install-op.sh  installs the 1Password CLI
scripts/deploy.sh      wrangler deploy + smoke test
scripts/setup-access.sh  Cloudflare Access app + policy, patches wrangler.toml, redeploys
scripts/test-local.mjs local end-to-end test (npm test)
```
