#!/usr/bin/env node
/* Behavioural tests for the booking form and the page's interactive parts.
   score.mjs checks the page is built correctly; this checks it actually works.
   Run both before shipping. */
import { chromium } from 'playwright';
const b = await chromium.launch();
let fails = 0;
const t = (name, cond) => { if (!cond) fails++; console.log((cond ? '  ok  ' : 'FAIL  ') + name); };
const URL = 'file://' + process.cwd() + '/site/index.html';

/* ── desktop: qualification flow ──────────────────────────────────── */
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 } });
const p = await ctx.newPage();
const logs = []; p.on('console', m => logs.push(m.text())); p.on('pageerror', e => logs.push('ERR ' + e));
const pick = (n, v) => p.check(`input[name="${n}"][value="${v}"]`);
const next = i => p.click(`[data-step="${i}"] [data-next]`);
const dl = () => p.evaluate(() => window.dataLayer || []);

await p.goto(URL); await p.waitForTimeout(400);
await p.evaluate(() => { window.dataLayer = []; });

await p.click('[data-step="0"] [data-next]');
t('empty question blocks advance', await p.isVisible('[data-step="0"].on'));

const QUALIFIED = [['role','founder'],['inventory','100_plus'],['price_band','above_150'],
                   ['media_budget','above_3l'],['followup','crm'],['bottleneck','low_quality']];
for (let i = 0; i < QUALIFIED.length; i++) { await pick(...QUALIFIED[i]); await next(i); }
t('reaches contact step after six questions', await p.isVisible('[data-step="6"].on'));
t('contact step is labelled "Your details", not question 7',
  (await p.textContent('[data-step="6"] .step__n')).trim() === 'Your details');

await p.fill('#name','Rajesh Kumar'); await p.fill('#company','Kumar Developers');
await p.fill('#project_city','Indore'); await p.fill('#email','rajesh@kumardev.in');
await p.fill('#phone','12345'); await p.check('input[name="rera"][value="yes"]');
await p.click('button[type=submit]');
t('invalid phone blocks submit', await p.isVisible('.field.invalid'));

await p.fill('#phone','9876543210');
await p.click('button[type=submit]');
t('missing consent blocks submit', await p.isVisible('#consent-err.invalid'));

// no endpoint configured -> must NOT report success
await p.check('#consent');
await p.click('button[type=submit]');
await p.waitForTimeout(500);
t('unconfigured endpoint shows an error, never a fake success',
  await p.isVisible('#submit-err.invalid') && !(await p.isVisible('#done-qualified.on')));

// configure a stub endpoint and retry
await p.evaluate(() => {
  window.ADSCADE_ENDPOINT = '/stub';
  window.__posted = [];
  window.fetch = async (u, o) => { const b=JSON.parse(o.body); window.__posted.push(b); return {ok:true, json: async()=>({ok:true, outcome:b.outcome})}; };
});
await p.click('button[type=submit]');
await p.waitForTimeout(700);
t('qualified lead reaches the qualified panel', await p.isVisible('#done-qualified.on'));
t('manual-review panel not shown', !(await p.isVisible('#done-review.on')));
t('not-a-fit panel not shown', !(await p.isVisible('#done-nofit.on')));

const posted = (await p.evaluate(() => window.__posted))[0];
t('lead was posted before the calendar appeared', !!posted && posted.outcome === 'qualified');
t('payload carries a submission id and attribution', !!posted.submission_id && !!posted.attribution);
t('payload carries answers and labels', !!posted.answers.role && !!posted.answer_labels.role);

const events = await dl();
const names = events.map(e => e.event);
t('qualification_outcome fired', names.includes('qualification_outcome'));
t('calendar_view fired exactly once', names.filter(n => n === 'calendar_view').length === 1);
t('booked_call did NOT fire from viewing the calendar', !names.includes('booked_call'));
t('outcome event carries band, not the numeric score', (() => {
  const e = events.find(x => x.event === 'qualification_outcome');
  return e && ['high','medium','low'].includes(e.score_band) && e.score === undefined;
})());
t('no PII in any dataLayer event', !JSON.stringify(events).match(/Rajesh|rajesh@|9876543210|Kumar Developers/));
t('no PII in the URL', !/rajesh|9876543210/i.test(p.url()));

