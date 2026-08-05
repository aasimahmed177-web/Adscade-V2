#!/usr/bin/env node
/* The final funnel: CTA → modal → Convex → redirect to Calendly.
   Covers the 17 points of the redirect brief at every required width. */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const html = readFileSync('site/index.html', 'utf8');
const CAL = 'https://calendly.com/aasim-ahmed177/realestate-growth-systems';
const b = await chromium.launch();
let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

/* A page whose navigations are captured instead of followed, so the redirect target can
   be asserted without actually leaving for calendly.com. */
async function open(width = 390, height = 844, query = '') {
  const ctx = await b.newContext({ viewport: { width, height } });
  const p = await ctx.newPage();
  // The page navigates to Calendly on success, taking window state with it. Mirror the
  // two things the assertions need into Node so they survive the hand-off.
  p.__posts = 0;
  p.__events = [];
  p.__payloads = [];
  await p.exposeFunction('__mirrorPost', body => { p.__posts++; p.__payloads.push(body); });
  await p.exposeFunction('__mirrorEvent', e => { p.__events.push(e); });
  await p.addInitScript(() => {
    // Capture dataLayer pushes at the source rather than reading the array afterwards.
    window.dataLayer = [];
    const nativePush = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function (obj) {
      try { window.__mirrorEvent(JSON.parse(JSON.stringify(obj))); } catch (e) { /* ignore */ }
      return nativePush(obj);
    };
  });
  p.on('pageerror', e => { fails++; console.log('FAIL  page error: ' + e); });
  p.on('console', m => {
    if (m.type() !== 'error') return;
    if (/Failed to load resource/i.test(m.text())) return;
    // The page's own [Adscade] diagnostics are deliberate on every failure path.
    if (/^\[Adscade\]/.test(m.text())) return;
    fails++; console.log('FAIL  console: ' + m.text());
  });
  await p.route('https://calendly.com/**', route => {
    route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>calendly stub</body></html>' });
  });
  await p.goto('file://' + process.cwd() + '/site/index.html' + query);
  await p.waitForTimeout(400);
  return p;
}
const stub = (p, impl) => p.evaluate(f => {
  window.ADSCADE_LEAD_ENDPOINT = '/stub';
  const inner = new Function('return ' + f)();
  window.fetch = async (u, o) => { window.__mirrorPost(o && o.body ? o.body : ''); return inner(); };
}, impl);
const OK = `async () => ({ok:true, json: async()=>({ok:true, stored:true, submissionId:'s-1'})})`;
const p_posts = p => p.__posts;

async function fill(p, over = {}) {
  await p.fill('#name',  over.name  ?? 'Rajesh Kumar');
  await p.fill('#email', over.email ?? 'rajesh@kumardev.in');
  await p.fill('#phone', over.phone ?? '9876543210');
  await p.check(`input[name="inventory"][value="${over.inv ?? '100_plus'}"]`);
  await p.check(`input[name="media_budget"][value="${over.bud ?? 'above_5l'}"]`);
  await p.check('#consent');
}

/* ── 13/14/15: nothing from the old same-page flow survives ───────── */
console.log('— the old inline flow is gone —');
t('13. no inline Calendly embed code',
  !/initInlineWidget|assets\.calendly\.com\/assets\/external|calendly-mount/.test(html));
