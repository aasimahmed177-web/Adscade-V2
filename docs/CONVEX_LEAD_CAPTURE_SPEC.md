# Convex lead capture — integration specification

Version 1.0 · 31 July 2026
Status: **specification only. Nothing here is deployed.** No Convex project has been
created, no keys exist, and the landing page contains no Convex code.

This document is the contract the frontend already codes against. When Convex is stood up,
implementing this spec is the whole of the integration work — the page itself changes by
exactly one configuration value.

---

## 0. Why the browser cannot be trusted

The page computes a score so it can show the right panel quickly. **That computation is not
authoritative and must never be.** Anyone can open devtools and call the scoring function
with whatever answers they like, or edit the response before it is read.

Two rules follow, and everything below exists to enforce them:

1. **The server recomputes the score from the raw answer keys.** A client-supplied `score`
   or `outcome` field is ignored — the current frontend does not even send them.
2. **The calendar is revealed only on the server's word.** `submitLead()` rejects any 200
   response that does not carry a recognised `outcome`; the browser never falls back to its
   own verdict. A lead that was not stored can never produce a booking.

---

## 1. Schema

```ts
// convex/schema.ts
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const answerKeys = v.object({
  role:         v.string(),
  inventory:    v.string(),
  price_band:   v.string(),
  media_budget: v.string(),
  followup:     v.string(),
  bottleneck:   v.string(),
});

export default defineSchema({
  leads: defineTable({
    // identity
    submissionId: v.string(),            // client-generated UUID; idempotency key
    submittedAt:  v.number(),            // server clock, ms epoch — never the client's

    // contact
    name:         v.string(),
    company:      v.string(),
    projectName:  v.optional(v.string()),
    projectCity:  v.string(),
    email:        v.string(),
    phone:        v.string(),            // E.164 where derivable, else digits as given
    consent:      v.boolean(),           // always true; false is rejected at validation
    reraEligible: v.boolean(),

    // qualification — all server-computed
    answers:      answerKeys,
    answerLabels: v.optional(v.record(v.string(), v.string())),
    score:        v.number(),            // server-recomputed. Never returned to the browser.
    outcome:      v.union(v.literal("qualified"),
                          v.literal("manual_review"),
                          v.literal("not_current_fit")),
    restriction:  v.optional(v.string()), // role_broker | role_agency | no_inventory |
                                          // no_budget | no_followup | rera_ineligible
    cap:          v.boolean(),            // a manual-review cap applied

    // attribution
    landingUrl:   v.optional(v.string()),
    referrer:     v.optional(v.string()),
    utmSource:    v.optional(v.string()),
    utmMedium:    v.optional(v.string()),
    utmCampaign:  v.optional(v.string()),
    utmContent:   v.optional(v.string()),
    utmTerm:      v.optional(v.string()),
    gclid:        v.optional(v.string()),
    viewport:     v.optional(v.string()), // mobile | tablet | desktop

    // booking lifecycle
    calendarShown:  v.boolean(),
    calendarToken:  v.optional(v.string()), // opaque; correlates the Calendly webhook
    booked:         v.boolean(),
    bookedAt:       v.optional(v.number()),
    calendlyEventUri: v.optional(v.string()),

    // operational
    ipHash:       v.optional(v.string()), // sha256(ip + secret). Never a raw IP.
    status:       v.union(v.literal("new"), v.literal("contacted"),
                          v.literal("booked"), v.literal("closed"), v.literal("dropped")),
  })
    .index("by_submissionId", ["submissionId"])   // idempotency lookups
    .index("by_outcome", ["outcome", "submittedAt"])
    .index("by_calendarToken", ["calendarToken"]) // webhook correlation
    .index("by_email", ["email"])
    .index("by_submittedAt", ["submittedAt"]),
});
```

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

Exactly what the page already sends:

