# Adscade VSL-5 takeover review

## Current calendar policy (owner update)

Calendar access is now open to every valid, successfully stored VSL-5 application,
including 1–4 people and a "no" monthly-shoot answer. Both questions remain required.
The backend qualification formula and qualified conversion events are unchanged:
open calendar access must not relabel unqualified leads as qualified in reporting.
The booking gate and rejection branch are now removed entirely; legacy header flags
cannot restore them. This release also fixes ordered Sheet delivery and sync/reporting
diagnostics. See [END_TO_END_AUDIT.md](END_TO_END_AUDIT.md) for the verified findings,
current deployment order and remaining live checks.

Base: `f563a64294f1027f4f8d9b6cff9a01c7f47b8edc` on
`feature/brokerage-content-funnel`. Working branch: `fix/vsl5-takeover`.

## Scope and inherited state

The active offer is the Brokerage Content Engine: one monthly shoot and 20 videos.
Reporting classification remains 5+ salespeople AND monthly shoot availability.
Convex owns the verdict; it does not restrict booking. VSL-4 remains compatible, and both offers share leads, Sheets and telemetry.

The prior Claude commit fixed the six missing Apps Script mappings, offer-aware email
matching, target-resolution isolation, phone formatting and content Calendly URL.
Those fixes are present in the checked-out repository, not merely in a report.

## Additional fixes in this branch

- Filter returned scheduled events by their actual `event_type`. The previous mock
  implemented a server filter and could hide a mixed-offer response. The updated mock
  returns mixed event types so the real client must enforce this boundary.
- Read `/users/me`'s `current_organization`, matching Calendly's documented PAT response.
  Source: https://developer.calendly.com/how-to-find-the-organization-or-user-uri
- Paginate event-type discovery instead of assuming the first page contains both offers.
- If event-type lookup fails, continue pinned calendars and known-booking lifecycle checks.
- Follow reschedule ancestry before matching new invitees by email, so a newer application
  cannot steal a reschedule or generate a duplicate booked-call conversion. Follow rapid
  reschedule chains to their current invitee in the same recheck cycle.
- Reconsider previously unmatched bookings and resolve their diagnostic row after matching.
- Report booking/recheck failures as unsuccessful syncs instead of claiming a green run.
- Keep the same form submission ID when a visitor closes/reopens the VSL-5 modal, so a
  retried request after a timeout cannot duplicate an already stored application.
- Add a repeatable local workflow suite and a read-only production configuration check.

## Validation actually performed

`npm test`: four suites pass:

1. Apps Script receiver: real `.gs` code with fake Google services.
2. Calendly target resolution: real resolver, simulated event types.
3. Calendly client: real HTTP requests against a local simulated Calendly service.
4. Workflow: 26 checks using the actual HTTP actions, Convex functions and Apps Script
   receiver on `convex-test`'s in-memory backend. Verifies the qualification matrix,
   invalid inputs, retry idempotency, lead-to-Sheet data, same-row booking updates,
   offer isolation, rapid reschedules, cancellation, unmatched recovery and failure reporting.

`npm run typecheck`: passes. `git diff --check`: passes.

### Module-loading follow-up

The owner's Node 20.19.0 run passed the first three suites, but the workflow suite
failed to import `internal` from generated `api.js`; typechecking was skipped by
the shell's `&&` chain. Declare `type: module` explicitly in the root package and
remove the test loader's CommonJS compatibility wrappers. The original error was
reproduced on Node 20.19.0. With the fix, all four suites and typechecking pass on
both Node 20.19.0 and Node 24.19.0 in the review environment.

These are simulated-service tests, not production verification. The native Convex
development server could not finish startup in this environment. Playwright's Chromium
download failed with timeouts/502, so the existing browser/real-deployment suites were
not rerun here. They remain required before production approval. No live form was
submitted, no meeting was booked, and no production configuration was changed.

## Remaining gates and exact deployment materials

1. On an authenticated development workstation, rerun the existing suites listed in
   `docs/VSL5_CONTENT_FUNNEL.md`, including content-api, content-browser and VSL-4
   regressions, against a disposable development deployment. Do not point test cleanup
   helpers at production.
2. Review this branch and approve production deployment explicitly, as required by the
   handoff. Merge is a separate action; this PR does not merge or deploy itself.
3. Confirm Convex is the Adscade production project for `pastel-minnow-203`, then run
   `node tools/production-preflight.mjs` in its authenticated environment. It reads
   names only and prints booleans; it does not print secret values or write anything.
4. Deploy the reviewed backend commit. The new content calendar can be resolved using
   `CALENDLY_CONTENT_SCHEDULING_URL` set to
   `https://calendly.com/aasim-ahmed177/brokerage-content-system-call`.
   Configure the acquisition URL independently as
   `https://calendly.com/aasim-ahmed177/realestate-growth-systems` via
   `CALENDLY_SCHEDULING_URL`. A pinned API event-type URI takes precedence; inspect
   existing settings before choosing either method. Do not put a public booking URL
   in an API URI variable.
5. Update the bound Apps Script with
   `google-apps-script/google-sheets-convex-mirror-v4.gs`, preserve properties, run
   `setupAdscade()`, and update the existing web app deployment to a new version.
   Confirm `ADSCADE_SYNC_SECRET` agrees with Convex's `GOOGLE_SHEETS_SYNC_SECRET`.
   An `/exec` URL being visible is not by itself a reason to rotate it: configured
   shared-secret verification is what restricts writes. The current script permits
   unauthenticated writes if that Script Property is absent, so confirm it is set.
6. Replace the VSL-5 Elementor widget with `site/vsl-5.html`, then install
   `wordpress/vsl-5-head.html` on that page only and clear relevant caches. Preserve
   global GTM/GA/Meta tags. The old widget sends `qualified` and will be rejected by
   the new endpoint, so header-only installation is insufficient.
7. Submit a controlled qualified application, complete a booking using the same email,
   then verify the SAME `submissionId` in Convex and Sheets gains the correct content
   event type, booking status and time. Allow the five-minute poll plus mirror time.
   Check one unqualified application is stored and does not redirect. Run the required
   VSL-4 regression. Use only contact details controlled by the owner.

No secret needs to appear in WordPress or chat. Production Convex, WordPress and Google
Apps Script account access is still needed to complete steps 3–7. Preserve lead data
if a release needs repair; never delete content leads to force an older schema to deploy.
