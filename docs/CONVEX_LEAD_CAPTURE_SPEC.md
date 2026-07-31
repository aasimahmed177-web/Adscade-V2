# Convex lead capture — integration specification

Version 2.0 · 31 July 2026
Status: **specification only. Nothing here is deployed.** No Convex project has been
created, no keys exist, and the landing page contains no Convex code.

This document is the contract the frontend already codes against. When Convex is stood up,
implementing this spec is the whole of the integration work — the page itself changes by
exactly one configuration value.

> **What changed in v2.** The weighted qualification model, the three outcome states and the
> disqualification path were removed by the client. There is now **one flow**: a valid lead
> is stored and every stored lead is offered the calendar. Sections 0, 1, 3–7 and 13 were
> rewritten; §§8–12 and 14 are substantially unchanged.

---

## 0. What the browser is trusted with

Almost nothing, and less than before.

Under v1 the page computed a score and the server had to recompute it to stop a visitor
editing their way into the calendar. **That attack surface no longer exists** — there is
nothing to score and nothing to gain by tampering. What remains is simpler and still holds:

1. **The calendar is revealed only after the server confirms storage.** `submitLead()`
   requires a 200 carrying `ok === true`; anything else — non-2xx, a network failure,
   malformed JSON, `ok:false`, or no endpoint configured — leaves the modal open with a
   retryable error and the scheduling section hidden. A lead that was not stored can never
   produce a booking.
2. **The server owns the clock and the identity.** The client's `timestamp` is telemetry;
   `submittedAt` is set from the server clock. The client's `submissionId` is an
   idempotency key, not a credential.
3. **No verdict field is accepted.** The frontend sends no score, outcome or eligibility
   flag. If a future client ever does, the backend must reject the payload rather than
   ignore the field — see §5.

---

## 1. Schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  leads: defineTable({
    // identity
    submissionId: v.string(),            // client-generated UUID; idempotency key
    submittedAt:  v.number(),            // server clock, ms epoch — never the client's

    // the five answers + consent. This is the whole form.
    name:               v.string(),
    email:              v.string(),
    phone:              v.string(),      // E.164 where derivable, else digits as given
    activeInventory:    v.union(v.literal("1_19"), v.literal("20_49"),
                                v.literal("50_99"), v.literal("100_plus")),
    monthlyMediaBudget: v.union(v.literal("below_1l"), v.literal("1_3l"),
                                v.literal("3_5l"), v.literal("above_5l")),
    consent:            v.boolean(),     // always true; false is rejected at validation

    // attribution
    landingPage:  v.optional(v.string()),
    referrer:     v.optional(v.string()),
    utmSource:    v.optional(v.string()),
    utmMedium:    v.optional(v.string()),
    utmCampaign:  v.optional(v.string()),
    utmContent:   v.optional(v.string()),
    utmTerm:      v.optional(v.string()),
    gclid:        v.optional(v.string()),
    device:       v.optional(v.string()), // mobile | tablet | desktop

    // booking lifecycle
    calendarToken:    v.optional(v.string()), // opaque; correlates the Calendly webhook
    booked:           v.boolean(),
    bookedAt:         v.optional(v.number()),
    calendlyEventUri: v.optional(v.string()),

    // operational — set by staff, not by the page
    ipHash: v.optional(v.string()),      // sha256(ip + secret). Never a raw IP.
    status: v.union(v.literal("new"), v.literal("contacted"),
                    v.literal("booked"), v.literal("closed"), v.literal("dropped")),
  })
    .index("by_submissionId", ["submissionId"])   // idempotency lookups
    .index("by_calendarToken", ["calendarToken"]) // webhook correlation
    .index("by_email", ["email"])
    .index("by_status", ["status", "submittedAt"])
    .index("by_submittedAt", ["submittedAt"]),
});
```

`by_outcome` is gone with the outcomes. `by_status` replaces it for the dashboard's default
view — status is now set by whoever works the lead, not by a scoring function.

**Why `by_calendarToken` and not `by_submissionId` for the webhook.** The submission ID is
generated in the browser and travels through a query string. Anyone who sees one could
forge a booking update. The calendar token is minted server-side, never rendered on the
page, and is the only key the webhook path accepts. See §9.

---

## 2. Public HTTP action

One public endpoint. Privileged mutations are never exposed to the browser.

```ts
// convex/http.ts
import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

const http = httpRouter();

