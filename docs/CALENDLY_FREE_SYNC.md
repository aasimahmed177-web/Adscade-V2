# Calendly Free-plan booking sync

How a Calendly booking made on `/vsl-4/` becomes a `booked` lead in Convex, given that
Calendly's Free plan has no webhooks.

> **Detection delay: up to ~5 minutes.** This is polling, not push. A booking, cancellation
> or reschedule is reflected here on the next scheduled run, never instantly. Do not
> describe this to anyone as real-time.

---

## Why polling, not a webhook

`docs/CONVEX_SETUP.md` originally sketched a webhook (`invitee.created` /
`invitee.canceled`). Calendly webhooks require a paid plan. On Free, the only way to learn
about a booking is to ask the API — so a Convex cron asks it every five minutes.

**Upgrading later is additive, not a rewrite.** See "Moving to webhooks" at the bottom.

---

## Setup

### 1. Create the personal access token

Calendly → Integrations → API & Webhooks → **Personal access tokens** → Create. Copy it
once; Calendly will not show it again.

The scopes actually used by this code: **`users:read`**, **`event_types:read`**,
**`scheduled_events:read`**. (If Calendly's token UI groups invitee access under
`scheduled_events:read` rather than a separate scope, that's fine — invitees are fetched
as a sub-resource of an event, `GET /scheduled_events/{id}/invitees`.)

### 2. Set it in Convex — **production only**

```bash
npx convex env set CALENDLY_PAT <token> --prod
```

**Never** put this token anywhere else: not in `site/index.html`, not in
`dist/head-tags.txt` or `dist/home-widget.txt`, not in WordPress, not in this repo, not in
a commit, not in a screenshot, not in a log line. `convex/calendlyClient.ts` reads it once,
server-side, via `process.env.CALENDLY_PAT`; no query or mutation in this codebase ever
returns it, and `http.ts` — the only code path reachable from a browser — never imports
anything from `convex/calendly.ts` or `convex/calendlyClient.ts`.

Confirm it's set without ever printing the value:

```bash
npx convex env list --prod   # shows the NAME "CALENDLY_PAT", never the value
```

### 3. Deploy

```bash
npx convex deploy
```

This pushes `convex/schema.ts` (the new fields and tables), `convex/calendly.ts`, and
`convex/crons.ts` (which registers the five-minute interval). Nothing on the frontend
changes — the paste files (`dist/*`) are untouched by this feature.

### 4. Confirm the cron is running

Convex dashboard → **Schedules** (or `npx convex run internal.calendly.getSyncState --prod`
a few minutes after deploying). `calendlySyncState.lastRunAt` should be recent.

---

## How the target event type is found

The code looks for an event type named exactly **"Real Estate Acquisition System Call"**
(`TARGET_EVENT_TYPE_NAME` in `convex/calendly.ts`), matched case-insensitively, via
`GET /event_types?user=<uri>`. Every sync run resolves the user URI from `GET /users/me`
first, then searches that list.

Both the user URI and the resolved event-type URI are recorded — not hardcoded — in the
`calendlySyncState` singleton table, so you can see exactly what the sync believes it's
watching without reading source code:

```bash
npx convex run internal.calendly.getSyncState --prod
```

**If the event type is ever renamed**, the name-match will stop finding it and every run
will log `No Calendly event type named "..." was found` into `calendlySyncState.lastError`.
Either rename it back, or pin the URI explicitly so a rename can't break sync silently:

```bash
npx convex env set CALENDLY_EVENT_TYPE_URI https://api.calendly.com/event_types/XXXXXXXX --prod
```

Find that URI once, from the same `getSyncState` output after a successful run (or from
`GET /event_types?user=<uri>` by hand). Setting this env var skips the name lookup
entirely — useful if the owner ever renames the event type on Calendly without wanting to
touch code.

Only events of this one type are ever fetched — the API call filters server-side with
`event_type=<uri>`, so a booking on a *different* Calendly event type never reaches this
pipeline at all, not even as an "unmatched" entry.

