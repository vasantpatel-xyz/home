# family.vasantpatel.xyz

A private, phone-first family site on Cloudflare. One Worker serves static pages
from `public/` plus a tiny JSON API; shared lists live in Workers KV; Cloudflare
Access decides who may open any of it. Every person and every project gets a path.

```
family.vasantpatel.xyz/                      things that affect everyone
family.vasantpatel.xyz/51-hartlander/        project hub
family.vasantpatel.xyz/51-hartlander/move/   the move board (13 → 51, Nov 14)
kaavi.vasantpatel.xyz/                       Kaavi's home: lists his pages
kaavi.vasantpatel.xyz/reading/               Reading Quest
kaavi.vasantpatel.xyz/list/                  his checklist
kaveera. / kai. / ami.vasantpatel.xyz/       the same shape for each person
<any host>/api/boards/<id>, /api/docs/<id>   JSON behind every page (ids carry the person: kaavi/list)
<any host>/healthz                           the only path without login
```

One worker serves all five hostnames. The first label of the hostname picks the
folder under `public/` (`public/family/`, `public/kaavi/`, …); `/assets/*` and
the 404 page come from `public/_shared/`. Each home page lists that site's own
paths, and the family home links out to each person's site. One Cloudflare
Access application covers all five hostnames, so one login works everywhere.
```

```
phone ──HTTPS──▶ family.vasantpatel.xyz
                  │  Cloudflare Access: login required, allowed emails only
                  ▼
                Worker (src/worker.js) — runs first for every request
                  ├─ verifies the Access JWT itself (signature, issuer, audience, expiry)
                  ├─ /api/boards/<id>   GET → {version,state,updatedAt,updatedBy}
                  │                     PUT → saves if `version` matches, else 409 + current copy
                  ├─ /api/me            → {email}
                  ├─ everything else    → static file from public/, bundled into the worker at deploy
                  └─ cron 12:00 UTC     → digest email of open move items (src/digest.js, via Resend)
                  ▼
                KV namespace (binding KV), keys board:<id>
```

## Login: what "password and MFA" means here

Cloudflare Access is the login gate. It does not store passwords itself; it
hands the login to an identity provider and then issues a signed token the
worker checks on every request.

- **Today (set up by the script):** one-time PIN. Cloudflare emails a code to an allowed address. That is one factor (control of the mailbox) plus whatever protects the mailbox.
- **Stronger login (recommended, five minutes in the dashboard):** add Google as a login method. Each family member then signs in with their Google account, so the password *and* Google's 2-Step Verification apply. Zero Trust dashboard → Settings → Authentication → Login methods → Add new → Google. You create an OAuth client in Google Cloud console as the page describes, paste its client id/secret, then in the Access application's policy choose *Include → Emails* as before. Keep one-time PIN enabled too as the fallback for a kid's device.
- **Kids without email:** a parent signs in once on the child's device. Sessions last 30 days (`session_duration` in `setup-access.sh`).
- **Who can see what:** today one application and one email list cover all five hostnames. If a person's site should be private to them, give that hostname its own Access application with its own policy; the worker already accepts several audiences (comma-separate them in `ACCESS_AUD`).

## Deploying

Meant to be run by a Claude Code session following [CLAUDE.md](CLAUDE.md). The
same three scripts work for a human:

| Script | What it does |
|---|---|
| `scripts/install-op.sh` | Installs the 1Password CLI (`op`) via apt, falling back to a pinned zip. |
| `scripts/deploy.sh` | Reads Cloudflare token + account id from 1Password, `wrangler deploy`, sets the Resend secret if present, smoke-tests the domain. |
| `scripts/setup-access.sh a@x b@y` | Creates/updates the Access app for the domain with those emails, writes the Access audience and digest recipients into `wrangler.toml`, redeploys. |

### Secrets: 1Password only

Nothing secret is in this repo or in Cloudflare env vars you have to type. A
1Password **service account** (token in `OP_SERVICE_ACCOUNT_TOKEN`) with read
access to vault `Claude-Deploy` is the only credential the deploy machine holds.
Items it reads:

| Item | Field | Used for |
|---|---|---|
| `Cloudflare Move Board` | `credential` | Cloudflare API token (wrangler + Access API) |
| `Cloudflare Move Board` | `account_id` | Cloudflare account |
| `Resend` (optional) | `credential` | Resend API key for the daily digest. Missing item = digest off. |

Cloudflare token permissions: Account → Workers Scripts Edit · Workers KV Storage Edit ·
Access: Apps and Policies Edit · Access: Organizations, Identity Providers, and Groups Read;
Zone `vasantpatel.xyz` → Workers Routes Edit · DNS Edit · Zone Read.

Network hosts the deploy touches: `api.cloudflare.com`, the npm registry,
`downloads.1password.com` or `cache.agilebits.com`, `my.1password.com`.

## Adding a person's tool or a project page

Everything static is a folder under `public/`. `deploy.sh` bundles it into the worker (`scripts/bundle-assets.mjs`), so there is no separate upload step; for local work run `npm run bundle` after editing pages.

1. Create `public/<person>/<tool>/index.html` (copy any existing page for the head and the top bar). It is served at `https://<person>.vasantpatel.xyz/<tool>/`.
2. Link it from `public/<person>/index.html`, the home that lists that site's paths.
3. For a new shared checklist, copy `public/kai/list/index.html` and change `data-board` (the API id, lowercase with slashes, e.g. `kai/chores`) and `data-title`. It starts empty with a "To do" section; sections can be added on the page.
4. Something that affects everyone goes under `public/family/` instead.
5. A new person or group means a new hostname: add a route in `wrangler.toml`, a folder under `public/`, the name in `SITES` in `src/worker.js`, then `deploy.sh` and `setup-access.sh` (which adds the hostname to the Access app).
6. `bash scripts/deploy.sh`.