http.route({
  path: "/lead",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const origin = request.headers.get("Origin") ?? "";
    if (!isAllowedOrigin(origin)) return json(403, { ok: false, code: "forbidden_origin" });

    let body: unknown;
    try { body = await request.json(); }
    catch { return json(400, { ok: false, code: "malformed_body" }); }

    const result = await ctx.runMutation(internal.leads.submit, {
      payload: body,
      ipHash: await hashIp(request),
    });
    return json(result.status, result.body, origin);
  }),
});

http.route({ path: "/lead", method: "OPTIONS", handler: preflight });
http.route({ path: "/calendly-webhook", method: "POST", handler: calendlyWebhook });

export default http;
```

The action does three things only: check origin, parse, delegate. All logic lives in the
internal mutation, which the browser cannot call.

---

## 3. Request payload

Exactly what the page already sends — captured from a live submission, not transcribed:

```jsonc
{
  "submissionId": "b9ac081f-84cb-4f0d-a52b-254d8bd6a487",
  "timestamp":    "2026-07-31T15:56:59.644Z",  // client clock — telemetry only
  "name":         "Rajesh Kumar",
  "email":        "rajesh@kumardev.in",
  "phone":        "+91 98765 43210",           // as typed; normalise server-side
  "activeInventory":    "50_99",
  "monthlyMediaBudget": "1_3l",
  "consent":      true,
  "website":      "",                          // honeypot — must be empty
  "landingPage":  "https://adscade.com/vsl-4/",
  "referrer":     "https://www.youtube.com/",
  "device":       "mobile",
  "attribution": {
    "utm_source": "youtube", "utm_medium": "cpc", "utm_campaign": "carrying-cost",
    "utm_content": null, "utm_term": null, "gclid": null,
    "landing_path": "/vsl-4/", "referrer": "https://www.youtube.com/"
  }
}
```

Controlled values:

| Field | Permitted values |
|---|---|
| `activeInventory` | `1_19` · `20_49` · `50_99` · `100_plus` |
| `monthlyMediaBudget` | `below_1l` · `1_3l` · `3_5l` · `above_5l` |
| `device` | `mobile` · `tablet` · `desktop` |

**Deliberately absent:** any `score`, `outcome`, `qualified` or `rera` field. The frontend
sends none of them, and the backend must reject the payload if a future client ever does —
silently ignoring them is weaker than failing loudly.

User-agent is **not** collected. `device` is a three-value bucket and is sufficient for the
only operational question anyone actually asks (did mobile behave differently).

`phone` arrives as typed. Normalise to E.164 server-side where derivable; **store the
original alongside it** rather than replacing it, so a normalisation bug never destroys the
only way to reach a lead.

---

## 4. Response

Success — one shape, because there is one outcome:

```json
{ "ok": true, "submissionId": "opaque-id", "calendarToken": "short-lived-opaque-value" }
```

Validation error:

```json
{ "ok": false, "code": "validation_error", "fields": ["email", "phone"] }
```

Other errors: `malformed_body` (400) · `forbidden_origin` (403) · `rate_limited` (429) ·
`server_error` (500).

`calendarToken` is optional from the frontend's point of view — the page reveals the
calendar on `ok === true` alone. Send it anyway: without it the Calendly webhook has
nothing to correlate against and §9 cannot work.

**The frontend treats anything other than a 2xx carrying `ok: true` as a hard failure.**
It does not retry automatically, does not show a success state, and does not reveal the
calendar. This is verified by eight cases in `tools/e2e.mjs` (400, 422, 429, 500, network
failure, malformed JSON, `ok:false`, and no endpoint configured).

---

## 5. Internal mutation

```ts
// convex/leads.ts  (internalMutation — not callable from the browser)
export const submit = internalMutation({
  handler: async (ctx, { payload, ipHash }) => {
    if (payload.website) return ok200({});                      // honeypot: accept, discard
    if ("score" in payload || "outcome" in payload || "qualified" in payload)
      return err(400, "malformed_body");                        // client must not send these

    const fields = validate(payload);                           // §7
    if (fields.length) return err(422, "validation_error", fields);

    // idempotency: the same submissionId returns the original row, never a second one
    const existing = await ctx.db.query("leads")
      .withIndex("by_submissionId", q => q.eq("submissionId", payload.submissionId)).unique();
    if (existing) return ok200({
      submissionId: existing.submissionId, calendarToken: existing.calendarToken,
    });

    const calendarToken = crypto.randomUUID();
    await ctx.db.insert("leads", {
      submissionId: payload.submissionId,
      submittedAt:  Date.now(),                                 // server clock, not the client's
      calendarToken, booked: false, status: "new", ipHash,
      /* … the five answers, consent and attribution … */
    });
    await ctx.scheduler.runAfter(0, internal.notify.newLead, { submissionId: payload.submissionId });

    return ok200({ submissionId: payload.submissionId, calendarToken });
  },
});
```

Responsibilities, in order: honeypot → reject client-supplied verdicts → validate →
idempotency check → persist → notify → respond.

**The honeypot returns a success shape.** A bot that fills it must see the same response a
human does, or you have built it a detector. Nothing is written.

**Notify after insert, never before.** If the notification provider is down, the lead is
still stored and the visitor still reaches the calendar. Scheduling it as a separate job is
what makes that true.

---

## 6. No scoring

*Removed in v2.* There is no scoring model, no threshold, no restriction list and no
outcome routing. Every submission that passes validation is stored, and every stored lead
is offered the calendar.

**Qualification now happens on the call, by a person.** The five answers exist to prepare
for that conversation, not to decide whether it happens.

If scoring is ever reintroduced, two rules from v1 are worth carrying forward:

- Compute it server-side and never return the number to the browser.
- Reveal the calendar only on the server's word, never on a client-side verdict.

The v1 model, its 37,500-combination oracle and its mutation harness were deleted rather
than left dormant — a scoring path that still exists is a scoring path that can be
re-enabled by accident. Recover them from git history if they are ever wanted.

---

## 7. Validation

| Field | Rule | Error |
|---|---|---|
| `name` | non-empty after trim, ≤ 200 chars | `validation_error` |
| `email` | RFC-ish shape, ≤ 254 chars | `validation_error` |
| `phone` | digits 8–15; `^[6-9]\d{9}$`, `^91[6-9]\d{9}$`, `^0[6-9]\d{9}$`, or explicit `+` international | `validation_error` |
| `activeInventory` | one of the four permitted values | `validation_error` |
| `monthlyMediaBudget` | one of the four permitted values | `validation_error` |
| `consent` | must be exactly `true` | `validation_error` |
| `submissionId` | 8–64 chars, `[A-Za-z0-9-]` | `validation_error` |

Return **every** failing field at once — a form that reveals one error at a time is a form
people abandon.

**Validate the two choice fields against the permitted list, not merely as non-empty
strings.** They are radio groups in the browser, so a bad value can only arrive from a
crafted request — but that is exactly the case worth rejecting, and an unrecognised value
would otherwise sit silently in the database corrupting every report built on it.

The phone rule accepts `9876543210`, `919876543210`, `09876543210` and `+91 98765 43210`.
All four are formats Indian users actually type; rejecting any of them loses real leads.
The frontend applies the same rule, and `tools/e2e.mjs` tests all four plus an
international number and a too-short one.

---

## 8. Origins, rate limiting, bots

**CORS.** Allow-list only; no wildcard. `https://adscade.com`, `https://www.adscade.com`,
plus a staging origin from an env var. Reply `Access-Control-Allow-Origin` with the
*matched* origin, never the received one. Methods `POST, OPTIONS`; headers
`Content-Type`; `Access-Control-Max-Age: 86400`.