---

## What happens on each run (`convex/calendly.ts`, `sync`)

**Pass A — discover new bookings.** Lists active events of the target type in a window
from 1 day ago to 90 days ahead. For each event's invitees with `status: "active"`:

1. Skip if this invitee URI is already linked to a lead, or already logged as unmatched
   (idempotency — see below).
2. Normalise the invitee's email (`trim().toLowerCase()`) and look up the **most recent
   lead with that email that is not already booked to something else**
   (`calendlyStatus === "not_booked"`, or absent on legacy rows).
3. **Found** → `markBooked`: the lead's `calendlyStatus` becomes `"booked"`, the
   event/invitee URIs, start/end time, and Calendly's question answers are stored, and one
   `bookedCallEvents` row is inserted in the same mutation call.
4. **Not found** → `recordUnmatched`, plus a *diagnostic-only* same-name lookup (see
   "Matching" below) — never auto-linked, never discarded.

**Pass B — recheck open bookings.** For every lead with `calendlyStatus` of `"booked"` or
`"rescheduled"` whose meeting hasn't happened yet, fetches that exact invitee by its stored
URI (not a full re-list — cheaper, and works because every Calendly resource's `uri` field
is itself a fetchable URL). Up to 50 leads per status per run, oldest-synced-first, so a
backlog larger than that still gets covered fairly across runs rather than starving the
newest bookings.

- Invitee still `active` → nothing changed; just record that it was checked.
- Invitee `canceled`, and `rescheduled: true` with a `new_invitee` → treated as a
  **reschedule**, not a cancellation (see below).
- Invitee `canceled`, no `new_invitee` → a genuine cancellation.

---

## Matching

**Primary: normalised email, exact match, most recent eligible lead.** "Eligible" means
`calendlyStatus` is `not_booked` (or the field is absent, for rows created before this
feature existed — no backfill was needed). If the same email submitted twice, only the
newest unbooked row can be claimed by a new booking; older ones are left alone.

**Secondary: name, diagnostic only.** When email matching fails, the sync also looks for a
lead with the same name (case-insensitive) submitted in the last 14 days, and attaches it
to the unmatched row as `diagnosticCandidateLeadId` — a hint for whoever reviews unmatched
bookings, so they don't have to search by hand. **This is never used to book anything.** A
name match alone cannot move a lead from `not_booked` to `booked`.

**Why no phone matching:** the landing page deliberately does not pass the phone number to
Calendly (see the redirect logic in `site/index.html` and `docs/CONVEX_SETUP.md`), so
Calendly's invitee record never has one to match on.

---

## Idempotency

Every invitee URI is a permanent, unique key. Before booking one:

```
findLeadByInviteeUri(uri)        -- already linked to a lead? skip.
findUnmatchedByInviteeUri(uri)   -- already logged as unmatched? skip.
```

`markBooked` re-checks inside the mutation itself (a `bookedCallEvents` row already
existing for that invitee URI is a no-op), so even if the action somehow called it twice
in one run, only one lead update and one `bookedCallEvents` row would ever result.

`markRescheduled` is idempotent the same way: if the lead's `calendlyInviteeUri` already
equals the new invitee's URI, the call is a no-op.

---

## Booking status fields (on `leads`)

| Field | Meaning |
|---|---|
| `calendlyStatus` | `not_booked` \| `booked` \| `canceled` \| `rescheduled` |
| `calendlyEventUri` / `calendlyInviteeUri` | The **current** booking. Idempotency key. |
| `calendlyEventTypeUri` | Which event type this was booked against. |
| `calendlyBookedAt` | When the visitor **first** booked. Never overwritten by a reschedule. |
| `calendlyStartTime` / `calendlyEndTime` | The current scheduled slot. |
| `calendlyCanceledAt` | Set only on a genuine cancellation. |
| `calendlyRescheduled` | `true` once this booking has EVER been rescheduled — permanent, unlike `calendlyStatus`, which moves on again if the new booking is later canceled or rescheduled again. |
| `calendlyQuestionsAndAnswers` | Calendly's own invitee-side Q&A, verbatim. |
| `calendlyLastSyncedAt` | When Pass B last checked this booking. Drives the recheck rotation. |

