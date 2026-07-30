#!/usr/bin/env node
/* Responsive + logged-out-visitor checks across the required breakpoints (brief §18). */
import { chromium } from 'playwright';
const b = await chromium.launch();
const URL = 'file://' + process.cwd() + '/site/index.html';
let fails = 0;
const t = (n,c) => { if(!c) fails++; return (c?'ok':'FAIL'); };

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
console.log(' ', t('dock hides while the form is on screen',
  await p.evaluate(()=>document.getElementById('dock').classList.contains('hide'))),
  '— dock hides while the form is on screen');

await p.evaluate(() => {
  window.ADSCADE_ENDPOINT='/stub';
  window.fetch = async () => ({ok:true, json: async()=>({ok:true})});
});
const keys=[['role','founder'],['inventory','100_plus'],['price_band','above_150'],
            ['media_budget','above_3l'],['followup','crm'],['bottleneck','low_quality']];
for (let i=0;i<keys.length;i++){ await p.check(`input[name="${keys[i][0]}"][value="${keys[i][1]}"]`); await p.click(`[data-step="${i}"] [data-next]`); }
await p.fill('#name','A'); await p.fill('#company','B'); await p.fill('#project_city','C');
await p.fill('#email','a@b.in'); await p.fill('#phone','9876543210'); await p.check('#consent');
await p.click('button[type=submit]'); await p.waitForTimeout(900);
console.log(' ', t('dock stays hidden over the calendar',
  await p.evaluate(()=>document.getElementById('dock').classList.contains('hide'))),
  '— dock stays hidden over the calendar');
console.log(' ', t('calendar area has no horizontal overflow',
  await p.evaluate(()=>{const c=document.querySelector('.cal');
    return !c || c.scrollWidth <= c.clientWidth + 1;})),
  '— calendar area has no horizontal overflow');
console.log(' ', t('no horizontal page overflow after calendar mounts',
  await p.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth <= 1)),
  '— no page overflow after calendar mounts');

/* Calendly failure path — the visitor must never face an empty 900px box */
const f = await (await b.newContext({viewport:{width:390,height:844}})).newPage();
await f.route('**/assets.calendly.com/**', r => r.abort());
await f.goto(URL); await f.waitForTimeout(400);
await f.evaluate(()=>{ window.ADSCADE_ENDPOINT='/stub';
  window.fetch = async () => ({ok:true, json: async()=>({ok:true})}); });
const A=[['role','founder'],['inventory','100_plus'],['price_band','above_150'],
        ['media_budget','above_3l'],['followup','crm'],['bottleneck','low_quality']];
for (let i=0;i<A.length;i++){ await f.check(`input[name="${A[i][0]}"][value="${A[i][1]}"]`); await f.click(`[data-step="${i}"] [data-next]`); }
await f.fill('#name','T'); await f.fill('#company','T'); await f.fill('#project_city','Indore');
await f.fill('#email','t@t.in'); await f.fill('#phone','9876543210'); await f.check('#consent');
await f.click('button[type=submit]'); await f.waitForTimeout(1400);
const fb = await f.evaluate(()=>({
  shown: document.getElementById('cal-fallback').classList.contains('on'),
  box: Math.round(document.querySelector('.cal').getBoundingClientRect().height),
  href: [...document.querySelectorAll('#cal-fallback a')].map(a=>a.href)[0] }));
console.log('\n— Calendly failure path —');
console.log(' ', t('fallback surfaces when the embed is blocked', fb.shown), '— fallback surfaces when the embed is blocked');
console.log(' ', t('reserved space collapses', fb.box === 0), '— reserved space collapses');
console.log(' ', t('fallback points at the event URL',
  fb.href === 'https://calendly.com/aasim-ahmed177/realestate-growth-systems'),
  '— fallback points at the event URL');

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
