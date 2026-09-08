# Adscade VSL-5 end-to-end audit — 8 September 2026

The live page still served the original qualification gate during this audit. The
replacement code is on `fix/vsl5-takeover`; publishing the GitHub branch does not
update Elementor, Apps Script or production Convex automatically.

## Confirmed findings and fixes

| Finding | Evidence | Fix / status |
|---|---|---|
| Small teams blocked from Calendly | Live HTML contains `if (qualified)` and the exact “Application received” / established-brokerages message in the owner's screenshot | Removed the entire gate and rejection branch from the replacement widget. Every valid, stored application redirects, even with a stale strict-mode header flag. |
| WordPress serves an older widget | Live form is the old dark design; current release marker is absent | Replace the entire widget and purge caches. New marker: `data-release="2026-09-08-open-booking"`. |
| Late Sheet update can erase a booking | Replayed initial snapshot after a booked snapshot; receiver changed the row back to `not_booked` | Lead revisions travel as `convex_sync_version`. Receiver ignores older snapshots. Late callbacks cannot mark newer data synced or failed. |
| Calendly health retains an old error after recovery | Regression failed after simulated outage followed by successful sync | A successful sync explicitly removes the old error. Missing PAT now records an unsuccessful run. |
| Conversion rates can exceed 100% with open booking | Qualified-session denominator was divided into redirects from all sessions | Rates now count sessions that reached both stages. Same correction applies to campaign breakdowns. |
| Production check can target the wrong environment | Existing check used `--prod`, matching the earlier anonymous-deployment difficulty | Diagnostic command explicitly targets `pastel-minnow-203` and reads public release, configured receiver health, sync status and Sheet counts. |
| Duplicate page metadata | Live HTML had two titles, two descriptions and two canonical tags; the first title was `VSL 5 - ` | Updated header leaves those three tags to WordPress. Set the title/description below in the page's SEO settings. |
| Shared Apps Script URL unavailable | The previously supplied `/exec` URL returned HTTP 404 from this session | Requires checking the URL currently configured in production. The supplied URL may be an older deployment. No replacement URL was invented. |

Qualification remains reporting only: 5+ team members plus a yes to monthly shoots
is `contentQualified=true`; other valid answers remain false and still reach booking.
Neither the browser nor booking sync promotes every applicant to a qualified lead.

## What was actually verified

- Live WordPress source retrieved successfully after earlier 502 responses. The
  cause of the screenshot is confirmed in the served source, not inferred from cache.
- Production content endpoint returns the expected 422 for an intentionally empty
  request. CORS preflight returns 204 for `https://adscade.com`.
- The content Calendly URL returns HTTP 200. This establishes reachability only;
  it does not verify appointment availability, booking questions or account settings.
- `npm test`: four suites pass using real repository code and simulated services.
- `npm run typecheck`: passes.
- `node tools/content-ui-review.mjs`: 216 browser assertions at 1440, 1024, 768,
  390 and 320 pixels. Validations, retry, duplicate clicks, all CTAs, FAQ, modal/focus,
  sticky controls, overflow, server-owned reporting and Calendly destination checked.
- `node --import tsx tools/workflow-test.mjs --browser`: 60 checks, with browser entry for all
  eight team-size/shoot combinations, through the real Convex HTTP router and
  mutations into booking sync and the actual Apps Script receiver. External Calendly
  and Google services are simulated. Includes same-row updates, rescheduling,
  cancellation, offer-aware matching, failed sync recovery and delayed snapshots.

No live lead, appointment, cancellation or Sheet row was created by this audit.
There is no authenticated Convex, WordPress, Calendly or Sheets account connection
in this runtime. Production settings, actual Sheet delivery and a real booking
therefore remain unverified. GitHub access is available and the fixes are committed
on the review branch; no merge or production deployment is implied.

## Install these exact files

1. **Apps Script:** replace the receiver with
   `google-apps-script/google-sheets-convex-mirror-v4.gs` in the existing bound project.
   Keep its existing `ADSCADE_SPREADSHEET_ID` and `ADSCADE_SYNC_SECRET` properties.
   Run `setupAdscade()` once. Under **Deploy → Manage deployments → Edit**, select
   **New version** and deploy as yourself with access set to **Anyone**. Saving the
   editor alone does not update a deployed web app. Open its current `/exec` URL:
   it should return `ok:true`, `configured:true` and version
   `2026-09-08-ordered-mirror`. Use the URL from that deployment, not an earlier one.

2. **Convex:** in the authenticated Adscade-V2 project terminal, obtain the reviewed
   branch and deploy to the known production deployment:

   ```bash
   git fetch origin
   git switch fix/vsl5-takeover
   git pull --ff-only origin fix/vsl5-takeover
   npm ci
   CONVEX_DEPLOYMENT=prod:pastel-minnow-203 npx convex deploy
   ```

   If Git reports local changes or a conflict, keep those changes and share the error;
   do not reset or delete them. If the Apps Script deployment URL changed, update
   `GOOGLE_SHEETS_WEBHOOK_URL` in the production Convex dashboard to the current URL.
   The existing server-to-server secret must still match; no secret belongs in the
   page header or chat. The new schema field is optional, so old lead rows remain valid.

3. **WordPress:** replace the **entire** VSL-5 Elementor HTML widget with
   `site/vsl-5.html`, and replace its page-specific head snippet with
   `wordpress/vsl-5-head.html`. Do not append another copy of the form. Update/publish
   the page, then clear WordPress/cache-plugin/CDN caches. Retest in a private tab.

   WordPress already outputs the title, description and canonical. Use its page SEO
   settings for the following; the new head snippet no longer duplicates them:

   | Field | Value |
   |---|---|
   | SEO title | One Shoot a Month. 20 Real Estate Videos. — Adscade |
   | Description | Your team just shows up. Adscade researches, scripts, guides the iPhone shoot, edits, captions and publishes 20 real estate videos a month for your brokerage. |
   | Canonical | `https://adscade.com/vsl-5-2/` |

   The header retains the paid page's `noindex, follow` setting. Global GTM/Google/Meta
   tags stay in their existing locations. The visible form says all team sizes can book.

4. **Read-only verification:** after the changes are published, run:

   ```bash
   node tools/production-preflight.mjs
   ```

   Share its output. It prints status, counts and presence booleans; it withholds
   secrets, webhook values and lead contact details. It never writes data or deploys.
   A pending mirror immediately after a new lead may be transient; it still needs
   to become synced. A good status report alone does not prove a real booking.

5. **Final live journey:** submit your own details with **1–4 people / Yes**, reach the
   correct Calendly event and book using the same email. Repeat **1–4 / No** through
   the redirect without booking another appointment. After one five-minute polling
   cycle plus the async Sheet update, verify the booked application's original
   `submission_id` now has `calendly_status=booked` on the **same row**, with
   `content_qualified=FALSE`. The classification must not restrict booking.

## Rollout and remaining scope

Deploy the receiver before the backend to enable out-of-order protection as soon as
versioned snapshots arrive. Unversioned historical rows are revision zero and require
no backfill. Existing Sheet columns and submission IDs are preserved. Do not roll
back to an older schema by deleting leads; repair forward if needed.

The new iPhone image variants and founder image are still awaiting their WordPress
upload URLs. The widget still references the existing two images, including the
professional-camera illustration. Their replacement is not included in this audit.
Live ad-platform conversion configuration, spend and campaign settings were not
accessible. Start/resume ads after the published page and a real booking-to-Sheet
journey pass, rather than treating local tests as a production certificate.