None of this reaches the browser. `http.ts` — the only code the frontend ever talks to —
has no import of, and no reference to, anything in `convex/calendly.ts`.

---

## Cancellation and rescheduling

**Cancellation:** `calendlyStatus → "canceled"`, `calendlyCanceledAt` set. The historical
`calendlyEventUri`/`calendlyInviteeUri`/times are **left in place** — a canceled call still
happened as an event. The matching `bookedCallEvents` row is **never deleted or edited**;
whether to exclude a later-canceled call from an Ads upload is a decision made at upload
time, not something this pipeline decides for you.

**Reschedule:** detected when a canceled invitee has `rescheduled: true` and a
`new_invitee` link. The lead is updated to point at the **new** event/invitee/time
(`calendlyStatus → "rescheduled"`), but **`calendlyBookedAt` is deliberately left
unchanged** — it records when the visitor first committed to a call, and a reschedule
doesn't change that. This is a documented interpretation, not a literal field Calendly
gives you: "preserve the original event reference" is implemented as "the booking
timestamp doesn't move; the event/invitee/time fields do."

A second reschedule of the same booking is caught on a later run, the same way — Pass B
follows whatever invitee URI is currently stored, however many times it's been replaced.

---

## `booked_call` — the future Ads-upload record

`bookedCallEvents` is written **once per invitee**, only from inside `markBooked`, only
when a real, active Calendly invitee was matched to a lead. Nothing else in this codebase
inserts into that table. It is shaped for a future Google Ads offline/enhanced-conversion
upload:

| Field | Purpose |
|---|---|
| `gclid` | From the matched lead, if the visitor arrived via a Google Ads click. |
| `hashedEmail` / `hashedPhone` | SHA-256 of the lead's already-normalised email/phone. Computed once, here — never re-derived from anything Calendly sent, since Calendly never receives the phone at all. |
| `calendlyBookedAt` | The original booking timestamp. |
| `leadId` / `submissionId` | For a human cross-referencing the Convex dashboard. |

No Google Ads upload credentials or code exist yet, and none should be added without a
separate, explicit request — this table only prepares the shape.

---

## Testing without a real booking

Two scripts, covering everything short of the live network call from inside a deployed
Convex action:

```bash
npx tsx tools/calendlyClient-test.mjs    # HTTP client: fetch, auth errors, 429, pagination
node tools/calendly-sync-test.mjs        # every query/mutation, against the real Convex DB
```

Both need `npx convex dev` running against the **local/anonymous** deployment first —
neither one ever touches production data or a real Calendly account.

`tools/calendlyMockServer.mjs` is a small stand-in for the Calendly API, built from the
same field names and pagination shape `calendlyClient.ts` expects.

**Why the two scripts don't drive the actual `sync` action end-to-end against that mock:**
the Convex action sandbox appears to block outbound requests to private/loopback IP
ranges. A request from inside a Convex action to the real `api.calendly.com` (with a
deliberately wrong token, expecting a clean 401) succeeded without trouble; the identical
request to `127.0.0.1` or to the host's own LAN IP either got an immediate
`Connection reset by peer` or hung indefinitely, in both a sandboxed and an explicitly
unsandboxed shell. That rules out testing the *orchestration* against a local mock, but
not the two things that actually needed proving:

- `calendlyClient-test.mjs` runs `calendlyClient.ts`'s functions directly under plain
  Node (via `tsx`, since this Node version doesn't strip TS types) — no Convex action
  involved, so the sandbox restriction doesn't apply. It proves the HTTP client, the
  `Bearer` auth header, pagination via `next_page_token`, direct resource-URI fetches, and
  401/429 error classification are all correct against realistic Calendly response shapes.
- `calendly-sync-test.mjs` calls every query and mutation in `convex/calendly.ts`
  **directly**, with hand-crafted Calendly-shaped arguments standing in for what the real
  fetch loop would pass — matching, idempotency, booking, cancellation, reschedule
  (including that `calendlyBookedAt` truly survives), the unmatched log and its upsert
  behaviour, the diagnostic name hint, and the recheck rotation ordering. This runs
  against the real Convex database and its real indexes — a real bug (a field-name
  mismatch between `recordUnmatched`'s arguments and the `calendlyUnmatched` schema) was
  found and fixed this way, exactly as intended.

What remains genuinely untested until a real booking happens: the live `fetch()` calls
inside `sync()` running together as one action against the real Calendly API. That call
shape is proven correct in isolation (script one) and the API is proven reachable from a
Convex action (the 401 test above); the only way to close that last gap is a real booking
against production, described next.

---

## Running a real test booking (production)

1. Confirm the token and cron are live:
   ```bash
   npx convex env list --prod              # confirms CALENDLY_PAT is set, never its value
   npx convex run internal.calendly.getSyncState --prod
   ```
2. Submit a real lead through `/vsl-4/` (or `POST /submit-lead` directly) with an email you
   control.
3. Follow the redirect to Calendly and book a real slot with **that same email**.
4. Wait up to 5 minutes, then:
   ```bash
   npx convex run internal.calendly.getSyncState --prod
   ```
   `lastRunOk: true` and a `lastRunSummary` mentioning `booked=1` (or more) means it saw
   the booking.
5. Look up the lead (by email, via `internal.admin.listLeads` or the dashboard's Data tab)
   and confirm: `calendlyStatus: "booked"`, a real `calendlyEventUri`/`calendlyInviteeUri`,
   `calendlyStartTime` matching what you picked, and `calendlyQuestionsAndAnswers`
   populated if the Calendly event asks any questions.
6. Re-run the check a few minutes later (or just wait for the next cron tick) and confirm
   nothing duplicated — same lead, same `bookedCallEvents` count.
7. Cancel or reschedule that same booking on Calendly, wait for the next tick, and confirm
   the lead's `calendlyStatus` follows.
8. Delete the test lead when done (`internal.admin.purgeBySubmissionIdPrefix` or by hand in
   the dashboard) so it doesn't sit in the real sales queue.

---

## Inspecting unmatched bookings

```bash
npx convex run internal.calendly.debugListUnmatched --prod '{"limit": 20}'
```

Each row: the invitee's email/name as Calendly has them, the event time, any Q&A, and —
if a same-name lead was found in the last 14 days — `diagnosticCandidateLeadId`. Cross-
reference that ID against the leads table by hand; the system will never do it for you.
There is no automatic resolution path — `resolved` stays `false` until a human sets it.

---

## Operational commands

```bash
npx convex run internal.calendly.getSyncState --prod              # health at a glance
npx convex run internal.admin.listLeads --prod '{"limit": 20}'    # recent leads, incl. calendly* fields
npx convex run internal.calendly.debugListBookedCallEvents --prod '{"limit": 20}'
npx convex run internal.calendly.debugListUnmatched --prod '{"limit": 20}'
```

---

## Moving to webhooks later

Upgrading the Calendly plan makes `invitee.created`/`invitee.canceled` webhooks available.
That becomes an **addition**, not a rewrite:

1. Add an HTTP route (e.g. `POST /calendly-webhook`) in `convex/http.ts` — a **separate**
   route from `/submit-lead`, still with no browser ever calling it.
2. Verify `Calendly-Webhook-Signature` (HMAC) on every request; reject anything unsigned.
3. Call the **same** `markBooked` / `markCanceled` / `markRescheduled` mutations this
   polling pipeline already uses — they don't care whether they were invoked from a cron
   or a webhook.
4. Keep the cron running at a much longer interval (or leave it as-is) as a safety net for
   any webhook delivery Calendly ever drops.

Do not remove the polling path the moment a webhook exists — treat it as backup for at
least one full cycle before trusting the webhook alone.
