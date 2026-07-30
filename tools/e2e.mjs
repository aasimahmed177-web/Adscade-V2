#!/usr/bin/env node
/* Behavioural test for the booking form. The scoring harness checks that the form is
   built correctly; this checks that it actually works. Run both before shipping. */
import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
const logs=[]; p.on('console',m=>logs.push(m.text())); p.on('pageerror',e=>logs.push('ERR '+e));
await p.goto('file://' + process.cwd() + '/site/index.html');
await p.waitForTimeout(400);
let fails=0;
const t=(name,cond)=>{ if(!cond) fails++; console.log((cond?'  ok  ':'FAIL  ')+name); };

await p.click('[data-step="0"] [data-next]');
t('empty question blocks advance', await p.isVisible('[data-step="0"].on'));

const seq=[['input[value="brokerage_team"]',0],['#city',1],['input[value="active"]',2],
 ['input[value="150k_300k"]',3],['input[value="freelancer"]',4],['input[value="unknown"]',5]];
for(const [sel,step] of seq){
  if(sel.startsWith('#')) await p.fill(sel,'Thane West'); else await p.check(sel);
  await p.click(`[data-step="${step}"] [data-next]`);
}
t('reaches contact step', await p.isVisible('[data-step="6"].on'));

await p.fill('#name','Rajesh Kumar'); await p.fill('#business','Kumar Realty');
await p.fill('#phone','12345'); await p.fill('#email','raj@kumar.in'); await p.check('#consent');
await p.click('button[type=submit]');
t('invalid phone blocks submit', await p.isVisible('.field.invalid'));

await p.fill('#phone','9876543210');
await p.click('button[type=submit]');
await p.waitForTimeout(400);
t('corrected phone then submits', await p.isVisible('#done.on'));
t('payload reached submitLead', logs.some(l=>l.includes('lead captured')));

await p.reload(); await p.waitForTimeout(400);
await p.check('input[value="independent_broker"]'); await p.click('[data-step="0"] [data-next]');
await p.fill('#city','Nagpur'); await p.click('[data-step="1"] [data-next]');
await p.check('input[value="none"]'); await p.click('[data-step="2"] [data-next]');
t('no-inventory shows disqualify notice', await p.isVisible('#dq.on'));

t('no js errors', !logs.some(l=>l.startsWith('ERR')));
await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
