# Family site — deploy instructions for Claude Code

You are deploying the private family site `family.vasantpatel.xyz` to Cloudflare.
Everything is written and tested locally. Your job is to run the scripts in
order, check each result, and report back. Work in the directory that contains
this file (`cd` into it first if the repo root is somewhere else).

Rules for this session:

- Do not ask the user anything except at **Step 3** (the email list). Decide everything else yourself from these instructions.
- Never print, echo or log the Cloudflare token, the Resend key or the 1Password token. The scripts only print lengths.
- Do not edit `wrangler.toml` by hand. `scripts/setup-access.sh` is the only thing that should change it.
- Do not touch `seed/`, `src/` or `public/`. If something there looks wrong, finish the deploy and mention it at the end.
- If a step fails, read the **If it fails** notes for that step, fix only what they cover, and retry once. If it still fails, stop and report the exact error output to the user.

## Step 1 — Preflight

```bash
test -n "$OP_SERVICE_ACCOUNT_TOKEN" && echo "OP token present" || echo "OP token MISSING"
bash scripts/install-op.sh
op read "op://Claude-Deploy/Cloudflare Move Board/account_id" | wc -c
op read "op://Claude-Deploy/Cloudflare Move Board/credential" | wc -c
op read "op://Claude-Deploy/Resend/credential" 2>/dev/null | wc -c
```

Expected: "OP token present", `op` installs and prints its version, the two Cloudflare lines print numbers greater than 10. The Resend line may print 0; that only means the daily digest email stays off.

Alternative without 1Password: if `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are already set as environment variables (`test -n "$CLOUDFLARE_API_TOKEN" && echo set`), the scripts use them and the `op` lines above may fail harmlessly. Skip to Step 2.

**If it fails**

- `OP token MISSING`: stop. Tell the user to add `OP_SERVICE_ACCOUNT_TOKEN` to the Claude Code cloud environment (claude.ai → Code → environment settings → Environment variables) and start a new session.
- `install-op.sh` cannot download: the environment's network does not allow 1Password. Stop and tell the user to allow `downloads.1password.com`, `cache.agilebits.com` and `my.1password.com`, or switch the environment to unrestricted network, then start a new session.
- `op read` cannot find the Cloudflare item: stop. The 1Password item must be in vault `Claude-Deploy`, titled exactly `Cloudflare Move Board`, with fields `credential` (the Cloudflare API token) and `account_id`; the service account needs read access to that vault.

## Step 2 — Deploy the worker

```bash
bash scripts/deploy.sh
```

Expected: wrangler uploads `family-site` with its static pages, binds the KV namespace, attaches the custom domain `family.vasantpatel.xyz`, sets the Resend secret if the 1Password item exists, and the smoke test prints `/healthz -> 200` and `/ -> 503 (expected until setup-access.sh has run)`. The 503 is correct: the site refuses to serve anything until the login gate exists.

**If it fails**

- `Authentication error [code: 10000]` or similar: the Cloudflare API token lacks a permission. It needs, for the account: *Workers Scripts: Edit*, *Workers KV Storage: Edit*, *Access: Apps and Policies: Edit*, *Access: Organizations, Identity Providers, and Groups: Read*; for the zone `vasantpatel.xyz`: *Workers Routes: Edit*, *DNS: Edit*, *Zone: Read*. Stop and report.
- An error about the custom domain or an existing DNS record for `family.vasantpatel.xyz`: tell the user to delete that DNS record in the Cloudflare dashboard, then retry once.
- `/healthz` keeps returning 000 or 5xx after the retries but wrangler said "Deployed": wait two minutes and run `curl -sI https://family.vasantpatel.xyz/healthz` again. New custom domains can take a few minutes for the certificate. Carry on to Step 3 if wrangler itself succeeded.
- Network errors reaching `api.cloudflare.com` or npm: the environment must allow `api.cloudflare.com` (npm is normally allowed). Stop and report.

## Step 3 — Turn on the login gate (Cloudflare Access)

Ask the user exactly this, then wait:

> Which email addresses should be allowed to open the family site? List everyone: you, Ami, and any address the kids will sign in with. These same addresses will receive the daily move digest.

Then run with every address they gave you:

```bash
bash scripts/setup-access.sh first@example.com second@example.com
```

Expected: it prints the Zero Trust team domain, creates or updates the Access application for `family.vasantpatel.xyz` with a one-time-PIN policy for those emails, writes `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` and `DIGEST_TO` into `wrangler.toml`, redeploys, and the final check prints `-> 302`.

Then commit the config change so later deploys keep the gate:

```bash
git add wrangler.toml && git commit -m "Wire family site to its Cloudflare Access app" && git push
```

**If it fails**

- "Zero Trust is not set up on this Cloudflare account yet": tell the user to open the Cloudflare dashboard → Zero Trust, choose any team name, pick the Free plan and finish the short onboarding. Then re-run the same command.
- A permissions error listing or creating Access apps: the token needs *Access: Apps and Policies: Edit* and *Access: Organizations, Identity Providers, and Groups: Read*. Stop and report.
- To change the list later, re-run `setup-access.sh` with the complete new list.

## Step 4 — Hand over

Tell the user, in these words or close to them:

> The site is live at https://family.vasantpatel.xyz. Open it on your phone: Cloudflare emails you a one-time code, enter it, and the site loads. The move board is under 51 Hartlander. Tick one item, pull to refresh, and confirm it stays ticked. Everyone on the email list can do the same and sees the same board. Each person also has a page and a personal list at /kaavi, /kaveera, /kai and /ami. Logins last 30 days per device.
>
> The login is a one-time code by email today. To add Google sign-in (password plus Google's 2-step verification) follow "Stronger login" in the README; it is a five-minute dashboard step.

Then write a short final report: what was deployed, the live URL, the email list that was allowed, whether the digest email is on, whether `wrangler.toml` was committed and pushed, and anything that needed a workaround.
