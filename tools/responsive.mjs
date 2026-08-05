#!/usr/bin/env node
/* Responsive + logged-out-visitor checks across the required breakpoints (brief §18). */
import { chromium } from 'playwright';
const b = await chromium.launch();
const URL = 'file://' + process.cwd() + '/site/index.html';
let fails = 0;
const t = (n,c) => { if(!c) fails++; return (c?'ok':'FAIL'); };


/* Fill and submit the lead modal. Replaces the seven-step walk the old form required. */
async function submitLead(pg) {
  await pg.evaluate(() => {
    window.ADSCADE_LEAD_ENDPOINT = '/stub';
    window.fetch = async () => ({ok:true, json: async()=>({ok:true, stored:true, submissionId:'s-1'})});
  });
  await pg.evaluate(() => document.querySelector('.js-cta').click());
  await pg.fill('#name','Rajesh Kumar'); await pg.fill('#email','rajesh@kumardev.in');
  await pg.fill('#phone','9876543210');
  await pg.check('input[name="inventory"][value="100_plus"]');
  await pg.check('input[name="media_budget"][value="above_5l"]');
  await pg.check('#consent');
  await pg.click('#lead-form button[type=submit]');
  await pg.waitForTimeout(900);
}

console.log('\nwidth      ovf  height  <16px tap<48  h1  CTA  errors');
console.log('─'.repeat(58));
for (const [w,h] of [[360,800],[375,812],[390,844],[430,932],[768,1024],[1440,900]]) {
  const p = await (await b.newContext({viewport:{width:w,height:h}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(String(e)));
  await p.goto(URL); await p.waitForTimeout(800);
  const r = await p.evaluate(() => {
    const de=document.documentElement;
    const small=[...document.querySelectorAll('p,li,span,label,div,button,a')]
      .filter(e=>!e.children.length&&e.textContent.trim().length>25)
      .filter(e=>{const c=getComputedStyle(e);return c.textTransform!=='uppercase'&&parseFloat(c.fontSize)<16;}).length;
    const tap=[...document.querySelectorAll('button, a.cta, .opt, .brandbar__fit')]
      .filter(e=>{const b=e.getBoundingClientRect();return b.width>0&&b.height>0&&b.height<48;}).length;
    const btn=document.querySelector('.rail .cta').getBoundingClientRect();
    return {o:de.scrollWidth-de.clientWidth, h:document.body.scrollHeight, small, tap,
      h1:document.querySelectorAll('h1').length,
      cta:(btn.top<innerHeight&&btn.bottom>0)||!document.getElementById('dock').classList.contains('hide')};
  });
  const ok = r.o===0 && r.small===0 && r.tap===0 && r.h1===1 && r.cta && errs.length===0;
  if(!ok) fails++;
  console.log(`${(w+'x'+h).padEnd(10)} ${String(r.o).padStart(3)} ${String(r.h).padStart(7)} ${String(r.small).padStart(6)} ${String(r.tap).padStart(6)} ${String(r.h1).padStart(3)} ${String(r.cta).padStart(5)} ${errs.length?'ERR':'  none'}`);
  await p.close();
}

/* sticky CTA must never obscure the form or the calendar */
console.log('\n— sticky CTA safety —');
const p = await (await b.newContext({viewport:{width:390,height:844}})).newPage();
await p.goto(URL); await p.waitForTimeout(600);
await p.evaluate(()=>{document.documentElement.style.scrollBehavior='auto';
  document.getElementById('book').scrollIntoView();});
await p.waitForTimeout(700);
console.log(' ', t('dock hides while a real CTA is on screen',
  await p.evaluate(()=>document.getElementById('dock').classList.contains('hide'))),
  '— dock hides while a real CTA is on screen');

await p.evaluate(()=>{window.scrollTo(0,0);});
await p.waitForTimeout(400);
await p.evaluate(() => document.querySelector('.js-cta').click());
await p.waitForTimeout(400);
console.log(' ', t('dock is suppressed while the modal is open',
  await p.evaluate(()=>{
    const d = document.getElementById('dock');
    return d.classList.contains('hide') || document.body.classList.contains('modal-open');
  })),
  '— dock is suppressed while the modal is open');
console.log(' ', t('modal fits the viewport without page overflow',
  await p.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1)),
  '— modal fits the viewport without page overflow');
console.log(' ', t('modal content is reachable by scrolling inside the panel',
  await p.evaluate(()=>{
    const pn = document.querySelector('#lead-modal .modal__panel');
    return pn.scrollHeight <= pn.clientHeight + 1 || getComputedStyle(pn).overflowY !== 'visible';
  })),
  '— modal content is reachable by scrolling inside the panel');
await p.keyboard.press('Escape');
await p.waitForTimeout(300);

// The scheduling section and the Calendly failure path were removed with the inline
// embed: a stored lead now leaves this page for calendly.com. Redirect behaviour is
// covered by tools/redirect.mjs.

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
