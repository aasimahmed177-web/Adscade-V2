# VSL-5 — Brokerage Content Engine

The second Adscade offer, live at `https://adscade.com/vsl-5-2/`. It shares the VSL-4
backend rather than duplicating it; `offer` is the routing key that keeps the two apart.

> **Before this work, the live page captured nothing.** `window.ADSCADE_CONTENT_LEAD_ENDPOINT`
> was never assigned — all three occurrences on the page were inside a code comment — so
> `leadEndpoint()` returned `''`, every submission threw `No content lead endpoint
> configured.`, and the visitor saw the red error state. Applications made before this
> deploys were never transmitted anywhere and are not recoverable.

---

## Flow

```
ad → /vsl-5-2/ → application modal
   → POST /submit-content-lead
   → Convex stores the lead and COMPUTES qualification
   → response { ok, stored, submissionId, qualified }
   → qualified   → Calendly (name + email prefilled)
     unqualified → polite not-fit state, no calendar
   → booking syncs back onto the same lead (5-minute poll)
   → Google Sheets mirrors lead + booking state
```

---

## Why one `leads` table

The alternative — a separate `contentLeads` table — would have forced the Calendly sync,
the most delicate code in the repo, to search two tables by email, and would have
duplicated the entire Sheets mirror and `bookedCallEvents` machinery for every future
offer. Instead:

| Concern | Where it lives |
|---|---|
| Which funnel a row came from | `leads.offer` |
| What each funnel must collect | its own HTTP endpoint |
| What the table is *able* to hold | `convex/schema.ts` |

**The rule that keeps this safe:** the schema makes offer-specific answers optional so
both row shapes can coexist, but each endpoint validates its own offer strictly. If the
write path were as permissive as the table, that relaxation would silently become a
relaxation of each funnel's real contract. Hence two mutations — `insertLead` and
`insertContentLead` — not one permissive shared one.

Adding `doctor_content_engine` later means: a literal in `OFFERS`, a handful of optional
fields, one endpoint, one mutation. Not a new Convex/Calendly/Sheets stack.

### `offer` is optional, and absent means acquisition

Every lead and telemetry row written before this change has no `offer` field. Nothing is
backfilled. `offerOf(row)` in `convex/schema.ts` is the single place that knows absent
means `real_estate_acquisition` — **read the offer through it, never off `.offer`
directly**, or historical rows will be miscounted.

---

## HTTP contract

### `POST /submit-content-lead`

Required. Anything missing or malformed returns `422` naming the offending fields.

| Field | Rule |
|---|---|
| `submissionId` | `^[A-Za-z0-9-]{8,64}$`, the idempotency key |
| `name` | non-empty, ≤200 |
| `email` | structural check, ≤254 |
| `companyName` | non-empty, ≤200 |
| `phone` | international normalisation, see below |
| `teamSize` | `1_4` \| `5_9` \| `10_19` \| `20_plus` |
| `monthlyShoot` | `yes` \| `no` |
| `consent` | exactly `true` — truthy is not consent |

Optional: `landingPage`, `referrer`, `device`, `attribution{utm_*, gclid, gbraid, wbraid}`,
`hp_ref` (honeypot). `offer` may be sent but is **ignored** — the endpoint defines it.

**Rejected outright, `400 malformed_body`:** `qualified`, `score`, `outcome`, `status`.
The browser submits facts; it does not get a vote. Failing loudly here means a stale
frontend build is visible immediately instead of quietly trusted.

| Status | Meaning |
|---|---|
| `200` | `{ ok, stored: true, submissionId, qualified, duplicate? }` |
| `400` | malformed body, or a client-supplied verdict |
| `403` | `forbidden_origin` |
| `405` | not POST |
| `413` | body over 8 KB |
| `415` | not `application/json` |
| `422` | `validation_error` with `fields` |
| `500` | `server_error` — never a stack trace |

### Qualification

```
qualified = teamSize ∈ {5_9, 10_19, 20_plus}  AND  monthlyShoot === "yes"
```

Computed in `convex/http.ts` (`isContentQualified`), stored on the row as
`contentQualified`, and returned as `qualified`. Stored rather than recomputed later so
the Sheet, the funnel report and what the visitor actually saw can never disagree.

