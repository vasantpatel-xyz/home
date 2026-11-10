# Agents that act on your behalf

"Agent" here means something that runs without you, with its own credentials,
and does a bounded job. Two places to put one.

## 1. Inside the Worker (free, always on, no Claude usage)

The daily digest is the first one. `src/worker.js` has a `scheduled()` entry
that Cloudflare calls on the cron in `wrangler.toml` (`0 12 * * *`, 12:00 UTC).
It loads the move board from KV, builds an email with `src/digest.js`, and sends
it through Resend to everyone in `DIGEST_TO` (the same addresses as the Access
list, written by `setup-access.sh`). It stops itself three days after the move.

Good candidates for more of these:

- Sunday evening "what is left this week" for each personal list.
- A nudge when an item has been open for more than N days.
- A weekly backup of every board to an R2 bucket (free tier: 10 GB).

Pattern: write a pure function in `src/`, call it from `scheduled()` keyed on
`event.cron`, add a cron line, test it with `npm run dev` and
`curl 'http://127.0.0.1:8787/__scheduled?cron=0+12+*+*+*'`.

## 2. Claude Code scheduled tasks (uses Claude, can do anything a session can)

A scheduled task is a Claude Code session that starts on a schedule in the
cloud, with this repo checked out and the same environment (so the same
`OP_SERVICE_ACCOUNT_TOKEN`). That is what lets it act for you: it reads the
Cloudflare token from the vault the same way `deploy.sh` does, and never sees a
secret pasted into chat.

Set one up from any Claude Code session on this repo by saying, for example:

> Create a scheduled task that runs every Sunday at 6pm Eastern in a fresh
> session on this repo. Prompt: "cd family. Source scripts/cf-env.sh. Use
> `npx wrangler kv key get --binding KV --remote` to read every `board:*` key
> (list them with `npx wrangler kv key list --binding KV --remote`). Write a
> short summary of what is still open per person and per project and email it
> to the addresses in DIGEST_TO in wrangler.toml using the Resend key from
> op://Claude-Deploy/Resend/credential."

Other useful ones:

- **Deploy on change:** "When main has new commits in `family/`, run `bash scripts/deploy.sh` and report the smoke-test lines." (Run daily; it exits fast when nothing changed.)
- **Access audit:** monthly, list the Access application's allowed emails via the Cloudflare API and compare with `DIGEST_TO`; report any difference.
- **Pricing watch:** monthly, fetch the Workers/KV usage from the Cloudflare GraphQL analytics API with the vault token and report the percentage of the free tier used.

Guardrails that keep this safe:

- The service account can read only the `Claude-Deploy` vault. Keep it that way; put new secrets in that vault rather than widening access.
- The Cloudflare token is scoped to this zone and the Workers/KV/Access permissions listed in the README. An agent cannot touch DNS for other hosts or other Workers.
- Scheduled tasks run with the repo's permission mode; keep destructive steps (deleting KV keys, removing Access policies) out of scheduled prompts.
- Every Claude run costs normal Claude usage; the Worker-side agents cost nothing.