```jsonc
{
  "submission_id": "3f2a…",          // client UUID — idempotency key, not trusted as identity
  "submitted_at":  "2026-07-31T09:12:04.113Z",
  "name":          "Rajesh Kumar",
  "company":       "Kumar Developers",
  "project_name":  "Kumar Heights",   // optional
  "project_city":  "Indore",
  "email":         "rajesh@kumardev.in",
  "phone":         "9876543210",
  "consent":       true,
  "rera":          "yes",             // "yes" | "no"
  "answers": {
    "role": "founder", "inventory": "100_plus", "price_band": "above_150",
    "media_budget": "above_3l", "followup": "crm", "bottleneck": "low_quality"
  },
  "answer_labels": { "role": "Founder / promoter / director…", "…": "…" },
  "website":       "",                // honeypot — must be empty
  "landing_url":   "https://adscade.com/vsl-5/",
  "referrer":      "https://www.youtube.com/",
  "viewport":      "mobile",
  "attribution": {
    "utm_source": "youtube", "utm_medium": "cpc", "utm_campaign": "carrying-cost",
    "utm_content": null, "utm_term": null, "gclid": null,
    "landing_path": "/vsl-5/", "referrer": "https://www.youtube.com/"
  }
}
```

**Deliberately absent:** `score` and `outcome`. The frontend does not send them, and the
backend must reject the payload if a future client ever does — silently ignoring them is
weaker than failing loudly.

User-agent is **not** collected. `viewport` is a three-value bucket and is sufficient for
the only operational question anyone actually asks (did mobile behave differently).

---

## 4. Response

Success — one of three outcomes:

```json
{ "ok": true, "submissionId": "opaque-id", "outcome": "qualified",
  "calendarToken": "short-lived-opaque-value" }
```
```json
{ "ok": true, "submissionId": "opaque-id", "outcome": "manual_review" }
```
```json
{ "ok": true, "submissionId": "opaque-id", "outcome": "not_current_fit" }
```

Validation error:

```json
{ "ok": false, "code": "validation_error", "fields": ["email", "phone"] }
```

Other errors: `malformed_body` (400) · `forbidden_origin` (403) · `rate_limited` (429) ·
`server_error` (500).

**The numeric score is never returned.** `calendarToken` appears only on `qualified`.

The frontend already treats a 200 whose `outcome` is missing or unrecognised as a hard
failure — so an accidental `{ok:true}` cannot open the calendar.

---

## 5. Internal mutation

```ts
// convex/leads.ts  (internalMutation — not callable from the browser)
export const submit = internalMutation({
  handler: async (ctx, { payload, ipHash }) => {
    if (payload.website) return ok200({ outcome: "not_current_fit" });   // honeypot
    if ("score" in payload || "outcome" in payload)
      return err(400, "malformed_body");                                 // client must not send these

    const fields = validate(payload);
    if (fields.length) return err(422, "validation_error", fields);

    // idempotency: same submissionId returns the original verdict, never a second row
    const existing = await ctx.db.query("leads")
      .withIndex("by_submissionId", q => q.eq("submissionId", payload.submission_id)).unique();
    if (existing) return ok200({
      submissionId: existing.submissionId, outcome: existing.outcome,
      calendarToken: existing.outcome === "qualified" ? existing.calendarToken : undefined,
    });

    const verdict = score(payload.answers, payload.rera === "yes");      // §6
    const calendarToken = verdict.outcome === "qualified" ? crypto.randomUUID() : undefined;

    await ctx.db.insert("leads", { /* …, score: verdict.score, outcome: verdict.outcome, … */ });
    await ctx.scheduler.runAfter(0, internal.notify.newLead, { /* … */ });

    return ok200({ submissionId: payload.submission_id, outcome: verdict.outcome, calendarToken });
  },
});
```

Responsibilities, in order: honeypot → reject client-supplied verdicts → validate →
idempotency check → score → persist → notify → respond.

---

## 6. Authoritative scoring

Port `MODEL` and `evaluate()` from `site/index.html` verbatim. The rules are frozen; the
oracle in `tools/exhaustive.mjs` checks all 37,500 combinations and is the reference.

| Question | Max | Restriction options | Manual-review cap options |
|---|---:|---|---|
| role | 20 | `broker`, `agency_other` | — |
| inventory | 20 | `none` | — |
| price_band | 10 | — | — |
| media_budget | 20 | `below_1l_not_ready` | `undecided` |
| followup | 20 | `none` | `founder_only` |
| bottleneck | 10 | — | `exploring` |

Routing, evaluated in this order:

1. Any restriction, **or** `rera !== "yes"`, **or** fewer than six recognised answers →
   `not_current_fit`
2. `inventory === "1_19"` → `qualified` only if price `above_150` **and** budget in
   {`above_3l`,`1_3l`,`ready_1l`} **and** follow-up in {`crm`,`spreadsheet`} **and**
   score ≥ 65 **and** no cap. Otherwise `manual_review` (≥50) or `not_current_fit`
