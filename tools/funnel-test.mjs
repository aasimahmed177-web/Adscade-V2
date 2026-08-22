#!/usr/bin/env node
/* Anonymous funnel telemetry — real HTTP against a running Convex deployment, plus a real
   browser driving the actual landing page. No stubs for the endpoint itself.

   Covers the brief's telemetry requirements G-P:
     G  legitimate allowed event accepted
     H  duplicate eventId does not duplicate a row
     I  invalid event name rejected
     J  payload containing name/email/phone rejected
     K  unapproved Origin rejected
     L  endpoint failure does not prevent CTA/modal/form behaviour
     M  landing_page_view once per page session
     N  initial_cta_click behaviour
     O  lead_modal_open and lead_form_start distinguishable
     P  funnelSummary unique-session conversion maths

   Prereqs: `npx convex dev` running; `npx http-server site -p 8788 -s` for the browser half.
*/
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const SITE = (readFileSync('.env.local', 'utf8').match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
if (!SITE) { console.error('CONVEX_SITE_URL missing — is `npx convex dev` running?'); process.exit(2); }
const BASE = SITE.replace(/\/$/, '');
const TRACK = BASE + '/track-event';
const ORIGIN = process.env.ADSCADE_TEST_ORIGIN || 'http://127.0.0.1:8788';

const run = (fn, args) => {
  const out = execSync(`npx convex run --no-push internal.${fn} '${JSON.stringify(args ?? {})}'`,
    { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  return out ? JSON.parse(out) : null;
};
const uuid = () => crypto.randomUUID();
const post = (body, headers = {}) => fetch(TRACK, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://adscade.com', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const evt = (over = {}) => ({
  eventId: uuid(), sessionId: uuid(), eventName: 'landing_page_view',
  clientTimestamp: Date.now(), device: 'mobile',
  landingPage: 'https://adscade.com/vsl-4/',
  attribution: { utm_source: 'google', utm_campaign: 'test_camp' },
  ...over,
});

console.log(`\ntelemetry endpoint: ${TRACK}\n`);
run('funnel.purgeAllEvents');

/* ── G: allowed events ────────────────────────────────────────────── */
console.log('— G. allowed events accepted —');
for (const name of ['landing_page_view','initial_cta_click','lead_modal_open',
                    'lead_form_start','lead_form_submit','lead_form_stored','calendly_redirect']) {
  const r = await post(evt({ eventName: name }));
  const b = await r.json();
  t(`accepts ${name}`, r.status === 200 && b.ok === true && b.recorded === true && b.duplicate === false,
    `${r.status} ${JSON.stringify(b)}`);
}

/* ── H: idempotency ───────────────────────────────────────────────── */
console.log('\n— H. idempotency by eventId —');
{
  const before = run('funnel.countEvents');
  const fixed = uuid(), sid = uuid();
  const a = await (await post(evt({ eventId: fixed, sessionId: sid }))).json();
  const b = await (await post(evt({ eventId: fixed, sessionId: sid }))).json();
  t('first write is not a duplicate', a.duplicate === false);
  t('second write reports duplicate', b.duplicate === true, JSON.stringify(b));
  t('only one row was created', run('funnel.countEvents') === before + 1);
}

/* ── I: event-name allowlist ──────────────────────────────────────── */
console.log('\n— I. event-name allowlist —');
for (const bad of ['scroll_depth', 'lead_form_stored ', 'LANDING_PAGE_VIEW', 'purchase', '']) {
  const r = await post(evt({ eventName: bad }));
  const b = await r.json();
  t(`rejects "${bad}"`, r.status === 422 && b.code === 'unknown_event', `${r.status} ${b.code}`);
}
{
  const r = await post(evt({ eventId: 'short' }));
  t('rejects a malformed eventId', r.status === 422 && (await r.json()).code === 'validation_error');
  const r2 = await post(evt({ sessionId: '!!bad!!' }));
  t('rejects a malformed sessionId', r2.status === 422 && (await r2.json()).code === 'validation_error');
}

/* ── J: PII rejection ─────────────────────────────────────────────── */
console.log('\n— J. lead PII is rejected, not silently dropped —');
for (const key of ['name','email','phone','activeInventory','monthlyMediaBudget','consent',
                   'media_budget','inventory','questions_and_answers','fullName']) {
  const r = await post(evt({ [key]: 'should-never-be-accepted' }));
  const b = await r.json();
  t(`rejects payload carrying "${key}"`,
    r.status === 400 && b.code === 'pii_rejected' && (b.fields || []).includes(key),
    `${r.status} ${JSON.stringify(b)}`);
}
{
  const before = run('funnel.countEvents');
  await post(evt({ email: 'someone@example.com' }));
  t('a rejected PII payload writes no row at all', run('funnel.countEvents') === before);
  const all = JSON.stringify(run('funnel.listEvents', { limit: 200 }));
  t('no stored row contains an email address anywhere', !/@/.test(all.replace(/"userAgent":"[^"]*"/g, '')));
}

/* ── K: origin discipline ─────────────────────────────────────────── */
console.log('\n— K. origin discipline —');
for (const o of ['https://evil.example', 'http://adscade.com', 'https://adscade.com.evil.example']) {
  const r = await post(evt(), { Origin: o });
  t(`refuses origin ${o}`, r.status === 403 && (await r.json()).code === 'forbidden_origin', String(r.status));
}
{
  const r = await post(evt(), { Origin: 'https://adscade.com' });
  t('allows https://adscade.com and echoes it',
    r.status === 200 && r.headers.get('access-control-allow-origin') === 'https://adscade.com');
  t('never returns a wildcard', r.headers.get('access-control-allow-origin') !== '*');
  const pre = await fetch(TRACK, { method: 'OPTIONS', headers: { Origin: 'https://adscade.com' } });
  t('OPTIONS preflight works', pre.status === 204 &&
    pre.headers.get('access-control-allow-origin') === 'https://adscade.com');
  const g = await fetch(TRACK, { method: 'GET' });
  t('GET is refused', g.status === 404 || g.status === 405, String(g.status));
}

/* ── transport + caps ─────────────────────────────────────────────── */
console.log('\n— transport and caps —');
{
  // sendBeacon sends text/plain; validation must be identical, not weakened.
  const r = await post(evt(), { 'Content-Type': 'text/plain' });
  t('accepts text/plain (sendBeacon) with identical validation', r.status === 200);
  const bad = await post(evt({ eventName: 'nope' }), { 'Content-Type': 'text/plain' });
  t('text/plain is still validated', bad.status === 422);
  const wrong = await post(evt(), { 'Content-Type': 'application/xml' });
  t('rejects other content types', wrong.status === 415);
  const huge = await post(evt({ ctaText: 'x'.repeat(4000) }));
  t('rejects an oversized body', huge.status === 413, String(huge.status));
  const malformed = await post('{not json', {});
  t('rejects malformed JSON', malformed.status === 400);
  const capped = await (await post(evt({ ctaText: 'y'.repeat(400) }))).json();
  t('over-long ctaText is capped, not rejected', capped.ok === true);
}

/* ── P: funnelSummary maths ───────────────────────────────────────── */
console.log('\n— P. funnelSummary unique-session maths —');
{
  run('funnel.purgeAllEvents');
  const CAMP = 'summary_test_' + Date.now();
  const stage = async (sid, name, extra = {}) =>
    await post(evt({ sessionId: sid, eventName: name,
      attribution: { utm_campaign: CAMP, utm_content: extra.content ?? 'creative_a' } }));

  // 4 sessions land; 2 click CTA (one clicks TWICE — the raw-vs-unique trap); 1 stores.
  const s = [uuid(), uuid(), uuid(), uuid()];
  for (const sid of s) await stage(sid, 'landing_page_view');
  await stage(s[0], 'initial_cta_click');
  await stage(s[0], 'initial_cta_click');   // same session, second CTA tap
  await stage(s[1], 'initial_cta_click');
  await stage(s[0], 'lead_modal_open');
  await stage(s[0], 'lead_form_start');
  await stage(s[0], 'lead_form_submit');
  await stage(s[0], 'lead_form_stored');
  await stage(s[0], 'calendly_redirect');

  const sum = run('admin.funnelSummary', { hours: 1, utmCampaign: CAMP });
  t('raw CTA count includes the repeat tap', sum.rawCounts.initial_cta_click === 3,
    String(sum.rawCounts.initial_cta_click));
  t('unique CTA sessions does NOT', sum.uniqueSessions.initial_cta_click === 2,
    String(sum.uniqueSessions.initial_cta_click));
  t('landing sessions counted', sum.uniqueSessions.landing_page_view === 4);
  t('landing -> CTA uses unique sessions (2/4 = 50%)', sum.conversion['landing -> CTA'] === 50,
    String(sum.conversion['landing -> CTA']));
  t('CTA -> modal (1/2 = 50%)', sum.conversion['CTA -> modal'] === 50);
  t('modal -> form start (1/1 = 100%)', sum.conversion['modal -> form start'] === 100);
  t('landing -> stored lead (1/4 = 25%)', sum.conversion['landing -> stored lead'] === 25);
  t('totalSessions is distinct sessions', sum.totalSessions === 4, String(sum.totalSessions));

  const other = run('admin.funnelSummary', { hours: 1, utmCampaign: 'a_campaign_that_does_not_exist' });
  t('an unmatched campaign filter yields an empty funnel', other.totalEvents === 0);
  t('empty stages report null, not a misleading 0%', other.conversion['landing -> CTA'] === null);

  const bd = run('admin.funnelBreakdown', { hours: 1, groupBy: 'utmCampaign' });
  const mine = bd.groups.find((g) => g.group === CAMP);
  t('funnelBreakdown groups by campaign', !!mine && mine.uniqueSessions.landing_page_view === 4);
  t('funnelBreakdown computes landing -> stored', mine.landingToStoredPct === 25,
    String(mine && mine.landingToStoredPct));
}

/* ══ browser half: real page, real endpoint ═══════════════════════ */
const b = await chromium.launch();
const openPage = async (route) => {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => { fails++; console.log('FAIL  page error: ' + e); });
  await p.route('https://calendly.com/**', (r) =>
    r.fulfill({ status: 200, contentType: 'text/html', body: 'calendly stub' }));

  // The page navigates away to Calendly at the end of the funnel, which destroys any
  // in-page capture array. Mirror dataLayer pushes out to Node so they survive.
  p.__dl = [];
  await p.exposeFunction('__mirrorDl', (o) => { p.__dl.push(o); });
  await p.addInitScript(() => {
    window.dataLayer = [];
    const push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function (o) {
      try { window.__mirrorDl(JSON.parse(JSON.stringify(o))); } catch (e) {}
      return push(o);
    };
  });
  if (route) await route(p);

  // site/index.html's own <head> hardcodes the PRODUCTION lead endpoint, and that script
  // runs AFTER addInitScript — so seeding ADSCADE_LEAD_ENDPOINT alone is overwritten, and
  // landing_page_view (which fires during page scripts) would be sent to production.
  // ADSCADE_TRACK_ENDPOINT is the documented override the page checks first and never
  // reassigns, so it survives. The lead endpoint is repointed after load, before any
  // submission happens.
  await p.addInitScript((u) => { window.ADSCADE_TRACK_ENDPOINT = u; }, TRACK);
  await p.goto(ORIGIN + '/index.html');
  await p.evaluate((u) => { window.ADSCADE_LEAD_ENDPOINT = u; }, BASE + '/submit-lead');
  await p.waitForTimeout(900);
  return p;
};
// The session id must be captured while we are still ON the landing page: after the
// Calendly redirect, sessionStorage belongs to calendly.com and reads back null.
const readSid = async (p) => await p.evaluate(() => sessionStorage.getItem('adscade_sid'));
const sessionRows = (sid) => {
  const rows = run('funnel.listEvents', { limit: 200 }).filter((r) => r.sessionId === sid);
  return { sid, rows, names: rows.map((r) => r.eventName) };
};

console.log('\n— M/N/O. real browser funnel —');
{
  run('funnel.purgeAllEvents');
  const p = await openPage();
  const SID = await readSid(p);            // captured before any navigation
  let st = sessionRows(SID);
  t('M. landing_page_view fires once on load',
    st.names.filter((n) => n === 'landing_page_view').length === 1, st.names.join(','));
  t('a session id was created', /^[A-Za-z0-9-]{8,64}$/.test(SID || ''), String(SID));

  // Re-firing track() for a once-only stage must not create a second row.
  await p.evaluate(() => window.adscadeTrack('landing_page_view', null, true));
  await p.waitForTimeout(600);
  st = sessionRows(SID);
  t('M. a repeat landing_page_view is suppressed by the once guard',
    st.names.filter((n) => n === 'landing_page_view').length === 1);

  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.waitForTimeout(800);
  st = sessionRows(SID);
  t('N. initial_cta_click recorded', st.names.includes('initial_cta_click'));
  t('O. lead_modal_open recorded and distinct from CTA click', st.names.includes('lead_modal_open'));
  t('O. lead_form_start not yet fired (no field touched)', !st.names.includes('lead_form_start'));
  const cta = st.rows.find((r) => r.eventName === 'initial_cta_click');
  t('N. CTA text captured', cta && typeof cta.ctaText === 'string' && cta.ctaText.length > 0,
    cta && cta.ctaText);

  await p.fill('#name', 'Funnel Test');
  await p.waitForTimeout(700);
  st = sessionRows(SID);
  t('O. lead_form_start fires on first field interaction', st.names.includes('lead_form_start'));

  await p.fill('#email', 'funnel@adscade-test.com');
  await p.fill('#phone', '9845011223');
  await p.waitForTimeout(700);
  st = sessionRows(SID);
  t('O. typing more does NOT emit repeated lead_form_start rows',
    st.names.filter((n) => n === 'lead_form_start').length === 1,
    String(st.names.filter((n) => n === 'lead_form_start').length));

  await p.check('input[name="inventory"][value="50_99"]');
  await p.check('input[name="media_budget"][value="aed_15000_30000"]');
  await p.check('#consent');
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(3500);

  st = sessionRows(SID);
  t('lead_form_submit recorded', st.names.includes('lead_form_submit'));
  t('lead_form_stored recorded', st.names.includes('lead_form_stored'));
  t('calendly_redirect recorded', st.names.includes('calendly_redirect'));
  t('redirected to Calendly', /calendly\.com/.test(p.url()), p.url());

  const stored = st.rows.find((r) => r.eventName === 'lead_form_stored');
  t('submissionId attached once the modal has opened',
    stored && typeof stored.submissionId === 'string' && stored.submissionId.length >= 8);
  t('every row shares one sessionId', new Set(st.rows.map((r) => r.sessionId)).size === 1);
  t('no telemetry row carries lead PII',
    !/Funnel Test|funnel@adscade-test|9845011223|aed_15000_30000/.test(JSON.stringify(st.rows)));
  t('attribution captured on telemetry rows',
    stored && Object.prototype.hasOwnProperty.call(stored, 'landingPage'));
  await p.close();
}

/* ── endpoint derivation must fail closed ─────────────────────────── */
console.log('\n— endpoint derivation —');
{
  const ctx = await b.newContext();
  const pg = await ctx.newPage();
  await pg.goto(ORIGIN + '/index.html');
  const derive = async (lead) => await pg.evaluate((l) => {
    const prevTrack = window.ADSCADE_TRACK_ENDPOINT;
    const prevLead = window.ADSCADE_LEAD_ENDPOINT;
    window.ADSCADE_TRACK_ENDPOINT = undefined;
    window.ADSCADE_LEAD_ENDPOINT = l;
    // Exercised through the page's own function, not a copy of the logic.
    const out = window.__adscadeTrackEndpoint ? window.__adscadeTrackEndpoint() : null;
    window.ADSCADE_TRACK_ENDPOINT = prevTrack;
    window.ADSCADE_LEAD_ENDPOINT = prevLead;
    return out;
  }, lead);

  t('derives /track-event from a real lead endpoint',
    (await derive('https://x.convex.site/submit-lead')) === 'https://x.convex.site/track-event');
  t('tolerates a trailing slash',
    (await derive('https://x.convex.site/submit-lead/')) === 'https://x.convex.site/track-event');
  // The important one: a blind .replace() would return '/stub' unchanged and POST funnel
  // events at the LEAD endpoint.
  t('an unrecognised endpoint disables telemetry rather than posting to the lead endpoint',
    (await derive('/stub')) === '');
  t('an empty endpoint disables telemetry', (await derive('')) === '');
  await pg.close();
}

/* ── L: telemetry failure must not break the funnel ───────────────── */
console.log('\n— L. telemetry failure never blocks the funnel —');
{
  const p = await openPage(async (pg) => {
    // Every telemetry call fails at the network layer; the lead path is untouched.
    await pg.route('**/track-event', (r) => r.abort());
  });
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.waitForTimeout(400);
  t('modal still opens', await p.evaluate(() => !document.getElementById('lead-modal').hidden));
  await p.fill('#name', 'Telemetry Down');
  await p.fill('#email', 'down@adscade-test.com');
  await p.fill('#phone', '9845011224');
  await p.check('input[name="inventory"][value="1_19"]');
  await p.check('input[name="media_budget"][value="below_aed_5000"]');
  await p.check('#consent');
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(3500);
  t('lead still submits and redirects to Calendly with telemetry dead',
    /calendly\.com/.test(p.url()), p.url());
  await p.close();
}

/* ── Q: existing GTM/dataLayer events still fire ──────────────────── */
console.log('\n— Q. existing dataLayer events are untouched —');
{
  const p = await openPage();
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.fill('#name', 'DataLayer Check');
  await p.fill('#email', 'dl@adscade-test.com');
  await p.fill('#phone', '9845011225');
  await p.check('input[name="inventory"][value="20_49"]');
  await p.check('input[name="media_budget"][value="above_aed_30000"]');
  await p.check('#consent');
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(3500);
  const dl = p.__dl;   // mirrored to Node; survives the Calendly navigation
  const names = dl.map((e) => e.event);
  for (const want of ['landing_page_view','initial_cta_click','lead_modal_open',
                      'lead_form_start','lead_form_submit','lead_form_stored','calendly_redirect']) {
    t(`dataLayer still receives ${want}`, names.includes(want), names.join(','));
  }
  t('dataLayer events still carry attribution',
    dl.length > 0 && Object.prototype.hasOwnProperty.call(dl[0], 'utm_source'));
  t('dataLayer carries no PII',
    !/DataLayer Check|dl@adscade-test|9845011225/.test(JSON.stringify(dl)));
  await p.close();
}

await b.close();
run('funnel.purgeAllEvents');
console.log(fails ? `\n${fails} FAILED\n` : '\nall funnel telemetry tests passed\n');
process.exit(fails ? 1 : 0);