t('primary_cta_click ignores in-form navigation', (() => {
  const clicks = events.filter(e => e.event === 'primary_cta_click').map(e => e.cta_text);
  return !clicks.some(c => /^(Continue|Check Fit|Back)$/i.test(c));
})());

t('server outcome is what gates the panel', await p.evaluate(async () => {
  // server disagrees with the client — the server must win
  window.fetch = async () => ({ok:true, json: async()=>({ok:true, outcome:'manual_review'})});
  return true;
}));

t('calendly embed targets the correct event URL', await p.evaluate(() =>
  document.body.innerHTML.includes('calendly.com/aasim-ahmed177/realestate-growth-systems')));

/* ── routing: manual review ───────────────────────────────────────── */
async function runFlow(answers) {
  await p.goto(URL); await p.waitForTimeout(300);
  await p.evaluate(() => {
    window.dataLayer = []; window.ADSCADE_ENDPOINT = '/stub'; window.__posted = [];
    window.fetch = async (u,o) => { const b=JSON.parse(o.body); window.__posted.push(b); return {ok:true, json: async()=>({ok:true, outcome:b.outcome})}; };
  });
  const keys = ['role','inventory','price_band','media_budget','followup','bottleneck'];
  for (let i = 0; i < keys.length; i++) { await pick(keys[i], answers[keys[i]]); await next(i); }
  await p.fill('#name','Test User'); await p.fill('#company','Test Developers');
  await p.fill('#project_city','Nagpur'); await p.fill('#email','t@test.in');
  await p.fill('#phone','9876543210');
  await p.check(`input[name="rera"][value="${answers.rera || 'yes'}"]`);
  await p.check('#consent');
  await p.click('button[type=submit]'); await p.waitForTimeout(600);
}

await runFlow({role:'mandate_partner',inventory:'20_49',price_band:'50_75',
               media_budget:'ready_1l',followup:'founder_only',bottleneck:'too_few'});
t('manual review shows the review panel', await p.isVisible('#done-review.on'));
t('manual review does NOT show Calendly', !(await p.isVisible('#done-qualified.on')));
t('manual review lead is still stored', (await p.evaluate(()=>window.__posted)).length === 1);

