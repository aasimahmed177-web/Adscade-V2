#!/usr/bin/env node
/* resolveSyncTargets() — which Calendly event types the sync watches, and for which
   offers.
 *
 * Run OUTSIDE Convex, against the real exported function, because the Convex action
 * sandbox blocks outbound requests to loopback addresses and sync() therefore cannot be
 * driven end-to-end against a mock Calendly (see the note atop tools/calendly-sync-test.mjs).
 * The resolver is pure so that this limitation costs no coverage on the branchiest logic
 * in the file.
 *
 *   npx tsx tools/calendly-targets-test.mjs
 */
import { resolveSyncTargets, needsEventTypeLookup, TARGET_EVENT_TYPE_NAME } from '../convex/calendly.js';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const EMAIL = 'owner@adscade.com';

const ACQ_URI = 'https://api.calendly.com/event_types/ACQ-UUID';
const CONTENT_URI = 'https://api.calendly.com/event_types/CONTENT-UUID';
const ACQ_URL = 'https://calendly.com/aasim-ahmed177/realestate-growth-systems';
const CONTENT_URL = 'https://calendly.com/aasim-ahmed177/brokerage-content-system-call';

/** The account as Calendly actually reports it, once both events exist. */
const BOTH_EVENTS = [
  { uri: ACQ_URI, name: TARGET_EVENT_TYPE_NAME, scheduling_url: ACQ_URL },
  { uri: CONTENT_URI, name: 'Brokerage Content System Call', scheduling_url: CONTENT_URL },
];
/** The account before the content event was created. */
const ACQ_ONLY = [BOTH_EVENTS[0]];
/** An account where the acquisition event has been RENAMED — the live risk today. */
const RENAMED_ACQ = [
  { uri: ACQ_URI, name: 'Real Estate Growth Systems', scheduling_url: ACQ_URL },
  BOTH_EVENTS[1],
];

const offersFor = (res, uri) => res.targets.find((x) => x.uri === uri)?.offers ?? null;

console.log('\n— pinned API URIs —');
{
  const res = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_EVENT_TYPE_URI: CONTENT_URI,
  }, [], EMAIL);
  t('both targets resolve', res.targets.length === 2, JSON.stringify(res));
  t('no errors', res.errors.length === 0);
  t('acquisition maps to its own offer only',
    JSON.stringify(offersFor(res, ACQ_URI)) === '["real_estate_acquisition"]');
  t('content maps to its own offer only',
    JSON.stringify(offersFor(res, CONTENT_URI)) === '["brokerage_content_engine"]');
  t('source recorded as env', res.targets.every((x) => x.source === 'env'));
  t('pinning everything needs no API lookup at all',
    needsEventTypeLookup({
      CALENDLY_EVENT_TYPE_URI: ACQ_URI,
      CALENDLY_CONTENT_EVENT_TYPE_URI: CONTENT_URI,
    }) === false);
}

console.log('\n— resolving by PUBLIC booking URL —');
{
  // The value a human actually has. A public booking URL is not an API event-type URI
  // and cannot be used as one, so the resolver does the conversion rather than anyone
  // hand-guessing a UUID.
  const res = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_SCHEDULING_URL: CONTENT_URL,
  }, BOTH_EVENTS, EMAIL);
  t('content resolves from its booking URL to the API URI',
    offersFor(res, CONTENT_URI) !== null, JSON.stringify(res.targets));
  t('and records how it was resolved',
    res.targets.find((x) => x.uri === CONTENT_URI)?.source === 'scheduling_url');
  t('no errors', res.errors.length === 0, JSON.stringify(res.errors));

  for (const variant of [
    CONTENT_URL + '/',
    CONTENT_URL.toUpperCase(),
    CONTENT_URL + '?month=2026-09',
    '  ' + CONTENT_URL + '  ',
  ]) {
    const r = resolveSyncTargets({
      CALENDLY_EVENT_TYPE_URI: ACQ_URI,
      CALENDLY_CONTENT_SCHEDULING_URL: variant,
    }, BOTH_EVENTS, EMAIL);
    t(`tolerates ${JSON.stringify(variant.slice(0, 48))}`, offersFor(r, CONTENT_URI) !== null);
  }

  const wrong = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_SCHEDULING_URL: 'https://calendly.com/someone/not-a-real-event',
  }, BOTH_EVENTS, EMAIL);
  t('an unknown booking URL is an error, not a silent skip',
    wrong.errors.length === 1 && wrong.errors[0].includes('not-a-real-event'),
    JSON.stringify(wrong.errors));
  t('and it does NOT resolve to some other event type',
    wrong.targets.length === 1 && wrong.targets[0].uri === ACQ_URI);
}

