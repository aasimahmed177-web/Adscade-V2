#!/usr/bin/env node
/* Real HTTP tests against a running Convex deployment — no mocks, no stubs.
   Usage: node tools/convex-api.mjs [siteUrl]
   Defaults to CONVEX_SITE_URL from .env.local (the local dev deployment). */
import { readFileSync } from 'fs';

let base = process.argv[2];
if (!base) {
  try {
    const env = readFileSync('.env.local', 'utf8');
    base = (env.match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
  } catch { /* none */ }
}
if (!base) { console.error('No site URL. Pass one, or set CONVEX_SITE_URL in .env.local'); process.exit(2); }
const URL_ = base.replace(/\/$/, '') + '/submit-lead';
console.log(`\ntesting ${URL_}\n`);

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };
const uuid = () => crypto.randomUUID();

const base_payload = (over = {}) => ({
  submissionId: uuid(),
  timestamp: new Date().toISOString(),
  name: 'Rajesh Kumar',
  email: 'rajesh@kumardev.in',
  phone: '9876543210',
  activeInventory: '100_plus',
  monthlyMediaBudget: 'above_5l',
  consent: true,
  website: '',
  landingPage: 'https://adscade.com/vsl-4/',
  referrer: 'https://www.youtube.com/',
  device: 'mobile',
  attribution: {
    utm_source: 'youtube', utm_medium: 'cpc', utm_campaign: 'carrying-cost',
    utm_content: null, utm_term: null, gclid: 'Cj0KTest123',
    landing_path: '/vsl-4/', referrer: 'https://www.youtube.com/',
  },
  ...over,
});

const post = (body, headers = {}) => fetch(URL_, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

/* ── happy path ───────────────────────────────────────────────────── */
console.log('— storage —');
const goodId = uuid();
let r = await post(base_payload({ submissionId: goodId }));
let j = await r.json();
t('valid submission stores', r.status === 200 && j.ok === true && j.stored === true, JSON.stringify(j));
t('response carries the submissionId back', j.submissionId === goodId);
t('response leaks no internal id', !('_id' in j) && !('id' in j), Object.keys(j).join(','));

/* ── idempotency ──────────────────────────────────────────────────── */
console.log('\n— idempotency —');
const r2 = await post(base_payload({ submissionId: goodId }));
const j2 = await r2.json();
t('same submissionId returns duplicate', r2.status === 200 && j2.ok === true && j2.duplicate === true, JSON.stringify(j2));
t('duplicate still reports stored:true', j2.stored === true);

/* ── validation ───────────────────────────────────────────────────── */
console.log('\n— validation —');
for (const [label, over, field] of [
  ['missing name',            { name: '' },                       'name'],
  ['invalid email',           { email: 'not-an-email' },          'email'],
  ['email without dot',       { email: 'a@b' },                   'email'],
  ['invalid phone',           { phone: '12345' },                 'phone'],
  ['unknown inventory',       { activeInventory: 'ALL_OF_THEM' }, 'activeInventory'],
  ['unknown budget',          { monthlyMediaBudget: 'loads' },    'monthlyMediaBudget'],
  ['consent false',           { consent: false },                 'consent'],
  ['consent truthy string',   { consent: 'yes' },                 'consent'],
  ['bad submissionId',        { submissionId: 'x' },              'submissionId'],
]) {
  const res = await post(base_payload(over));
  const body = await res.json();
  t(`rejects ${label}`, res.status === 422 && body.ok === false &&
    body.code === 'validation_error' && body.fields.includes(field),
    `${res.status} ${JSON.stringify(body)}`);
}

console.log('\n— phone formats accepted —');
for (const [label, phone] of [
  ['10-digit', '9876543210'], ['91-prefixed', '919876543210'],
  ['0-prefixed', '09876543210'], ['+91 spaced', '+91 98765 43210'],
  ['international', '+442071838750'],
]) {
  const res = await post(base_payload({ phone }));
  const body = await res.json();
  t(`accepts ${label}`, res.status === 200 && body.stored === true, `${res.status} ${JSON.stringify(body)}`);
}

/* ── abuse & malformed ────────────────────────────────────────────── */
console.log('\n— abuse and malformed input —');
let res = await post(base_payload({ website: 'http://spam.example' }));
let body = await res.json();
t('honeypot returns ok but stored:false', res.status === 200 && body.ok === true && body.stored === false,
  JSON.stringify(body));

res = await post('{not json');
t('malformed JSON → 400 malformed_body', res.status === 400 && (await res.json()).code === 'malformed_body');

res = await post('[]');
t('JSON array → 400 malformed_body', res.status === 400 && (await res.json()).code === 'malformed_body');

res = await post(base_payload({ name: 'x'.repeat(9000) }));
t('oversized body → 413', res.status === 413, String(res.status));

res = await post(base_payload({ score: 87 }));
t('client-supplied score → 400', res.status === 400 && (await res.json()).code === 'malformed_body');

res = await post(base_payload({ status: 'booked' }));
t('client-supplied status → 400', res.status === 400 && (await res.json()).code === 'malformed_body');

res = await fetch(URL_, { method: 'GET' });
// The Convex router only dispatches the methods registered for the path, so a GET is
// refused at 404 before the action runs. The in-action method check is belt-and-braces.
t('GET is refused', res.status === 404 || res.status === 405, String(res.status));
t('GET body is not a lead response', !(await res.text()).includes('"stored"'));

/* ── CORS ─────────────────────────────────────────────────────────── */
console.log('\n— CORS —');
const pre = await fetch(URL_, { method: 'OPTIONS', headers: { Origin: 'https://adscade.com' } });
t('OPTIONS preflight → 204', pre.status === 204, String(pre.status));
t('preflight allows adscade.com', pre.headers.get('access-control-allow-origin') === 'https://adscade.com',
  String(pre.headers.get('access-control-allow-origin')));
t('preflight sets Vary: Origin', /origin/i.test(pre.headers.get('vary') || ''), String(pre.headers.get('vary')));
t('preflight allows POST, OPTIONS', pre.headers.get('access-control-allow-methods') === 'POST, OPTIONS');
t('preflight allows Content-Type', pre.headers.get('access-control-allow-headers') === 'Content-Type');
t('preflight caches for 86400', pre.headers.get('access-control-max-age') === '86400');

for (const origin of ['https://adscade.com', 'https://www.adscade.com']) {
  const rr = await post(base_payload(), { Origin: origin });
  t(`POST echoes allowed origin ${origin}`,
    rr.headers.get('access-control-allow-origin') === origin,
    String(rr.headers.get('access-control-allow-origin')));
}
for (const origin of ['https://evil.example', 'http://adscade.com', 'https://adscade.com.evil.example', 'null']) {
  const rr = await post(base_payload(), { Origin: origin });
  t(`POST refuses origin ${origin}`, rr.headers.get('access-control-allow-origin') === null,
    String(rr.headers.get('access-control-allow-origin')));
}
t('never returns a wildcard origin',
  (await post(base_payload(), { Origin: 'https://adscade.com' })).headers.get('access-control-allow-origin') !== '*');

const errCors = await post(base_payload({ email: 'bad' }), { Origin: 'https://adscade.com' });
t('error responses also carry CORS headers',
  errCors.headers.get('access-control-allow-origin') === 'https://adscade.com');

console.log(fails ? `\n${fails} FAILED\n` : '\nall Convex API tests passed\n');
process.exit(fails ? 1 : 0);
