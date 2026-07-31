#!/usr/bin/env node
/* Behavioural tests for the modal → storage → Calendly flow.
   integrity.mjs checks the page is built correctly; this checks it works. */
import { chromium } from 'playwright';

const b = await chromium.launch();
let fails = 0;
const t = (n, c) => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n); };
const URL = 'file://' + process.cwd() + '/site/index.html';

const OK_STUB = `async () => ({ok:true, json: async()=>({ok:true, stored:true, submissionId:'s-1'})})`;

async function page(width = 1280, height = 900) {
  const p = await (await b.newContext({ viewport: { width, height } })).newPage();
  p.on('pageerror', e => { fails++; console.log('FAIL  page error: ' + e); });
  await p.goto(URL); await p.waitForTimeout(400);
  return p;
}
async function stub(p, impl = OK_STUB) {
  await p.evaluate(f => {
    window.ADSCADE_LEAD_ENDPOINT = '/stub';
    window.__posted = [];
    const inner = new Function('return ' + f)();
    window.fetch = async (u, o) => { if (o && o.body) window.__posted.push(JSON.parse(o.body)); return inner(); };
  }, impl);
}
async function fill(p, over = {}) {
  await p.fill('#name',  over.name  ?? 'Rajesh Kumar');
  await p.fill('#email', over.email ?? 'rajesh@kumardev.in');
  await p.fill('#phone', over.phone ?? '9876543210');
  await p.check(`input[name="inventory"][value="${over.inventory ?? '100_plus'}"]`);
  await p.check(`input[name="media_budget"][value="${over.budget ?? 'above_5l'}"]`);
  if (over.consent !== false) await p.check('#consent');
}

/* ── initial CTA state ────────────────────────────────────────────── */
let p = await page();
const initial = await p.$$eval('.cta:not([type=submit]):not([data-next]):not([data-back]), .js-cta',
  els => els.filter(e => !e.closest('#lead-modal')).map(e => e.textContent.trim()));
t(`all CTAs start as "Tell Us About Your Project" (${initial.length} found)`,
  initial.length >= 3 && initial.every(x => x === 'Tell Us About Your Project'));
t('modal is closed on load', await p.evaluate(() => document.getElementById('lead-modal').hidden));
t('Calendly section is hidden on load', await p.evaluate(() => document.getElementById('schedule').hidden));

/* ── every CTA opens the same modal ───────────────────────────────── */
const ctaCount = await p.evaluate(() =>
  [...document.querySelectorAll('.cta, .js-cta')].filter(e => !e.closest('#lead-modal') && !e.closest('.dock')).length);
for (let i = 0; i < ctaCount; i++) {
  await p.evaluate(i => {
    const list = [...document.querySelectorAll('.cta, .js-cta')].filter(e => !e.closest('#lead-modal') && !e.closest('.dock'));
    list[i].click();
  }, i);
  const open = await p.evaluate(() => !document.getElementById('lead-modal').hidden);
  if (!open) { fails++; console.log(`FAIL  CTA #${i} did not open the modal`); }
  await p.keyboard.press('Escape');
}
t(`every one of ${ctaCount} CTAs opens the modal`, true);

/* ── modal accessibility ──────────────────────────────────────────── */
await p.evaluate(() => document.querySelector('.js-cta').click());
t('dialog semantics present', await p.evaluate(() => {
  const d = document.querySelector('#lead-modal .modal__panel');
  return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true'
      && !!document.getElementById(d.getAttribute('aria-labelledby'));
}));
t('background scroll is locked', await p.evaluate(() => document.body.classList.contains('modal-open')));
t('focus starts inside the modal', await p.evaluate(() => document.querySelector('#lead-modal').contains(document.activeElement)));

// focus trap: tab past the last control and stay inside
await p.evaluate(() => {
  const f = [...document.querySelectorAll('#lead-modal .modal__panel button, #lead-modal input, #lead-modal a')]
    .filter(e => e.offsetParent !== null);
  f[f.length - 1].focus();
});
await p.keyboard.press('Tab');
t('focus is trapped inside the modal', await p.evaluate(() =>
  document.getElementById('lead-modal').contains(document.activeElement)));

