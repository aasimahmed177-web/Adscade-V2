#!/usr/bin/env node
/* POST /submit-content-lead — brokerage_content_engine (VSL-5) intake.

   Real HTTP against a running Convex deployment, and real reads of what landed in the
   database. No stubs: a test that only checks the response body cannot tell whether the
   row was actually written, which offer it was filed under, or whether the Sheets mirror
   was queued.

   Covers the brief's content-endpoint requirements 1-13, plus the things that only
   matter because a SECOND offer now shares this table:
     - the full 4x2 qualification matrix, not just the three named cases
     - international phone handling (a bare number must NOT become +91)
     - /submit-lead still refuses content payloads (VSL-4 strictness preserved)
     - telemetry rejects the new content answers as PII

   Prereqs: `npx convex dev` running.
*/
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const SITE = (readFileSync('.env.local', 'utf8').match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
if (!SITE) { console.error('CONVEX_SITE_URL missing — is `npx convex dev` running?'); process.exit(2); }
const BASE = SITE.replace(/\/$/, '');
const CONTENT = BASE + '/submit-content-lead';
const ACQUIRE = BASE + '/submit-lead';
const TRACK = BASE + '/track-event';

const run = (fn, args) => {
  const out = execSync(`npx convex run --no-push internal.${fn} '${JSON.stringify(args ?? {})}'`,
    { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  return out ? JSON.parse(out) : null;
};

const PREFIX = 'content-test-';
const sid = () => PREFIX + Math.random().toString(36).slice(2) + Date.now().toString(36);

const body = (over = {}) => ({
  submissionId: sid(),
  timestamp: new Date().toISOString(),
  offer: 'brokerage_content_engine',
  name: 'Test Broker',
  email: 'broker@example.com',
  companyName: 'Test Brokerage LLC',
  phone: '+971501234567',
  teamSize: '5_9',
  monthlyShoot: 'yes',
  consent: true,
  hp_ref: '',
  landingPage: 'https://adscade.com/vsl-5-2/',
  referrer: null,
  device: 'desktop',
  attribution: { utm_source: 'google', utm_campaign: 'content_test', gclid: 'g-content' },
  ...over,
});

const post = (payload, { url = CONTENT, headers = {} } = {}) => fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://adscade.com', ...headers },
  body: typeof payload === 'string' ? payload : JSON.stringify(payload),
});

const leadBySubmissionId = (submissionId) => {
  const all = run('admin.listLeads', { limit: 200 });
  return all.find((l) => l.submissionId === submissionId) ?? null;
};

console.log(`\ncontent endpoint: ${CONTENT}\n`);
run('admin.purgeBySubmissionIdPrefix', { prefix: PREFIX });

/* ── 1-3: the three named qualification cases ─────────────────────── */
console.log('— 1-3. server-side qualification —');
{
  const cases = [
    { teamSize: '5_9', monthlyShoot: 'yes', expect: true, label: '5_9 + yes' },
    { teamSize: '1_4', monthlyShoot: 'yes', expect: false, label: '1_4 + yes' },
    { teamSize: '10_19', monthlyShoot: 'no', expect: false, label: '10_19 + no' },
  ];
  for (const c of cases) {
    const b = body({ teamSize: c.teamSize, monthlyShoot: c.monthlyShoot });
    const r = await post(b);
    const j = await r.json();
    t(`${c.label} -> stored`, r.status === 200 && j.ok === true && j.stored === true,
      `${r.status} ${JSON.stringify(j)}`);
    t(`${c.label} -> server says qualified=${c.expect}`, j.qualified === c.expect,
      JSON.stringify(j));
    const row = leadBySubmissionId(b.submissionId);
    t(`${c.label} -> verdict persisted on the row`, row?.contentQualified === c.expect,
      String(row?.contentQualified));
  }
}

/* ── the full matrix, not just the named cases ────────────────────── */
console.log('\n— qualification matrix (4 team sizes x 2 shoot answers) —');
{
  for (const teamSize of ['1_4', '5_9', '10_19', '20_plus']) {
    for (const monthlyShoot of ['yes', 'no']) {
      const expect = ['5_9', '10_19', '20_plus'].includes(teamSize) && monthlyShoot === 'yes';
      const j = await (await post(body({ teamSize, monthlyShoot }))).json();
      t(`${teamSize} + ${monthlyShoot} -> ${expect}`, j.qualified === expect,
        JSON.stringify(j));
    }
  }
}

/* ── 4-6, 9: enum / required-field validation ─────────────────────── */
console.log('\n— 4-6, 9. field validation —');
{
  const bad = [
    ['invalid team size', { teamSize: 'three_ish' }, 'teamSize'],
    ['missing team size', { teamSize: undefined }, 'teamSize'],
    ['invalid monthlyShoot', { monthlyShoot: 'maybe' }, 'monthlyShoot'],
    ['boolean monthlyShoot', { monthlyShoot: true }, 'monthlyShoot'],
    ['missing companyName', { companyName: undefined }, 'companyName'],
    ['blank companyName', { companyName: '   ' }, 'companyName'],
    ['missing name', { name: '' }, 'name'],
    ['consent false', { consent: false }, 'consent'],
    ['consent truthy-but-not-true', { consent: 'yes' }, 'consent'],
    ['bad submissionId', { submissionId: 'short' }, 'submissionId'],
  ];
  for (const [label, over, field] of bad) {
    const b = body(over);
    if (over.teamSize === undefined && 'teamSize' in over) delete b.teamSize;
    if (over.companyName === undefined && 'companyName' in over) delete b.companyName;
    const r = await post(b);
    const j = await r.json();
    t(`rejects ${label}`,
      r.status === 422 && j.code === 'validation_error' && (j.fields || []).includes(field),
      `${r.status} ${JSON.stringify(j)}`);
  }
}

/* ── 7-8: email and phone ─────────────────────────────────────────── */
console.log('\n— 7-8. email and phone —');
{
  for (const email of ['not-an-email', 'a@b', 'two@@at.com', 'spaced @example.com', '']) {
    const r = await post(body({ email }));
    const j = await r.json();
    t(`rejects email ${JSON.stringify(email)}`,
      r.status === 422 && (j.fields || []).includes('email'), `${r.status}`);
  }
  for (const phone of ['123', 'abcdefgh', '', '+', '1'.repeat(20)]) {
    const r = await post(body({ phone }));
    const j = await r.json();
    t(`rejects phone ${JSON.stringify(phone)}`,
      r.status === 422 && (j.fields || []).includes('phone'), `${r.status}`);
  }
  for (const email of ['broker@example.com', 'first.last+tag@sub.example.co.uk']) {
    const r = await post(body({ email }));
    t(`accepts email ${email}`, r.status === 200, String(r.status));
  }
}

/* ── phone normalisation: international, never assuming +91 ───────── */
console.log('\n— phone normalisation is country-aware, never +91 by default —');
{
  const cases = [
    ['+971501234567', '+971501234567', 'UAE, explicit +'],
    ['+971 50 123 4567', '+971501234567', 'UAE with spaces'],
    ['00971501234567', '+971501234567', 'ITU 00 prefix becomes +'],
    ['+919876543210', '+919876543210', 'India, explicit + is preserved'],
    ['+44 7700 900123', '+447700900123', 'UK, explicit +'],
  ];
  for (const [input, expected, label] of cases) {
    const b = body({ phone: input });
    const r = await post(b);
    const row = r.status === 200 ? leadBySubmissionId(b.submissionId) : null;
    t(`${label}: ${input} -> ${expected}`, row?.normalisedPhone === expected,
      `${r.status} ${row?.normalisedPhone}`);
  }

  // The regression this endpoint exists to avoid. VSL-4 maps a bare 10-digit number to
  // +91; doing that to a Gulf brokerage would silently corrupt every match and every
  // outbound message while looking perfectly valid in the Sheet.
  for (const bare of ['0501234567', '9876543210', '501234567']) {
    const b = body({ phone: bare });
    const r = await post(b);
    const row = leadBySubmissionId(b.submissionId);
    t(`bare ${bare} is stored without an invented country code`,
      r.status === 200 && row?.normalisedPhone === bare.replace(/\D/g, '') &&
      !row?.normalisedPhone.startsWith('+'),
      `${r.status} ${row?.normalisedPhone}`);
  }
  {
    const b = body({ phone: '+971 50 123 4567' });
    await post(b);
    t('raw phone is preserved exactly as the visitor typed it',
      leadBySubmissionId(b.submissionId)?.phone === '+971 50 123 4567',
      leadBySubmissionId(b.submissionId)?.phone);
  }
}

/* ── 10: idempotency ──────────────────────────────────────────────── */
console.log('\n— 10. idempotency by submissionId —');
{
  const before = run('admin.countLeads');
  const b = body({ teamSize: '20_plus', monthlyShoot: 'yes' });
  const a1 = await (await post(b)).json();
  const a2 = await (await post(b)).json();
  const a3 = await (await post(b)).json();
  t('first submit is not a duplicate', a1.duplicate === undefined && a1.stored === true);
  t('second submit reports duplicate', a2.duplicate === true, JSON.stringify(a2));
  t('third submit reports duplicate', a3.duplicate === true);
  t('only one row was created', run('admin.countLeads') === before + 1,
    `${before} -> ${run('admin.countLeads')}`);
  t('a duplicate returns the SAME verdict, not a recomputed one',
    a2.qualified === a1.qualified && a1.qualified === true);
  t('a duplicate re-queues the Sheets mirror',
    leadBySubmissionId(b.submissionId)?.googleSheetsSyncStatus === 'pending');
}

/* ── 11: origin discipline ────────────────────────────────────────── */
console.log('\n— 11. origin discipline —');
{
  for (const o of ['https://evil.example', 'http://adscade.com', 'https://adscade.com.evil.example']) {
    const r = await post(body(), { headers: { Origin: o } });
    t(`refuses origin ${o}`, r.status === 403 && (await r.json()).code === 'forbidden_origin',
      String(r.status));
  }
  const ok = await post(body(), { headers: { Origin: 'https://adscade.com' } });
  t('allows https://adscade.com and echoes it',
    ok.status === 200 && ok.headers.get('access-control-allow-origin') === 'https://adscade.com');
  t('never returns a wildcard', ok.headers.get('access-control-allow-origin') !== '*');
  t('sets Vary: Origin', (ok.headers.get('vary') || '').toLowerCase().includes('origin'));

  const www = await post(body(), { headers: { Origin: 'https://www.adscade.com' } });
  t('allows https://www.adscade.com', www.status === 200);

  const pre = await fetch(CONTENT, { method: 'OPTIONS', headers: { Origin: 'https://adscade.com' } });
  t('OPTIONS preflight works',
    pre.status === 204 && pre.headers.get('access-control-allow-origin') === 'https://adscade.com',
    String(pre.status));

  const get = await fetch(CONTENT, { method: 'GET' });
  t('GET is refused', get.status === 404 || get.status === 405, String(get.status));
}

/* ── 12: body size and transport ──────────────────────────────────── */
console.log('\n— 12. body size and content type —');
{
  const huge = await post(body({ companyName: 'x'.repeat(9000) }));
  t('rejects an oversized body', huge.status === 413, String(huge.status));

  const wrongType = await post(body(), { headers: { 'Content-Type': 'text/plain' } });
  t('rejects text/plain (no CORS-simple-request bypass)', wrongType.status === 415,
    String(wrongType.status));

  const malformed = await post('{not json');
  t('rejects malformed JSON', malformed.status === 400, String(malformed.status));

  const arr = await post('[]');
  t('rejects a JSON array body', arr.status === 400, String(arr.status));

  const capped = await post(body({ companyName: 'y'.repeat(150) }));
  t('a long-but-legal companyName is accepted', capped.status === 200, String(capped.status));
}

/* ── 13: the browser may not assert a verdict ─────────────────────── */
console.log('\n— 13. client-supplied verdicts are rejected, not ignored —');
{
  for (const key of ['qualified', 'score', 'outcome', 'status']) {
    const r = await post(body({ [key]: key === 'qualified' ? true : 'anything' }));
    const j = await r.json();
    t(`rejects a payload carrying "${key}"`,
      r.status === 400 && j.code === 'malformed_body', `${r.status} ${JSON.stringify(j)}`);
  }
  // Fail loudly, and write nothing at all.
  const before = run('admin.countLeads');
  await post(body({ qualified: true }));
  t('a rejected verdict payload writes no row', run('admin.countLeads') === before);

  // A lie must not win even when it agrees with the server.
  const b = body({ teamSize: '1_4', monthlyShoot: 'no', qualified: true });
  const r = await post(b);
  t('claiming qualified on an unqualifying answer is still a 400', r.status === 400);
  t('and no row was created for it', leadBySubmissionId(b.submissionId) === null);
}

/* ── the row itself ───────────────────────────────────────────────── */
console.log('\n— what actually lands in the database —');
{
  const b = body({ teamSize: '10_19', monthlyShoot: 'yes', companyName: 'Gulf Estates' });
  await post(b);
  const row = leadBySubmissionId(b.submissionId);
  t('offer is stamped brokerage_content_engine', row?.offer === 'brokerage_content_engine');
  t('companyName stored', row?.companyName === 'Gulf Estates');
  t('teamSize stored', row?.teamSize === '10_19');
  t('monthlyShoot stored', row?.monthlyShoot === 'yes');
  t('contentQualified stored true', row?.contentQualified === true);
  t('acquisition-only fields are absent, not empty strings',
    row?.activeInventory === undefined && row?.monthlyMediaBudget === undefined,
    `${row?.activeInventory} / ${row?.monthlyMediaBudget}`);
  t('calendlyStatus starts not_booked', row?.calendlyStatus === 'not_booked');
  t('Sheets mirror was queued', row?.googleSheetsSyncStatus === 'pending');
  t('createdAt is a server timestamp', typeof row?.createdAt === 'number' &&
    Math.abs(Date.now() - row.createdAt) < 5 * 60 * 1000);
  t('status is submitted', row?.status === 'submitted');
  t('attribution captured', row?.utmSource === 'google' && row?.gclid === 'g-content');
  t('normalisedEmail is lowercased', row?.normalisedEmail === 'broker@example.com');
}

/* ── honeypot: flag, never discard ────────────────────────────────── */
console.log('\n— honeypot flags rather than silently discarding —');
{
  const b = body({ hp_ref: 'http://spam.example' });
  const r = await post(b);
  const row = leadBySubmissionId(b.submissionId);
  t('a tripped honeypot still stores the application', r.status === 200 && row !== null);
  t('and marks it suspect for separate review', row?.status === 'suspect', row?.status);
}

/* ── spreadsheet formula neutralisation ───────────────────────────── */
console.log('\n— spreadsheet formula neutralisation —');
{
  const b = body({ companyName: '=HYPERLINK("http://evil","click")', name: '+cmd|calc' });
  await post(b);
  const row = leadBySubmissionId(b.submissionId);
  t('companyName beginning with = is neutralised', row?.companyName.startsWith("'="),
    row?.companyName);
  t('name beginning with + is neutralised', row?.name.startsWith("'+"), row?.name);
}

/* ── VSL-4 must not have been loosened ────────────────────────────── */
console.log('\n— regression: /submit-lead is unchanged —');
{
  const acq = {
    submissionId: sid(),
    name: 'Developer Co',
    email: 'dev@example.com',
    phone: '9876543210',
    activeInventory: '50_99',
    monthlyMediaBudget: 'aed_5000_15000',
    consent: true,
    attribution: { gclid: 'g1', gbraid: 'gb1', wbraid: 'wb1' },
  };
  const r = await post(acq, { url: ACQUIRE });
  t('acquisition lead still stores', r.status === 200 && (await r.json()).stored === true);
  const row = leadBySubmissionId(acq.submissionId);
  t('acquisition rows are stamped real_estate_acquisition',
    row?.offer === 'real_estate_acquisition', row?.offer);
  t('VSL-4 phone rule is untouched: bare 10-digit still becomes +91',
    row?.normalisedPhone === '+919876543210', row?.normalisedPhone);

  const legacy = { ...acq, submissionId: sid(), monthlyMediaBudget: '3_5l' };
  t('legacy INR budget key still accepted',
    (await post(legacy, { url: ACQUIRE })).status === 200);
  t('and normalised to the AED key',
    leadBySubmissionId(legacy.submissionId)?.monthlyMediaBudget === 'aed_15000_30000');

  // The whole point of two endpoints: neither can loosen the other.
  const contentAtAcquire = await post(
    { submissionId: sid(), name: 'X', email: 'x@example.com', phone: '9876543210',
      companyName: 'C', teamSize: '5_9', monthlyShoot: 'yes', consent: true },
    { url: ACQUIRE },
  );
  const caj = await contentAtAcquire.json();
  t('/submit-lead refuses a content payload',
    contentAtAcquire.status === 422 &&
    (caj.fields || []).includes('activeInventory') &&
    (caj.fields || []).includes('monthlyMediaBudget'),
    JSON.stringify(caj));

  const acqAtContent = await post(acq, { url: CONTENT });
  const acj = await acqAtContent.json();
  t('/submit-content-lead refuses an acquisition payload',
    acqAtContent.status === 422 &&
    (acj.fields || []).includes('companyName') &&
    (acj.fields || []).includes('teamSize'),
    JSON.stringify(acj));
}

/* ── telemetry: offer routing and the new PII keys ────────────────── */
console.log('\n— telemetry: offer discriminator and PII rejection —');
{
  const ev = (over = {}) => ({
    eventId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    eventName: 'landing_page_view',
    clientTimestamp: Date.now(),
    device: 'mobile',
    landingPage: 'https://adscade.com/vsl-5-2/',
    attribution: { utm_campaign: 'content_test' },
    ...over,
  });
  const track = (b) => fetch(TRACK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://adscade.com' },
    body: JSON.stringify(b),
  });

  const withOffer = await track(ev({ offer: 'brokerage_content_engine' }));
  t('accepts offer=brokerage_content_engine', withOffer.status === 200, String(withOffer.status));

  const noOffer = await track(ev());
  t('an absent offer is still accepted (VSL-4 pages send none)', noOffer.status === 200);

  const badOffer = await track(ev({ offer: 'dubai_brokerage_content_engine' }));
  const bj = await badOffer.json();
  t('rejects an unrecognised offer rather than misfiling it',
    badOffer.status === 422 && bj.code === 'unknown_offer', `${badOffer.status} ${JSON.stringify(bj)}`);

  t('accepts the new lead_qualified stage',
    (await track(ev({ eventName: 'lead_qualified', offer: 'brokerage_content_engine' }))).status === 200);

  // The content answers are lead data. They must be refused here as loudly as name/email.
  for (const key of ['companyName', 'company_name', 'company', 'teamSize', 'team_size',
                     'monthlyShoot', 'monthly_shoot']) {
    const r = await track(ev({ [key]: 'should-never-be-accepted' }));
    const j = await r.json();
    t(`telemetry rejects "${key}"`,
      r.status === 400 && j.code === 'pii_rejected' && (j.fields || []).includes(key),
      `${r.status} ${JSON.stringify(j)}`);
  }
}

