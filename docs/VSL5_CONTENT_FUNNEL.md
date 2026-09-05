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

VSL-5 uses `normalisePhoneInternational()`:

| Input | Stored as | Why |
|---|---|---|
| `+971 50 123 4567` | `+971501234567` | country code given, honoured |
| `00971501234567` | `+971501234567` | ITU `00` prefix means `+` |
| `+919876543210` | `+919876543210` | still country-aware |
| `0501234567` | `0501234567` | **no country code invented** |
| `123` | rejected | too short |

A *wrong* country code is worse than none: it corrupts `normalisedPhone` matching and
makes every outbound WhatsApp attempt fail while looking perfectly valid in the Sheet. A
bare number is kept as digits rather than rejected, because losing a real brokerage over
a formatting habit costs more than an unprefixed row.

---

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
`team_size_label`. Acquisition rows leave the content columns blank and vice versa;
`content_qualified` is blank (not `FALSE`) for offers with no qualification gate.

For visual separation without touching the write path, add a tab with:

```
=QUERY(Leads!A:AZ, "where lower(D) = 'brokerage_content_engine'", 1)
```

(adjust the column letter for `offer` once the header lands).

The mirror stays background and asynchronous. Convex is authoritative; nobody waits for
Sheets.

---

## Calendly — more than one event type

`convex/calendly.ts` used to resolve exactly **one** event type. With two offers that
would mean the second offer's bookings are never discovered at all — the API filters
server-side by `event_type`, so they would not even show up as unmatched.

It now resolves a list, one entry per offer, from `EVENT_TYPE_CONFIG`:

| Offer | Pin by URI | Or look up by name |
|---|---|---|
| `real_estate_acquisition` | `CALENDLY_EVENT_TYPE_URI` | `CALENDLY_EVENT_TYPE_NAME`, default `"Real Estate Acquisition System Call"` |
| `brokerage_content_engine` | `CALENDLY_CONTENT_EVENT_TYPE_URI` | `CALENDLY_CONTENT_EVENT_TYPE_NAME` |

- The content offer is **optional**: if nothing is configured it is skipped quietly, and
  VSL-4 keeps syncing exactly as before. No scary "not found" error for an event that
  does not exist yet.
- Targets are **deduped by URI**, because both funnels currently point at the *same*
  Calendly event. Listing it twice would double every API call for no benefit.
- Matching is still **by email**, and the lead row already knows its own offer — so a
  content booking attaches to the content lead correctly *even while both funnels share
  one event type*.

`calendlySyncState.calendlyTargets` records what each run resolved:

```bash
npx convex run internal.calendly.getSyncState --prod
```

### ⚠ Pre-existing issue to check, unrelated to VSL-5

Both pages currently point at `calendly.com/aasim-ahmed177/realestate-growth-systems`,
but the acquisition sync looks for an event type **named** `"Real Estate Acquisition
System Call"`. If that event's display name is not exactly that string, and
`CALENDLY_EVENT_TYPE_URI` is not pinned in production, then every run has been logging
`No Calendly event type named "..." was found` and **no VSL-4 booking has been syncing**.

This could not be verified from here — it needs production env access. See "What to check
in production" below.

---

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

### 2. The content Calendly event — once you create it

Add to the same snippet:

```html
<script>
  window.ADSCADE_CONTENT_CALENDLY_URL =
    "https://calendly.com/<you>/<your-content-event>";
</script>
```

and pin it server-side so the sync can see bookings on it:

```bash
npx convex env set CALENDLY_CONTENT_EVENT_TYPE_URI https://api.calendly.com/event_types/XXXXXXXX --prod
```

Until both are set, qualified applicants go to the event this page already pointed at
(`calendly.com/aasim-ahmed177/realestate-growth-systems`) — the existing URL, kept as the
fallback so shipping the backend does not take the calendar away from a qualified
brokerage. Nothing was invented.

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
| `CALENDLY_CONTENT_EVENT_TYPE_URI` | **new, optional** | pin the VSL-5 event once it exists |
| `CALENDLY_CONTENT_EVENT_TYPE_NAME` | new, optional | alternative to pinning by URI |
| `ADSCADE_DEV_ORIGIN` | dev only | **must NOT be set in production** — it widens the CORS allow-list |

**VSL-5 introduces no new required variable.**

---

## Tests

```bash
npx convex dev                            # terminal 1
npx --yes http-server site -p 8788 -s     # terminal 2

node tools/content-api.mjs        # 117 assertions — endpoint, qualification, phone, regression
node tools/content-browser.mjs    # real browser: qualified/unqualified/failure/mobile
```

Plus the full existing suite, which must stay green:

```bash
for t in integrity score responsive acceptance modal redirect \
         convex-api convex-e2e calendly-sync-test funnel-test \
         content-api content-browser; do node tools/$t.mjs; done
npx --yes tsx tools/calendlyClient-test.mjs
```

`content-browser.mjs` generates `site/.vsl-5-shell.html` at run time — the WordPress
`<head>` the Elementor fragment normally sits inside. Without a viewport meta the mobile
assertions would silently run at a 980px layout viewport and test nothing. It is
gitignored and deleted after the run.

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
| Roll back Convex | redeploy the previous commit. The schema is additive, so old code ignores the new fields — but any VSL-5 rows already stored will fail the older schema's *required* `activeInventory`. Delete them first, or roll forward instead. |
| Roll back the Sheet | nothing to undo — the added columns are inert to the old script. |

**Preferred rollback is step 1 alone.** It is instant, needs no deploy, and cannot affect
VSL-4.

---

## What to check in production

Requires your deploy key; none of this could be verified from the development machine.

```bash
npx convex env list --prod
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