**Everyone is stored**, qualified or not. Unqualified applicants see the not-fit message;
their row is still in Convex and in the Sheet.

A retried submission returns the **stored** verdict, never a recomputed one — the visitor
already acted on the first answer.

---

## Phone normalisation

VSL-4's `normalisePhone()` maps a bare ten-digit number to `+91`, because that funnel was
built for Indian developers and its historical rows depend on it. **It is untouched.**

VSL-5 uses `normalisePhoneInternational()`, which **requires a country code and never
invents one**. It always returns E.164 or rejects.

| Input | Result |
|---|---|
| `+971 50 123 4567` | `+971501234567` |
| `00971501234567` | `+971501234567` (ITU `00` prefix) |
| `+919876543210` | `+919876543210` |
| `+971 (50) 123-4567` | `+971501234567` |
| `0501234567` | **rejected** — no country code |
| `9876543210` | **rejected** — would have become `+91…` on VSL-4 |
| `call me on +971…` | **rejected** — letters |
| `+0501234567` | **rejected** — no country code starts with `0` |
| `+123`, 20 digits | **rejected** — outside E.164's 8–15 |

An earlier revision accepted bare national numbers and stored them as digits, reasoning
that losing a lead to a formatting habit costs more than an unprefixed row. That was the
wrong trade here: an unprefixed Gulf number is not reliably dialable or WhatsApp-reachable,
so the "saved" lead is often uncontactable anyway, and it silently breaks phone dedup.

**The page enforces the identical rule before submit** (`validInternationalPhone()` in
`site/vsl-5.html`), so a visitor is corrected in the field rather than getting a generic
save error afterwards. If you change one, change both — there are tests on each side.

One irreducible ambiguity, pinned by a test rather than left to chance: `00501234567` is
both a valid `+501` (Belize) number and what a UAE visitor produces by prepending `00` to
their national number. Nothing in the string distinguishes them, so the ITU prefix is
honoured as written.

## Google Sheets — one tab, one `offer` column

Both offers mirror into the existing `Leads` sheet. This was chosen over a separate
"Content Leads" tab because of how the Apps Script is actually built:

- `ensureHeaders_()` already **auto-appends any missing header** to the existing sheet, so
  new columns are genuinely additive and need no restructuring;
- `SHEET_NAME` is a single constant and `upsertLead_`/`findSubmissionRow_` are
  single-sheet by design — routing by offer means rewriting the write path of a live
  script that is hard to test and is the only operational view of the business;
- the Calendly booking-status mirror stays one code path for all offers.

New columns: `offer`, `company_name`, `team_size`, `monthly_shoot`, `content_qualified`,
`team_size_label`. Acquisition rows leave the content columns blank and vice versa.

`content_qualified` is deliberately **three-state**: `TRUE` / `FALSE` for a gated offer,
and **blank** for one with no gate. Collapsing blank into `FALSE` would make every
acquisition lead read as a rejected application whenever the column is filtered.

> **A bug worth recording.** The first version of this change added the six headers and
> made Convex send the six values, but never added them to `doPost`'s `rowData` — and
> `upsertLead_` writes `''` for any header it cannot find there. The result would have
> been six permanently blank columns while Convex, the schema and every other test
> passed, because nothing in this repo executed the receiver.
>
> `tools/appsscript-test.mjs` now runs the real `.gs` file in a Node VM with the Google
> services faked, and asserts the mapping, the three-state qualification, formula
> escaping, the shared secret, and that a later booking **updates the same row** instead
> of appending a second one.

For visual separation without touching the write path, add a tab with:

```
=QUERY(Leads!A:AZ, "where lower(D) = 'brokerage_content_engine'", 1)
```

(adjust the column letter for `offer` once the header lands).

The mirror stays background and asynchronous. Convex is authoritative; nobody waits for
Sheets.

---

## Calendly — more than one event type

`convex/calendly.ts` resolves each offer's event type. The client checks each returned
scheduled event's `event_type` locally before assigning it to that offer. It does not
trust a server-side query filter to prevent cross-offer matches.

