# Access Control — Testing & Validation Guide

## Overview

`pizza.vasantpatel.xyz` is protected by a Cloudflare WAF. Only Prisma Access egress IPs are allowed through. Everyone else is blocked and redirected to an access request flow that verifies their identity before forwarding the request to the admin.

---

## What You're Testing

| Component | What it does |
|---|---|
| WAF block + redirect | Non-Prisma traffic is blocked and sent to the access request page |
| Access request form | Collects name, phone, company, work email |
| Turnstile | Proves the submitter is human |
| Corporate email check | Rejects Gmail, Yahoo, Hotmail, etc. |
| OTP verification | Sends a 6-digit code to the work email, confirms they own it |
| Admin email | Sends full request details to `patelv26@gmail.com` |
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
- Form shows: Full name, Phone, Company, Work email
- Turnstile widget appears at the bottom

---

## Test 2 — Corporate Email Enforcement

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

## Test 3 — OTP Verification

Enter the 6-digit code from the email.

**Expected:**
- Success screen: "Request sent"
- Admin receives email at `patelv26@gmail.com` with:
  - Name, phone, company, email
  - Requested URL (`https://pizza.vasantpatel.xyz/`)
  - Full network info (IP, ISP, ASN, hostname, location, timezone, coordinates)
  - Browser info (user agent, platform, language, screen)
- `vasant_verified` cookie is set in the browser (30 days, all of `vasantpatel.xyz`)

To inspect the cookie:
```
DevTools → Application → Cookies → vasantpatel.xyz → vasant_verified
```

---

## Test 4 — WAF Block + Redirect

> Requires a non-Prisma network (phone hotspot, home internet, coffee shop WiFi).

1. Disconnect from VPN / Prisma Access
2. Visit `https://pizza.vasantpatel.xyz`

**Expected:**
- Cloudflare WAF blocks the request
- Browser immediately redirects to `https://vasantpatel.xyz/myip?access=1&from=https://pizza.vasantpatel.xyz/`
- Full access request page loads

---

## Test 5 — Verified Cookie Bypass

After completing Test 3 (OTP verified, cookie set):

1. Visit `https://pizza.vasantpatel.xyz` from the same browser
2. The `vasant_verified` cookie is present

**Expected:**
- WAF skip rule matches the cookie
- No redirect, no block — direct access to the site

To test cookie expiry / revocation: clear cookies in DevTools and revisit. You should be blocked and redirected again.

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

Every verified request generates an email to `patelv26@gmail.com`:

```
Subject: Access Request — Jane Smith @ Acme Corp

--- Requester ---
Name:          Jane Smith
Phone:         +1 212 555 0100
Company:       Acme Corp
Email:         jane@acmecorp.com
Reason:        (blank)
Requested URL: https://pizza.vasantpatel.xyz/

--- Network ---
IP:          203.0.113.45
ISP:         Comcast Cable Communications
ASN:         AS7922
Hostname:    c-203-0-113-45.hsd1.ny.comcast.net
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

Reply-to is set to the requester's email — just hit reply to respond.

---

## Quick Reference

| URL | Purpose |
|---|---|
| `https://pizza.vasantpatel.xyz` | Protected site — blocked without Prisma IP or verified cookie |
| `https://vasantpatel.xyz/myip?access=1` | Access request form (direct link for demo) |
| `https://vasantpatel.xyz` | Public splash page (Matt Damon facts) |
