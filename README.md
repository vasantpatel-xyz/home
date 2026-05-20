# Access Control — Testing & Validation Guide

## Overview

`pizza.vasantpatel.xyz` is protected by a Cloudflare WAF managed via Terraform (`cloudflare-prisma-waf`). Only Prisma Browser egress IPs and previously verified users are allowed through. Everyone else is blocked and redirected to a support contact flow that collects their identity and network info before forwarding to the admin.

For WAF architecture, Terraform module structure, and IP list details see:
`~/networking/cloudflare-prisma-waf/README.md`

---

## CF Pages Setup

### Environment Variables (Settings → Environment Variables → Add as Secret)

| Variable | Value |
|---|---|
| `TURNSTILE_SECRET` | Cloudflare Turnstile secret key |
| `RESEND_API_KEY` | Resend API key (`re_...`) |
| `VERIFIED_COOKIE_SECRET` | Shared secret — must match `verified_cookie_secret` in `terraform.tfvars` |

### Bindings (Settings → Bindings → KV Namespace)

| Name | Namespace |
|---|---|
| `OTP_STORE` | `OTP_STORE` |

> After adding or changing any variable, trigger a new deployment for it to take effect.

---

## WAF Rule Summary

| Rule | Type | Expression |
|---|---|---|
| Skip | Allow | IP in `$prisma_egress_ips` only |
| Block | 403 + redirect | Everything else scoped to `pizza.vasantpatel.xyz` |

The block response is a tiny redirect page — no content served from CF directly. Users are sent to `vasantpatel.xyz/myip?access=1&from=<original URL>` where the support flow lives.

---

## What You're Testing

| Component | What it does |
|---|---|
| WAF block + redirect | Non-Prisma traffic is blocked and sent to the support page with the original URL |
| Prisma Browser check | Client-side org check + server-side IP validation against 204 known Prisma egress IPs |
| Prisma setup instructions | Device-specific steps shown (Mac, Windows, iPhone/iPad, Android) if not on Prisma |
| Support form | Collects name, phone, company, work email |
| Turnstile | Proves the submitter is human (no bots) |
| Corporate email check | Rejects Gmail, Yahoo, Hotmail, Outlook, etc. |
| OTP verification | Sends a 6-digit code to the work email — confirms they own it |
| Silent network capture | IP, ISP, ASN, hostname, location, browser info collected in background — included in admin email only |
| Confirmation email | User receives email with next steps immediately after OTP verification |
| Admin email | Full details sent to `patelv26@gmail.com` with reply-to set to user |
| IP whitelist | Admin adds approved IPs to `whitelist.json` + `terraform apply` — only way to get permanent access |

---

## Test 1 — Support Form (no VPN needed)

Visit the form directly:

```
https://vasantpatel.xyz/myip?access=1
```

**Expected:**
- Page loads in "Access Restricted" mode (🔒 header)
- If not on Prisma Browser: red warning banner appears with device-specific setup instructions, submit button locked
- If on Prisma Browser: form is active — Full name, Phone, Company, Work email
- Turnstile widget appears at the bottom
- Network info is collected silently in the background (not displayed)

---

## Test 2 — Prisma Browser Validation

### Not on Prisma
Load the form from a non-Prisma network (home internet, hotspot).

**Expected:**
- Warning banner: *"Your connection doesn't appear to be coming through Prisma Browser"*
- Device-specific setup instructions shown (auto-detected: Mac / Windows / iPhone / Android)
- Form is still submittable — user can request support even without Prisma
- Admin email will show: `On Prisma: No — submitted without Prisma Browser`

### On Prisma
Load the form while connected to Prisma Browser.

**Expected:**
- No warning banner
- Form is fully active
- Admin email will show: `On Prisma: Yes ✓`

---

## Test 3 — Corporate Email Enforcement

Fill out the form with a free email (e.g. `test@gmail.com`) and submit.

**Expected:**
- Error: `Please use your corporate email address.`
- No OTP sent

Retry with a valid work email (e.g. `yourname@yourcompany.com`).

**Expected:**
- Turnstile passes
- OTP sent to the work email
- Page switches to OTP entry step

---

## Test 4 — OTP Verification + Emails

Enter the 6-digit code from the email.

**Expected:**
- Success screen: *"Support ticket sent"*
  - *"A confirmation has been sent to your email."*
  - *"Our team will review your request and get back to you via email."*
- **User receives** confirmation email: support request received, team will follow up
- **Admin receives** email at `patelv26@gmail.com` with all details (see format below)
  - Reply-to set to user's email — just hit reply to respond

---

## Test 5 — WAF Block + Redirect

> Requires a non-Prisma network (phone hotspot, home internet, coffee shop WiFi).

1. Disconnect from VPN / Prisma Access
2. Visit `https://pizza.vasantpatel.xyz`

**Expected:**
- Cloudflare WAF blocks the request
- Browser immediately redirects to `https://vasantpatel.xyz/myip?access=1&from=https://pizza.vasantpatel.xyz/`
- Support page loads with original URL captured silently

---

## Test 6 — OTP Expiry

Start a request, wait 10+ minutes, then try to enter the OTP.

**Expected:**
- Error: `Code expired or not found. Please start over.`

---

## Test 7 — Duplicate Submission Rate Limit

Submit the form twice with the same email within 10 minutes.

**Expected:**
- Second submission returns: `A code was already sent. Check your inbox or wait 10 minutes.`

---

## Admin Email Format

```
Subject: Support Request — Jane Smith @ Acme Corp

--- Requester ---
Name:          Jane Smith
Phone:         +1 212 555 0100
Company:       Acme Corp
Email:         jane@acmecorp.com
Requested URL: https://pizza.vasantpatel.xyz/
On Prisma:     Yes ✓  (or "No — submitted without Prisma Browser")

--- Network ---
IP:          203.0.113.45
ISP:         Palo Alto Networks
ASN:         AS396982
Hostname:    ...
Location:    New York, NY, US
Postal:      10001
Timezone:    America/New_York
Coordinates: 40.7143,-74.0060

--- Browser ---
User Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)...
Platform:   MacIntel
Language:   en-US
Screen:     1680x1050 @2x
```

Reply-to is set to the user's email — hit reply to follow up.

---

## User Confirmation Email

Sent immediately after OTP verification:

```
Subject: Your support request was received

Hi Jane, your support request regarding https://pizza.vasantpatel.xyz/ has been
received and is under review.

Our team will get back to you via email. No further action needed until then.

If you have questions, reply to this email.
```

---

## Quick Reference

| URL | Purpose |
|---|---|
| `https://pizza.vasantpatel.xyz` | Protected site — blocked without Prisma IP or verified cookie |
| `https://vasantpatel.xyz/myip?access=1` | Support form (direct link for demo) |
| `https://vasantpatel.xyz` | Public splash page (Matt Damon facts) |

---

## Pending

- Get `vasantpatel.xyz` unblocked in Prisma Browser URL filtering (recategorization or admin exception in Prisma console)
