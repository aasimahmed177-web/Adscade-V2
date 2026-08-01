#!/usr/bin/env node
/* Acceptance checks for the client's explicit sign-off list (31 Jul 2026 brief).
   Deliberately separate from score.mjs: these are the client's words turned into
   assertions, not the design harness. */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const html = readFileSync('site/index.html', 'utf8');
const b = await chromium.launch();
let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const page = async (w = 390, h = 844) => {
  const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  p.on('pageerror', e => { fails++; console.log('FAIL  page error: ' + e); });
  await p.goto('file://' + process.cwd() + '/site/index.html');
  await p.waitForTimeout(400);
  return p;
};
const stubOK = p => p.evaluate(() => {
  window.ADSCADE_LEAD_ENDPOINT = '/stub';
  window.__reloaded = false;
  window.addEventListener('beforeunload', () => { window.__reloaded = true; });
  // stored:true is what unlocks the calendar — a bare {ok:true} must NOT.
  window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, stored: true, submissionId: 's-1' }) });
});
const fill = async p => {
  await p.fill('#name', 'Rajesh Kumar');
  await p.fill('#email', 'rajesh@kumardev.in');
  await p.fill('#phone', '9876543210');
  await p.check('input[name="inventory"][value="100_plus"]');
  await p.check('input[name="media_budget"][value="above_5l"]');
  await p.check('#consent');
};

console.log('\n── documentation & slug ──');
// exclude this file: it contains the retired slug as a literal in the assertion below,
// and a check that fails on its own source is a check nobody will trust
const docs = execSync(
  'grep -rn "vsl-[0-9]" docs/ site/ tools/ 2>/dev/null | grep -v "tools/acceptance.mjs" || true'
).toString();
t('no documentation refers to /vsl-5/', !docs.includes('vsl-5'), docs.match(/vsl-5/g)?.join(',') || '');
t('documentation refers to /vsl-4/', docs.includes('vsl-4'));
t('canonical points at /vsl-4/', /rel="canonical" href="https:\/\/adscade\.com\/vsl-4\/"/.test(html));
t('og:url points at /vsl-4/', /og:url" content="https:\/\/adscade\.com\/vsl-4\/"/.test(html));
// The only slugs in the page are metadata. No behaviour may branch on the URL.
const slugInJs = /location\.(pathname|href)\s*[.=!]==?\s*['"`]\/vsl/.test(html)
              || /pathname\.(includes|indexOf|match)\(\s*['"`]\/vsl/.test(html);
t('no page functionality branches on the slug', !slugInJs);

console.log('\n── privacy policy matches the build ──');
const priv = readFileSync('site/privacy.html', 'utf8');
t('privacy lists the five fields and no more',
  /Your name/.test(priv) && /work email/i.test(priv) && /WhatsApp or phone/i.test(priv) &&
  /residential units/i.test(priv) && /advertising budget range/i.test(priv));
t('privacy no longer claims six qualifying questions', !/six qualif/i.test(priv));
t('privacy no longer claims to collect city or business name',
  !/micro-market you sell in/i.test(priv) && !/name and business name/i.test(priv));
t('privacy states the phone number is passed to Calendly',
  /name, email address and phone number are passed to Calendly/i.test(priv));
t('privacy states there is no automatic assessment', /no scoring/i.test(priv));

console.log('\n── the form is exactly five fields + consent ──');
let p = await page();
const names = await p.$$eval('#lead-form [name]',
  e => [...new Set(e.map(x => x.name))].filter(n => n !== 'hp_ref'));
t('exactly [name,email,phone,inventory,media_budget,consent]',
  JSON.stringify(names.slice().sort()) ===
  JSON.stringify(['consent','email','inventory','media_budget','name','phone']),
  names.join(','));
t('consent is required and unchecked',
  await p.evaluate(() => { const c = document.getElementById('consent');
    return c.type === 'checkbox' && !c.checked && c.hasAttribute('required'); }));

console.log('\n── no scoring, no disqualification ──');
t('no evaluator function is exposed',
  await p.evaluate(() => typeof window.__adscadeEvaluate === 'undefined'));
t('no outcome/disqualification markup',
  await p.evaluate(() => !document.querySelector('#done-qualified,#done-review,#done-nofit,.dq')));
t('no scoring vocabulary in source', !/not_current_fit|manual_review|score_band|__adscadeEvaluate/.test(html));

console.log('\n── CTA behaviour ──');
const before = await p.$$eval('.cta:not([type=submit]):not([data-keep-label]), .js-cta:not([data-keep-label])',
  e => e.filter(x => !x.closest('#lead-modal')).map(x => x.textContent.trim()));
t(`all CTAs start as "Tell Us About Your Project" (${before.length})`,
  before.length >= 3 && before.every(x => x === 'Tell Us About Your Project'));
t('Calendly hidden before storage', await p.evaluate(() => document.getElementById('schedule').hidden));
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
t('initial CTA opens the modal', await p.evaluate(() => !document.getElementById('lead-modal').hidden));
await p.keyboard.press('Escape');

console.log('\n── failed storage must not grant Calendly access ──');
const pf = await page();
await pf.evaluate(() => { window.ADSCADE_LEAD_ENDPOINT = '/stub';
  window.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }); });
await pf.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await fill(pf);
await pf.click('#lead-form button[type=submit]');
await pf.waitForTimeout(700);
t('storage failure leaves Calendly hidden',
  await pf.evaluate(() => document.getElementById('schedule').hidden));
t('storage failure keeps the original CTA label',
  (await pf.$eval('.js-cta:not([data-keep-label])', e => e.textContent.trim())) === 'Tell Us About Your Project');
t('storage failure shows a retryable error',
  await pf.evaluate(() => document.getElementById('submit-err').classList.contains('invalid')
    && !document.querySelector('#lead-form button[type=submit]').disabled));
await pf.close();

console.log('\n── successful storage grants Calendly access ──');
p = await page();
await stubOK(p);
await p.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, 1400); });
await p.waitForTimeout(200);
const y0 = await p.evaluate(() => window.scrollY);
const url0 = p.url();
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await fill(p);
await p.click('#lead-form button[type=submit]');
await p.waitForTimeout(900);