3. Any cap → `manual_review` (≥50) or `not_current_fit`
4. score ≥ 65 → `qualified` · 50–64 → `manual_review` · <50 → `not_current_fit`

> **Note for the implementer.** The budget condition in rule 2 is deliberately redundant —
> every budget value outside the allowed set is already blocked by a restriction or a cap.
> Mutation testing confirms it is an *equivalent mutation*: removing it changes no outcome.
> Keep it. It is defence-in-depth against a future weight change, not dead code.

Unknown or missing answer keys contribute **zero** and count as unanswered. A partial
submission can reach 70 points from four answers, so the completeness check is what stops it
qualifying — not the threshold.

---

## 7. Validation

| Field | Rule | Error |
|---|---|---|
| `name`, `company`, `project_city` | non-empty after trim, ≤ 200 chars | `validation_error` |
| `email` | RFC-ish shape, ≤ 254 chars | `validation_error` |
| `phone` | digits 8–15; `^[6-9]\d{9}$`, `^91[6-9]\d{9}$`, `^0[6-9]\d{9}$` or explicit `+` | `validation_error` |
| `consent` | must be exactly `true` | `validation_error` |
| `rera` | `"yes"` or `"no"` | `validation_error` |
| `answers.*` | each must be a known key for its question | treated as unanswered |
| `submission_id` | 8–64 chars, `[A-Za-z0-9-]` | `validation_error` |

Return **every** failing field at once — a form that reveals one error at a time is a form
people abandon.

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

---

## 9. Calendly webhook — the authoritative booking source

The browser's `postMessage` listener is a **UX signal only**. It fires `booked_call` for
analytics. It must not be the source of truth for whether a call exists.

```
qualified response ──> calendarToken minted server-side
                   └─> embed opens with the token in Calendly UTM/custom field
Calendly booking ──> webhook POST /calendly-webhook
                 └─> verify Calendly-Webhook-Signature (HMAC, CALENDLY_WEBHOOK_SECRET)
                 └─> look up by_calendarToken
                 └─> set booked = true, bookedAt, calendlyEventUri, status = "booked"
```

Subscribe to `invitee.created` and `invitee.canceled`. Verify the signature on every
request and reject anything unsigned — otherwise the endpoint is a public "mark this lead
booked" button.

**Never accept a booking update keyed only on `submission_id`.** That value is generated in
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

- List by `by_outcome` index; default view is `qualified` then `manual_review`
- Show: submitted, outcome, restriction, company, city, contact, source, booked
- **Score visible internally, never sent to the browser on the public page**
- Filter by outcome, date, UTM source, booked
- CSV export — **prefix any cell starting with `= + - @` with an apostrophe.** Formula
  injection is real: a visitor can type `=HYPERLINK(...)` into "company name", and it will
  execute when the export is opened in Excel. This exact defect was found and fixed in the
  earlier WordPress prototype.
- Manual outcome override with an audit trail

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

`submitLead()` already: rejects when unset, sets a 12-second timeout, requires
`ok === true` with a recognised `outcome`, and refuses to fall back to a client verdict.
Those behaviours are what make the swap safe.

**Steps**

1. `npx convex dev`; add `schema.ts`, `http.ts`, `leads.ts` from this document.
2. Port `MODEL` and `evaluate()` verbatim. Run `tools/exhaustive.mjs`'s oracle against the
   server implementation — all 37,500 combinations must agree.
3. Set the env vars in §12.
4. Set `window.ADSCADE_ENDPOINT` to the deployed action URL, before the page script runs.
5. Submit one real lead of **each** outcome and confirm three things: the row exists, the
   calendar appears only for `qualified`, and the score is absent from every network
   response the browser receives.
6. Register the Calendly webhook; make a real test booking; confirm `booked` flips.
7. Only then point paid traffic at the page.

**Do not skip step 5.** Everything upstream of it is untested against a real backend.

---

## 14. Not in scope

- No Convex project has been created.
- The WordPress plugin at `wordpress/adscade-lead-capture.php` is **superseded prototype
  work and must not be installed.** It exists only as a reference implementation of
  validation, honeypot, rate limiting and CSV-injection escaping.
- GTM is not installed and no container ID exists.
