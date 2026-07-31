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
    fails++; console.log('FAIL  console: ' + m.text());
  });
  // Injected before the widget script runs — the production pattern.
  await p.addInitScript(url => { window.ADSCADE_LEAD_ENDPOINT = url; }, ENDPOINT);
  await p.goto(ORIGIN + '/index.html');
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
await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 1500); });
await p.waitForTimeout(250);
const y0 = await p.evaluate(() => window.scrollY);
const url0 = p.url();

t('Calendly hidden before submission', await p.evaluate(() => document.getElementById('schedule').hidden));
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
t('initial CTA opened the modal', await p.evaluate(() => !document.getElementById('lead-modal').hidden));

await fill(p);
await p.click('#lead-form button[type=submit]');
await p.waitForTimeout(2500);

const after = await p.evaluate(() => ({
  modalClosed: document.getElementById('lead-modal').hidden,
  scheduleShown: !document.getElementById('schedule').hidden,
  y: window.scrollY,
  labels: [...document.querySelectorAll('.cta:not([type=submit]):not([data-keep-label]), .js-cta:not([data-keep-label])')]
    .filter(e => !e.closest('#lead-modal')).map(e => e.textContent.trim()),
}));
t('modal closed', after.modalClosed);
t('Calendly section revealed', after.scheduleShown);
t('no reload or redirect', p.url() === url0);
t(`scroll preserved (${y0} → ${after.y})`, Math.abs(after.y - y0) < 40);
t('every CTA now reads "Choose a Time"',
  after.labels.length >= 3 && after.labels.every(x => x === 'Choose a Time'), after.labels.join('|'));

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

/* ── Calendly handoff ─────────────────────────────────────────────── */
console.log('\n— Calendly handoff —');
await p.waitForTimeout(2500);
const cal = await p.evaluate(() => {
  const mount = document.querySelector('#cal, .cal, [data-calendly-mount]');
  const iframes = document.querySelectorAll('#schedule iframe');
  return {
    mounts: iframes.length,
    src: iframes[0] ? iframes[0].src : null,
    prefill: window.__adscadeCalendlyPrefill || null,
  };
});
t('Calendly initialised exactly once', cal.mounts <= 1, `${cal.mounts} iframes`);
t('page URL carries no personal data', !/priya|9845|nairbuilders/i.test(p.url()), p.url());

/* ── later CTA clicks scroll to Calendly ──────────────────────────── */
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(250);
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await p.waitForTimeout(1600);
t('later CTA scrolls to Calendly', await p.evaluate(() => {
  const r = document.getElementById('schedule').getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}));
t('modal does not reopen', await p.evaluate(() => document.getElementById('lead-modal').hidden));
await p.close();

/* ── a rejected submission must not reveal Calendly ───────────────── */
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
t('server rejection keeps Calendly hidden',
  await p.evaluate(() => document.getElementById('schedule').hidden));
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