Rules the API enforces on every board: at most 30 sections and 500 items, text
trimmed to 400 characters, only `http(s)` links kept, version check on every save.

## Agents that act on your behalf

Two kinds, both documented in [agents/README.md](agents/README.md):

- **Inside Cloudflare (free, always on):** the worker's cron sends the daily digest of open move items to everyone on the Access list until three days after the move. Pattern for more: add a function in `src/`, call it from `scheduled()`, add a cron line in `wrangler.toml`.
- **Claude Code scheduled tasks:** a Claude session that runs on a schedule in the cloud with this repo and the 1Password vault, e.g. "every Sunday, read the move board and email me what is still open by owner" or "deploy when main changes". The vault is what lets it act for you without you typing secrets.

## Pricing

See [PRICING.md](PRICING.md). Short version: at family scale every piece sits
inside a free tier (Workers, KV, cron, custom domain, Access for up to 50
users, Resend's free sends). The paid 1Password plan is the only subscription,
and it is one you already have.

## Everyday maintenance

| Task | How |
|---|---|
| Change who can log in (and who gets the digest) | `bash scripts/setup-access.sh` with the complete new list, then commit `wrangler.toml`. |
| Redeploy after editing pages or the worker | `bash scripts/deploy.sh` |
| Reset a board to its seed / empty | `source scripts/cf-env.sh && npx wrangler kv key delete --binding KV --remote "board:51-hartlander/move"` |
| Inspect a board's raw data | `source scripts/cf-env.sh && npx wrangler kv key get --binding KV --remote "board:kaavi/list"` |
| Turn the digest off | `source scripts/cf-env.sh && npx wrangler secret delete RESEND_API_KEY` |
| Change the digest hour | Edit `crons` in `wrangler.toml` (UTC), redeploy. |
| Use a different hostname | Edit the `routes` pattern in `wrangler.toml`, run `deploy.sh`, then `setup-access.sh` again (the Access app is matched by domain). |

## Local development and tests

```bash
npm ci
npm run dev        # http://127.0.0.1:8787 with the login gate bypassed, cron reachable at /__scheduled
npm test           # 60 checks: digest builder, API + 409 merge, static pages, cron → mock Resend, browser flows, JWT verification, fail-closed
```

The test signs its own RS256 JWTs and points the worker at a local certs
endpoint (`ACCESS_CERTS_URL`), and at a local mock of Resend
(`RESEND_API_URL`), so everything runs offline. Playwright with Chromium must
be installed (it is in the Claude Code cloud container).

## Files

```
CLAUDE.md               step-by-step deploy instructions for a Claude Code session
README.md               this file
PRICING.md              what each piece costs and where the free tiers end
agents/README.md        the digest agent and how to add Claude scheduled tasks
wrangler.toml           worker name, custom domain, assets, cron, KV binding, Access vars (filled by setup-access.sh)
package.json            pins wrangler; npm scripts dev / deploy / test
seed/51-hartlander-move.json   the move board's starting list
src/worker.js           auth, boards API, static pass-through, cron entry
src/digest.js           digest email builder (pure function)
public/                 the site: home, people, projects, lists, shared css/js
scripts/cf-env.sh       loads Cloudflare credentials from 1Password
scripts/install-op.sh   installs the 1Password CLI
scripts/deploy.sh       wrangler deploy + Resend secret + smoke test
scripts/setup-access.sh Access app + policy, patches wrangler.toml, redeploys
scripts/test-local.mjs  local end-to-end test (npm test)
```