**Rate limiting.** Keyed on `sha256(ip + RATE_LIMIT_SECRET)`. Suggested 20 per 10 minutes.
Deliberately generous: Indian carrier-grade NAT puts very many unrelated mobile visitors
behind one address, and this funnel is ~99% mobile. This is bot friction, not a quota.
Also cap 3 submissions per email per hour.

**Bots.** Four layers, cheapest first: the honeypot `website` field (accept and discard —
never 4xx, or you teach the bot); origin check; rate limit; then a required minimum dwell
time between first render and submit if abuse appears. **Do not add a CAPTCHA** — it costs
real conversions on this audience and the honeypot is already doing the work.

> **v2 raises the stakes here.** Under v1 a junk submission was usually filtered into
> `not_current_fit` and never saw the calendar. Now every stored lead is offered a booking
> slot, so bot friction is the *only* thing standing between a scripted submitter and a
> calendar full of fake appointments. Watch the booked-call rate in the first fortnight of
> paid traffic, and turn on dwell-time checking at the first sign of abuse.

---

## 9. Calendly webhook — the authoritative booking source

The browser's `postMessage` listener is a **UX signal only**. It fires `booked_call` for
analytics. It must not be the source of truth for whether a call exists.

```
stored lead ──> calendarToken minted server-side
            └─> embed opens with the token in a Calendly UTM/custom field
Calendly booking ──> webhook POST /calendly-webhook
                 └─> verify Calendly-Webhook-Signature (HMAC, CALENDLY_WEBHOOK_SECRET)
                 └─> look up by_calendarToken
                 └─> set booked = true, bookedAt, calendlyEventUri, status = "booked"
```

