#!/usr/bin/env node
/* Exercises every query and mutation in convex/calendly.ts directly against the real
   Convex database engine — real indexes, real validators — with hand-crafted,
   Calendly-shaped arguments standing in for what the sync() action's fetch loop would
   pass them.

   Why not drive it through sync() end-to-end against a mock server: the Convex action
   sandbox appears to block outbound requests to private/loopback IP ranges (confirmed —
   see docs/CALENDLY_FREE_SYNC.md "Testing without a real booking" — a request to
   api.calendly.com from the same action succeeds cleanly, but the identical request to
   127.0.0.1 or a LAN IP gets reset or hangs). convex/calendlyClient.ts's HTTP/parsing/
   pagination layer is covered separately, against the same mock, by
   tools/calendlyClient-test.mjs, which runs outside Convex and is unaffected by that
   restriction. Together the two scripts cover everything except the live network call
   from inside a deployed Convex action, which needs a real reachable Calendly account. */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const SITE = (readFileSync('.env.local', 'utf8').match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
if (!SITE) { console.error('CONVEX_SITE_URL not found in .env.local — is `npx convex dev` running?'); process.exit(2); }
const ENDPOINT = SITE.replace(/\/$/, '') + '/submit-lead';

const run = (fn, argsObj) => {
  const json = execSync(
    `npx convex run --no-push internal.${fn} '${JSON.stringify(argsObj ?? {})}'`,
    { stdio: ['pipe', 'pipe', 'pipe'] },
  ).toString().trim();
  return json ? JSON.parse(json) : null;
};

async function submitLead(over = {}) {
  const submissionId = 'calendly-test-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  const body = {
    submissionId,
    timestamp: new Date().toISOString(),
    name: over.name ?? 'Test Lead',
    email: over.email,
    phone: over.phone ?? '9876543210',
    activeInventory: '50_99',
    monthlyMediaBudget: '1_3l',
    consent: true,
    website: '',
    landingPage: 'https://adscade.com/vsl-4/',
    device: 'desktop',
    attribution: { gclid: over.gclid ?? null },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://adscade.com' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.stored) throw new Error('seed lead not stored: ' + JSON.stringify(data));
  return submissionId;
}

const leadBySubmissionId = (submissionId) => {
  const all = run('admin.listLeads', { limit: 200 });
  const row = all.find((l) => l.submissionId === submissionId);
  if (!row) throw new Error('lead not found for ' + submissionId);
  return row;
};

const CAL = (path) => `https://api.calendly.com/${path}-${Math.random().toString(36).slice(2)}`;
const qa = (answer) => [{ question: 'What city is the project in?', answer, position: 1 }];
// Convex's JSON serialization does not guarantee the same key order as the literal that
// was inserted, so a straight JSON.stringify comparison is fragile. Compare values.
const qaEqual = (a, b) => a.length === b.length && a.every((x, i) =>
  x.question === b[i].question && x.answer === b[i].answer && x.position === b[i].position);

console.log('\n— setup —');
// Start from a clean slate regardless of whether a previous run of this script crashed
// before reaching its own cleanup — a stray "booked" lead from an earlier attempt would
// otherwise pollute the recheck-rotation assertions below.
run('calendly.debugPurgeAll');
run('admin.purgeBySubmissionIdPrefix', { prefix: 'calendly-test-' });
const emailA = `sync-a-${Date.now()}@adscade-test.com`;
const emailB = `sync-b-${Date.now()}@adscade-test.com`;
const emailC = `sync-c-${Date.now()}@adscade-test.com`;
const emailF = `sync-f-${Date.now()}@adscade-test.com`;
const nameE = `Sync Diagnostic ${Date.now()}`;

const subA = await submitLead({ email: emailA, name: 'Lead A', gclid: 'gclid-A-test' });
const subB = await submitLead({ email: emailB, name: 'Lead B' });
const subC = await submitLead({ email: emailC, name: 'Lead C' });
const subE = await submitLead({ email: `sync-e-unused-${Date.now()}@adscade-test.com`, name: nameE });
const subF = await submitLead({ email: emailF, name: 'Lead F' });
t('five seed leads created', !!(subA && subB && subC && subE && subF));

const leadA0 = leadBySubmissionId(subA);
const leadB0 = leadBySubmissionId(subB);
const leadC0 = leadBySubmissionId(subC);
const leadE0 = leadBySubmissionId(subE);
const leadF0 = leadBySubmissionId(subF);
t('fresh leads start not_booked', [leadA0, leadB0, leadC0, leadE0, leadF0].every((l) => l.calendlyStatus === 'not_booked'));

console.log('\n— matching query: findEligibleLeadByEmail —');
t('finds the lead by normalised email',
  run('calendly.findEligibleLeadByEmail', { normalisedEmail: emailA.toLowerCase() })?._id === leadA0._id);
t('an unknown email matches nothing',
  run('calendly.findEligibleLeadByEmail', { normalisedEmail: 'nobody-' + Date.now() + '@nowhere.test' }) === null);

console.log('\n— booking: markBooked —');
const eventTypeUri = CAL('event_types/target');
const evA = CAL('scheduled_events/evA'), invA = CAL('invitees/invA');
const startA = Date.now() + 3600000, endA = startA + 1800000, bookedA = Date.now();

t('idempotency check finds nothing before booking',
  run('calendly.findLeadByInviteeUri', { inviteeUri: invA }) === null);

run('calendly.markBooked', {
  leadId: leadA0._id, inviteeUri: invA, eventUri: evA, eventTypeUri,
  bookedAtMs: bookedA, startTimeMs: startA, endTimeMs: endA, questionsAndAnswers: qa('Bengaluru'),
});
const leadA1 = leadBySubmissionId(subA);
t('lead status becomes booked', leadA1.calendlyStatus === 'booked');
t('event/invitee URIs stored', leadA1.calendlyEventUri === evA && leadA1.calendlyInviteeUri === invA);
t('start/end/booked times stored',
  leadA1.calendlyStartTime === startA && leadA1.calendlyEndTime === endA && leadA1.calendlyBookedAt === bookedA);
t('Q&A stored verbatim', qaEqual(leadA1.calendlyQuestionsAndAnswers, qa('Bengaluru')),
  JSON.stringify(leadA1.calendlyQuestionsAndAnswers));
t('calendlyLastSyncedAt is set', typeof leadA1.calendlyLastSyncedAt === 'number');

const bookedEvents1 = run('calendly.debugListBookedCallEvents', { limit: 20 });
t('exactly one booked_call record exists', bookedEvents1.length === 1, bookedEvents1.length);
t('booked_call carries the gclid from the lead', bookedEvents1[0].gclid === 'gclid-A-test');
t('booked_call hashes are 64-char hex, no raw PII',
  /^[0-9a-f]{64}$/.test(bookedEvents1[0].hashedEmail) && /^[0-9a-f]{64}$/.test(bookedEvents1[0].hashedPhone) &&
  !JSON.stringify(bookedEvents1[0]).includes(emailA) && !JSON.stringify(bookedEvents1[0]).includes('9876543210'));

console.log('\n— idempotency: markBooked called twice for the same invitee —');
run('calendly.markBooked', {
  leadId: leadA0._id, inviteeUri: invA, eventUri: evA, eventTypeUri,
  bookedAtMs: Date.now(), startTimeMs: startA, endTimeMs: endA, questionsAndAnswers: qa('SHOULD NOT OVERWRITE'),
});
const leadA2 = leadBySubmissionId(subA);
t('a second call for the same invitee is a no-op', leadA2.calendlyBookedAt === bookedA);
t('Q&A was not overwritten by the duplicate call',
  qaEqual(leadA2.calendlyQuestionsAndAnswers, qa('Bengaluru')));
t('still exactly one booked_call record', run('calendly.debugListBookedCallEvents', { limit: 20 }).length === 1);
t('findLeadByInviteeUri now finds it (idempotency for a future run)',
  run('calendly.findLeadByInviteeUri', { inviteeUri: invA })?._id === leadA0._id);
t('a booked lead is no longer eligible for a fresh match',
  run('calendly.findEligibleLeadByEmail', { normalisedEmail: emailA.toLowerCase() }) === null);

console.log('\n— booking B and C for the cancellation/reschedule tests —');
const evB = CAL('scheduled_events/evB'), invB = CAL('invitees/invB');
const startB = Date.now() + 7200000;
run('calendly.markBooked', {
  leadId: leadB0._id, inviteeUri: invB, eventUri: evB, eventTypeUri,
  bookedAtMs: Date.now(), startTimeMs: startB, endTimeMs: startB + 1800000, questionsAndAnswers: [],
});
const evC = CAL('scheduled_events/evC'), invC = CAL('invitees/invC');
const startC = Date.now() + 10800000, bookedC = Date.now();
run('calendly.markBooked', {
  leadId: leadC0._id, inviteeUri: invC, eventUri: evC, eventTypeUri,
  bookedAtMs: bookedC, startTimeMs: startC, endTimeMs: startC + 1800000, questionsAndAnswers: [],
});
t('B and C both booked', leadBySubmissionId(subB).calendlyStatus === 'booked' && leadBySubmissionId(subC).calendlyStatus === 'booked');
t('three booked_call records now exist', run('calendly.debugListBookedCallEvents', { limit: 20 }).length === 3);

console.log('\n— unmatched: recordUnmatched —');
const strayInvitee = CAL('invitees/stray');
const strayEvent = CAL('scheduled_events/strayEv');
run('calendly.recordUnmatched', {
  inviteeUri: strayInvitee, eventUri: strayEvent, eventTypeUri,
  inviteeEmail: 'typo@nowhere-test.com', inviteeName: nameE,
  startTimeMs: Date.now() + 14400000, endTimeMs: Date.now() + 16200000,
  questionsAndAnswers: [], diagnosticCandidateLeadId: leadE0._id,
});
const unmatched1 = run('calendly.debugListUnmatched', { limit: 20 });
t('unmatched booking logged, not discarded', unmatched1.some((u) => u.inviteeUri === strayInvitee));
const strayRow = unmatched1.find((u) => u.inviteeUri === strayInvitee);
t('diagnostic candidate is attached but nothing was auto-booked',
  strayRow.diagnosticCandidateLeadId === leadE0._id && leadBySubmissionId(subE).calendlyStatus === 'not_booked');
t('resolved defaults to false — sync never resolves it itself', strayRow.resolved === false);

console.log('\n— unmatched upsert: seen again does not duplicate —');
run('calendly.recordUnmatched', {
  inviteeUri: strayInvitee, eventUri: strayEvent, eventTypeUri,
  inviteeEmail: 'typo@nowhere-test.com', inviteeName: nameE,
  startTimeMs: Date.now() + 14400000, endTimeMs: Date.now() + 16200000,
  questionsAndAnswers: [], diagnosticCandidateLeadId: leadE0._id,
});
t('still exactly one unmatched row for the same invitee',
  run('calendly.debugListUnmatched', { limit: 20 }).filter((u) => u.inviteeUri === strayInvitee).length === 1);

console.log('\n— diagnostic name matching: findCandidateLeadByName —');
t('finds a same-name lead within the window',
  run('calendly.findCandidateLeadByName', { name: nameE, sinceMs: Date.now() - 86400000 })?._id === leadE0._id);
t('finds nothing for a name that does not exist',
  run('calendly.findCandidateLeadByName', { name: 'Nobody Called This ' + Date.now(), sinceMs: Date.now() - 86400000 }) === null);
t('finds nothing outside the lookback window',
  run('calendly.findCandidateLeadByName', { name: nameE, sinceMs: Date.now() + 1000 }) === null);

console.log('\n— cancellation: markCanceled —');
const canceledAt = Date.now();
run('calendly.markCanceled', { leadId: leadB0._id, canceledAtMs: canceledAt });
const leadB1 = leadBySubmissionId(subB);
t('status becomes canceled', leadB1.calendlyStatus === 'canceled');
t('calendlyCanceledAt recorded', leadB1.calendlyCanceledAt === canceledAt);
t('the historical event/invitee reference is kept, not cleared',
  leadB1.calendlyEventUri === evB && leadB1.calendlyInviteeUri === invB);
t('the booked_call row for B is untouched by the cancellation',
  run('calendly.debugListBookedCallEvents', { limit: 20 }).some((b) => b.inviteeUri === invB));

console.log('\n— reschedule: markRescheduled —');
const evC2 = CAL('scheduled_events/evC2'), invC2 = CAL('invitees/invC2');
const startC2 = startC + 86400000;
run('calendly.markRescheduled', {
  leadId: leadC0._id, newInviteeUri: invC2, newEventUri: evC2,
  newStartTimeMs: startC2, newEndTimeMs: startC2 + 1800000, newQuestionsAndAnswers: qa('Mumbai'),
});
const leadC1 = leadBySubmissionId(subC);
t('status becomes rescheduled', leadC1.calendlyStatus === 'rescheduled');
t('the permanent rescheduled flag is set', leadC1.calendlyRescheduled === true);
t('event/invitee URIs point at the replacement booking', leadC1.calendlyEventUri === evC2 && leadC1.calendlyInviteeUri === invC2);
t('start/end reflect the new slot', leadC1.calendlyStartTime === startC2);
t('the ORIGINAL booking timestamp is preserved, not overwritten',
  leadC1.calendlyBookedAt === bookedC, `${bookedC} -> ${leadC1.calendlyBookedAt}`);
t('no second booked_call row was created for the reschedule',
  run('calendly.debugListBookedCallEvents', { limit: 20 }).length === 3);
t('re-linking the same new invitee a second time is a no-op', (() => {
  run('calendly.markRescheduled', {
    leadId: leadC0._id, newInviteeUri: invC2, newEventUri: evC2,
    newStartTimeMs: startC2 + 999, newEndTimeMs: startC2 + 1800999, newQuestionsAndAnswers: [],
  });
  return leadBySubmissionId(subC).calendlyStartTime === startC2; // unchanged by the duplicate call
})());

console.log('\n— recheck rotation: findLeadsAwaitingRecheck —');
run('calendly.markBooked', {
  leadId: leadF0._id, inviteeUri: CAL('invitees/invF'), eventUri: CAL('scheduled_events/evF'), eventTypeUri,
  bookedAtMs: Date.now(), startTimeMs: startB + 999999, endTimeMs: startB + 1799999, questionsAndAnswers: [],
});
const awaiting = run('calendly.findLeadsAwaitingRecheck', { status: 'booked', notBeforeMs: 0, limit: 10 });
t('both open bookings (A and F) are due for a recheck', awaiting.length === 2, awaiting.length);
t('rotation is oldest-synced-first (A booked before F)', awaiting[0].submissionId === subA && awaiting[1].submissionId === subF);
t('a future notBeforeMs excludes everything', run('calendly.findLeadsAwaitingRecheck', { status: 'booked', notBeforeMs: Date.now() + 999999999, limit: 10 }).length === 0);

console.log('\n— touchSynced —');
run('calendly.touchSynced', { leadId: leadA0._id });
const afterTouch = run('calendly.findLeadsAwaitingRecheck', { status: 'booked', notBeforeMs: 0, limit: 10 });
t('touching A moves it behind F in the rotation', afterTouch[0].submissionId === subF && afterTouch[1].submissionId === subA);

console.log('\n— sync state singleton —');
run('calendly.setSyncState', {
  calendlyUserUri: CAL('users/me'), calendlyOrganizationUri: CAL('organizations/org'),
  calendlyEventTypeUri: eventTypeUri, calendlyEventTypeName: 'Real Estate Acquisition System Call',
  lastRunOk: true, lastRunSummary: 'first summary',
});
const state1 = run('calendly.getSyncState');
t('sync state round-trips', state1.lastRunSummary === 'first summary' && state1.lastRunOk === true);
run('calendly.setSyncState', { lastRunOk: false, lastError: 'second call' });
const state2 = run('calendly.getSyncState');
t('a second call patches the same singleton row', state2._id === state1._id);
t('the patch applied', state2.lastRunOk === false && state2.lastError === 'second call');
t('fields not passed on the second call are preserved', state2.calendlyEventTypeName === 'Real Estate Acquisition System Call');

console.log('\n— cleanup —');
const purged = run('calendly.debugPurgeAll');
t('purge clears bookedCallEvents', purged.bookedCallEvents === 4, purged.bookedCallEvents); // A, B, C, F
t('purge clears calendlyUnmatched', purged.unmatched === 1, purged.unmatched);
t('debug counts are zero after purge',
  run('calendly.debugCountBookedCallEvents') === 0 && run('calendly.debugCountUnmatched') === 0);
t('sync state singleton is gone', run('calendly.getSyncState') === null);
run('admin.purgeBySubmissionIdPrefix', { prefix: 'calendly-test-' });

console.log(fails ? `\n${fails} FAILED\n` : '\nall Calendly DB-layer tests passed\n');
process.exit(fails ? 1 : 0);
