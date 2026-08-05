# Convex setup — Adscade lead capture

Backend for the lead modal on <https://adscade.com/vsl-4/>.

> **No secret appears in this file, and none may ever be added to it.** The only value the
> browser needs is the public HTTP Action URL. Deploy keys live in the shell or in CI, never
> in the repo, never in WordPress, never in `home-widget.txt`.

---

## Status

| | |
|---|---|
| Convex installed | ✅ `convex@1.42.3`, `convex/` committed |
| Schema + functions written | ✅ `schema.ts`, `http.ts`, `leads.ts` |
| Local deployment | ✅ tested — real leads written and read back |
| Cloud **production** (`pastel-minnow-203`) | ✅ **deployed 1 Aug 2026** |
| Production endpoint verified | ✅ full API contract + a real stored lead + idempotent replay |
| Verification rows cleared | ✅ production is at **0 leads** |
| Frontend wired to production | ✅ in `dist/head-tags.txt` |
| Live on `/vsl-4/` | ⬜ needs the paste — see the install steps in the completion report |

> **Rotate the production deploy key.** It was transmitted in plaintext during setup.
> Dashboard → Production → Settings → Deploy Keys → revoke and reissue. Nothing in this
> repo or in WordPress depends on it; only future `npx convex deploy` runs use it.

---

## Project layout

```
convex/
  schema.ts   leads table, enums, indexes
  http.ts     public POST /submit-lead + OPTIONS preflight, validation, CORS
  leads.ts    internalMutation insertLead — the authoritative write
  debug.ts    internal read-only queries used by the test suites
```

---

## Schema

Table `leads`:

| Field | Type | Notes |
|---|---|---|
| `submissionId` | string | client UUID; **idempotency key** |
| `createdAt` | number | **server** clock, ms epoch |
| `name` | string | ≤200 chars |
| `email` | string | as typed |
| `normalisedEmail` | string | trimmed + lowercased |
| `phone` | string | **as typed** — never overwritten |
| `normalisedPhone` | string | E.164 where derivable |
| `activeInventory` | enum | `1_19` `20_49` `50_99` `100_plus` |
| `monthlyMediaBudget` | enum | `below_1l` `1_3l` `3_5l` `above_5l` |
| `consent` | boolean | only `true` can be stored |
| `landingPage` `referrer` | optional string | ≤2048 |
| `utmSource` `utmMedium` `utmCampaign` `utmContent` `utmTerm` `gclid` | optional string | ≤256 |
| `deviceCategory` | optional string | `mobile` \| `tablet` \| `desktop` |
| `userAgent` | optional string | truncated to 512, operational triage only |
| `status` | string | `submitted` on insert |

Indexes: `by_submissionId`, `by_createdAt`, `by_normalisedEmail`, `by_normalisedPhone`.

**Never stored:** lead score, qualification outcome, disqualification reason,
manual-review status. There is no scoring model. `http.ts` returns **400** if a client
sends `score`, `outcome`, `qualified` or `status` — failing loudly beats ignoring it.

---

## Endpoint

```
POST    https://<production>.convex.site/submit-lead
OPTIONS https://<production>.convex.site/submit-lead
```

Deployed and verified:

```
https://pastel-minnow-203.convex.site/submit-lead
```

### Allowed origins

```
https://adscade.com
https://www.adscade.com
```

The matched origin is echoed back; a wildcard is never returned. `Vary: Origin` is set so
a cache cannot serve one origin's response to another.

`ADSCADE_DEV_ORIGIN` is an optional Convex env var that appends **one** extra origin. It
exists so the browser end-to-end suite can run against a real backend. **It must not be set
in production** — check with `npx convex env list --prod`.

> **CORS is not authentication.** It stops an ordinary browser on another site from posting
> here. It stops nothing that sets its own headers — curl, a script, a server. The real
> protections are validation, the enum checks, length caps, the honeypot and idempotency.

### Responses

```jsonc
{ "ok": true,  "submissionId": "…", "stored": true }                    // 200 stored
{ "ok": true,  "submissionId": "…", "stored": true, "duplicate": true } // 200 idempotent replay
{ "ok": true,  "submissionId": null, "stored": false }                  // 200 honeypot — nothing written
{ "ok": false, "code": "validation_error", "fields": ["email"] }        // 422
{ "ok": false, "code": "malformed_body" }                               // 400
{ "ok": false, "code": "payload_too_large" }                            // 413
{ "ok": false, "code": "server_error" }                                 // 500
```

**`stored: true` is the only thing that triggers the redirect to Calendly.** No internal
database id is ever returned.

A tripped bot trap no longer returns `stored: false` — it stores the lead with
`status: "suspect"` and returns `stored: true`, because discarding silently destroyed real
leads whose browser autofilled the hidden field. The client still refuses to redirect on
`stored: false`, so a future server change cannot hand off an unsaved lead.

---

## Running it

```bash
npx convex dev
```

Watches `convex/`, pushes on save, prints the deployment URL. Writes `CONVEX_URL` and
`CONVEX_SITE_URL` to `.env.local`, which is gitignored.

Inspect leads:

```bash
npx convex dashboard
```

or from the CLI:

```bash
npx convex run --no-push internal.debug.recentLeads
```

---

## Deploying

**Do not run an interactive project-creation flow, and do not create a second project.**
Deploy to the project that already exists.

```bash
npx convex deploy
```

`npx convex deploy` needs one of:

- an interactive session already logged in via `npx convex login`, or
- `CONVEX_DEPLOY_KEY` exported in the same shell, holding a **production** deploy key for
  `pastel-minnow-203`.

