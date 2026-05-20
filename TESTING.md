# Access Control — Testing & Validation Guide

## Overview

`pizza.vasantpatel.xyz` is protected by a Cloudflare WAF managed via Terraform (`cloudflare-prisma-waf`). Only Prisma Browser egress IPs and previously verified users are allowed through. Everyone else is blocked and redirected to an access request flow that validates their identity before forwarding the request to the admin.

For WAF architecture, Terraform module structure, and IP list details see:
`~/nhl/networking/development/cloudflare-prisma-waf/README.md`

---

## WAF Rule Summary

| Rule | Type | Expression |
|---|---|---|
| Skip | Allow | IP in `$prisma_egress_ips` **or** `vasant_verified` cookie present |
| Block | 403 + redirect | Everything else scoped to `pizza.vasantpatel.xyz` |

The block response is a tiny redirect page — no content served from CF directly. Users are sent to `vasantpatel.xyz/myip?access=1&from=<original URL>` where the full access request flow lives.

---

## What You're Testing

| Component | What it does |
|---|---|
| WAF block + redirect | Non-Prisma traffic is blocked and sent to the access request page with the original URL |
| Prisma Browser check | Client-side org check + server-side IP validation against 204 known Prisma egress IPs |
| Access request form | Collects name, phone, company, work email |
| Turnstile | Proves the submitter is human (no bots) |
| Corporate email check | Rejects Gmail, Yahoo, Hotmail, Outlook, etc. |
| OTP verification | Sends a 6-digit code to the work email — confirms they own it |
| Confirmation email | Requester receives an email with next steps immediately after OTP verification |
| Admin email | Full request details sent to `patelv26@gmail.com` with reply-to set to requester |
| Verified cookie | Sets a 30-day cookie so verified users skip the flow on return visits |
| WAF cookie bypass | Verified users reach `pizza.vasantpatel.xyz` directly on return |

---

## Test 1 — Access Request Form (no VPN needed)

Visit the form directly:

```
https://vasantpatel.xyz/myip?access=1
```

**Expected:**
- Page loads in "Access Restricted" mode (🔒 header)
- Your IP, ISP, ASN, hostname, location, and browser info resolve automatically
- If not on Prisma Browser: red warning banner appears, submit button locked
- If on Prisma Browser: form is active — Full name, Phone, Company, Work email
- Turnstile widget appears at the bottom

---

## Test 2 — Prisma Browser Validation

### Not on Prisma
Load the form from a non-Prisma network (home internet, hotspot).

**Expected:**
- Warning banner: *"You don't appear to be on Prisma Browser — connect first, then try again"*
- Submit button disabled: *"Connect to Prisma Browser first"*
- Even if the UI is bypassed, `/submit` rejects with `not_prisma` server-side

### On Prisma
Load the form while connected to Prisma Browser.

**Expected:**
- No warning banner
- Form is fully active and submittable

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
- Success screen appears:
  - *"A confirmation has been sent to your email."*
  - *"Once your request is approved you'll receive an email — then try visiting the site again."*
- **Requester receives** a confirmation email: request received, wait for approval email
- **Admin receives** email at `patelv26@gmail.com` with:
  - Name, phone, company, email
  - Requested URL (captured from the original blocked page)
  - Full network info (IP, ISP, ASN, hostname, location, timezone, coordinates)
  - Browser info (user agent, platform, language, screen)
  - Reply-to set to requester's email — just hit reply to respond
- `vasant_verified` cookie is set in the browser (30 days, all of `vasantpatel.xyz`)

To inspect the cookie:
```
DevTools → Application → Cookies → vasantpatel.xyz → vasant_verified
```

---

## Test 5 — WAF Block + Redirect

> Requires a non-Prisma network (phone hotspot, home internet, coffee shop WiFi).

1. Disconnect from VPN / Prisma Access
2. Visit `https://pizza.vasantpatel.xyz`

**Expected:**
- Cloudflare WAF blocks the request
- Browser immediately redirects to `https://vasantpatel.xyz/myip?access=1&from=https://pizza.vasantpatel.xyz/`
- Full access request page loads with original URL captured

---

## Test 6 — Verified Cookie Bypass

After completing Test 4 (OTP verified, cookie set):

1. Visit `https://pizza.vasantpatel.xyz` from the same browser
2. The `vasant_verified` cookie is present

**Expected:**
- WAF skip rule matches the cookie
- No redirect, no block — direct access to the site

To test revocation: clear cookies in DevTools and revisit. You should be blocked and redirected again.

---

## Test 7 — OTP Expiry

Start a request, wait 10+ minutes, then try to enter the OTP.

**Expected:**
- Error: `Code expired or not found. Please start over.`

---

## Test 8 — Duplicate Submission Rate Limit

Submit the form twice with the same email within 10 minutes.

**Expected:**
- Second submission returns: `A code was already sent. Check your inbox or wait 10 minutes.`

---

## Admin Email Format

```
Subject: Access Request — Jane Smith @ Acme Corp

--- Requester ---
Name:          Jane Smith
Phone:         +1 212 555 0100
Company:       Acme Corp
Email:         jane@acmecorp.com
Requested URL: https://pizza.vasantpatel.xyz/

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

Reply-to is set to the requester's email — hit reply to approve and notify them.

---

## Requester Confirmation Email

Sent immediately after OTP verification:

```
Subject: Your access request was received

Hi Jane, your access request for https://pizza.vasantpatel.xyz/ has been
received and is under review.

You'll receive a follow-up email once your request has been approved.
At that point, try visiting the site again — no further action needed until then.

If you have questions, reply to this email.
```

---

## Quick Reference

| URL | Purpose |
|---|---|
| `https://pizza.vasantpatel.xyz` | Protected site — blocked without Prisma IP or verified cookie |
| `https://vasantpatel.xyz/myip?access=1` | Access request form (direct link for demo) |
| `https://vasantpatel.xyz` | Public splash page (Matt Damon facts) |

---

## Pending

- Get `vasantpatel.xyz` unblocked in Prisma Browser URL filtering (recategorization or admin exception in Prisma console)
