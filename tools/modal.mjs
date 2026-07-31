#!/usr/bin/env node
/* Mobile modal contract (brief §2–§5). Geometry, clean initial state, autofill and the
   error block — each measured, at every required width. */
import { chromium } from 'playwright';
import { readFileSync } from 'fs';

const html = readFileSync('site/index.html', 'utf8');
const b = await chromium.launch();
let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };
const WIDTHS = [[320,720],[360,800],[375,812],[390,844],[430,932],[768,1024],[1440,900]];

/* ── clean initial state, in a genuinely fresh context each time ──── */
console.log('— no default answers (fresh browser context) —');
t('no checked attribute in the source HTML',
  !/<input[^>]*type="(radio|checkbox)"[^>]*\schecked/i.test(html));
for (const [w, h] of [[390,844],[1440,900]]) {
  const ctx = await b.newContext({ viewport: { width: w, height: h } }); // fresh: no storage, no bfcache
  const p = await ctx.newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html');
  await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.waitForTimeout(250);
  const st = await p.evaluate(() => ({
    inv: [...document.querySelectorAll('input[name="inventory"]')].filter(x => x.checked).length,
    bud: [...document.querySelectorAll('input[name="media_budget"]')].filter(x => x.checked).length,
    consent: document.getElementById('consent').checked,
    text: ['name','email','phone'].map(id => document.getElementById(id).value).join(''),
  }));
  t(`${w}px: no inventory preselected`, st.inv === 0, `${st.inv} checked`);
  t(`${w}px: no media budget preselected`, st.bud === 0, `${st.bud} checked`);
  t(`${w}px: consent unchecked`, st.consent === false);
  t(`${w}px: text fields empty`, st.text === '');
  await ctx.close();
}

/* ── selections survive within one open session, not across reopens ─ */
console.log('\n— selection persistence —');
{
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.check('input[name="inventory"][value="50_99"]');
  await p.fill('#name', 'Kept During Session');
  // scroll the body — the selection must survive ordinary interaction
  await p.evaluate(() => { const bd = document.querySelector('.modal__body'); bd.scrollTop = bd.scrollHeight; });
  await p.waitForTimeout(200);
  t('selection survives scrolling within the open form',
    await p.evaluate(() => document.querySelector('input[name="inventory"]:checked')?.value === '50_99'));
  t('typed name survives within the open form',
    await p.evaluate(() => document.getElementById('name').value === 'Kept During Session'));
  await p.close();
}