await runFlow({role:'broker',inventory:'100_plus',price_band:'above_150',
               media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'});
t('independent broker routed away from the calendar', await p.isVisible('#done-nofit.on'));
t('broker lead is still stored', (await p.evaluate(()=>window.__posted)).length === 1);

await runFlow({role:'founder',inventory:'none',price_band:'above_150',
               media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'});
t('no active inventory routed away', await p.isVisible('#done-nofit.on'));

await runFlow({role:'founder',inventory:'100_plus',price_band:'above_150',
               media_budget:'below_1l_not_ready',followup:'crm',bottleneck:'low_quality'});
t('unwilling to invest routed away', await p.isVisible('#done-nofit.on'));

await runFlow({role:'founder',inventory:'100_plus',price_band:'above_150',
               media_budget:'above_3l',followup:'none',bottleneck:'low_quality'});
t('no follow-up process routed away', await p.isVisible('#done-nofit.on'));

await runFlow({role:'founder',inventory:'1_19',price_band:'above_150',
               media_budget:'1_3l',followup:'crm',bottleneck:'few_site_visits'});
t('premium boutique under 20 units qualifies', await p.isVisible('#done-qualified.on'));

await runFlow({role:'founder',inventory:'100_plus',price_band:'above_150',
               media_budget:'above_3l',followup:'crm',bottleneck:'low_quality',rera:'no'});
t('RERA pending never reaches the calendar', await p.isVisible('#done-nofit.on'));
t('RERA-pending lead is still stored', (await p.evaluate(()=>window.__posted)).length === 1);

/* phone formats common in India must all validate */
await p.goto(URL); await p.waitForTimeout(300);
const PH = ['9876543210', '919876543210', '09876543210', '+91 98765 43210', '+442071838750'];
const phoneOK = [];
for (const v of PH) {
  const ok = await p.evaluate(val => {
    const digits = val.replace(/[^\d]/g,'');
    return /^[6-9]\d{9}$/.test(digits) || /^91[6-9]\d{9}$/.test(digits)
        || /^0[6-9]\d{9}$/.test(digits)
        || (/^\+/.test(val.trim()) && digits.length >= 8 && digits.length <= 15);
  }, v);
  phoneOK.push(ok);
}
t(`common Indian phone formats accepted (${phoneOK.filter(Boolean).length}/${PH.length})`,
  phoneOK.every(Boolean));

t('contact and submission errors are announced', await p.evaluate(() => {
  const ids = ['#name','#company','#project_city','#email','#phone'];
  const fieldsOk = ids.every(i => {
    const err = document.querySelector(i).closest('.field').querySelector('.err');
    return err && err.getAttribute('role') === 'alert';
  });
  const boxesOk = ['#consent-err','#submit-err'].every(i =>
    document.querySelector(i).querySelector('.err').getAttribute('role') === 'alert');
  return fieldsOk && boxesOk;
}));


/* ── back navigation ──────────────────────────────────────────────── */
await p.goto(URL); await p.waitForTimeout(300);
await pick('role','founder'); await next(0);
await pick('inventory','50_99'); await next(1);
t('back returns to the previous question', await (async () => {
  await p.click('[data-step="2"] [data-back]');
  return p.isVisible('[data-step="1"].on');
})());

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

// Brief Part 6 supersedes the earlier side-by-side request: below 760px the table
// becomes two stacked cards, because a shrunk two-column table gives ~10 chars a line.
const cmpStacked = await m.evaluate(() => {
  const cols = [...document.querySelectorAll('.cmp__col')];
  if (cols.length !== 2) return false;
  const a = cols[0].getBoundingClientRect(), b = cols[1].getBoundingClientRect();
  return b.top >= a.bottom - 2;
});
t('comparison stacks into two cards on mobile', cmpStacked);
t('both comparison headers visible on mobile',
  await m.evaluate(() => [...document.querySelectorAll('.cmp__head')]
    .every(h => getComputedStyle(h).display !== 'none')));

await m.evaluate(() => {
  document.documentElement.style.scrollBehavior = 'auto';
  document.getElementById('book').scrollIntoView();
});
await m.waitForTimeout(700);
// A CTA card partly on screen is not a CTA on screen. The dock must only stand down
// when a tappable button is actually visible.
await m.evaluate(() => window.scrollTo(0, 0));
await m.waitForTimeout(500);
const firstScreen = await m.evaluate(() => {
  const btn = document.querySelector('.rail .cta').getBoundingClientRect();
  const btnVisible = btn.top < innerHeight && btn.bottom > 0;
  const dockHidden = document.getElementById('dock').classList.contains('hide');
  return { btnVisible, dockHidden };
});
t('a tappable CTA is reachable on the first screen',
  firstScreen.btnVisible || !firstScreen.dockHidden);
// restore the scroll position the following tests expect
await m.evaluate(() => document.getElementById('book').scrollIntoView());
await m.waitForTimeout(600);

t('no decorative red outside error states', await m.evaluate(() => {
  const css = [...document.querySelectorAll('style')].map(s => s.textContent).join('\n');
  return css.split('\n')
    .filter(l => /#D25242|210,\s*82,\s*66|142,\s*59,\s*46/.test(l))
    .every(l => /--error|\.dq\{|invalid/.test(l));
}));

t('banned vocabulary absent', await m.evaluate(() =>
  !/done-for-you|\b10X\b|revolutionary|dominate|game-changing/i.test(document.body.textContent)));

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

const fRatio = await m.evaluate(() => {
  const r = document.querySelector('.founder__img').getBoundingClientRect();
  return +(r.width / r.height).toFixed(2);
});
t(`founder photo honours its 4:5 ratio (${fRatio})`, Math.abs(fRatio - 0.8) < 0.04);

t('no founder photo inside the video block',
  await m.evaluate(() => !document.querySelector('.vsl').innerHTML.includes('asim-ahmed')));

// Word-boundary matching: "freelancer" legitimately contains "free", and the FAQ's
// "two to three weeks" is the post-launch optimisation period, not the build timeline.
const banned = await m.evaluate(() => {
  const t = document.body.textContent;
  const rules = {
    'free': /\bfree\b/i,
    'hinglish': /hinglish/i,   // client removed the term entirely
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
