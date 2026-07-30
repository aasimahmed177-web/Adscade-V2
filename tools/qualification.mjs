#!/usr/bin/env node
/**
 * Deterministic tests for the qualification model (brief §9/§10).
 * Runs the page's own evaluate() so the test can never drift from the implementation.
 */
import { chromium } from 'playwright';

const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('file://' + process.cwd() + '/site/index.html');
await p.waitForTimeout(600);

let fails = 0;
async function scenario(name, answers, expected, expectScore) {
  const r = await p.evaluate(a => window.__adscadeEvaluate(a), answers);
  const ok = r.outcome === expected && (expectScore === undefined || r.score === expectScore);
  if (!ok) fails++;
  console.log(`${ok ? '  ok  ' : 'FAIL  '}${name.padEnd(46)} score:${String(r.score).padStart(3)} → ${r.outcome}${r.restriction ? ' ('+r.restriction+')' : ''}`);
}

console.log('\n— qualification model —\n');

await scenario('strong developer, everything aligned',
  {role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'},
  'qualified', 100);

await scenario('mid developer, marketing lead',
  {role:'marketing_sales_lead',inventory:'50_99',price_band:'75_150',media_budget:'1_3l',followup:'spreadsheet',bottleneck:'few_site_visits'},
  'qualified', 90);

await scenario('premium boutique, <20 units — qualifies',
  {role:'founder',inventory:'1_19',price_band:'above_150',media_budget:'1_3l',followup:'crm',bottleneck:'few_site_visits'},
  'qualified', 83);

await scenario('boutique <20 units but mid-price — review only',
  {role:'founder',inventory:'1_19',price_band:'75_150',media_budget:'1_3l',followup:'crm',bottleneck:'few_site_visits'},
  'manual_review', 83);

await scenario('boutique <20 units, premium, no sales team — review',
  {role:'founder',inventory:'1_19',price_band:'above_150',media_budget:'1_3l',followup:'inconsistent',bottleneck:'few_site_visits'},
  'manual_review', 75);

await scenario('budget undecided never auto-qualifies',
  {role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'undecided',followup:'crm',bottleneck:'low_quality'},
  'manual_review', 84);

await scenario('mid score, no restriction — manual review',
  {role:'mandate_partner',inventory:'20_49',price_band:'50_75',media_budget:'ready_1l',followup:'founder_only',bottleneck:'too_few'},
  'manual_review', 59);

await scenario('independent broker — restricted',
  {role:'broker',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'},
  'not_current_fit');

await scenario('marketing agency — restricted',
  {role:'agency_other',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'},
  'not_current_fit');

await scenario('no active inventory — restricted',
  {role:'founder',inventory:'none',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'},
  'not_current_fit');

await scenario('will not invest ₹1L — restricted',
  {role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'below_1l_not_ready',followup:'crm',bottleneck:'low_quality'},
  'not_current_fit');

await scenario('no follow-up process — restricted',
  {role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'none',bottleneck:'low_quality'},
  'not_current_fit');

await scenario('just exploring, weak everything — not a fit',
  {role:'mandate_partner',inventory:'1_19',price_band:'below_50',media_budget:'ready_1l',followup:'founder_only',bottleneck:'exploring'},
  'not_current_fit', 41);

/* ── invariants ── */
console.log('\n— invariants —\n');
const maxScore = await p.evaluate(() => window.__adscadeEvaluate(
  {role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality'}).score);
const t = (n,c) => { if(!c) fails++; console.log((c?'  ok  ':'FAIL  ')+n); };
t(`maximum possible score is 100 (got ${maxScore})`, maxScore === 100);
t('score never rendered into the DOM', !(await p.evaluate(() =>
  /\b(score|weighted)\b/i.test(document.body.innerText))));
t('no scoring value in any data attribute', !(await p.evaluate(() =>
  [...document.querySelectorAll('*')].some(e => e.dataset && e.dataset.score))));

await b.close();
console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