await p.keyboard.press('Escape');
t('Escape closes the modal', await p.evaluate(() => document.getElementById('lead-modal').hidden));
t('scroll lock released on close', await p.evaluate(() => !document.body.classList.contains('modal-open')));
t('focus returns to the CTA that opened it', await p.evaluate(() =>
  document.activeElement && document.activeElement.classList.contains('js-cta')));

await p.evaluate(() => document.querySelector('.js-cta').click());
await p.click('#lead-modal .modal__x');
t('close button closes the modal', await p.evaluate(() => document.getElementById('lead-modal').hidden));

/* ── validation ───────────────────────────────────────────────────── */
await p.evaluate(() => document.querySelector('.js-cta').click());
await p.click('#lead-form button[type=submit]');
t('empty form blocks submit', await p.evaluate(() => !document.getElementById('lead-modal').hidden));
t('field errors shown', await p.evaluate(() => document.querySelectorAll('.field.invalid').length >= 3));
t('both question groups flagged', await p.evaluate(() =>
  document.querySelectorAll('[data-radio-err].invalid').length === 2));
t('consent flagged', await p.evaluate(() => document.getElementById('consent-err').classList.contains('invalid')));

await fill(p, { email: 'not-an-email' });
await p.click('#lead-form button[type=submit]');
t('invalid email blocks submit', await p.evaluate(() =>
  document.getElementById('email').closest('.field').classList.contains('invalid')));

/* ── phone formats ────────────────────────────────────────────────── */
for (const [label, val, want] of [
  ['10-digit Indian',      '9876543210',      true],
  ['91-prefixed, no plus', '919876543210',    true],
  ['0-prefixed',           '09876543210',     true],
  ['+91 with spaces',      '+91 98765 43210', true],
  ['international',        '+442071838750',   true],
  ['too short',            '12345',           false],
]) {
  await p.fill('#email', 'rajesh@kumardev.in');
  await p.fill('#phone', val);
  await p.click('#lead-form button[type=submit]');
  const invalid = await p.evaluate(() => document.getElementById('phone').closest('.field').classList.contains('invalid'));
  t(`phone accepted: ${label}`, invalid !== want);
  if (want) break; // the first valid one submits; re-open below
}

/* ── failed storage must never reveal Calendly ────────────────────── */
for (const [label, impl] of [
  ['no endpoint configured', null],
  ['400', `async () => ({ok:false, status:400, json: async()=>({ok:false})})`],
  ['422', `async () => ({ok:false, status:422, json: async()=>({ok:false})})`],
  ['429', `async () => ({ok:false, status:429, json: async()=>({ok:false})})`],
  ['500', `async () => ({ok:false, status:500, json: async()=>({ok:false})})`],
  ['network failure', `async () => { throw new Error('network'); }`],
  ['malformed JSON',  `async () => ({ok:true, json: async()=>{ throw new SyntaxError('bad'); }})`],
  ['ok:false body',   `async () => ({ok:true, json: async()=>({ok:false})})`],
  // The honeypot path returns a 200 that looks successful. It must fail exactly like a
  // server error, or a bot submission would open the calendar and book real time.
  ['honeypot stored:false', `async () => ({ok:true, json: async()=>({ok:true, stored:false, submissionId:null})})`],
  ['ok:true but stored missing', `async () => ({ok:true, json: async()=>({ok:true})})`],
]) {
  p = await page();
  if (impl) await stub(p, impl);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await fill(p);
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(600);
  const r = await p.evaluate(() => ({
    err: document.getElementById('submit-err').classList.contains('invalid'),
    modalOpen: !document.getElementById('lead-modal').hidden,
    scheduleHidden: document.getElementById('schedule').hidden,
    ctaLabel: document.querySelector('.js-cta').textContent.trim(),
    retryable: !document.querySelector('#lead-form button[type=submit]').disabled,
  }));
  t(`${label} → error, modal stays open, no Calendly, retryable`,
    r.err && r.modalOpen && r.scheduleHidden && r.ctaLabel === 'Tell Us About Your Project' && r.retryable);
  await p.close();
}

