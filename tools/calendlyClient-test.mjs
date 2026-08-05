#!/usr/bin/env node
/* Exercises convex/calendlyClient.ts directly — real HTTP, real fetch, real pagination —
   against the mock Calendly server. Runs entirely outside Convex (plain Node via tsx), so
   it is unaffected by the Convex action sandbox's apparent block on outbound requests to
   private/loopback IP ranges (see docs/CALENDLY_FREE_SYNC.md "Testing without a real
   booking" for why that block ruled out testing the full sync action against a local mock).
   This covers the HTTP/parsing/pagination logic that calendly.ts's sync() then calls. */
import { startMockCalendly, mockFixtures } from './calendlyMockServer.mjs';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const { base, state, stop } = await startMockCalendly();
process.env.CALENDLY_API_BASE = base;
process.env.CALENDLY_PAT = state.token;
console.log('mock Calendly at', base);

const {
  getCurrentUser, listEventTypes, listActiveEvents, listInvitees, getInvitee, getEvent,
  CalendlyAuthError, CalendlyRateLimitError,
} = await import('../convex/calendlyClient.ts');

const fx = mockFixtures(base);
const targetType = fx.eventType('Real Estate Acquisition System Call');
const decoyType = fx.eventType('Free Consultation');
state.eventTypes.push(targetType, decoyType);

const inMinutes = (m) => new Date(Date.now() + m * 60000).toISOString();
const evTarget = fx.event(targetType.uri, { startTime: inMinutes(60), endTime: inMinutes(90) });
const evDecoy = fx.event(decoyType.uri, { startTime: inMinutes(60), endTime: inMinutes(90) });
[evTarget, evDecoy].forEach((e) => state.events.set(new URL(e.uri).pathname, e));

const invA = fx.invitee(evTarget.uri, { email: 'a@example.com', name: 'A', qa: [{ question: 'City?', answer: 'Pune', position: 1 }] });
const invB = fx.invitee(evTarget.uri, { email: 'b@example.com', name: 'B' });
[invA, invB].forEach((i) => state.invitees.set(new URL(i.uri).pathname, i));

console.log('\n— identity —');
const me = await getCurrentUser();
t('getCurrentUser returns the mock user', me.email === 'aasim@adscade.com');
t('organization URI is present', typeof me.organization === 'string' && me.organization.length > 0);

console.log('\n— event types —');
const types = await listEventTypes(me.uri);
t('both event types returned', types.length === 2);
t('target event type findable by exact name match',
  types.some((et) => et.name === 'Real Estate Acquisition System Call'));

console.log('\n— active events, filtered server-side by event_type —');
const events = await listActiveEvents(me.uri, targetType.uri, new Date(Date.now() - 86400000), new Date(Date.now() + 90 * 86400000));
t('only the target-type event comes back', events.length === 1 && events[0].uri === evTarget.uri,
  `${events.length} events`);
t('the decoy event type never appears', !events.some((e) => e.uri === evDecoy.uri));

console.log('\n— invitees —');
const invitees = await listInvitees(evTarget.uri);
t('both invitees on the target event returned', invitees.length === 2);
t('Q&A survives the round trip', invitees.find((i) => i.uri === invA.uri)?.questions_and_answers?.[0]?.answer === 'Pune');

console.log('\n— direct resource fetch by URI (used by the recheck pass) —');
const fetchedInvitee = await getInvitee(invA.uri);
t('getInvitee fetches the exact resource', fetchedInvitee.email === 'a@example.com');
const fetchedEvent = await getEvent(evTarget.uri);
t('getEvent fetches the exact resource', fetchedEvent.uri === evTarget.uri);

console.log('\n— pagination —');
state.pageSize = 1; // force listInvitees to need two pages for these two invitees
const paginated = await listInvitees(evTarget.uri);
t('pagination follows next_page_token to completion', paginated.length === 2, paginated.length);
state.pageSize = 100;

console.log('\n— error classification —');
try {
  process.env.CALENDLY_PAT = 'wrong-token';
  await getCurrentUser();
  t('a bad token throws', false);
} catch (e) {
  t('a bad token throws CalendlyAuthError specifically', e instanceof CalendlyAuthError, e.constructor.name);
} finally {
  process.env.CALENDLY_PAT = state.token;
}

try {
  state.forceRateLimitOnce = true;
  await getCurrentUser();
  t('a 429 throws', false);
} catch (e) {
  t('a 429 throws CalendlyRateLimitError specifically', e instanceof CalendlyRateLimitError, e.constructor.name);
}
t('the client recovers on the next call', (await getCurrentUser()).email === 'aasim@adscade.com');

await stop();
console.log(fails ? `\n${fails} FAILED\n` : '\nall calendlyClient tests passed\n');
process.exit(fails ? 1 : 0);