console.log('\n— the failure-isolation case —');
{
  // THE BUG THIS EXISTS FOR. The acquisition event has been renamed, so the default
  // name lookup fails. Previously that returned from the entire run before discovery,
  // so a perfectly configured content target never synced either — a pre-existing VSL-4
  // problem silently taking VSL-5 down with it.
  const res = resolveSyncTargets({
    CALENDLY_CONTENT_SCHEDULING_URL: CONTENT_URL,
  }, RENAMED_ACQ, EMAIL);

  t('the acquisition failure is reported', res.errors.length === 1, JSON.stringify(res.errors));
  t('the error names the variable that fixes it',
    res.errors[0].includes('CALENDLY_EVENT_TYPE_URI'), res.errors[0]);
  t('the CONTENT target still resolves despite it',
    offersFor(res, CONTENT_URI) !== null, JSON.stringify(res.targets));
  t('exactly one healthy target survives', res.targets.length === 1);
}
{
  // The mirror image: content misconfigured must not stop acquisition.
  const res = resolveSyncTargets({
    CALENDLY_CONTENT_SCHEDULING_URL: 'https://calendly.com/x/does-not-exist',
  }, BOTH_EVENTS, EMAIL);
  t('a broken CONTENT target does not stop acquisition',
    offersFor(res, ACQ_URI) !== null && res.errors.length === 1,
    JSON.stringify(res));
}
{
  const res = resolveSyncTargets({}, RENAMED_ACQ, EMAIL);
  t('everything unresolvable yields zero targets and a reported error',
    res.targets.length === 0 && res.errors.length === 1, JSON.stringify(res));
}

console.log('\n— before the content event exists —');
{
  // The state right after deploying the backend and before creating the calendar.
  const res = resolveSyncTargets({}, ACQ_ONLY, EMAIL);
  t('acquisition resolves by its default name', offersFor(res, ACQ_URI) !== null);
  t('the unconfigured content offer is silent — NOT an error',
    res.errors.length === 0, JSON.stringify(res.errors));
  t('only one target', res.targets.length === 1);
}

console.log('\n— a SHARED event type —');
{
  // Today's live situation: both funnels point at one Calendly event.
  const res = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_EVENT_TYPE_URI: ACQ_URI,
  }, [], EMAIL);
  t('it is listed ONCE, not twice', res.targets.length === 1, JSON.stringify(res.targets));
  t('and carries BOTH offers, rather than silently crediting the first',
    JSON.stringify(offersFor(res, ACQ_URI)) ===
    '["real_estate_acquisition","brokerage_content_engine"]',
    JSON.stringify(offersFor(res, ACQ_URI)));
  t('no error — sharing is a valid, if ambiguous, configuration', res.errors.length === 0);
}
{
  // Same, reached via two different config routes rather than the same literal.
  const res = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_SCHEDULING_URL: ACQ_URL,
  }, BOTH_EVENTS, EMAIL);
  t('dedupe works across different resolution methods', res.targets.length === 1);
  t('and still merges both offers', offersFor(res, ACQ_URI)?.length === 2);
}

console.log('\n— precedence —');
{
  const res = resolveSyncTargets({
    CALENDLY_CONTENT_EVENT_TYPE_URI: CONTENT_URI,
    CALENDLY_CONTENT_SCHEDULING_URL: ACQ_URL,          // would resolve elsewhere
    CALENDLY_CONTENT_EVENT_TYPE_NAME: TARGET_EVENT_TYPE_NAME, // and so would this
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
  }, BOTH_EVENTS, EMAIL);
  t('a pinned URI beats both the booking URL and the name',
    offersFor(res, CONTENT_URI) !== null && res.targets.length === 2,
    JSON.stringify(res.targets));

  const res2 = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_SCHEDULING_URL: CONTENT_URL,
    CALENDLY_CONTENT_EVENT_TYPE_NAME: 'Something Else Entirely',
  }, BOTH_EVENTS, EMAIL);
  t('a booking URL beats a name', offersFor(res2, CONTENT_URI) !== null);

  const res3 = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: ACQ_URI,
    CALENDLY_CONTENT_EVENT_TYPE_NAME: 'brokerage content system call', // case-insensitive
  }, BOTH_EVENTS, EMAIL);
  t('name matching is case-insensitive', offersFor(res3, CONTENT_URI) !== null);
}

console.log('\n— whitespace and empty values —');
{
  const res = resolveSyncTargets({
    CALENDLY_EVENT_TYPE_URI: '   ',        // set-but-blank must behave as unset
    CALENDLY_CONTENT_EVENT_TYPE_URI: '  ' + CONTENT_URI + '  ',
  }, ACQ_ONLY, EMAIL);
  t('a blank pinned URI falls through to the name lookup',
    offersFor(res, ACQ_URI) !== null, JSON.stringify(res.targets));
  t('a padded URI is trimmed', offersFor(res, CONTENT_URI) !== null,
    JSON.stringify(res.targets.map((x) => x.uri)));
}

console.log('\n— an event type with no scheduling_url —');
{
  // The field is optional in the API response; its absence must not throw.
  const res = resolveSyncTargets(
    { CALENDLY_CONTENT_SCHEDULING_URL: CONTENT_URL, CALENDLY_EVENT_TYPE_URI: ACQ_URI },
    [{ uri: 'https://api.calendly.com/event_types/X', name: 'No URL' }],
    EMAIL,
  );
  t('missing scheduling_url is skipped, not crashed on',
    res.errors.length === 1 && res.targets.length === 1, JSON.stringify(res));
}

console.log(fails === 0
  ? '\nall Calendly target-resolution tests passed\n'
  : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