/* ── successful storage ───────────────────────────────────────────── */
p = await page();
await stub(p);
// scroll-behavior:smooth animates scrollTo, so disable it before measuring or the
// reading is taken mid-animation and the assertion tests the animation, not the page
await p.evaluate(() => {
  document.documentElement.style.scrollBehavior = 'auto';
  window.dataLayer = []; window.scrollTo(0, 1200);
});
await p.waitForTimeout(200);
const scrollBefore = await p.evaluate(() => window.scrollY);
await p.evaluate(() => document.querySelector('.js-cta').click());
await fill(p);
await p.click('#lead-form button[type=submit]');
await p.waitForTimeout(900);

const after = await p.evaluate(() => ({
  modalHidden:  document.getElementById('lead-modal').hidden,
  scheduleShown:!document.getElementById('schedule').hidden,
  successShown: !document.getElementById('cta-success').hidden,
  scrollY:      window.scrollY,
  labels: [...document.querySelectorAll('.cta, .js-cta')]
            .filter(e => !e.closest('#lead-modal')).map(e => e.textContent.trim()),
  state: window.__adscadeState(),
}));
t('modal closes on success', after.modalHidden);
t('Calendly section revealed', after.scheduleShown);
t('success message shown', after.successShown);
t(`scroll position preserved (${scrollBefore} → ${after.scrollY})`, Math.abs(after.scrollY - scrollBefore) < 40);
t('every CTA becomes "Choose a Time"', after.labels.length >= 3 && after.labels.every(x => x === 'Choose a Time'));
t('no page reload — state survives in memory', after.state.leadStored === true);

const posted = (await p.evaluate(() => window.__posted))[0];
t('payload carries the five answers + consent',
  !!posted.name && !!posted.email && !!posted.phone &&
  posted.activeInventory === '100_plus' && posted.monthlyMediaBudget === 'above_5l' && posted.consent === true);
t('payload carries submissionId, attribution and device',
  !!posted.submissionId && !!posted.attribution && !!posted.device);
t('no score anywhere in the payload',
  !/score|qualified|outcome/i.test(JSON.stringify(posted)));

const ev = await p.evaluate(() => (window.dataLayer || []).map(e => e.event));
t('lead_form_stored fired', ev.includes('lead_form_stored'));
t('no qualification events remain', !ev.some(e => /qualification|score/.test(e)));
t('no PII in dataLayer', !/Rajesh|rajesh@|9876543210/.test(JSON.stringify(await p.evaluate(() => window.dataLayer))));

/* ── post-submission CTA scrolls to Calendly ──────────────────────── */
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(200);
await p.evaluate(() => document.querySelector('.js-cta').click());
await p.waitForTimeout(1500);   // scrollIntoView({behavior:'smooth'}) ignores the root override
t('CTA after submission scrolls to Calendly', await p.evaluate(() => {
  const r = document.getElementById('schedule').getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}));
t('modal does not reopen after submission', await p.evaluate(() => document.getElementById('lead-modal').hidden));

/* ── double submission ────────────────────────────────────────────── */
const p2 = await page();
await stub(p2, `async () => { await new Promise(r=>setTimeout(r,300)); return {ok:true, json: async()=>({ok:true, stored:true})}; }`);
await p2.evaluate(() => document.querySelector('.js-cta').click());
await fill(p2);
await p2.evaluate(() => {
  const b = document.querySelector('#lead-form button[type=submit]');
  b.click(); b.click(); b.click();
});
await p2.waitForTimeout(900);
t('double click sends exactly one request', (await p2.evaluate(() => window.__posted.length)) === 1);
await p2.close();

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
