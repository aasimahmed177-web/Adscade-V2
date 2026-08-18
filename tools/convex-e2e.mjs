#!/usr/bin/env node
/* REAL end-to-end: a real browser, a real HTTP origin, a real Convex backend.
   No fetch stub anywhere in this file — the only thing injected is the endpoint URL,
   exactly as the WordPress header snippet will inject it in production.

   Prereqs: `npx convex dev` running, and the page served at ORIGIN. */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const ORIGIN = process.env.ADSCADE_TEST_ORIGIN || 'http://127.0.0.1:8788';
const SITE = process.argv[2] ||
  (readFileSync('.env.local', 'utf8').match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
const ENDPOINT = SITE.replace(/\/$/, '') + '/submit-lead';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };
const rows = () => JSON.parse(
  execSync('npx convex run --no-push internal.debug.recentLeads 2>/dev/null').toString());
// rows() is capped at 5 by the query — never use its length to count.
const count = () => JSON.parse(
  execSync('npx convex run --no-push internal.debug.countLeads 2>/dev/null').toString());

const b = await chromium.launch();

async function open(width = 390, height = 844) {
  const p = await (await b.newContext({ viewport: { width, height } })).newPage();
  p.on('pageerror', e => { fails++; console.log('FAIL  page error: ' + e); });
  // "Failed to load resource" is the browser logging a non-2xx response. One of the tests
  // below deliberately provokes a 422, so that line is expected noise. A real JavaScript
  // error still fails the run, via the pageerror handler above and this filter.
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/i.test(m.text())) return;
    // The page's own [Adscade] diagnostics are deliberate on every failure path — one of
    // the tests below provokes a real 422 to prove the failure handling works.
    if (/^\[Adscade\]/.test(m.text())) return;
    // Chromium emits this when the stubbed Calendly page loads in a sandboxed context.
    // It comes from the browser, not the page under test.
    if (/requestStorageAccess/i.test(m.text())) return;
    fails++; console.log('FAIL  console: ' + m.text());
  });
  // CHANGED 18 Aug 2026: site/index.html's own <head> now hardcodes the real production
  // endpoint directly (the owner's own paste does this). addInitScript alone no longer
  // wins — it runs before the page's own scripts, so the page's head assignment executes
  // afterward and overwrites it back to production. Set it again after load, since
  // leadEndpoint() reads window.ADSCADE_LEAD_ENDPOINT at call time, not parse time.
  await p.addInitScript(url => { window.ADSCADE_LEAD_ENDPOINT = url; }, ENDPOINT);
  await p.goto(ORIGIN + '/index.html');
  await p.evaluate(url => { window.ADSCADE_LEAD_ENDPOINT = url; }, ENDPOINT);
  await p.waitForTimeout(600);
  return p;
}
async function fill(p, over = {}) {
  await p.fill('#name',  over.name  ?? 'Priya Nair');
  await p.fill('#email', over.email ?? 'priya@nairbuilders.in');
  await p.fill('#phone', over.phone ?? '+91 98450 11223');
  await p.check(`input[name="inventory"][value="${over.inv ?? '50_99'}"]`);
  await p.check(`input[name="media_budget"][value="${over.bud ?? '3_5l'}"]`);
  await p.check('#consent');
}

console.log(`\nbrowser ${ORIGIN}  →  ${ENDPOINT}\n`);

/* ── the required journey, end to end, against the real database ──── */
console.log('— the full journey —');
const before = rows().length ? rows()[0].submissionId : null;
let p = await open();
// Capture the hand-off rather than following it, so the redirect URL can be asserted.
await p.route('https://calendly.com/**', r =>
  r.fulfill({ status: 200, contentType: 'text/html', body: 'calendly stub' }));
const startUrl = p.url();

t('no scheduling section on the page', await p.evaluate(() => !document.getElementById('schedule')));
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
t('initial CTA opened the modal', await p.evaluate(() => !document.getElementById('lead-modal').hidden));

await fill(p);
await p.click('#lead-form button[type=submit]');
await p.waitForTimeout(3000);

const landed = new URL(p.url());
t('redirected away from the landing page', p.url() !== startUrl);
t('redirected to the configured Calendly event',
  landed.origin + landed.pathname === 'https://calendly.com/aasim-ahmed177/realestate-growth-systems',
  landed.origin + landed.pathname);
t('name prefilled', landed.searchParams.get('name') === 'Priya Nair');
t('email prefilled', landed.searchParams.get('email') === 'priya@nairbuilders.in');
t('phone absent from the redirect URL',
  !/9845011223|98450/.test(decodeURIComponent(p.url())) && landed.searchParams.get('phone') === null);

/* ── the lead is really in the database ───────────────────────────── */
console.log('\n— the row in Convex —');
const latest = rows()[0];
t('a new row exists', latest && latest.submissionId !== before);
t('name stored', latest.name === 'Priya Nair', latest.name);
t('email stored and normalised', latest.email === 'priya@nairbuilders.in' &&
  latest.normalisedEmail === 'priya@nairbuilders.in');
t('phone kept as typed', latest.phone === '+91 98450 11223', latest.phone);
t('phone normalised to E.164', latest.normalisedPhone === '+919845011223', latest.normalisedPhone);
t('inventory stored', latest.activeInventory === '50_99', latest.activeInventory);
t('budget stored', latest.monthlyMediaBudget === '3_5l', latest.monthlyMediaBudget);
t('consent stored true', latest.consent === true);
t('status is submitted', latest.status === 'submitted', latest.status);
t('landingPage captured', typeof latest.landingPage === 'string' && latest.landingPage.length > 0);
t('no scoring fields stored',
  !('score' in latest) && !('outcome' in latest) && !('qualified' in latest) &&
  !('disqualificationReason' in latest) && !('manualReview' in latest),
  Object.keys(latest).join(','));

/* ── a rejected submission must not hand off ──────────────────────── */
console.log('\n— real 422 from the real backend —');
const countBefore = count();
p = await open();
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
// An address the CLIENT accepts and the SERVER rejects, so the rejection genuinely comes
// from Convex: the client regex allows any dot-bearing domain, the server additionally
// forbids empty labels. No stubbing — this is a real 422 over the wire.
await fill(p, { email: 'priya@nairbuilders..in' });
await p.click('#lead-form button[type=submit]');
await p.waitForTimeout(2500);
t('server rejection does not redirect', !/calendly\.com/.test(p.url()), p.url());
t('server rejection keeps the modal open',
  await p.evaluate(() => !document.getElementById('lead-modal').hidden));
t('server rejection shows the compact error',
  await p.evaluate(() => document.getElementById('submit-err').classList.contains('invalid')));
t('entered values are preserved',
  await p.evaluate(() => document.getElementById('name').value === 'Priya Nair'
    && document.querySelector('input[name="inventory"]:checked') !== null));
t('retry is possible',
  await p.evaluate(() => !document.querySelector('#lead-form button[type=submit]').disabled));
t('no row was written', count() === countBefore, `${countBefore} → ${count()}`);
await p.close();

/* ── idempotency through the browser ──────────────────────────────── */
console.log('\n— double submit through the real stack —');
const n0 = count();
p = await open();
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await fill(p, { email: 'dupe@nairbuilders.in' });
await p.evaluate(() => {
  const btn = document.querySelector('#lead-form button[type=submit]');
  btn.click(); btn.click(); btn.click();
});
await p.waitForTimeout(3000);
t('three rapid clicks create exactly one lead', count() === n0 + 1, `${n0} → ${count()}`);
await p.close();

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall real end-to-end tests passed\n');
process.exit(fails ? 1 : 0);
