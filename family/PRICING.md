# What this costs

Checked 2026-11-10 against Cloudflare's published plan pages. Numbers move;
the links are the places to re-check. The design keeps every component on a
free tier at family scale, and the table says what would push it over.

| Piece | Plan used | Free allowance (per account unless noted) | Family-scale usage | Where it would start costing |
|---|---|---|---|---|
| Workers (the site + API) | Workers Free | 100,000 requests/day, 10 ms CPU per request | A few hundred requests/day | Past 100k/day the Worker returns errors for the rest of the day rather than billing; the paid plan is $5/month for 10M requests. |
| Workers KV (the lists) | Workers Free | 100,000 reads/day, 1,000 writes/day, 1 GB stored | Dozens of reads, a handful of writes per day. Saves are debounced so one tick = one write. | 1,000 writes/day, which would mean ~1,000 ticks or edits in a day. |
| Static assets (public/) | Workers Free | Free, requests to assets are not counted against the Worker limit | — | Not at this size. |
| Cron trigger (the digest) | Workers Free | Cron triggers included; a few per Worker | 1 run/day | Only via the Worker request/CPU limits. |
| Custom domain `family.vasantpatel.xyz` | Your existing zone | Free | — | — |
| Cloudflare Access (login) | Zero Trust Free | Up to 50 users, one-time PIN and social/Google logins included, 24h log retention | 5 people | The 51st user. Then $7/user/month for everyone. |
| Resend (digest email) | Free | 3,000 emails/month, 100/day, one verified domain | ≤ 5 emails/day for a few weeks | Not at this size. |
| 1Password service account | Your existing 1Password subscription | Service accounts are part of the plan; the free limit on the number of service accounts and their request rate depends on plan | 1 service account, a few reads per deploy | Only if you add many service accounts. Check your plan's limit in the 1Password admin console. |
| Claude Code scheduled tasks | Your Claude plan | Counted as normal Claude usage | Optional | Each scheduled run uses Claude usage like a conversation. |

**So: yes, this is free on Cloudflare** for a household, by a wide margin.
The only recurring bills are the ones you already pay: 1Password and Claude.

## Sources

- Workers limits and pricing: https://developers.cloudflare.com/workers/platform/limits/ and https://developers.cloudflare.com/workers/platform/pricing/
- Workers KV limits: https://developers.cloudflare.com/kv/platform/limits/
- Cloudflare Zero Trust plans (Free for up to 50 users, $7/user/month after): https://www.cloudflare.com/plans/sase-zero-trust.md
- Resend pricing: https://resend.com/pricing
- 1Password service accounts: https://developer.1password.com/docs/service-accounts/

Third-party summaries seen while checking (less reliable than the pages above):
[Cloudflare Workers pricing 2026 overview](https://www.activepieces.com/blog/cloudflare-workers-pricing-2026-free-vs-paid-plans),
[Cloudflare Zero Trust free plan](https://costbench.com/software/business-vpn/cloudflare-zero-trust/free-plan/),
[1Password Families plan details](https://support.1password.com/explore/families).