`resolveSyncTargets()` now resolves a list, one entry per offer. It is a **pure exported
function**, so `tools/calendly-targets-test.mjs` can exercise every branch outside Convex
(the action sandbox blocks loopback, so `sync()` cannot be driven against a mock).

Each offer resolves in this order:

| Order | Acquisition | Content |
|---|---|---|
| 1. pinned API URI | `CALENDLY_EVENT_TYPE_URI` | `CALENDLY_CONTENT_EVENT_TYPE_URI` |
| 2. public booking URL | `CALENDLY_SCHEDULING_URL` | `CALENDLY_CONTENT_SCHEDULING_URL` |
| 3. display name | `CALENDLY_EVENT_TYPE_NAME`, default `"Real Estate Acquisition System Call"` | `CALENDLY_CONTENT_EVENT_TYPE_NAME` |

**A public booking URL is not an API event-type URI** (`calendly.com/you/event` vs
`api.calendly.com/event_types/UUID`) and cannot be substituted for one. Option 2 exists
so nobody has to hand-convert or guess a UUID — give it the URL you actually have and the
sync resolves it. Comparison ignores trailing slashes, query strings and case.

To read the pairing directly, without anyone handling the token:

```bash
npx convex run internal.calendly.listEventTypesForSetup --prod
```

It prints each event's name, `publicBookingUrl` and `apiEventTypeUri`. `CALENDLY_PAT` is
read server-side and never appears in the output.

### Failures are isolated

A resolution failure on one offer is **recorded and skipped, never fatal**. The earlier
version returned from the whole run the moment the required acquisition target failed —
so the pre-existing VSL-4 naming problem would silently have stopped VSL-5 from syncing
too, and stopped the Pass B lifecycle rechecks with it.

Now: healthy targets sync, `lastError` names the broken one and the variable that fixes
it, and `lastRunOk` goes false so the failure is visible without hiding the work that did
succeed. Pass B runs even when **no** target resolves, because rechecks work from invitee
URIs already stored on leads — cancellations keep being detected while discovery is
misconfigured.

### Matching is offer-aware

`findEligibleLeadByEmail` takes the `offers` a booked event type can legitimately serve,
and will not match outside them.

Without this, one person who applies to **both** funnels with the same address — the
owner running an acceptance test, most obviously — could have a content booking attached
to their acquisition lead purely because that row was newer. The booking would look
healthy while sitting on the wrong row, mirroring to the wrong Sheet line, leaving the
real lead forever `not_booked`. Both submission orders are covered by tests.

A **shared** event type carries *both* offers in its target and may match either. That is
the honest representation: today both funnels point at one event, which genuinely cannot
tell their bookings apart. Merging the offers states the ambiguity instead of silently
crediting whichever offer resolved first. Give the offers distinct event types and the
ambiguity disappears on its own.

Legacy leads with no `offer` field resolve as acquisition through `offerOf()`, so an
acquisition event still matches them and a content event never will.

## Telemetry

One shared, offer-neutral stage ladder, not a parallel set of names per offer:

```
landing_page_view → initial_cta_click → lead_modal_open → lead_form_start
→ lead_form_submit → lead_form_stored → [lead_qualified] → calendly_redirect
```

`lead_qualified` is new and fires only for offers that gate the calendar.
`admin:funnelSummary` inserts the `stored -> qualified` step only when the data contains
it, so VSL-4 is never shown a 0% step for a gate it does not have.

The page keeps its **own** GTM vocabulary (`content_cta_click`, `content_form_open`, …)
untouched — anything already built in GTM or Ads keeps working — and maps those names
onto the canonical stages when posting to `/track-event`. Two vocabularies, one page.

```bash
npx convex run internal.admin.funnelSummary '{"hours":72,"offer":"brokerage_content_engine"}'
npx convex run internal.admin.funnelBreakdown '{"hours":72,"groupBy":"offer"}'
```

`offersSeen` in the summary is the quick check that a newly deployed page is actually
reporting.

**Privacy boundary, unchanged and extended:** `/track-event` rejects lead PII outright
rather than dropping it. The content answers are now on that list too — `companyName`,
`company_name`, `company`, `teamSize`, `team_size`, `monthlyShoot`, `monthly_shoot` — for
the same reason as `email`: they are lead data, they belong on the lead row, and a
frontend mistake should fail loudly instead of leaking quietly.