t('13. no calendar_view event', !/track\(\s*['"`]calendar_view/.test(html));
t('13. no booked_call event on this page', !/track\(\s*['"`]booked_call/.test(html));
t('14. no "Choose a Time" state', !/['"`]Choose a Time['"`]/.test(html));
t('14. no scheduling section markup', !/id="schedule"/.test(html));
t('15. no scoring or disqualification',
  !/__adscadeEvaluate|not_current_fit|manual_review|score_band/.test(html));
t('redirect uses location.assign, not window.open',
  /window\.location\.assign\(/.test(html) && !/window\.open\(/.test(html));

/* ── 1/2/3/4: modal contract at every width ──────────────────────── */
console.log('\n— modal contract —');
for (const [w, h] of [[360,800],[375,812],[390,844],[430,932],[768,1024],[1440,900]]) {
  const p = await open(w, h);
  const ctas = await p.$$eval('.cta:not([type=submit]):not([data-keep-label]), .js-cta:not([data-keep-label])',
    els => els.filter(e => !e.closest('#lead-modal')).map(e => e.textContent.trim()));
  const allSame = ctas.length >= 3 && ctas.every(x => x === 'Tell Us About Your Project');

  // every CTA must open the SAME modal
  const total = await p.evaluate(() =>
    [...document.querySelectorAll('.cta, .js-cta')].filter(e => !e.closest('#lead-modal')).length);
  let allOpen = true;
  for (let i = 0; i < total; i++) {
    await p.evaluate(i => {
      const list = [...document.querySelectorAll('.cta, .js-cta')].filter(e => !e.closest('#lead-modal'));
      list[i].click();
    }, i);
    if (!(await p.evaluate(() => !document.getElementById('lead-modal').hidden))) allOpen = false;
    await p.keyboard.press('Escape');
    await p.waitForTimeout(80);
  }
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  const st = await p.evaluate(() => {
    const names = [...new Set([...document.querySelectorAll('#lead-form [name]')].map(e => e.name))]
      .filter(n => n !== 'hp_ref');
    return {
      names: names.sort().join(','),
      inv: [...document.querySelectorAll('input[name="inventory"]')].filter(x => x.checked).length,
      bud: [...document.querySelectorAll('input[name="media_budget"]')].filter(x => x.checked).length,
      consent: document.getElementById('consent').checked,
    };
  });
  const label = `${w}x${h}`.padEnd(9);
  t(`${label} 1. every CTA opens the same modal (${total})`, allOpen);
  t(`${label} 1. all CTAs read "Tell Us About Your Project"`, allSame, ctas.join('|'));
  t(`${label} 2. exactly five fields + consent`,
    st.names === 'consent,email,inventory,media_budget,name,phone', st.names);
  t(`${label} 3. no default radio answer`, st.inv === 0 && st.bud === 0);
  t(`${label} 4. consent starts unchecked`, st.consent === false);
  await p.close();
}

/* ── 5: phone formats ─────────────────────────────────────────────── */
console.log('\n— 5. phone formats —');
for (const [label, phone, ok] of [
  ['10-digit Indian', '9876543210', true],
  ['91-prefixed', '919876543210', true],
  ['0-prefixed', '09876543210', true],
  ['+91 spaced', '+91 98765 43210', true],
  ['international', '+442071838750', true],
  ['too short', '12345', false],
]) {
  const p = await open();
  // A request that never settles: a phone the client accepts must reach the network and
  // leave the page in place, so the field can still be inspected. With a resolving stub
  // the page would have already redirected and #phone would no longer exist.
  await stub(p, `async () => new Promise(() => {})`);
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p, { phone });
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(700);
  const invalid = await p.evaluate(() =>
    document.getElementById('phone').closest('.field').classList.contains('invalid'));
  t(`${label} ${ok ? 'accepted' : 'rejected'}`,
    invalid !== ok && (ok ? p_posts(p) === 1 : p_posts(p) === 0),
    `invalid=${invalid} posted=${p_posts(p)}`);
  await p.close();
}

/* ── 6/7: every failure keeps the visitor on the page ─────────────── */
console.log('\n— 6/7. failure never redirects —');
for (const [label, impl] of [
  ['no endpoint configured', null],
  ['400', `async () => ({ok:false, status:400, json: async()=>({ok:false, code:'malformed_body'})})`],
  ['422 validation', `async () => ({ok:false, status:422, json: async()=>({ok:false, code:'validation_error', fields:['email']})})`],
  ['429', `async () => ({ok:false, status:429, json: async()=>({ok:false})})`],
  ['500 write failure', `async () => ({ok:false, status:500, json: async()=>({ok:false, code:'server_error'})})`],
  ['network / CORS error', `async () => { throw new TypeError('Failed to fetch'); }`],
  ['timeout', `async () => { const e = new Error('abort'); e.name = 'AbortError'; throw e; }`],
  ['invalid JSON', `async () => ({ok:true, json: async()=>{ throw new SyntaxError('bad'); }})`],
  ['ok:false body', `async () => ({ok:true, json: async()=>({ok:false})})`],
  ['bot/honeypot stored:false', `async () => ({ok:true, json: async()=>({ok:true, stored:false, submissionId:null})})`],
]) {
  const p = await open();
  if (impl) await stub(p, impl);
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p);
  const before = p.url();
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(900);
  const r = await p.evaluate(() => ({
    modalOpen: !document.getElementById('lead-modal').hidden,
    err: document.getElementById('submit-err').classList.contains('invalid'),
    retryable: !document.querySelector('#lead-form button[type=submit]').disabled,
    label: document.querySelector('#lead-form button[type=submit]').textContent.trim(),
    values: document.getElementById('name').value === 'Rajesh Kumar'
         && document.querySelector('input[name="inventory"]:checked')?.value === '100_plus'
         && document.getElementById('consent').checked,
  }));
  t(`${label}: no redirect, modal open, values kept, retryable`,
    p.url() === before && !/calendly\.com/.test(p.url()) &&
    r.modalOpen && r.err && r.retryable && r.values && r.label === 'Continue',
    `url=${p.url() === before ? 'same' : p.url()} modal=${r.modalOpen} err=${r.err} retry=${r.retryable} kept=${r.values}`);
  await p.close();
}

/* ── 8/9/10/11/12: the successful redirect ───────────────────────── */
console.log('\n— 8-12. the redirect —');
{
  const p = await open(390, 844,
    '?utm_source=youtube&utm_medium=cpc&utm_campaign=carrying-cost&utm_term=builder&gclid=CjTest');
  await stub(p, OK);
  const navs = [];
  p.on('framenavigated', f => { if (f === p.mainFrame()) navs.push(f.url()); });

  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p, { name: 'Priya Nair', email: 'Priya@NairBuilders.in', phone: '+91 98450 11223' });
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(2500);

  const finalUrl = p.url();
  const u = new URL(finalUrl);
  t('8. redirected exactly once', navs.length === 1, `${navs.length} navigations`);
  t('9. correct Calendly event URL', u.origin + u.pathname === CAL, u.origin + u.pathname);
  t('10. name prefilled', u.searchParams.get('name') === 'Priya Nair', String(u.searchParams.get('name')));
  t('10. email prefilled', u.searchParams.get('email') === 'Priya@NairBuilders.in');
  t('11. phone absent from the URL',
    !/9845011223|98450|\+91/.test(decodeURIComponent(finalUrl)) && u.searchParams.get('phone') === null);
  t('12. utm_source preserved', u.searchParams.get('utm_source') === 'youtube');
  t('12. utm_medium preserved', u.searchParams.get('utm_medium') === 'cpc');
  t('12. utm_campaign preserved', u.searchParams.get('utm_campaign') === 'carrying-cost');
  t('12. utm_term preserved', u.searchParams.get('utm_term') === 'builder');
  t('12. absent utm_content not invented', u.searchParams.get('utm_content') === null);
  t('gclid not forwarded', u.searchParams.get('gclid') === null);
  const forbidden = ['inventory','media_budget','activeInventory','monthlyMediaBudget',
                     'consent','score','outcome','submissionId','endpoint'];
  t('no sensitive or internal parameters',
    forbidden.every(k => u.searchParams.get(k) === null),
    forbidden.filter(k => u.searchParams.get(k) !== null).join(','));
  await p.close();
}

console.log('\n— redirect with no campaign in the URL —');
{
  const p = await open();
  await stub(p, OK);
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p);
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(2500);
  const u = new URL(p.url());
  t('only name and email are appended',
    [...u.searchParams.keys()].sort().join(',') === 'email,name',
    [...u.searchParams.keys()].join(','));
  await p.close();
}

/* ── 16: double click ─────────────────────────────────────────────── */
console.log('\n— 16. double submission —');
{
  const p = await open();
  await stub(p, `async () => { await new Promise(r=>setTimeout(r,400)); return {ok:true, json: async()=>({ok:true, stored:true})}; }`);
  const navs = [];
  p.on('framenavigated', f => { if (f === p.mainFrame()) navs.push(f.url()); });
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p);
  await p.evaluate(() => {
    const btn = document.querySelector('#lead-form button[type=submit]');
    btn.click(); btn.click(); btn.click();
  });
  await p.waitForTimeout(2500);
  t('16. exactly one POST', p.__posts === 1, String(p.__posts));
  t('16. exactly one redirect', navs.length === 1, `${navs.length}`);
  await p.close();
}

/* ── tracking ─────────────────────────────────────────────────────── */
console.log('\n— tracking —');
{
  const p = await open();
  await stub(p, OK);
  await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(p);
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(2500);
  const dl = p.__events;
  const ev = dl.map(e => e.event);
  for (const want of ['initial_cta_click','lead_modal_open','lead_form_start','lead_form_submit',
                      'lead_form_stored','calendly_redirect']) {
    t(`${want} fired`, ev.includes(want), ev.join(','));
  }
  t('lead_form_stored precedes calendly_redirect',
    ev.indexOf('lead_form_stored') >= 0 && ev.indexOf('lead_form_stored') < ev.indexOf('calendly_redirect'));
  t('no calendar_view or booked_call', !ev.includes('calendar_view') && !ev.includes('booked_call'));
  t('no PII in dataLayer',
    !/Rajesh|rajesh@|9876543210|kumardev/i.test(JSON.stringify(dl)), JSON.stringify(dl).slice(0, 120));
  await p.close();
}

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall redirect-flow tests passed\n');
process.exit(fails ? 1 : 0);