A key beginning `dev:` deploys to a development deployment and **cannot** deploy production.
Generate the production key in the dashboard: switch the environment selector to
**Production**, then Settings → Deploy Keys → Create Deploy Key.

After deploying:

```bash
npx convex env list --prod          # confirm ADSCADE_DEV_ORIGIN is NOT set
node tools/convex-api.mjs https://pastel-minnow-203.convex.site
```

---

## Connecting the frontend

One value, injected before the widget script runs. In WordPress put it in the **header**
snippet (`dist/head-tags.txt` already contains it, commented, with a placeholder):

```html
<script>window.ADSCADE_LEAD_ENDPOINT = "https://pastel-minnow-203.convex.site/submit-lead";</script>
```

The page reads it at call time, so header/widget load order does not matter. If it is
missing or empty the form fails visibly and the visitor is **not** redirected — it never
pretends to have saved anything.

---

## Testing

```bash
node tools/convex-api.mjs                      # HTTP contract against .env.local
node tools/convex-api.mjs https://<prod>.convex.site
node tools/convex-e2e.mjs                      # real browser → real origin → real database
```

`convex-e2e.mjs` needs the page served from an allowed origin:

```bash
npx http-server site -p 8788 -s
npx convex env set ADSCADE_DEV_ORIGIN http://127.0.0.1:8788    # dev deployment ONLY
```

### CORS by hand

```bash
curl -i -X OPTIONS https://pastel-minnow-203.convex.site/submit-lead -H "Origin: https://adscade.com"
```

Expect `204`, `access-control-allow-origin: https://adscade.com`, `vary: Origin`.

```bash
curl -i -X OPTIONS https://pastel-minnow-203.convex.site/submit-lead -H "Origin: https://evil.example"
```

Expect **no** `access-control-allow-origin` header.

### A submission by hand

```bash
curl -i -X POST https://pastel-minnow-203.convex.site/submit-lead \
  -H "Content-Type: application/json" -H "Origin: https://adscade.com" \
  -d '{"submissionId":"11111111-2222-3333-4444-555555555555","name":"Test Lead","email":"test@example.com","phone":"9876543210","activeInventory":"50_99","monthlyMediaBudget":"3_5l","consent":true,"website":""}'
```

Expect `{"ok":true,...,"stored":true}`. Repeat it — the second call returns
`"duplicate":true` and **no second row appears**. Delete the test row in the dashboard
afterwards.

---

## Rolling back

Functions are versioned per deploy. In the dashboard: **History** → pick the previous
deploy → *Rollback*. Or redeploy a known-good commit:

```bash
git checkout <sha> -- convex/ && npx convex deploy
```

A schema change that only **adds optional fields** is backward compatible and needs no data
migration. Adding a **required** field to a table with existing rows will be rejected at
push — add it as optional, backfill, then tighten.

To disable intake without touching WordPress, clear `ADSCADE_LEAD_ENDPOINT` in the header
snippet. The form then fails visibly rather than silently dropping leads.

---

## Bot protection — what exists, what is optional

Live today: honeypot (`website`); a `Content-Type: application/json` requirement — without
it a `text/plain` POST is a CORS *simple request*, so any third-party page could write
leads and the allow-list would only withhold the response header; a **403** on a present
but non-allow-listed `Origin` (omitting the response header alone does not stop the write);
`Content-Length` and body-size caps; strict enum and length validation; spreadsheet-formula
neutralisation on operator-facing text; `http(s)`-only URL fields; idempotency on
`submissionId`, which the page now generates once per modal-open so a retry after a
timeout replays rather than duplicates; and a disabled submit button while in flight.

**There is no request-rate limit.** A determined script can still write many valid leads.
That is the main residual risk and the reason to watch the queue after launch.

**No IP address is stored**, raw or hashed. India's carrier-grade NAT puts very many
unrelated mobile visitors behind one address, and this funnel is ~99% mobile, so
IP-keyed rate limiting would block real buyers to stop a bot that can rotate addresses
anyway.

**Cloudflare Turnstile** is the recommended next step *if* spam appears — it is
privacy-preserving and usually invisible. It is deliberately **not installed**: it costs
conversions on this audience and there is no evidence of abuse yet. Add it only on request.

Watch the booked-call rate for the first fortnight of paid traffic. Every stored lead is
offered a calendar, so bot friction is the only thing between a scripted submitter and a
diary full of fake appointments.

---

## Future: the Calendly webhook

There is no booking signal on the landing page at all: the visitor is redirected to
Calendly and books after leaving the site, so nothing in the browser can honestly report
it. Read booked calls from the Calendly dashboard, or make them authoritative here:

1. Add `calendarToken` (server-minted, opaque) to the schema and return it on success.
2. Append it to the redirect URL as a Calendly UTM/custom field.
3. Add `POST /calendly-webhook`, verify `Calendly-Webhook-Signature` (HMAC) on **every**
   request, look up `by_calendarToken`, set `booked`, `bookedAt`, `calendlyEventUri`.
4. Subscribe to `invitee.created` and `invitee.canceled`.

**Never key a booking update on `submissionId`.** It is generated in the browser and
travels through a query string; anyone who saw one could mark arbitrary leads as converted.

---

## Clearing verification data

```bash
npx convex run internal.admin.countLeads
npx convex run internal.admin.listLeads '{"limit":20}'
npx convex run internal.admin.purgeTestLeads
```

`purgeTestLeads` deletes only rows whose stored user-agent is `node`, `curl/…` or
contains `HeadlessChrome`. No browser sends those, so it cannot match a genuine visitor —
which is why it is safer than purging by date or clearing the table.
