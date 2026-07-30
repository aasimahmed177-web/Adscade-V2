#!/usr/bin/env node
/* Behavioural tests for the booking form and the page's interactive parts.
   score.mjs checks the page is built correctly; this checks it actually works.
   Run both before shipping. */
import { chromium } from 'playwright';
const b = await chromium.launch();
let fails = 0;
const t = (name, cond) => { if (!cond) fails++; console.log((cond ? '  ok  ' : 'FAIL  ') + name); };
const URL = 'file://' + process.cwd() + '/site/index.html';

/* ── desktop: full happy path ─────────────────────────────────────── */
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('ERR ' + e));
await p.goto(URL); await p.waitForTimeout(400);

await p.click('[data-step="0"] [data-next]');
t('empty question blocks advance', await p.isVisible('[data-step="0"].on'));

t('scheduler hidden before submit', !(await p.isVisible('.book-slot')));

const seq = [['input[value="brokerage_team"]',0],['#city',1],['input[value="active"]',2],
  ['input[value="150k_300k"]',3],['input[value="freelancer"]',4],['input[value="unknown"]',5]];
for (const [sel, step] of seq) {
  if (sel.startsWith('#')) await p.fill(sel, 'Thane West'); else await p.check(sel);
  await p.click(`[data-step="${step}"] [data-next]`);
}
t('reaches contact step', await p.isVisible('[data-step="6"].on'));

await p.fill('#name','Rajesh Kumar'); await p.fill('#business','Kumar Realty');
await p.fill('#phone','12345'); await p.fill('#email','raj@kumar.in');
await p.click('button[type=submit]');
t('invalid phone blocks submit', await p.isVisible('.field.invalid'));

await p.fill('#phone','9876543210');
await p.click('button[type=submit]');
t('missing consent blocks submit', await p.isVisible('#consent-err.invalid'));

await p.check('#consent');
await p.click('button[type=submit]');
await p.waitForTimeout(700);
t('completed form submits', await p.isVisible('#done.on'));
t('scheduler appears only after submit', await p.isVisible('.book-slot'));
t('scheduler points at the real calendly link',
  (await p.getAttribute('.book-slot', 'href')) === 'https://calendly.com/aasim-ahmed177/realestate-growth-systems');
t('payload reached submitLead', logs.some(l => l.includes('lead captured')));
const doneBox = await (await p.$('#done')).boundingBox();
t('confirmation is on screen', doneBox && doneBox.y > -10 && doneBox.y < 900);

/* ── a disqualified lead must never reach the scheduler ───────────── */
await p.goto(URL); await p.waitForTimeout(300);
const pick = (n, v) => p.check(`input[name="${n}"][value="${v}"]`);
const next = i => p.click(`[data-step="${i}"] [data-next]`);
await pick('business_type','independent_broker'); await next(0);
await p.fill('#city','Nashik'); await next(1);
await pick('inventory','none'); await next(2);
await pick('spend','none'); await next(3);
await pick('lead_source','nothing'); await next(4);
await pick('cpql','unknown'); await next(5);
t('submit relabels for a disqualified lead',
  (await p.textContent('button[type=submit]')).trim() === 'Send My Details');
await p.fill('#name','Tyre Kicker'); await p.fill('#business','No Stock Realty');
await p.fill('#phone','9000000001'); await p.fill('#email','t@k.in'); await p.check('#consent');
await p.click('button[type=submit]'); await p.waitForTimeout(600);
t('disqualified lead is still captured', await p.isVisible('#done.on'));
t('disqualified lead gets NO scheduler', !(await p.isVisible('.book-slot')));
t('disqualified lead gets the honest ending', await p.isVisible('#done-later'));

/* ── disqualification, inline in the step that caused it ──────────── */
await p.goto(URL); await p.waitForTimeout(300);
await p.check('input[value="independent_broker"]'); await p.click('[data-step="0"] [data-next]');
await p.fill('#city','Nagpur'); await p.click('[data-step="1"] [data-next]');
await p.check('input[value="none"]');
t('no-inventory warns immediately, no Continue needed', await p.isVisible('.dq[data-dq="inventory"].on'));
const dqBox = await (await p.$('.dq[data-dq="inventory"]')).boundingBox();
const navBox = await (await p.$('[data-step="2"] .nav')).boundingBox();
t('warning sits above Continue, not after it', dqBox.y < navBox.y);
await p.check('input[value="active"]');
t('correcting the answer clears the warning', !(await p.isVisible('.dq[data-dq="inventory"].on')));

await p.check('input[value="none"]');
await p.click('[data-step="2"] [data-remind]');
t('lightweight exit skips to contact step', await p.isVisible('[data-step="6"].on'));
t('warning does not follow to the contact step', !(await p.isVisible('[data-step="6"] .dq.on')));

/* ── VSL control reveals in place, never teleports ────────────────── */
await p.goto(URL); await p.waitForTimeout(300);
const beforeY = await p.evaluate(() => window.scrollY);
await p.click('#play');
await p.waitForTimeout(500);
t('play reveals the agenda', await p.isVisible('#agenda.on'));
t('play does not jump the page', Math.abs(await p.evaluate(() => window.scrollY) - beforeY) < 40);