An unrecognised `offer` is rejected `422 unknown_offer` rather than filed under the wrong
funnel, which would corrupt the comparison the field exists to make.

---

## What you must configure

### 1. WordPress header snippet (the `/vsl-5-2/` page)

No secrets. Both values are public by nature.

```html
<script>
  window.ADSCADE_CONTENT_LEAD_ENDPOINT =
    "https://pastel-minnow-203.convex.site/submit-content-lead";
</script>
```

Telemetry needs no second variable — it is derived from this one, and **fails closed**:
if the endpoint does not end in `/submit-content-lead`, telemetry disables itself rather
than risk POSTing funnel events at the lead endpoint.

### 2. The content Calendly event

The owner-supplied booking URL is:

```
https://calendly.com/aasim-ahmed177/brokerage-content-system-call
```

It is already the fallback in `site/vsl-5.html`, so the redirect works without the header
variable. Setting it explicitly is still worthwhile — it means the URL can be changed
without editing the widget:

```html
<script>
  window.ADSCADE_CONTENT_CALENDLY_URL =
    "https://calendly.com/aasim-ahmed177/brokerage-content-system-call";
</script>
```

**The frontend URL alone does not configure syncing.** The page sends the visitor to the
calendar; the backend still has to be told which event type to poll, or the booking will
never come back onto the lead. Either let the sync resolve it from the same public URL:

```bash
npx convex env set CALENDLY_CONTENT_SCHEDULING_URL https://calendly.com/aasim-ahmed177/brokerage-content-system-call --prod
```

or pin the API URI directly, which is immune to the event being renamed *or* re-slugged:

```bash
npx convex run internal.calendly.listEventTypesForSetup --prod   # read apiEventTypeUri
npx convex env set CALENDLY_CONTENT_EVENT_TYPE_URI https://api.calendly.com/event_types/XXXXXXXX --prod
```

Pinning the URI is the more durable of the two.

### 3. Google Apps Script

Redeploy `google-apps-script/google-sheets-convex-mirror-v4.gs` and run `setupAdscade()`
once. The new columns are appended automatically; existing rows are untouched and get
blanks in the new columns.

---

## Environment variables

| Variable | Needed | Notes |
|---|---|---|
| `CALENDLY_PAT` | existing | server-side only, never logged or returned |
| `GOOGLE_SHEETS_WEBHOOK_URL` | existing | mirror fails closed without it |
| `GOOGLE_SHEETS_SYNC_SECRET` | existing | |
| `CALENDLY_EVENT_TYPE_URI` | optional | pin acquisition; immune to renames |
| `CALENDLY_SCHEDULING_URL` | **new, optional** | resolve acquisition from its public booking URL |
| `CALENDLY_CONTENT_EVENT_TYPE_URI` | **new** | pin the VSL-5 event — most durable |
| `CALENDLY_CONTENT_SCHEDULING_URL` | **new** | or resolve it from the public booking URL |
| `CALENDLY_CONTENT_EVENT_TYPE_NAME` | new, optional | last resort; breaks if the event is renamed |

Set **one** of the two content variables. Without either, VSL-5 bookings are never
discovered and the lead stays `not_booked` forever, even though the visitor booked
successfully.
| `ADSCADE_DEV_ORIGIN` | dev only | **must NOT be set in production** — it widens the CORS allow-list |

**VSL-5 introduces no new required variable.**

---

## Tests

```bash
npx convex dev                            # terminal 1
npx --yes http-server site -p 8788 -s     # terminal 2

node tools/content-api.mjs                     # endpoint, qualification, phone, regression
node tools/content-browser.mjs                # real browser: qualified/unqualified/failure/mobile
node tools/appsscript-test.mjs                # the real .gs receiver, in a Node VM
npx tsx tools/calendly-targets-test.mjs       # event-type resolution, incl. failure isolation
```

Plus the full existing suite, which must stay green:

```bash
for t in integrity score responsive acceptance modal redirect \
         convex-api convex-e2e calendly-sync-test funnel-test \
         content-api content-browser appsscript-test; do node tools/$t.mjs; done
npx --yes tsx tools/calendlyClient-test.mjs
npx --yes tsx tools/calendly-targets-test.mjs
```

