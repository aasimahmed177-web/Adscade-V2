#!/usr/bin/env node
/**
 * Mutation testing. Seeds realistic defects into site/index.html one at a time, runs the
 * suite, and reports which mutations survive. A surviving mutation is a hole in the tests.
 *
 * Never run against a dirty tree — the original file is restored after every mutation.
 */
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';

const PAGE = 'site/index.html';
const BACKUP = 'site/.index.html.mutbak';

const MUTATIONS = [
  ['score: role founder 20→18',      "founder:{s:20,",              "founder:{s:18,"],
  ['score: inventory 100+ 20→10',    "'100_plus':{s:20,",           "'100_plus':{s:10,"],
  ['score: budget above_3l 20→2',    "above_3l:{s:20,",             "above_3l:{s:2,"],
  ['restriction removed: broker',    "broker:{s:4,l:'Independent broker or property consultant',restrict:'role_broker'}",
                                     "broker:{s:4,l:'Independent broker or property consultant'}"],
  ['restriction removed: no inventory', "none:{s:0,l:'No currently active project or inventory',restrict:'no_inventory'}",
                                        "none:{s:0,l:'No currently active project or inventory'}"],
  ['restriction removed: no budget', "below_1l_not_ready:{s:0,l:'Below ₹1 lakh, not ready to increase',restrict:'no_budget'}",
                                     "below_1l_not_ready:{s:0,l:'Below ₹1 lakh, not ready to increase'}"],
  ['restriction removed: no follow-up', "none:{s:0,l:'No defined follow-up process',restrict:'no_followup'}",
                                        "none:{s:0,l:'No defined follow-up process'}"],
  ['cap removed: founder_only',      "founder_only:{s:5,l:'One person or the founder handles most enquiries',cap:true}",
                                     "founder_only:{s:5,l:'One person or the founder handles most enquiries'}"],
  ['cap removed: exploring',         "exploring:{s:0,l:'Mainly exploring options',cap:true}",
                                     "exploring:{s:0,l:'Mainly exploring options'}"],
  ['cap removed: undecided budget',  "undecided:{s:4,l:'Budget not decided',cap:true}",
                                     "undecided:{s:4,l:'Budget not decided'}"],
  ['threshold: qualified 65→55',     "} else if (score >= 65) {",   "} else if (score >= 55) {"],
  ['threshold: review 50→40',        "outcome = score >= 50 ? 'manual_review'", "outcome = score >= 40 ? 'manual_review'"],
  ['RERA gate removed',              "if (!restriction && answers.rera !== 'yes') restriction = 'rera_ineligible';", ""],
  ['premium exception: price dropped',  "var premium = answers.price_band === 'above_150';", "var premium = true;"],
  ['premium exception: budget dropped', "var funded  = ['above_3l','1_3l','ready_1l'].indexOf(answers.media_budget) > -1;", "var funded  = true;"],
  ['premium exception: sales team dropped', "&& team && score >= 65 && !cap)", "&& score >= 65 && !cap)"],
  ['completeness check removed',     "if (restriction || !complete) {", "if (restriction) {"],
  ['client verdict overrides server','var outcome = (saved && saved.outcome) || verdict.outcome;', 'var outcome = verdict.outcome;'],
  ['failed save treated as success', "if (!res.ok) throw new Error('Submission failed: ' + res.status);", ""],
  ['unconfigured endpoint fakes success', "throw new Error('No submission endpoint configured — lead not stored.');",
                                          "return {ok:true, outcome:'qualified'};"],
  ['score leaked into the DOM',      '<p class="q" id="q1">Which best describes your role and business?</p>',
                                     '<p class="q" id="q1">Which best describes your role and business? <span data-score="20">score 20</span></p>'],
  ['score leaked into analytics',    "track('qualification_outcome', {outcome: outcome, score_band: verdict.band}, true);",
                                     "track('qualification_outcome', {outcome: outcome, score_band: verdict.band, score: verdict.score}, true);"],
  ['booked_call fires on calendar load', "track('calendar_view', null, true); }",
                                         "track('calendar_view', null, true); track('booked_call', null, true); }"],
  ['primary_cta_click counts form nav', "if (el.closest('#lead-form')) return;", ""],
  ['duplicate id introduced',        '<div class="errbox" id="consent-err">', '<div class="errbox" id="submit-err">'],
  ['privacy link broken',            'href="privacy.html" target="_blank"',   'href="#" target="_blank"'],
  ['visible implementation text',    '<p class="hero__kicker">For regional residential developers</p>',
                                     '<p class="hero__kicker">For regional residential developers</p>","hero eyebrow'],
  ['label association broken',       '<label for="email">Work email</label>', '<label for="emial">Work email</label>'],
  ['tap target below 48px',          '.opt{\n  display:flex;align-items:center;gap:.8rem;padding:1rem 1.15rem;',
                                     '.opt{\n  display:flex;align-items:center;gap:.8rem;padding:.2rem .4rem;'],
  ['reading copy below 16px',        '--t-micro:.75rem; --t-label:.75rem; --t-small:1rem;',
                                     '--t-micro:.75rem; --t-label:.75rem; --t-small:.7rem;'],
  ['horizontal overflow introduced', '.wrap{width:var(--col);margin-inline:auto}',
                                     '.wrap{width:var(--col);margin-inline:auto}\n.leak__fig{min-width:820px}'],
];

const SUITES = ['tools/exhaustive.mjs','tools/qualification.mjs','tools/e2e.mjs',
                'tools/integrity.mjs','tools/score.mjs','tools/responsive.mjs'];

function runSuites() {
  for (const s of SUITES) {
    try { execSync(`node ${s}`, {stdio:'pipe', timeout:180000}); }
    catch { return s; }              // first suite to fail kills the mutation
  }
  return null;
}

copyFileSync(PAGE, BACKUP);
const original = readFileSync(PAGE, 'utf8');
let killed = 0, survived = [], skipped = [];

console.log(`\nseeding ${MUTATIONS.length} mutations\n`);
for (const [name, find, replace] of MUTATIONS) {
  if (!original.includes(find)) { skipped.push(name); console.log(`  SKIP  ${name} (anchor not found)`); continue; }
  writeFileSync(PAGE, original.replace(find, replace));
  const killer = runSuites();
  if (killer) { killed++; console.log(`  killed   ${name.padEnd(42)} ← ${killer.replace('tools/','')}`); }
  else { survived.push(name); console.log(`  SURVIVED ${name}`); }
}
writeFileSync(PAGE, original);
unlinkSync(BACKUP);

const scored = MUTATIONS.length - skipped.length;
console.log(`\nmutation score: ${killed}/${scored} = ${(killed/scored*100).toFixed(1)}%`);
if (skipped.length)  console.log(`skipped (anchor drift): ${skipped.length}`);
if (survived.length) { console.log('\nSURVIVING — these are gaps in the suite:'); survived.forEach(s => console.log('  ·', s)); }
process.exit(survived.length ? 1 : 0);
