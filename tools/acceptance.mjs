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
t('privacy states the phone is NOT passed to Calendly',
  /phone number is not passed to Calendly/i.test(priv));
t('privacy states the visitor is redirected to Calendly',
  /redirect(ed)? to Calendly/i.test(priv));
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
t(`all CTAs start as "Contact Us" (${before.length})`,
  before.length >= 3 && before.every(x => x === 'Contact Us'));
t('no scheduling section exists on the page', await p.evaluate(() => !document.getElementById('schedule')));
await p.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
t('initial CTA opens the modal', await p.evaluate(() => !document.getElementById('lead-modal').hidden));
await p.keyboard.press('Escape');

console.log('\n── failed storage must not hand off to Calendly ──');
const pf = await page();
await pf.evaluate(() => { window.ADSCADE_LEAD_ENDPOINT = '/stub';
  window.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }); });
await pf.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
await fill(pf);
const pfUrl = pf.url();
await pf.click('#lead-form button[type=submit]');
await pf.waitForTimeout(900);
t('storage failure does not redirect', pf.url() === pfUrl && !/calendly/.test(pf.url()));
t('storage failure keeps the modal open',
  await pf.evaluate(() => !document.getElementById('lead-modal').hidden));
t('storage failure shows a retryable error',
  await pf.evaluate(() => document.getElementById('submit-err').classList.contains('invalid')
    && !document.querySelector('#lead-form button[type=submit]').disabled));
await pf.close();

console.log('\n── successful storage hands off to Calendly ──');
{
  const ps = await page();
  await ps.route('https://calendly.com/**', r =>
    r.fulfill({ status: 200, contentType: 'text/html', body: 'stub' }));
  await stubOK(ps);
  await ps.evaluate(() => document.querySelector('.js-cta:not([data-keep-label])').click());
  await fill(ps);
  await ps.click('#lead-form button[type=submit]');
  await ps.waitForTimeout(2500);
  const u = new URL(ps.url());
  t('redirects to the configured Calendly event',
    u.origin + u.pathname === 'https://calendly.com/aasim-ahmed177/realestate-growth-systems',
    u.origin + u.pathname);
  t('name and email are prefilled',
    u.searchParams.get('name') === 'Rajesh Kumar' && u.searchParams.get('email') === 'rajesh@kumardev.in');
  t('the phone number is not in the redirect URL',
    !/9876543210/.test(decodeURIComponent(ps.url())) && u.searchParams.get('phone') === null);
  await ps.close();
}

console.log('\n── no second video, no second page ──');
// CHANGED 18 Aug 2026: the client replaced the VSL (never-filmed placeholder video) with
// a static, art-directed hero image. There is no .vsl class or video element to find any
// more — that is the point. What must still be true: no video reappeared anywhere, and
// there is exactly one hero visual region.
const media = await p.$$eval('video, iframe[src*="youtube"], iframe[src*="vimeo"]',
  e => e.map(x => x.tagName + '.' + (x.className || '')));
t('no video element anywhere on the page', media.length === 0, media.join(','));
t('exactly one hero visual region', (await p.$$('.hero-media')).length === 1);
t('no second landing page in site/',
  execSync('ls site/*.html').toString().trim().split('\n').sort().join(',') ===
  'site/brand-guidelines.html,site/index.html,site/privacy.html,site/terms.html');
t('no inline Calendly mount remains', (await p.$$('#calendly-mount, .cal, #schedule')).length === 0);

console.log('\n── images placed as directed ──');
for (const [img, sect] of [
  ['residential.webp', 'leak'], ['before-after.webp', 'compare'],
  ['pipeline.webp', 'report'], ['adscade-founder-desktop.webp', 'founder'],
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