Subscribe to `invitee.created` and `invitee.canceled`. Verify the signature on every
request and reject anything unsigned — otherwise the endpoint is a public "mark this lead
booked" button.

**Never accept a booking update keyed only on `submissionId`.** That value is generated in
the browser and appears in a query string; treating it as proof of a booking would let
anyone mark arbitrary leads as converted.

---

## 10. Retention, deletion, export

- Non-client enquiries: delete after **12 months**. A scheduled Convex cron does this.
- Clients: retain for the engagement plus **3 years** (tax and contract records).
- `ipHash` is one-way and cannot be reversed to an IP.
- **Deletion request** (DPDP Act, 2023): an internal mutation deletes by email across all
  rows and writes an audit entry recording the request date and what was removed.
- **Export request**: an internal query returns one subject's rows as JSON. Never expose
  either as a public HTTP route.

---

## 11. Internal dashboard

Convex-hosted or a thin admin page behind auth. Requirements:

- List by `by_status`; default view is `new`, oldest first — under v2 nothing pre-sorts the
  queue for you, so the operational risk is a lead going stale, not a lead being misjudged
- Show: submitted, name, contact, inventory, budget, source, booked, status
- Filter by status, date, UTM source, booked
- CSV export — **prefix any cell starting with `= + - @` with an apostrophe.** Formula
  injection is real: a visitor can type `=HYPERLINK(...)` into the name field, and it will
  execute when the export is opened in Excel. This exact defect was found and fixed in the
  earlier WordPress prototype.
- Status changes carry an audit trail

---

## 12. Environment variables

| Name | Purpose |
|---|---|
| `ALLOWED_ORIGINS` | Comma-separated CORS allow-list |
| `RATE_LIMIT_SECRET` | Salt for the IP hash |
| `CALENDLY_WEBHOOK_SECRET` | HMAC verification for booking webhooks |
| `NOTIFY_EMAIL` | Where new-lead notifications go |
| `RESEND_API_KEY` (or equivalent) | Transactional email provider |

**None of these ever reach the browser.** The page's only configuration value is the public
HTTP action URL, which is not a secret.

---

## 13. Migration from the mock adapter

The page ships with one seam:

```js
window.ADSCADE_ENDPOINT   // the only value that changes
```

`submitLead()` already: throws when unset, sets a 12-second `AbortController` timeout,
requires `res.ok`, requires `ok === true` in the body, and treats a JSON parse failure as a
failure. Those behaviours are what make the swap safe.

**Steps**

1. `npx convex dev`; add `schema.ts`, `http.ts`, `leads.ts` from this document.
2. Set the env vars in §12.
3. Set `window.ADSCADE_ENDPOINT` to the deployed action URL, **before** the page script
   runs. In WordPress that means a small inline `<script>` in the header, not the footer.
4. Submit one real lead and confirm four things: the row exists with all five answers, the
   modal closed without a page reload, the calendar appeared, and no secret appears in any
   network response the browser receives.
5. Submit the **same** `submissionId` twice and confirm exactly one row exists.
6. Submit with a deliberately bad email and confirm the modal stays open with a retryable
   error and the calendar stays hidden.
7. Register the Calendly webhook; make a real test booking; confirm `booked` flips.
8. Only then point paid traffic at the page.

**Do not skip steps 4–6.** Everything upstream of them is tested against a stub, not a
backend.

---

## 14. Not in scope

- No Convex project has been created, and none will be created as part of this work.
- The WordPress plugin is **superseded prototype work and must not be installed.** It has
  been renamed to `wordpress/SUPERSEDED-do-not-install/adscade-lead-capture.php.reference`
  so WordPress cannot load it. It survives only as a reference implementation of
  validation, honeypot, rate limiting and CSV-injection escaping.
- GTM is not installed and no container ID exists.
- The v1 scoring model is deleted, not disabled. See §6.