/* ── funnelSummary can separate the two funnels ───────────────────── */
console.log('\n— funnelSummary separates the offers —');
{
  run('funnel.purgeAllEvents');
  const track = (b) => fetch(TRACK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://adscade.com' },
    body: JSON.stringify(b),
  });
  const stage = (sessionId, eventName, offer) => track({
    eventId: crypto.randomUUID(), sessionId, eventName, offer,
    clientTimestamp: Date.now(), landingPage: 'https://adscade.com/x/',
    attribution: { utm_campaign: 'split_test' },
  });

  // 2 content sessions land, 1 qualifies and redirects; 3 acquisition sessions land.
  const c1 = crypto.randomUUID(), c2 = crypto.randomUUID();
  for (const s of [c1, c2]) await stage(s, 'landing_page_view', 'brokerage_content_engine');
  await stage(c1, 'lead_form_stored', 'brokerage_content_engine');
  await stage(c1, 'lead_qualified', 'brokerage_content_engine');
  await stage(c1, 'calendly_redirect', 'brokerage_content_engine');
  for (let i = 0; i < 3; i++) {
    await stage(crypto.randomUUID(), 'landing_page_view', 'real_estate_acquisition');
  }

  const content = run('admin.funnelSummary', { hours: 1, offer: 'brokerage_content_engine' });
  const acq = run('admin.funnelSummary', { hours: 1, offer: 'real_estate_acquisition' });
  const all = run('admin.funnelSummary', { hours: 1 });

  t('content offer sees exactly its own 2 landing sessions',
    content.uniqueSessions.landing_page_view === 2, JSON.stringify(content.uniqueSessions));
  t('acquisition offer sees exactly its own 3', acq.uniqueSessions.landing_page_view === 3);
  t('unfiltered sees all 5', all.uniqueSessions.landing_page_view === 5);
  t('offersSeen lists both', all.offersSeen.length === 2, JSON.stringify(all.offersSeen));

  t('the qualification step appears for the content funnel',
    content.conversion['stored -> qualified'] === 100,
    JSON.stringify(content.conversion));
  t('and is omitted for a funnel that has no gate',
    acq.conversion['stored -> qualified'] === undefined,
    JSON.stringify(Object.keys(acq.conversion)));

  const byOffer = run('admin.funnelBreakdown', { hours: 1, groupBy: 'offer' });
  t('funnelBreakdown can group by offer', byOffer.groups.length === 2,
    JSON.stringify(byOffer.groups.map((g) => g.group)));

  run('funnel.purgeAllEvents');
}

/* ── cleanup ──────────────────────────────────────────────────────── */
console.log('\n— cleanup —');
{
  const purged = run('admin.purgeBySubmissionIdPrefix', { prefix: PREFIX });
  t('test rows removed', typeof purged === 'number', String(purged));
}

console.log(fails === 0
  ? '\nall content endpoint tests passed\n'
  : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
