# Move Board — deploy instructions for Claude Code

You are deploying a small family move checklist to Cloudflare. Everything is
already written and tested locally. Your job is to run the scripts in order,
check each result, and report back. Work in the directory that contains this
file (`cd` into it first if the repo root is somewhere else).

Rules for this session:

- Do not ask the user anything except at **Step 3** (the email list). Decide everything else yourself from these instructions.
- Never print, echo or log the Cloudflare token or the 1Password token. The scripts only print lengths.
- Do not edit `wrangler.toml` by hand. `scripts/setup-access.sh` is the only thing that should change it.
- Do not touch `seed.json` or `src/`. If something in them looks wrong, finish the deploy and mention it at the end.
- If a step fails, read the **If it fails** notes for that step, fix only what they cover, and retry once. If it still fails, stop and report the exact error output to the user.

## Step 1 — Preflight

Run, in this order:

```bash
test -n "$OP_SERVICE_ACCOUNT_TOKEN" && echo "OP token present" || echo "OP token MISSING"
bash scripts/install-op.sh
op read "op://Claude-Deploy/Cloudflare Move Board/account_id" | wc -c
op read "op://Claude-Deploy/Cloudflare Move Board/credential" | wc -c
```

Expected: "OP token present", `op` installs and prints its version, and both `wc -c` lines print a number greater than 10 (the account id is 32 hex chars, the token about 40 chars). Nothing else about the secrets should be shown.

**If it fails**

- `OP token MISSING`: stop. Tell the user to add `OP_SERVICE_ACCOUNT_TOKEN` to the Claude Code cloud environment (claude.ai → Code → environment settings → Environment variables) and start a new session.
- `install-op.sh` cannot download: the environment's network does not allow 1Password. Stop and tell the user to allow `downloads.1password.com`, `cache.agilebits.com` and `my.1password.com` (or switch the environment to unrestricted network), then start a new session.
- `op read` says the item or field is not found: stop. Tell the user the 1Password item must be in vault `Claude-Deploy`, titled exactly `Cloudflare Move Board`, with fields named `credential` (the Cloudflare API token) and `account_id`, and the service account must have read access to that vault.

## Step 2 — Deploy the worker

```bash
bash scripts/deploy.sh
```

Expected: wrangler uploads `move-board`, binds the `MOVE_BOARD` KV namespace, attaches the custom domain `move.vasantpatel.xyz`, and the smoke test prints `/healthz -> 200` and `/ -> 503 (expected until setup-access.sh has run)`. The 503 is correct: the worker refuses to serve the board until the login gate exists.

**If it fails**

- `Authentication error [code: 10000]` or similar from wrangler: the Cloudflare API token is missing a permission. Tell the user the token needs, for the account: *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Access: Apps and Policies: Edit*, *Access: Organizations, Identity Providers, and Groups: Read*; and for the zone `vasantpatel.xyz`: *Workers Routes: Edit*, *DNS: Edit*, *Zone: Read*. Stop and report.
- An error about the custom domain or an existing DNS record for `move.vasantpatel.xyz`: tell the user to delete that DNS record in the Cloudflare dashboard, then retry once.
- `/healthz` keeps returning 000 or 5xx after the retries but wrangler said "Deployed": wait two minutes and run `curl -sI https://move.vasantpatel.xyz/healthz` again. New custom domains sometimes take a few minutes for the certificate. Carry on to Step 3 if wrangler itself succeeded.
- Network errors reaching `api.cloudflare.com` or the npm registry: the environment's network must allow `api.cloudflare.com` (npm is normally allowed by default). Stop and report.

## Step 3 — Turn on the login gate (Cloudflare Access)

Ask the user exactly this, then wait:

> Which email addresses should be allowed to open the board? List all of them (yours and anyone in the family who will tick items).

Then run with every address they gave you:

```bash
bash scripts/setup-access.sh first@example.com second@example.com
```

Expected: it prints the Zero Trust team domain, creates (or updates) the Access application for `move.vasantpatel.xyz` with a one-time-PIN policy for those emails, writes `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` into `wrangler.toml`, redeploys, and the final check prints `-> 302`.

Then commit the config change so the next deploy keeps the gate:

```bash
git add wrangler.toml && git commit -m "Wire Move Board worker to its Cloudflare Access app" && git push
```

**If it fails**

- "Zero Trust is not set up on this Cloudflare account yet": tell the user to open the Cloudflare dashboard → Zero Trust, choose any team name, pick the Free plan and finish the short onboarding. Then re-run the same `setup-access.sh` command.
- A permissions error listing or creating Access apps: the token needs *Access: Apps and Policies: Edit* and *Access: Organizations, Identity Providers, and Groups: Read*. Stop and report.
- If the user wants to change the list later, re-running `setup-access.sh` with the new full list replaces it.

## Step 4 — Hand over

Tell the user, in these words or close to them:

> The board is live at https://move.vasantpatel.xyz. Open it on your phone: Cloudflare will email you a one-time code, enter it, and the board loads. Tick one item, then pull to refresh and confirm it stays ticked. Anyone on the email list can do the same, and everyone sees the same board. The login lasts 30 days per device.

Then write a short final report: what was deployed, the live URL, the email list that was allowed, whether `wrangler.toml` was committed and pushed, and anything that needed a workaround.