/* ── FAQ a11y wiring ──────────────────────────────────────────────── */
const faqOK = await p.evaluate(() => [...document.querySelectorAll('.faq__q')].every(q => {
  const id = q.getAttribute('aria-controls');
  return id && document.getElementById(id) && document.getElementById(id).hidden;
}));
t('FAQ panels wired and collapsed', faqOK);
await p.click('.faq__q');
t('FAQ opens', await p.evaluate(() => !document.getElementById('a1').hidden));

/* ── mobile ───────────────────────────────────────────────────────── */
const m = await (await b.newContext({ viewport: { width: 360, height: 740 } })).newPage();
await m.goto(URL); await m.waitForTimeout(600);

const vsl = await (await m.$('.vsl__frame')).boundingBox();
t(`video reachable on first screen (top=${Math.round(vsl.y)}px)`, vsl.y < 700);

t('no horizontal scroll', await m.evaluate(() =>
  document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1));

const bars = await m.$$eval('.leak__bar', els => els.map(e => Math.round(e.getBoundingClientRect().width)));
t(`leak bars encode the funnel (${bars.join('>')})`,
  bars.length === 4 && bars[0] > bars[1] && bars[1] > bars[2] && bars[2] > bars[3]);

// the bar width must be the number, not a decorative taper
const trackW = await m.evaluate(() => document.querySelector('.leak__track').getBoundingClientRect().width);
t('bar widths are proportional to the data',
  Math.abs(bars[1] / trackW - 0.60) < 0.03 && Math.abs(bars[2] / trackW - 0.20) < 0.03);

// Reading prose only. Uppercase utility type — eyebrows, captions, labels — is
// deliberately small in this design system and is not what gets read at length.
const small = await m.evaluate(() => {
  const bad = [];
  document.querySelectorAll('p,li,span,label,div').forEach(e => {
    const c = getComputedStyle(e);
    if (!e.children.length && e.textContent.trim().length > 30 &&
        c.textTransform !== 'uppercase' && parseFloat(c.fontSize) < 14)
      bad.push(c.fontSize + ' ' + (e.className || e.tagName));
  });
  return bad;
});
t(`reading prose >=14px (${small.slice(0,3).join(' ') || 'all ok'})`, small.length === 0);

const tapTargets = await m.evaluate(() => {
  const bad = [];
  document.querySelectorAll('button, a.cta, .opt, .foot__list a').forEach(e => {
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && r.height < 44) bad.push((e.className || e.tagName) + ':' + Math.round(r.height));
  });
  return bad;
});
t(`tap targets >=44px (${tapTargets.slice(0,3).join(' ') || 'all ok'})`, tapTargets.length === 0);

const cmpSideBySide = await m.evaluate(() => {
  const cells = [...document.querySelectorAll('.cmp__cell')];
  const old = cells[0].getBoundingClientRect(), nu = cells[1].getBoundingClientRect();
  return nu.left > old.right - 2 && Math.abs(nu.top - old.top) < 2;
});
t('comparison stays side-by-side on mobile', cmpSideBySide);
t('comparison headers visible on mobile',
  await m.evaluate(() => getComputedStyle(document.querySelector('.cmp__head')).display !== 'none'));

await m.evaluate(() => {
  document.documentElement.style.scrollBehavior = 'auto';
  document.getElementById('book').scrollIntoView();
});
await m.waitForTimeout(700);
t('dock stands down when the form is on screen',
  await m.evaluate(() => document.getElementById('dock').classList.contains('hide')));

await m.evaluate(() => document.querySelector('.faq-cta').scrollIntoView());
await m.waitForTimeout(500);
t('dock stands down for the FAQ CTA too',
  await m.evaluate(() => document.getElementById('dock').classList.contains('hide')));

const trustLines = await m.evaluate(() => {
  const s = [...document.querySelectorAll('.trust span')][1];
  return { h: Math.round(s.getBoundingClientRect().height), d: getComputedStyle(s).display };
});
t(`trust strip reads as one phrase (${trustLines.d}, ${trustLines.h}px)`, trustLines.d !== 'flex');

t('no founder photo inside the video block',
  await m.evaluate(() => !document.querySelector('.vsl').innerHTML.includes('asim-ahmed')));

// Word-boundary matching: "freelancer" legitimately contains "free", and the FAQ's
// "two to three weeks" is the post-launch optimisation period, not the build timeline.
const banned = await m.evaluate(() => {
  const t = document.body.textContent;
  const rules = {
    'free': /\bfree\b/i,
    'hinglish': /hinglish/i,
    '3-week build': /(live|built|ready)[^.]{0,20}three weeks/i,
    // scoped outside the form — the form's ₹ brackets are the broker's own spend, not our price
    'published pricing': null,
    'ad spend': /\bad spend\b/i,
  };
  const hits = Object.entries(rules).filter(([, re]) => re && re.test(t)).map(([k]) => k);
  const outsideForm = [...document.body.children]
    .map(n => n.contains(document.getElementById('lead-form')) ? '' : n.textContent).join(' ');
  if (/₹\s?\d{2},000\s*[–-]/.test(outsideForm)) hits.push('published pricing');
  return hits;
});
t(`removed wording stays removed (${banned.join(',') || 'none'})`, banned.length === 0);

t('no js errors', !logs.some(l => l.startsWith('ERR')));
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