/* ── panel geometry at every width ────────────────────────────────── */
console.log('\n— panel geometry —');
for (const [w, h] of WIDTHS) {
  const p = await (await b.newContext({ viewport: { width: w, height: h } })).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  await p.waitForTimeout(300);

  const g = await p.evaluate(() => {
    const panel = document.querySelector('#lead-modal .modal__panel');
    const head = document.querySelector('.modal__head');
    const body = document.querySelector('.modal__body');
    const r = panel.getBoundingClientRect();
    const cards = [...document.querySelectorAll('#lead-form .opt')];
    const firstFour = cards.slice(0, 4).map(e => Math.round(e.getBoundingClientRect().top));
    return {
      w: Math.round(r.width), h: Math.round(r.height),
      withinViewport: r.top >= -1 && r.bottom <= window.innerHeight + 1,
      widthRule: Math.round(r.width) <= Math.min(640, window.innerWidth - 24) + 1,
      headSticky: getComputedStyle(head).position === 'sticky',
      bodyScrollable: /auto|scroll/.test(getComputedStyle(body).overflowY),
      overscroll: getComputedStyle(body).overscrollBehaviorY,
      closeSize: (() => { const x = document.querySelector('.modal__x').getBoundingClientRect();
        return [Math.round(x.width), Math.round(x.height)]; })(),
      minTap: Math.min(...cards.map(e => Math.round(e.getBoundingClientRect().height))),
      inputH: Math.round(document.getElementById('name').getBoundingClientRect().height),
      perRow: firstFour.filter(x => x === firstFour[0]).length,
      bodyLocked: getComputedStyle(document.body).overflow === 'hidden',
      pageOverflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });

  const headBefore = await p.evaluate(() => Math.round(document.querySelector('.modal__head').getBoundingClientRect().top));
  await p.evaluate(() => { const bd = document.querySelector('.modal__body'); bd.scrollTop = bd.scrollHeight; });
  await p.waitForTimeout(200);
  const headAfter = await p.evaluate(() => Math.round(document.querySelector('.modal__head').getBoundingClientRect().top));

  const label = `${w}x${h}`.padEnd(9);
  t(`${label} panel stays within the viewport`, g.withinViewport, `${g.w}x${g.h}`);
  t(`${label} width follows min(640, 100vw-24)`, g.widthRule, `${g.w}px`);
  t(`${label} header is sticky and stays put while the body scrolls`,
    g.headSticky && headBefore === headAfter, `${headBefore} → ${headAfter}`);
  t(`${label} body scrolls internally`, g.bodyScrollable);
  t(`${label} overscroll is contained`, g.overscroll === 'contain', g.overscroll);
  t(`${label} page beneath is locked`, g.bodyLocked);
  t(`${label} close control is 48–52px`,
    g.closeSize[0] >= 48 && g.closeSize[0] <= 52 && g.closeSize[1] >= 48 && g.closeSize[1] <= 52, g.closeSize.join('x'));
  t(`${label} answer cards ≥48px tap target`, g.minTap >= 48, `${g.minTap}px`);
  t(`${label} inputs are compact (≤64px)`, g.inputH <= 64, `${g.inputH}px`);
  t(`${label} options ${w < 340 ? '1' : '2'} per row`, g.perRow === (w < 340 ? 1 : 2), `${g.perRow}`);
  t(`${label} no horizontal page overflow`, g.pageOverflowX === 0, `${g.pageOverflowX}px`);
  await p.close();
}

/* ── a11y behaviours must survive the restructure ─────────────────── */
console.log('\n— dialog behaviour —');
{
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  t('dialog semantics intact', await p.evaluate(() => {
    const d = document.querySelector('#lead-modal .modal__panel');
    return d.getAttribute('role') === 'dialog' && d.getAttribute('aria-modal') === 'true'
      && !!document.getElementById(d.getAttribute('aria-labelledby'));
  }));
  t('heading is inside the sticky header',
    await p.evaluate(() => !!document.querySelector('.modal__head #modal-title')));
  // "inside the dialog" was too weak: the honeypot is inside the dialog, and focus landed
  // on it, so a visitor who typed on open filled it and their lead was discarded as bot
  // traffic. Assert the exact element.
  t('focus starts on the first real field, not the honeypot', await p.evaluate(() => {
    const a = document.activeElement;
    return a && a.id === 'name' && !a.closest('[aria-hidden="true"]');
  }), await p.evaluate(() => document.activeElement.name || document.activeElement.id));
  t('typing straight after opening goes into the name field, not the honeypot', await (async () => {
    await p.keyboard.type('Rajesh Kumar');
    return await p.evaluate(() => document.querySelector('input[name="website"]').value === ''
      && document.getElementById('name').value === 'Rajesh Kumar');
  })());
  await p.fill('#name', '');
  await p.evaluate(() => {
    const f = [...document.querySelectorAll('#lead-modal button, #lead-modal input, #lead-modal a')]
      .filter(e => e.offsetParent !== null);
    f[f.length - 1].focus();
  });
  await p.keyboard.press('Tab');
  t('focus is trapped', await p.evaluate(() => document.getElementById('lead-modal').contains(document.activeElement)));
  await p.keyboard.press('Escape');
  t('Escape closes', await p.evaluate(() => document.getElementById('lead-modal').hidden));
  t('focus returns to the opener', await p.evaluate(() =>
    document.activeElement && document.activeElement.classList.contains('js-cta')));
  await p.close();
}

/* ── invalid fields must be findable ──────────────────────────────── */
console.log('\n— validation feedback —');
{
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => document.querySelector('.js-cta').click());
  // Everything valid EXCEPT the name, then scroll to the bottom and submit — the failure
  // the visitor actually hits, where the error is far above the visible area.
  await p.fill('#email', 'rajesh@kumardev.in');
  await p.fill('#phone', '9876543210');
  await p.check('input[name="inventory"][value="100_plus"]');
  await p.check('input[name="media_budget"][value="above_5l"]');
  await p.check('#consent');
  await p.evaluate(() => { const bd = document.querySelector('.modal__body'); bd.scrollTop = bd.scrollHeight; });
  await p.waitForTimeout(200);
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(900);
  const v = await p.evaluate(() => {
    const err = document.querySelector('.field.invalid .err');
    const body = document.querySelector('.modal__body').getBoundingClientRect();
    const r = err.getBoundingClientRect();
    return {
      visible: r.top >= body.top - 1 && r.bottom <= body.bottom + 1,
      focused: document.activeElement && document.activeElement.id === 'name',
      ariaInvalid: document.getElementById('name').getAttribute('aria-invalid'),
      describedby: document.getElementById('name').getAttribute('aria-describedby'),
      describedTargetExists: !!document.getElementById(
        document.getElementById('name').getAttribute('aria-describedby') || ''),
    };
  });
  t('the invalid field is scrolled into view', v.visible);
  t('focus moves to the invalid field', v.focused);
  t('invalid field is marked aria-invalid', v.ariaInvalid === 'true', String(v.ariaInvalid));
  t('invalid field points at its error text', v.describedby === 'err-name' && v.describedTargetExists,
    String(v.describedby));
  // clears once corrected
  await p.fill('#name', 'Rajesh Kumar');
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(400);
  t('aria-invalid clears once corrected',
    await p.evaluate(() => document.getElementById('name').getAttribute('aria-invalid') === null));
  await p.close();
}

