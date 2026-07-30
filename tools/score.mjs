#!/usr/bin/env node
/**
 * AdScade landing page scoring harness — 1000 points.
 *
 * FROZEN. This file is the specification. The autoresearch loop may never edit it.
 * Editing the ruler to make the number go up invalidates the entire run.
 *
 * Usage:  node tools/score.mjs [--json] [--verbose]
 */

import { chromium } from 'playwright';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = join(ROOT, 'site', 'index.html');

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const VERBOSE = args.includes('--verbose');

/* ── scoring bookkeeping ──────────────────────────────────────────── */
const cats = [];
let cur = null;
function category(name, max) { cur = { name, max, earned: 0, checks: [] }; cats.push(cur); }
function check(label, max, pass, note = '') {
  const earned = pass === true ? max : pass === false ? 0 : Math.max(0, Math.min(max, Math.round(pass)));
  cur.earned += earned;
  cur.checks.push({ label, max, earned, note });
}

/* ── helpers ──────────────────────────────────────────────────────── */
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const lc = s => norm(s).toLowerCase();

function srgb(c) { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function lum([r, g, b]) { return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b); }
function contrast(fg, bg) {
  const a = lum(fg), b = lum(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
function parseRGB(s) {
  const m = (s || '').match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(',').map(x => parseFloat(x));
  return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
}

/* ── the run ──────────────────────────────────────────────────────── */
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();

let bytes = 0;
page.on('response', async r => {
  try { const b = await r.body(); bytes += b.length; } catch { /* ignore */ }
});

const consoleErrors = [];
page.on('pageerror', e => consoleErrors.push(String(e)));

await page.goto('file://' + PAGE, { waitUntil: 'load' });
await page.waitForTimeout(700);

const html = readFileSync(PAGE, 'utf8');
const text = norm(await page.evaluate(() => document.body.innerText));
const textL = text.toLowerCase();
const has = (...terms) => terms.every(t => textL.includes(t.toLowerCase()));
const hasAny = (...terms) => terms.some(t => textL.includes(t.toLowerCase()));

/* ══ 1. MESSAGE MATCH & CONGRUENCY — 150 ═════════════════════════ */
category('Message match & congruency', 150);
{
  const AD_HEADLINE = 'Stop Losing Money on Scattered Real Estate Marketing';
  const AD_CTA = 'Book My Free Audit Call';

  const h1 = norm(await page.evaluate(() => document.querySelector('h1')?.innerText || ''));
  check('H1 matches ad headline exactly', 30,
    lc(h1) === lc(AD_HEADLINE), `h1="${h1}"`);

  check('Ad CTA string present verbatim', 25, text.includes(AD_CTA));

  const ctaTexts = await page.$$eval('.cta', els => els.map(e => e.innerText.replace(/\s+/g, ' ').trim()));
  const primary = ctaTexts.filter(t => !/^(continue|back|sending)/i.test(t));
  const offBrand = primary.filter(t => lc(t) !== lc(AD_CTA));
  check('No competing primary CTA copy', 20, offBrand.length === 0, offBrand.join(' | '));

  check('CTA repeated 3+ times', 15,
    primary.filter(t => lc(t) === lc(AD_CTA)).length >= 3, `${primary.length} primary CTAs`);

  const angles = {
    'money leak': ['leak', 'ad account'],
    '11pm follow-up': ['follow-up', 'night'],
    'buyer who walked': ['serious buyer', 'disorganised'],
    'freelancer overwhelm': ['freelancer', 'coordinat'],
    'losing to someone faster': ['faster', 'replied'],
  };
  for (const [name, terms] of Object.entries(angles)) {
    check(`Ad angle present: ${name}`, 10, has(...terms));
  }

  const title = await page.title();
  check('Title carries the ad headline', 10, lc(title).includes(lc(AD_HEADLINE)));
}

/* ══ 2. VSL FUNNEL ARCHITECTURE — 150 ════════════════════════════ */
category('VSL funnel architecture', 150);
{
  const vsl = await page.$('.vsl__frame');
  check('Video slot exists', 25, !!vsl);

  const ratio = vsl ? await vsl.evaluate(el => {
    const r = el.getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 0;
  }) : 0;
  check('Video slot is 16:9', 15, Math.abs(ratio - 16 / 9) < 0.06, `ratio=${ratio.toFixed(3)}`);

  check('Poster frame in slot', 15, !!(await page.$('.vsl__poster')));

  const play = await page.$('.vsl__play');
  const playOK = play ? await play.evaluate(el =>
    el.tagName === 'BUTTON' && !!el.getAttribute('aria-label')) : false;
  check('Play affordance is a labelled button', 20, playOK);

  check('Runtime / duration hint shown', 10, /\b\d+\s*(min|minute)/i.test(text));

  const foldCTA = await page.evaluate(() => {
    const vh = window.innerHeight;
    return [...document.querySelectorAll('.cta')].some(e => {
      const r = e.getBoundingClientRect();
      return r.top >= 0 && r.top < vh * 1.15;
    });
  });
  check('CTA within the first screen', 25, foldCTA);

  const belowVideo = await page.evaluate(() => {
    const v = document.querySelector('.vsl__frame');
    if (!v) return false;
    const vb = v.getBoundingClientRect().bottom + window.scrollY;
    return [...document.querySelectorAll('.cta')].some(e =>
      e.getBoundingClientRect().top + window.scrollY > vb);
  });
  check('CTA also appears below the video', 20, belowVideo);

  const forms = await page.$$('form');
  check('Exactly one conversion form', 15, forms.length === 1, `${forms.length} forms`);

  const leaks = await page.$$eval('a[href]', as => as
    .map(a => a.getAttribute('href'))
    .filter(h => /^(https?:)?\/\//i.test(h)));
  check('No outbound links off the funnel', 20, leaks.length === 0, leaks.join(' '));
}

/* ══ 3. QUALIFICATION FORM — 120 ═════════════════════════════════ */
category('Qualification form', 120);
{
  const steps = await page.$$('.step');
  check('Seven-step progressive form', 30,
    steps.length >= 7 ? 30 : Math.round(steps.length / 7 * 30), `${steps.length} steps`);

  const names = await page.$$eval('#lead-form [name]', els => [...new Set(els.map(e => e.name))]);
  const required = ['business_type', 'city', 'inventory', 'spend', 'lead_source', 'cpql', 'name', 'business', 'phone', 'email', 'consent'];
  const missing = required.filter(n => !names.includes(n));
  check('All qualification fields present', 10,
    Math.round((required.length - missing.length) / required.length * 10), missing.join(','));

  const consent = await page.$('#consent');
  const consentOK = consent ? await consent.evaluate(el =>
    el.type === 'checkbox' && !el.checked && el.hasAttribute('required')) : false;
  check('Consent checkbox, required and unchecked', 20, consentOK);

  check('Inline validation messages exist', 15, (await page.$$('.err')).length >= 4);

  check('Success state present', 15, !!(await page.$('#done')));
  check('Disqualification path present', 15, (await page.$$('[data-disqualify]')).length >= 2);
  check('Progress indicator', 15, (await page.$$('.form__prog i')).length >= 7);
}

/* ══ 4. COPY & ICP RESONANCE — 130 ═══════════════════════════════ */
category('Copy & ICP resonance', 130);
{
  const vocab = [
    ['cost per qualified lead', 'cpql'],
    ['site visit'],
    ['channel partner'],
    ['inventory'],
    ['portal', '99acres', 'magicbricks'],
    ['whatsapp'],
    ['broker'],
    ['micro-market'],
    ['ad spend', 'ad budget'],
    ['₹'],
  ];
  let v = 0;
  const missingVocab = [];
  for (const set of vocab) {
    if (hasAny(...set)) v += 6; else missingVocab.push(set[0]);
  }
  check('ICP vocabulary', 60, v, missingVocab.join(','));

  const objections = {
    'setup fee': ['setup fee'],
    'why not run ads myself': ['leaking bucket'],
    'burned before': ['burned'],
    'how many leads guaranteed': ['qualified lead" is defined', 'qualified lead', 'guarantee'],
    'how long': ['three weeks', '3 weeks'],
  };
  for (const [name, terms] of Object.entries(objections)) {
    check(`Objection handled: ${name}`, 10, hasAny(...terms));
  }

  const filler = ['leverage', 'seamless', 'cutting-edge', 'revolutionize', 'revolutionise',
    'synergy', 'best-in-class', 'game-changing', 'unlock the power', 'take it to the next level'];
  const found = filler.filter(f => textL.includes(f));
  check('No marketing filler', 20, found.length === 0 ? 20 : Math.max(0, 20 - found.length * 7), found.join(','));
}

/* ══ 5. VISUAL DESIGN & TYPOGRAPHY — 150 ═════════════════════════ */
category('Visual design & typography', 150);
{
  const used = await page.evaluate(() => {
    const colors = new Set(), fams = new Set(), sizes = new Set(), radii = new Set(), ls = [];
    for (const el of document.querySelectorAll('*')) {
      const c = getComputedStyle(el);
      colors.add(c.color);
      if (c.backgroundColor !== 'rgba(0, 0, 0, 0)') colors.add(c.backgroundColor);
      if (c.borderTopColor) colors.add(c.borderTopColor);
      fams.add(c.fontFamily.split(',')[0].replace(/["']/g, '').trim());
      if (el.textContent && !el.children.length) sizes.add(c.fontSize);
      radii.add(c.borderTopLeftRadius);
      if (c.textTransform === 'uppercase' && el.textContent?.trim())
        ls.push(parseFloat(c.letterSpacing) / parseFloat(c.fontSize) || 0);
    }
    return { colors: [...colors], fams: [...fams], sizes: [...sizes], radii: [...radii], ls };
  });

  const hexOf = rgb => {
    const p = parseRGB(rgb);
    return p ? '#' + p.slice(0, 3).map(x => Math.round(x).toString(16).padStart(2, '0')).join('').toUpperCase() : '';
  };
  const palette = ['#05100A', '#0F0D08', '#1A3322', '#EAE0C8', '#E0B865', '#C9A04A', '#D25242'];
  const seen = new Set(used.colors.map(hexOf));
  const missingPal = palette.filter(p => !seen.has(p));
  check('Reference palette in use', 49, (palette.length - missingPal.length) * 7, missingPal.join(' '));

  for (const f of ['Instrument Serif', 'Inter Tight', 'Fraunces']) {
    check(`Typeface in use: ${f}`, 10, used.fams.includes(f));
  }

  check('Type scale has 5+ steps', 20,
    used.sizes.length >= 5 ? 20 : used.sizes.length * 4, `${used.sizes.length} sizes`);

  const stages = await page.$$('.leak__stage');
  check('Signature leak diagram, 4 stages', 25,
    stages.length >= 4 ? 25 : stages.length * 6, `${stages.length} stages`);

  const tracked = used.ls.filter(x => x >= 0.1).length;
  check('Uppercase type is tracked out', 13, used.ls.length ? tracked / used.ls.length >= 0.8 : false,
    `${tracked}/${used.ls.length}`);

  const allowed = new Set(['0px', '4px', '14px', '50%', '999px', '2px', '10px']);
  const stray = used.radii.filter(r => !allowed.has(r));
  check('Radius discipline', 13, stray.length === 0 ? 13 : Math.max(0, 13 - stray.length * 4), stray.join(' '));
}

/* ══ 6. AD-POLICY COMPLIANCE — 120 ═══════════════════════════════ */
category('Ad-policy compliance', 120);
{
  const banned = [
    'guaranteed leads', 'no risk', 'risk-free', 'miracle', 'instant results',
    '100%', 'secret', '#1', 'no questions asked', 'best real estate',
  ];
  const hits = banned.filter(b => textL.includes(b));
  check('No banned claim phrases', 40, hits.length === 0 ? 40 : Math.max(0, 40 - hits.length * 12), hits.join(','));

  check('Guarantee stated', 15, hasAny('guarantee'));
  check('"Qualified lead" defined on page', 20,
    has('qualified lead') && hasAny('is defined as', 'defined as'));
  check('Privacy Policy linked', 10, !!(await page.$('a[href*="privacy"]')));
  check('Terms linked', 10, !!(await page.$('a[href*="terms"]')));
  check('Results-vary disclaimer', 10, has('results vary'));

  const footer = lc(await page.evaluate(() => document.querySelector('footer')?.innerText || ''));
  const idBits = ['adscade', '@', '+91', 'india'];
  const idHit = idBits.filter(b => footer.includes(b)).length;
  check('Business identity in footer', 15, Math.round(idHit / idBits.length * 15));
}

/* ══ 7. TECHNICAL QUALITY — 120 ══════════════════════════════════ */
category('Technical quality', 120);
{
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('No horizontal scroll at 360px', 25, overflow <= 1, `overflow=${overflow}px`);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(300);

  const focusables = await page.$$eval('a[href], button, input, select, textarea',
    els => els.filter(e => e.offsetParent !== null).length);
  const focusRule = /:focus-visible\s*\{[^}]*outline\s*:/i.test(html);
  check('Visible keyboard focus ring', 20, focusRule && focusables > 0, `${focusables} focusables`);

  const contrasts = await page.evaluate(() => {
    const out = [];
    const walk = el => {
      const c = getComputedStyle(el);
      if (el.children.length === 0 && el.textContent?.trim() && parseFloat(c.fontSize) >= 11) {
        let bgEl = el, bg = 'rgba(0, 0, 0, 0)';
        while (bgEl && bg === 'rgba(0, 0, 0, 0)') { bg = getComputedStyle(bgEl).backgroundColor; bgEl = bgEl.parentElement; }
        out.push([c.color, bg, parseFloat(c.fontSize)]);
      }
      [...el.children].forEach(walk);
    };
    walk(document.body);
    return out;
  });
  let low = 0;
  for (const [fg, bg, size] of contrasts) {
    const f = parseRGB(fg), b = parseRGB(bg);
    if (!f || !b) continue;
    const need = size >= 24 ? 3 : 4.5;
    if (contrast(f, b) < need) low++;
  }
  check('Text contrast passes AA', 25,
    low === 0 ? 25 : Math.max(0, 25 - low * 3), `${low}/${contrasts.length} below AA`);

  check('prefers-reduced-motion respected', 15, /prefers-reduced-motion\s*:\s*reduce/.test(html));

  const meta = await page.evaluate(() => ({
    desc: !!document.querySelector('meta[name="description"]'),
    og: document.querySelectorAll('meta[property^="og:"]').length >= 4,
    canonical: !!document.querySelector('link[rel="canonical"]'),
    lang: document.documentElement.lang === 'en',
  }));
  check('Meta / OG / canonical / lang', 15,
    Object.values(meta).filter(Boolean).length / 4 * 15,
    JSON.stringify(meta));

  const imgs = await page.$$eval('img', els => els.map(e => ({
    alt: e.hasAttribute('alt'), w: e.hasAttribute('width'), h: e.hasAttribute('height'),
  })));
  const imgOK = imgs.filter(i => i.alt && i.w && i.h).length;
  check('Images have alt + intrinsic size', 10,
    imgs.length ? imgOK / imgs.length * 10 : 0, `${imgOK}/${imgs.length}`);

  const kb = bytes / 1024;
  check('Page weight under 500 KB', 10, kb < 500, `${kb.toFixed(0)} KB`);
}

/* ══ 8. CONVEX READINESS — 60 ════════════════════════════════════ */
category('Convex readiness', 60);
{
  check('Single submitLead() adapter', 20, /async function submitLead\s*\(/.test(html));

  const seg = html.slice(html.indexOf('submitLead'), html.indexOf('submitLead') + 1400);
  check('Payload shape documented', 15,
    /businessType/.test(html) && /convex\/schema/.test(html));

  const hardcoded = /fetch\(\s*["'`]https?:\/\//.test(html);
  check('No hardcoded backend endpoint', 15, !hardcoded);

  check('Schema handoff doc exists', 10, existsSync(join(ROOT, 'docs', 'convex-schema.md')));
}

await browser.close();

/* ── report ───────────────────────────────────────────────────────── */
const total = cats.reduce((s, c) => s + c.earned, 0);
const max = cats.reduce((s, c) => s + c.max, 0);

if (AS_JSON) {
  console.log(JSON.stringify({ score: total, max, categories: cats }, null, 2));
} else {
  console.log('');
  for (const c of cats) {
    const pct = (c.earned / c.max * 100).toFixed(0);
    console.log(`${c.name.padEnd(34)} ${String(c.earned).padStart(4)} / ${String(c.max).padEnd(4)}  ${pct}%`);
    if (VERBOSE || c.earned < c.max) {
      for (const k of c.checks) {
        if (k.earned === k.max && !VERBOSE) continue;
        console.log(`   ${k.earned === k.max ? '·' : '✗'} ${k.label.padEnd(38)} ${k.earned}/${k.max} ${k.note ? '— ' + k.note : ''}`);
      }
    }
  }
  if (consoleErrors.length) console.log('\n  js errors: ' + consoleErrors.join(' | '));
  console.log('\n---');
  console.log(`score:      ${total}`);
  console.log(`max:        ${max}`);
  console.log(`percent:    ${(total / max * 100).toFixed(1)}`);
  console.log('---\n');
}
