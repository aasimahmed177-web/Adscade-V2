# Adscade — Tracking Specification

Version 1.0 · 31 July 2026 · Landing page `/vsl-4/`

**Google Tag Manager is not installed.** No container script is present, and none will be
added without a container ID supplied by the owner. The page publishes to
`window.dataLayer` and is inert until something consumes it — see *Activation* below.

---

## Design rules

1. **No personally identifying data ever enters an event.** Name, email, phone, company and
   free-text project details are sent to the storage endpoint only, never to `dataLayer`.
2. **No numeric score leaves the page.** Only a coarse `score_band` is emitted. The exact
   score is computed and stored server-side.
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

| Event | Fires when | Once | Parameters |
|---|---|---|---|
| `vsl_play` | Visitor starts the video | yes | — |
| `vsl_25_percent` | 25% watched | yes | — |
| `vsl_50_percent` | 50% watched | yes | — |
| `vsl_75_percent` | 75% watched | yes | — |
| `vsl_complete` | Video finished | yes | — |
| `primary_cta_click` | Any primary CTA clicked | no | `cta_text` |
| `qualification_form_start` | First "Continue" pressed | yes | — |
| `qualification_question_complete` | Each question answered and advanced | no | `question_number` (1–6), `answer_key` |
| `contact_details_submitted` | Contact step successfully saved | yes | — |
| `qualification_form_complete` | Submission stored | yes | — |
| `qualification_outcome` | Immediately after storage | yes | `outcome`, `score_band` |
| `calendar_view` | Calendly embed actually rendered | yes | — |
| `booked_call` | **Confirmed** Calendly scheduling event | yes | — |

### Controlled values

- `outcome` — `qualified` · `manual_review` · `not_current_fit`
- `score_band` — `high` (≥65) · `medium` (50–64) · `low` (<50)
- `answer_key` — the option slug, e.g. `founder`, `100_plus`, `above_3l`. Never free text.

---

## VSL events — not yet active

The real video has not been supplied. **No progress event is fabricated.** `vsl_play`
currently fires from the placeholder's disclosure control, and the four progress events are
specified but not wired.

When the player is installed, connect progress at the marked point in `site/index.html`
(search `VIDEO INTEGRATION`):

```js
// YouTube IFrame API
player.addEventListener('onStateChange', e => {
  if (e.data === YT.PlayerState.PLAYING) track('vsl_play', null, true);
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

On confirmation the page also PATCHes the stored lead to set `calendly_booked = 1`.

---

## Activation checklist

Before switching tracking on, in order:

1. Owner supplies the **GTM container ID**.
2. `docs/PROPOSED_PRIVACY_TRACKING_UPDATE.md` is reviewed and the privacy policy updated.
3. Any required consent mechanism is in place.
4. GTM container script is added (header + body).
5. Verify in GTM Preview: each event fires once, carries attribution, and carries **no PII**.
6. Confirm `booked_call` fires only after a real test booking — not on opening the calendar.

Until step 1, the page is correct and complete as it stands: it publishes events that
nothing yet reads.
