#!/usr/bin/env node
/**
 * Exhaustive scoring tests — every reachable answer combination, not a hand-picked few.
 * 5 × 5 × 5 × 5 × 5 × 6 × 2(rera) = 37,500 combinations.
 *
 * The oracle below is written INDEPENDENTLY from the page's evaluate() — it is the
 * business rules from the brief transcribed directly. If the two ever disagree, one of
 * them has drifted from the specification.
 */
import { chromium } from 'playwright';

const S = {
  role:{founder:20,marketing_sales_lead:18,mandate_partner:14,broker:4,agency_other:0},
  inventory:{'100_plus':20,'50_99':18,'20_49':14,'1_19':5,none:0},
  price_band:{above_150:10,'75_150':10,'50_75':8,below_50:5,mixed:7},
  media_budget:{above_3l:20,'1_3l':18,ready_1l:12,below_1l_not_ready:0,undecided:4},
  followup:{crm:20,spreadsheet:16,inconsistent:12,founder_only:5,none:0},
  bottleneck:{low_quality:10,few_site_visits:10,no_visibility:10,slow_followup:8,too_few:6,exploring:0},
};
const RESTRICT = { role:['broker','agency_other'], inventory:['none'],
                   media_budget:['below_1l_not_ready'], followup:['none'] };
const CAP = { media_budget:['undecided'], followup:['founder_only'], bottleneck:['exploring'] };
const TEAM = ['crm','spreadsheet'];

function oracle(a){
  let score = 0, restricted = false, capped = false;
  for (const k of Object.keys(S)) {
    score += S[k][a[k]];
    if ((RESTRICT[k]||[]).includes(a[k])) restricted = true;
    if ((CAP[k]||[]).includes(a[k]))       capped = true;
  }
  if (a.rera !== 'yes') restricted = true;
  if (restricted) return {score, outcome:'not_current_fit'};
  if (a.inventory === '1_19') {
    const ok = a.price_band === 'above_150'
            && ['above_3l','1_3l','ready_1l'].includes(a.media_budget)
            && TEAM.includes(a.followup) && score >= 65 && !capped;
    return {score, outcome: ok ? 'qualified' : (score >= 50 ? 'manual_review' : 'not_current_fit')};
  }
  if (capped)       return {score, outcome: score >= 50 ? 'manual_review' : 'not_current_fit'};
  if (score >= 65)  return {score, outcome:'qualified'};
  if (score >= 50)  return {score, outcome:'manual_review'};
  return {score, outcome:'not_current_fit'};
}

const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
await p.goto('file://' + process.cwd() + '/site/index.html');
await p.waitForTimeout(600);

const keys = Object.keys(S);
const combos = [];
(function build(i, acc){
  if (i === keys.length) { for (const r of ['yes','no']) combos.push({...acc, rera:r}); return; }
  for (const v of Object.keys(S[keys[i]])) build(i+1, {...acc, [keys[i]]: v});
})(0, {});

console.log(`\nexhaustive: ${combos.length.toLocaleString()} combinations\n`);

const actual = await p.evaluate(cs => cs.map(c => {
  const r = window.__adscadeEvaluate(c);
  return {score: r.score, outcome: r.outcome};
}), combos);

let mismatches = [], qualified = 0, review = 0, nofit = 0;
combos.forEach((c, i) => {
  const want = oracle(c), got = actual[i];
  if (want.score !== got.score || want.outcome !== got.outcome) {
    if (mismatches.length < 6) mismatches.push({c, want, got});
  }
  if (got.outcome === 'qualified') qualified++;
  else if (got.outcome === 'manual_review') review++; else nofit++;
});

let fails = 0;
const t = (n,c) => { if(!c) fails++; console.log((c?'  ok  ':'FAIL  ')+n); };

t(`page model matches the independent oracle on all ${combos.length.toLocaleString()} combinations`,
  mismatches.length === 0);
if (mismatches.length) mismatches.forEach(m =>
  console.log('   ', JSON.stringify(m.c), 'want', m.want, 'got', m.got));

console.log(`\n    distribution — qualified ${qualified} · manual review ${review} · not a fit ${nofit}\n`);

/* ── invariants that must hold across the WHOLE space ── */
const inv = await p.evaluate(cs => {
  const R = cs.map(c => ({c, r: window.__adscadeEvaluate(c)}));
  const q = R.filter(x => x.r.outcome === 'qualified');
  return {
    maxScore:        Math.max(...R.map(x => x.r.score)),
    qualifiedBelow65: q.filter(x => x.r.score < 65).length,
    qualifiedRestricted: q.filter(x => x.r.restriction).length,
    qualifiedCapped: q.filter(x => x.r.cap).length,
    qualifiedReraNo: q.filter(x => x.c.rera !== 'yes').length,
    qualifiedBroker: q.filter(x => x.c.role === 'broker' || x.c.role === 'agency_other').length,
    qualifiedNoInv:  q.filter(x => x.c.inventory === 'none').length,
    qualifiedNoBudget: q.filter(x => x.c.media_budget === 'below_1l_not_ready').length,
    qualifiedNoFollow: q.filter(x => x.c.followup === 'none').length,
    qualifiedFounderOnly: q.filter(x => x.c.followup === 'founder_only').length,
    qualifiedExploring: q.filter(x => x.c.bottleneck === 'exploring').length,
    qualifiedUndecided: q.filter(x => x.c.media_budget === 'undecided').length,
    boutique: q.filter(x => x.c.inventory === '1_19')
               .every(x => x.c.price_band === 'above_150'
                        && ['above_3l','1_3l','ready_1l'].includes(x.c.media_budget)
                        && ['crm','spreadsheet'].includes(x.c.followup)),
  };
}, combos);

