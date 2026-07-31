# Adscade — Tracking Specification

Version 2.0 · 31 July 2026 · Landing page — current slug `/vsl-4/` (configurable; no slug is hard-coded in the page)

> **What changed in v2.** Scoring and the three outcome states were removed, so
> `qualification_outcome`, `qualification_question_complete` and `score_band` are gone. The
> CTA is now a two-state machine, which needs two distinct click events rather than one.

**Google Tag Manager is not installed.** No container script is present, and none will be
added without a container ID supplied by the owner. The page publishes to
`window.dataLayer` and is inert until something consumes it — see *Activation* below.

---

## Design rules

1. **No personally identifying data ever enters an event.** Name, email, phone, company and
   free-text project details are sent to the storage endpoint only, never to `dataLayer`.
2. **No score exists to leak.** There is no scoring model. Nothing on the page produces a
   verdict about a visitor, so no event carries one.
3. **Every event fires at most once** where a repeat would be meaningless. Listeners are
   registered once, at load.
4. **Attribution is attached to every event** from the URL that brought the visitor.
5. **The page works with tracking absent.** `track()` returns immediately if
   `window.dataLayer` does not exist.

---

## Implementation

```js
function track(event, data, once) {
  if (once) { if (fired[event]) return; fired[event] = true; }
  if (!window.dataLayer) return;                 // inert until a tag manager exists
  window.dataLayer.push(Object.assign({event}, attribution, data || {}));
}
```

`attribution` is captured once at page load:

| Key | Source |
|---|---|
| `utm_source` `utm_medium` `utm_campaign` `utm_content` `utm_term` | query string |
| `gclid` | query string |
| `landing_path` | `location.pathname` |
| `referrer` | `document.referrer` |

---

## Event schema

Nine events. Every one of them is in `site/index.html`; nothing here is aspirational except
the four VSL progress events, which are called out below.

| Event | Fires when | Once | Parameters |
|---|---|---|---|
| `main_vsl_play` | Visitor starts the video | yes | — |
| `initial_cta_click` | A CTA is clicked **before** the lead is stored | no | `cta_text` |
| `lead_modal_open` | The modal opens | yes | — |
| `lead_form_start` | First interaction with any field in the modal | yes | — |
| `lead_form_submit` | Submit pressed and client validation passed | yes | — |
| `lead_form_stored` | Server confirmed storage | yes | — |
| `scheduling_cta_click` | A CTA is clicked **after** the lead is stored | no | `cta_text` |
| `calendar_view` | Calendly embed actually rendered (iframe confirmed present) | yes | — |
| `booked_call` | **Confirmed** Calendly scheduling event | yes | — |

### The two CTA events are the point

`initial_cta_click` and `scheduling_cta_click` come from the same buttons — the same DOM
elements, relabelled in place. Splitting them is what makes the funnel legible:

```
initial_cta_click → lead_modal_open → lead_form_start → lead_form_submit
                  → lead_form_stored → calendar_view → booked_call
                                     ↘ scheduling_cta_click (return visits to the calendar)
```

A drop between `lead_form_submit` and `lead_form_stored` is a **backend or validation
problem**, not a copy problem — the visitor did everything asked and the storage call
failed. That gap is the single most important thing to watch after launch, and it did not
exist as a measurable step in v1.

`scheduling_cta_click` firing repeatedly is normal and healthy: it means a visitor who
already gave their details is scrolling back to the calendar. It is not a re-submission.

### Controlled values

- `cta_text` — the rendered button label, which is one of exactly two strings:
  `Tell Us About Your Project` or `Choose a Time`. It is a label, not free text.

### Retired in v2

`primary_cta_click` · `qualification_form_start` · `qualification_question_complete` ·
`contact_details_submitted` · `qualification_form_complete` · `qualification_outcome` ·
`score_band` · `outcome` · `answer_key`.

If any of these appear in a container, the container is configured against v1 and will
report a funnel that no longer exists. `tools/e2e.mjs` asserts that no event name matching
`/qualification|score/` is ever pushed.

---

## VSL events — not yet active

The real video has not been supplied. **No progress event is fabricated.** `main_vsl_play`
currently fires from the placeholder's disclosure control, and the four progress events
below are specified but **not wired** — they do not appear in the page and must not be
configured as triggers until the player is installed.

When the player is installed, connect progress at the marked point in `site/index.html`
(search `VIDEO INTEGRATION`):

```js
// YouTube IFrame API
player.addEventListener('onStateChange', e => {
  if (e.data === YT.PlayerState.PLAYING) track('main_vsl_play', null, true);
});
setInterval(() => {
  const pct = player.getCurrentTime() / player.getDuration() * 100;
  if (pct >= 25) track('vsl_25_percent', null, true);
  if (pct >= 50) track('vsl_50_percent', null, true);
  if (pct >= 75) track('vsl_75_percent', null, true);
  if (pct >= 98) track('vsl_complete', null, true);
}, 1000);
```

Vimeo exposes `timeupdate`; a hosted `<video>` exposes `timeupdate` and `ended`. Whichever
is used, the four thresholds must remain once-only.

---

## booked_call — the one that must not misfire

`booked_call` is the conversion. It fires **only** on a confirmed scheduling message from
Calendly:

```js
window.addEventListener('message', e => {
  if (!/^https:\/\/([a-z0-9-]+\.)?calendly\.com$/.test(e.origin)) return;
  if (e.data && e.data.event === 'calendly.event_scheduled') track('booked_call', null, true);
});
```

It must **never** fire on: embed load · calendar view · date selection · time selection ·
closing the calendar. The origin check is strict — a message from any other origin is
ignored, so a hostile page cannot forge a conversion.

The authoritative record of a booking is the **Calendly webhook**, verified by HMAC and
correlated on the server-minted `calendarToken` — see `docs/CONVEX_LEAD_CAPTURE_SPEC.md` §9.
`booked_call` is the analytics signal for the same event; the two are independent on
purpose, because a `postMessage` from a browser is not evidence.

---

## Known coverage gap — bookings made via the fallback link

`booked_call` depends on a `postMessage` from the **embedded** Calendly iframe. If the
embed fails to load (blocked script, corporate firewall, offline) the visitor is offered a
direct link that opens Calendly in a **new tab**. A booking completed in that tab cannot
message back to the funnel window, so `booked_call` and the `calendly_booked` database
update will not fire for that visitor.

The lead itself is still stored — only the booking confirmation is missed. During QA, do
not read a gap between `calendar_view` and `booked_call` as lost bookings without first
checking Calendly's own dashboard.

## Activation checklist

Before switching tracking on, in order:

1. Owner supplies the **GTM container ID**.
2. `docs/PROPOSED_PRIVACY_TRACKING_UPDATE.md` is reviewed and the privacy policy updated.
3. Any required consent mechanism is in place.
4. GTM container script is added (header + body).
5. Verify in GTM Preview: each event fires once, carries attribution, and carries **no PII**.
6. Confirm `booked_call` fires only after a real test booking — not on opening the calendar.
7. Confirm no event carries `name`, `email`, `phone` or `cta_text` other than the two
   permitted labels. `tools/e2e.mjs` checks this against the stub; check it again in GTM
   Preview against the real container.

Until step 1, the page is correct and complete as it stands: it publishes events that
nothing yet reads.
