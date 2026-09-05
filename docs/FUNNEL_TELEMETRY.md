# Anonymous first-party funnel telemetry

> **Multi-offer update.** Events now carry an optional `offer` field
> (`real_estate_acquisition` | `brokerage_content_engine`). Stage names stayed
> offer-neutral and shared rather than being duplicated per funnel, so
> `admin:funnelSummary` takes an `offer` filter instead of needing a second report.
> One new stage, `lead_qualified`, fires only for offers that gate the calendar.
> An ABSENT offer means `real_estate_acquisition` — every row written before VSL-5
> existed. Read it through `offerOf()`, never off `.offer` directly.
> See docs/VSL5_CONTENT_FUNNEL.md → "Telemetry".

Google Demand Gen tells us clicks, and Convex tells us stored leads. Neither tells us
**where the people in between dropped out**. This adds one compact anonymous row per
funnel stage so that gap is measurable.

```
landing_page_view -> initial_cta_click -> lead_modal_open -> lead_form_start
                  -> lead_form_submit  -> lead_form_stored -> calendly_redirect
```

## What it is not

- **Not a replacement for GTM.** The existing `window.dataLayer` pushes are untouched and
  still fire for all seven events. This is additive.
- **Not personal data.** No name, email, phone, inventory answer, budget answer, consent
  value or Calendly answer — see "Privacy boundary".
- **Not a tracker.** No fingerprinting, no cookies, no scroll/mouse/heatmap capture, no
  per-keystroke events. One tiny POST per meaningful stage.
- **Never in the critical path.** Fire-and-forget. If Convex is unreachable the CTA,
  modal, lead submission and Calendly redirect all behave exactly as before.

## Privacy boundary

`funnelEvents` is a separate table from `leads` **by design**: a visitor who clicks the
CTA and abandons the form never creates a lead row, so abandonment cannot be measured by
adding columns to `leads`.

`/track-event` **rejects** known lead-PII keys with `400 pii_rejected` rather than quietly
dropping them. If a future frontend change starts sending PII, that fails loudly instead
of leaking silently. Rejected keys include `name`, `email`, `phone`, `activeInventory`,
`monthlyMediaBudget`, `consent`, `media_budget`, `inventory`, `questions_and_answers`.

Identifiers:

| | |
|---|---|
| `sessionId` | random UUID in `sessionStorage`, one per browser tab session. Identifies a visit, never a person; dies with the tab. |
| `eventId` | random UUID per event. The idempotency key — a retried beacon writes no second row. |

## Endpoint

```
POST    https://<deployment>.convex.site/track-event
OPTIONS https://<deployment>.convex.site/track-event
```

Same origin discipline as `/submit-lead`: allow-list only, matched origin echoed, never a
wildcard, `Vary: Origin`, and a present-but-disallowed `Origin` is refused **403**.

Accepts `application/json` and `text/plain` — the latter because `navigator.sendBeacon`
cannot send JSON without provoking a preflight it cannot handle. Validation is identical
either way: the body is parsed as JSON and checked the same. Caps: 2 KB body, strict
per-field length caps, strict event-name allow-list.

Responses:

```jsonc
{ "ok": true,  "recorded": true, "duplicate": false }   // 200 stored
{ "ok": true,  "recorded": true, "duplicate": true  }   // 200 idempotent replay
{ "ok": false, "code": "pii_rejected", "fields": ["email"] }  // 400
{ "ok": false, "code": "unknown_event" }                // 422
{ "ok": false, "code": "forbidden_origin" }             // 403
```

## Frontend

The page's existing `track()` function now also calls `sendTelemetry()` — placed **before**
the `if (!window.dataLayer) return;` guard so telemetry records the funnel even when no tag
manager is installed. The `once` semantics are shared, so a once-only stage cannot be
double-counted.

The endpoint is **derived** from `window.ADSCADE_LEAD_ENDPOINT` (`/submit-lead` ->
`/track-event`) so there is no second value to configure in WordPress and the two cannot
drift. `window.ADSCADE_TRACK_ENDPOINT` overrides it if ever needed.

Derivation **fails closed**: if the configured lead endpoint does not end in `/submit-lead`,
telemetry is disabled rather than POSTing funnel events at the lead endpoint.

### A note on `initial_cta_click`

It is deliberately **not** a once-only event — a visitor who taps two different CTAs emits
two rows, and the existing dataLayer behaviour is unchanged. This is exactly why every
conversion rate below is computed from **unique sessions**, not raw rows.

## Reading the funnel

```bash
npx convex run admin:funnelSummary '{"hours":72}'
npx convex run admin:funnelSummary '{"hours":72,"utmCampaign":"dg_inm_others_uae_camp"}'
npx convex run admin:funnelBreakdown '{"hours":72,"groupBy":"utmContent"}'
```

`funnelSummary` returns `rawCounts` **and** `uniqueSessions`, and computes every rate from
unique sessions. A large gap between the two is itself informative. A stage nobody reached
reports `null`, not `0%` — a rate of zero out of zero would read as a broken funnel.

`funnelBreakdown` groups by `utmCampaign`, `utmContent` or `device` — which is how UAE vs
Gulf campaigns and individual creatives get compared.

## Attribution

`utm_source/medium/campaign/content/term`, `gclid`, `gbraid`, `wbraid`, landing path,
referrer and device category are captured on every telemetry row, and `gbraid`/`wbraid`
are now also persisted on `leads`, on `bookedCallEvents`, and sent to the Google Sheets
mirror (whose receiver already had those two columns but was never sent values for them).

## Retention

Nothing prunes `funnelEvents` yet. It is one small row per stage per visit, so growth is
proportional to ad traffic rather than to time. If it ever needs trimming, add a cron
deleting rows older than N days — there is nothing to migrate and nothing references them.