t('maximum score is exactly 100',              inv.maxScore === 100);
t('no qualified result scores below 65',       inv.qualifiedBelow65 === 0);
t('no qualified result carries a restriction', inv.qualifiedRestricted === 0);
t('no qualified result carries a review cap',  inv.qualifiedCapped === 0);
t('RERA-ineligible never qualifies',           inv.qualifiedReraNo === 0);
t('broker / agency never qualifies',           inv.qualifiedBroker === 0);
t('no active inventory never qualifies',       inv.qualifiedNoInv === 0);
t('unwilling to fund media never qualifies',   inv.qualifiedNoBudget === 0);
t('no follow-up process never qualifies',      inv.qualifiedNoFollow === 0);
t('founder-only follow-up never auto-qualifies', inv.qualifiedFounderOnly === 0);
t('exploring visitors never auto-qualify',     inv.qualifiedExploring === 0);
t('undecided budget never auto-qualifies',     inv.qualifiedUndecided === 0);
t('every qualified 1–19-unit case meets all premium conditions', inv.boutique);

/* ── threshold boundaries ─────────────────────────────────────────────
   Scores 49, 50 and 64 turn out to be reachable ONLY when a manual-review cap
   applies — the weights are coarse enough that a clean submission steps over
   them. The tests therefore assert the reachable truth rather than a
   hypothetical, and add a whole-space check on where the qualifying edge sits.
─────────────────────────────────────────────────────────────────────── */
console.log('\n— thresholds —');
const band = await p.evaluate(() => {
  const mk = a => window.__adscadeEvaluate(a);
  return {
    s49: mk({role:'founder',inventory:'1_19',price_band:'50_75',media_budget:'undecided',followup:'inconsistent',bottleneck:'exploring',rera:'yes'}),
    s50: mk({role:'founder',inventory:'20_49',price_band:'mixed',media_budget:'undecided',followup:'founder_only',bottleneck:'exploring',rera:'yes'}),
    s64: mk({role:'founder',inventory:'100_plus',price_band:'50_75',media_budget:'undecided',followup:'inconsistent',bottleneck:'exploring',rera:'yes'}),
    s65: mk({role:'mandate_partner',inventory:'20_49',price_band:'below_50',media_budget:'ready_1l',followup:'inconsistent',bottleneck:'slow_followup',rera:'yes'}),
    s65capped: mk({role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'undecided',followup:'founder_only',bottleneck:'too_few',rera:'yes'}),
  };
});
t(`score 49 → not a fit (${band.s49.score} → ${band.s49.outcome})`,
  band.s49.score === 49 && band.s49.outcome === 'not_current_fit');
t(`score 50 → manual review (${band.s50.score} → ${band.s50.outcome})`,
  band.s50.score === 50 && band.s50.outcome === 'manual_review');
t(`score 64 → manual review (${band.s64.score} → ${band.s64.outcome})`,
  band.s64.score === 64 && band.s64.outcome === 'manual_review');
t(`score 65 uncapped → qualified (${band.s65.score} → ${band.s65.outcome})`,
  band.s65.score === 65 && band.s65.outcome === 'qualified');
t(`score 65 with a cap → manual review, cap beats threshold (${band.s65capped.score} → ${band.s65capped.outcome})`,
  band.s65capped.score === 65 && band.s65capped.outcome === 'manual_review');

// whole-space edge: nothing below 65 may qualify, and 65 must actually be attainable
const edge = await p.evaluate(cs => {
  const q = cs.map(c => window.__adscadeEvaluate(c)).filter(r => r.outcome === 'qualified');
  return {min: Math.min(...q.map(r => r.score)), count: q.length};
}, combos);
t(`lowest qualifying score across the whole space is exactly 65 (found ${edge.min})`, edge.min === 65);

/* ── malformed input must fail safe ── */
console.log('\n— malformed input —');
const bad = await p.evaluate(() => ({
  empty:   window.__adscadeEvaluate({}),
  partial: window.__adscadeEvaluate({role:'founder',inventory:'100_plus',rera:'yes'}),
  unknown: window.__adscadeEvaluate({role:'ceo',inventory:'999',price_band:'x',media_budget:'y',followup:'z',bottleneck:'q',rera:'yes'}),
  injected:window.__adscadeEvaluate({role:'founder',inventory:'100_plus',price_band:'above_150',media_budget:'above_3l',followup:'crm',bottleneck:'low_quality',rera:'yes',score:9999}),
}));
t('empty answers → not a fit, score 0',       bad.empty.outcome==='not_current_fit' && bad.empty.score===0);
t('partial answers cannot qualify',           bad.partial.outcome==='not_current_fit');
t('unknown answer keys score nothing',        bad.unknown.score===0 && bad.unknown.outcome==='not_current_fit');
t('a client-injected score field is ignored', bad.injected.score===100);

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