const st = await p.evaluate(() => ({
  scheduleShown: !document.getElementById('schedule').hidden,
  modalClosed: document.getElementById('lead-modal').hidden,
  y: window.scrollY, reloaded: window.__reloaded,
  labels: [...document.querySelectorAll('.cta:not([type=submit]):not([data-keep-label]), .js-cta:not([data-keep-label])')]
    .filter(e => !e.closest('#lead-modal')).map(e => e.textContent.trim()),
}));
t('every stored submission is offered Calendly', st.scheduleShown);
t('modal closes on success', st.modalClosed);
t('every CTA becomes "Choose a Time"',
  st.labels.length >= 3 && st.labels.every(x => x === 'Choose a Time'), st.labels.join('|'));
t('no reload or redirect', !st.reloaded && p.url() === url0);
t(`scroll position preserved (${y0} → ${st.y})`, Math.abs(st.y - y0) < 40);

await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(200);
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await p.waitForTimeout(1500);
t('updated CTA scrolls to the Calendly section', await p.evaluate(() => {
  const r = document.getElementById('schedule').getBoundingClientRect();
  return r.top < window.innerHeight && r.bottom > 0;
}));
t('modal does not reopen after storage',
  await p.evaluate(() => document.getElementById('lead-modal').hidden));

console.log('\n── the header shortcut keeps a stable label ──');
{
  const ph = await page();
  const h0 = await ph.evaluate(() => Math.round(document.querySelector('.brandbar').getBoundingClientRect().height));
  await ph.evaluate(() => {
    window.ADSCADE_LEAD_ENDPOINT = '/stub';
    window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, stored: true }) });
  });
  await ph.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(ph);
  await ph.click('#lead-form button[type=submit]');
  await ph.waitForTimeout(900);
  const h1 = await ph.evaluate(() => Math.round(document.querySelector('.brandbar').getBoundingClientRect().height));
  // A repainted header pill wraps to two lines and moves the whole page under the reader.
  t('header height is unchanged by the CTA state change', h0 === h1, `${h0} → ${h1}`);
  t('header pill keeps its own short label',
    (await ph.$eval('.brandbar__fit', e => e.textContent.trim())) === 'Book a call');
  await ph.close();
}

console.log('\n── idempotency key is stable across retries ──');
{
  const pr = await page();
  await pr.evaluate(() => {
    window.ADSCADE_LEAD_ENDPOINT = '/stub';
    window.__ids = [];
    let n = 0;
    window.fetch = async (u, o) => {
      window.__ids.push(JSON.parse(o.body).submissionId);
      n++;
      if (n === 1) throw new Error('network');          // first attempt fails
      return { ok: true, json: async () => ({ ok: true, stored: true }) };
    };
  });
  await pr.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(pr);
  await pr.click('#lead-form button[type=submit]');
  await pr.waitForTimeout(700);
  await pr.click('#lead-form button[type=submit]');     // retry
  await pr.waitForTimeout(900);
  const ids = await pr.evaluate(() => window.__ids);
  t('a retry reuses the same submissionId', ids.length === 2 && ids[0] === ids[1], ids.join(' | '));
  await pr.close();
}

console.log('\n── no second video, no second page ──');
const media = await p.$$eval('video, iframe[src*="youtube"], iframe[src*="vimeo"], .vsl',
  e => e.map(x => x.tagName + '.' + (x.className || '')));
t('exactly one VSL region', (await p.$$('.vsl')).length === 1, media.join(','));
t('no second landing page in site/',
  execSync('ls site/*.html').toString().trim().split('\n').sort().join(',') ===
  'site/brand-guidelines.html,site/index.html,site/privacy.html,site/terms.html');
t('one Calendly mount only', (await p.$$('#cal, .cal')).length <= 2 && (await p.$$('#schedule')).length === 1);

console.log('\n── images placed as directed ──');
for (const [img, sect] of [
  ['residential.webp', 'leak'], ['before-after.webp', 'compare'],
  ['pipeline.webp', 'report'], ['asim-ahmed.webp', 'founder'],
]) {
  const where = await p.evaluate(i => {
    const el = document.querySelector(`img[src*="${i}"]`);
    if (!el) return null;
    const s = el.closest('section'); return (s && (s.id || s.className)) || 'no-section';
  }, img);
  t(`${img} is placed`, where !== null, `section: ${where}`);
}

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall acceptance checks passed\n');
process.exit(fails ? 1 : 0);