`content-browser.mjs` generates `site/.vsl-5-shell.html` at run time — the WordPress
`<head>` the Elementor fragment normally sits inside. Without a viewport meta the mobile
assertions would silently run at a 980px layout viewport and test nothing. It is
gitignored and deleted after the run.

---

## Live acceptance evidence

A green test suite is not proof the live funnel works. These are the checks that are:

**A — qualified application** (5–9 team, yes to monthly shoot), using an address you control:
- network: `POST /submit-content-lead` → `ok:true, stored:true, qualified:true`
- Convex: exactly one lead, `offer=brokerage_content_engine`, answers correct
- browser: redirects to `brokerage-content-system-call`, name + email prefilled, **no phone in the URL**
- Sheets: one row for that `submission_id`, all six content columns filled, `calendly_status=not_booked`

**B — then actually book it.** Allow one 5-minute sync cycle plus the async mirror:
- Convex: the **same** lead becomes `booked`, with the content event-type URI and time
- `bookedCallEvents`: exactly one row for that invitee, still one after a second poll
- Sheets: the **same row** updates to booked — **the row count must not increase**
- `getSyncState`: `lastRunOk`, no `lastError`, and `calendlyTargets` lists both event types

**C — unqualified** (1–4 + yes): stored with `contentQualified=false`, and the Sheet
shows `FALSE` — not blank. Calendar access is now open by default, so this application
also redirects without firing a qualified-application conversion. Optional strict
mode (`window.ADSCADE_CONTENT_REQUIRE_QUALIFICATION = true`) restores the not-fit
state and blocks this redirect. Failed submissions must never redirect in either mode.

**D — cross-offer safety.** Submit both funnels with the same email, then book the content
event: the booking must land on the **content** lead, not the acquisition one.

Proof of completion is one `submission_id` matching across Convex and Sheets, carrying the
right Calendly invitee.

---

## Deployment order

1. **Convex first.** `npx convex deploy` — adds `/submit-content-lead`, `/track-event`
   and the schema. Additive; VSL-4 is unaffected.
2. **Verify** with the production checks below.
3. **Apps Script** — redeploy, run `setupAdscade()`.
4. **WordPress last** — add `ADSCADE_CONTENT_LEAD_ENDPOINT`. The page starts capturing
   the moment this lands, so do it only after step 1 succeeds.
5. Later, when the content Calendly event exists: add
   `ADSCADE_CONTENT_CALENDLY_URL` and set `CALENDLY_CONTENT_EVENT_TYPE_URI`.

## Rollback

| Step | How |
|---|---|
| Stop VSL-5 capture instantly | remove the `ADSCADE_CONTENT_LEAD_ENDPOINT` line from WordPress. The page reverts to its previous (broken) behaviour; VSL-4 is untouched. |
| Roll back Convex | redeploy the previous commit. The schema is additive, so old code ignores the new fields — but any VSL-5 rows already stored will fail the older schema's *required* `activeInventory`. Preserve those leads and roll forward with a compatible schema. Never delete leads to force a rollback. |
| Roll back the Sheet | nothing to undo — the added columns are inert to the old script. |

**Preferred rollback is step 1 alone.** It is instant, needs no deploy, and cannot affect
VSL-4.

---

## What to check in production

Requires your deploy key; none of this could be verified from the development machine.

```bash
node tools/production-preflight.mjs
```

- `GOOGLE_SHEETS_WEBHOOK_URL` and `GOOGLE_SHEETS_SYNC_SECRET` **are** set
- `ADSCADE_DEV_ORIGIN` is **not** set
- decide whether to pin `CALENDLY_EVENT_TYPE_URI`

```bash
npx convex run internal.calendly.getSyncState --prod
```

- `lastRunOk` is `true` and `lastError` is empty — if it says *No Calendly event type
  named "Real Estate Acquisition System Call" was found*, **VSL-4 bookings are not
  syncing** and have not been. Pin `CALENDLY_EVENT_TYPE_URI` to fix it.
- `calendlyTargets` lists what each offer resolved to.