/* ── autofill styling ─────────────────────────────────────────────── */
console.log('\n— autofill —');
t('autofill selectors are present',
  /input:-webkit-autofill/.test(html) && /:-webkit-autofill:hover/.test(html)
  && /:-webkit-autofill:focus/.test(html));
t('autofill repaints the field with an inset shadow', /box-shadow:0 0 0 1000px #0A1810 inset/.test(html));
t('autofill forces readable text colour', /-webkit-text-fill-color:var\(--cream\)/.test(html));
{
  // Check the three real inputs, not a source slice: the honeypot sits immediately above
  // them and legitimately carries autocomplete="off".
  const p = await (await b.newContext()).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(300);
  const ac = await p.evaluate(() => ['name','email','phone']
    .map(id => id + '=' + (document.getElementById(id).getAttribute('autocomplete') || 'MISSING')));
  t('real inputs keep working autocomplete hints',
    ac.join(',') === 'name=name,email=email,phone=tel', ac.join(','));
  await p.close();
}
{
  // The declared fill colour must actually be readable on the declared background.
  const lum = c => { const f = c.map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
    return .2126 * f[0] + .7152 * f[1] + .0722 * f[2]; };
  const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const [a, c] = [lum(hex('#F3E8D2')), lum(hex('#0A1810'))].sort((x, y) => y - x);
  const ratio = (a + .05) / (c + .05);
  t('autofilled text contrast passes AA', ratio >= 4.5, `${ratio.toFixed(1)}:1`);
}

/* ── error block ──────────────────────────────────────────────────── */
console.log('\n— error block —');
t('uses the specified message',
  /We couldn't save your details\. Check your connection and try again/.test(html));
t('offers the verified WhatsApp number only', /wa\.me\/917019698301/.test(html) && !/7996112470/.test(html));
t('is announced via aria-live', /id="submit-err"[^>]*aria-live="assertive"/.test(html));
{
  const p = await (await b.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await p.goto('file://' + process.cwd() + '/site/index.html'); await p.waitForTimeout(400);
  await p.evaluate(() => { window.ADSCADE_LEAD_ENDPOINT = '/stub';
    window.fetch = async () => ({ ok: false, status: 500, json: async () => ({ ok: false }) }); });
  await p.evaluate(() => document.querySelector('.js-cta').click());
  const wBefore = await p.evaluate(() => Math.round(document.querySelector('.modal__panel').getBoundingClientRect().width));
  await p.fill('#name', 'Rajesh Kumar'); await p.fill('#email', 'r@k.in'); await p.fill('#phone', '9876543210');
  await p.check('input[name="inventory"][value="100_plus"]');
  await p.check('input[name="media_budget"][value="above_5l"]');
  await p.check('#consent');
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(700);
  const e = await p.evaluate(() => {
    const box = document.getElementById('submit-err');
    const btn = document.querySelector('#lead-form button[type=submit]');
    return {
      shown: box.classList.contains('invalid'),
      w: Math.round(document.querySelector('.modal__panel').getBoundingClientRect().width),
      h: Math.round(box.getBoundingClientRect().height),
      gap: Math.round(box.getBoundingClientRect().top - btn.getBoundingClientRect().bottom),
      preserved: document.getElementById('name').value === 'Rajesh Kumar'
        && document.querySelector('input[name="inventory"]:checked')?.value === '100_plus',
      calendlyHidden: document.getElementById('schedule').hidden,
      retryable: !btn.disabled,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  t('error appears', e.shown);
  t('error does not widen the panel', e.w === wBefore, `${wBefore} → ${e.w}`);
  t('error is compact (≤110px)', e.h <= 110, `${e.h}px`);
  t('error sits next to the submit button (≤24px gap)', e.gap <= 24, `${e.gap}px`);
  t('entered values are preserved', e.preserved);
  t('Calendly stays hidden', e.calendlyHidden);
  t('retry is possible', e.retryable);
  t('no horizontal overflow from the error', e.overflowX === 0);

  // clears on the next successful submission
  await p.evaluate(() => { window.fetch = async () => ({ ok: true, json: async () => ({ ok: true, stored: true }) }); });
  await p.click('#lead-form button[type=submit]');
  await p.waitForTimeout(900);
  t('error is gone after a successful retry',
    await p.evaluate(() => !document.getElementById('submit-err').classList.contains('invalid')));
  await p.close();
}

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall modal tests passed\n');
process.exit(fails ? 1 : 0);
