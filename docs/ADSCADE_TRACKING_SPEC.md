# Adscade — Tracking Specification

Version 3.0 · 1 August 2026 · Landing page — current slug `/vsl-4/` (configurable; no slug is hard-coded in the page)

> **What changed in v3.** The inline Calendly embed was replaced by a redirect: once Convex
> confirms storage, the visitor leaves this page for calendly.com in the same tab. So the
> two-state CTA, `scheduling_cta_click`, `calendar_view` and `booked_call` are all gone, and
> `calendly_redirect` is the new final event on this page.

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

Six events. Every one is genuinely live in `site/index.html`.

> **CHANGED 18 Aug 2026.** The hero VSL (never filmed; a placeholder throughout) was
> replaced by the client with a static, art-directed hero image. `main_vsl_play` and the
> four VSL progress events described further down are retired, not "not yet active" — no
> video exists, none is planned, and nothing should be configured to expect one.

| Event | Fires when | Once | Parameters |
|---|---|---|---|
| `initial_cta_click` | Any CTA is clicked | no | `cta_text` |
| `lead_modal_open` | The modal opens | yes | — |
| `lead_form_start` | First interaction with any field in the modal | yes | — |
| `lead_form_submit` | Submit pressed and client validation passed | yes | — |
| `lead_form_stored` | **Convex confirmed `stored: true`** | yes | — |
| `calendly_redirect` | Immediately before `window.location.assign` | yes | — |

### The funnel

```
initial_cta_click → lead_modal_open → lead_form_start → lead_form_submit
                  → lead_form_stored → calendly_redirect → [visitor leaves the site]
```

`lead_form_stored` fires **only** after the server confirms the write. Every failure path —
validation, network, timeout, CORS, 4xx, 5xx, malformed JSON, a `stored:false` body —
throws before it, so a gap between `lead_form_submit` and `lead_form_stored` is a **backend
problem, not a copy problem**. That gap is the single most important thing to watch after
launch.

`calendly_redirect` and `lead_form_stored` should track 1:1. If they diverge, something is
failing between the confirmed write and the navigation.

### Controlled values

- `cta_text` — the rendered button label. As of 18 Aug 2026 every CTA on the page,
  including the header shortcut, reads the same string: `Contact Us`. There is no
  separately-labelled shortcut any more. A label, never free text.

### Retired in v3

`scheduling_cta_click` · `calendar_view` · `booked_call` — all three belonged to the
same-page embed. A container still configured for them will report a funnel that no longer
exists. `tools/redirect.mjs` asserts none of them is emitted.

`main_vsl_play` · `vsl_25_percent` · `vsl_50_percent` · `vsl_75_percent` · `vsl_complete` —
retired 18 Aug 2026 with the VSL itself. See the note at the top of the event table.

Retired earlier, in v2: `primary_cta_click` · `qualification_*` · `score_band` · `outcome`
· `answer_key`.

---

## VSL events — retired, not "not yet active"

The client replaced the hero video concept with a static hero image (18 Aug 2026). There is
no `VIDEO INTEGRATION` marker left in `site/index.html` to search for, and no video element
anywhere on the page — confirmed by `tools/acceptance.mjs`'s "no video element anywhere on
the page" check. **Do not configure any of the events below in GTM.**

The snippet below is kept only as a historical reference for if a video is ever
reintroduced as a *deliberate* future decision — it does not describe current or planned
behaviour:

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

## Why there is no `booked_call` dataLayer event on this page

The booking happens on `calendly.com`, after the visitor has left the site. There is no
embedded iframe to receive a `postMessage` from and no honest way for **this page** to know
a meeting was scheduled. **Do not fabricate one** — a conversion event fired on redirect
would count every visitor who reached the calendar, not every visitor who booked. Treat
`calendly_redirect` as "reached the calendar," which is what it actually measures, nothing
more.

**A `booked_call` record exists — server-side, in Convex, not as a tracking event here.**
`convex/calendly.ts` polls the Calendly API every five minutes (Free plan has no webhooks)
and writes one `bookedCallEvents` row when a real, matched booking is found. Full design:
`docs/CALENDLY_FREE_SYNC.md`. Until that table is wired into an actual Ads upload, read
booked calls from the Calendly dashboard or the Convex dashboard, not from GTM.

### Attribution across the hand-off

`utm_source`, `utm_medium`, `utm_campaign`, `utm_content` and `utm_term` are appended to
the Calendly URL when they are present on the landing-page URL, so a booking can still be
attributed to the ad that produced it. `gclid` is **not** forwarded — it is a
Google-specific click identifier that Calendly has no use for, and the lead row in Convex
already carries it.

Nothing else is appended: no phone number, no answers, no consent value, no submission id,
no deployment detail.

---

## Activation checklist

Before switching tracking on, in order:

1. Owner supplies the **GTM container ID**.
2. `docs/PROPOSED_PRIVACY_TRACKING_UPDATE.md` is reviewed and the privacy policy updated.
3. Any required consent mechanism is in place.
4. GTM container script is added (header + body).
5. Verify in GTM Preview: each event fires once, carries attribution, and carries **no PII**.
6. Confirm `calendly_redirect` fires once per stored lead, and that no event carries
   `name`, `email`, `phone`, or a `cta_text` other than the two permitted labels.
   `tools/redirect.mjs` checks this against a stub; check it again in GTM Preview against
   the real container.
7. Remember the conversion is **not** measurable on this page. Set the Ads conversion on a
   Calendly webhook or Calendly's own reporting, never on `calendly_redirect`.

Until step 1, the page is correct and complete as it stands: it publishes events that
nothing yet reads.
