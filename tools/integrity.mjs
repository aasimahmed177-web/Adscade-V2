#!/usr/bin/env node
/**
 * HTML and rendered-text integrity (Phase 1).
 * Uses the browser's own parser — the most authoritative HTML parser available — plus
 * targeted source checks. Regex alone cannot see nesting, duplicate IDs or what a
 * visitor actually reads.
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const PAGE = 'site/index.html';
const src = readFileSync(PAGE, 'utf8');
const b = await chromium.launch();
const p = await (await b.newContext({viewport:{width:1280,height:900}})).newPage();
const pageErrors = [];
p.on('pageerror', e => pageErrors.push(String(e)));
await p.goto('file://' + process.cwd() + '/' + PAGE);
await p.waitForTimeout(700);

let fails = 0;
const t = (n, c, extra='') => { if (!c) fails++; console.log((c?'  ok  ':'FAIL  ')+n+(extra&&!c?'  → '+extra:'')); };

console.log('\n— rendered text —');

// Code fragments that must never reach a visitor. Each is a shape that has actually
// appeared in this project through a bad find/replace.
const visible = await p.evaluate(() => document.body.innerText);
const LEAKS = [
  ['unterminated string + label', /","[a-z ]+$/m],
  ['stray quote-comma-quote',     /"\s*,\s*"/],
  ['template literal marker',     /\$\{/],
  ['JS object fragment',          /\{s:\d+,l:'/],
  ['console/debug fragment',      /console\.(log|info|debug)/],
  ['TODO or FIXME',               /\b(TODO|FIXME|XXX|HACK)\b/],
  ['python repr',                 /\bok:\s|MISS:/],
  ['unreplaced placeholder',      /\b(LOREM|PLACEHOLDER|REPLACE_ME|VIDEO_ID|POSTER_URL)\b/],
];
for (const [label, re] of LEAKS) {
  const m = visible.match(re);
  t(`no ${label} in rendered text`, !m, m && JSON.stringify(m[0].slice(0,60)));
}

console.log('\n— document structure —');
const dom = await p.evaluate(() => {
  const ids = [...document.querySelectorAll('[id]')].map(e => e.id);
  const dupIds = ids.filter((v,i) => ids.indexOf(v) !== i);

  // form control names: radios legitimately repeat, other controls must not
  const named = [...document.querySelectorAll('input,select,textarea')]
    .filter(e => e.name && e.type !== 'radio').map(e => e.name);
  const dupNames = named.filter((v,i) => named.indexOf(v) !== i);

  const badFor = [...document.querySelectorAll('label[for]')]
    .filter(l => !document.getElementById(l.getAttribute('for')))
    .map(l => l.getAttribute('for'));

  const badControls = ['aria-controls','aria-labelledby','aria-describedby'].flatMap(attr =>
    [...document.querySelectorAll('['+attr+']')]
      .flatMap(e => e.getAttribute(attr).split(/\s+/).filter(id => id && !document.getElementById(id))
      .map(id => attr+'→'+id)));

  const emptyHrefs = [...document.querySelectorAll('a')]
    .filter(a => { const h = a.getAttribute('href'); return !h || h === '#' || h.trim() === ''; })
    .map(a => a.innerText.trim().slice(0,30));

  // every radio must be reachable by its whole row
  const looseRadios = [...document.querySelectorAll('input[type=radio]')]
    .filter(r => !r.closest('label')).length;

  return {
    h1: document.querySelectorAll('h1').length,
    dupIds: [...new Set(dupIds)], dupNames: [...new Set(dupNames)],
    badFor, badControls, emptyHrefs, looseRadios,
    unlabelledInputs: [...document.querySelectorAll('input:not([type=hidden])')]
      .filter(i => !i.closest('label') && !document.querySelector(`label[for="${i.id}"]`)).length,
  };
});

t('exactly one H1',                      dom.h1 === 1, `found ${dom.h1}`);
t('no duplicate element IDs',            dom.dupIds.length === 0, dom.dupIds.join(','));
t('no duplicate form-control names',     dom.dupNames.length === 0, dom.dupNames.join(','));
t('every label[for] resolves',           dom.badFor.length === 0, dom.badFor.join(','));
t('every aria reference resolves',       dom.badControls.length === 0, dom.badControls.join(','));
t('no empty or placeholder link targets',dom.emptyHrefs.length === 0, dom.emptyHrefs.join(' | '));
t('every radio row is a label',          dom.looseRadios === 0, `${dom.looseRadios} loose`);
t('every input is labelled',             dom.unlabelledInputs === 0, `${dom.unlabelledInputs} unlabelled`);

// The browser silently repairs bad nesting; comparing the source tag balance catches
// what the DOM would otherwise hide. Comments, <script> and <style> bodies are stripped
// first — the VIDEO INTEGRATION comment contains example <iframe>/<video> markup that is
// documentation, not document structure.
console.log('\n— markup well-formedness —');
const VOID = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);
const body = src.slice(src.indexOf('<body>') + 6, src.indexOf('</body>'))
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '');
const stack = [], mismatches = [];
for (const m of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
  const [, close, tag, self] = m;
  if (VOID.has(tag.toLowerCase()) || self === '/') continue;
  if (close) {
    const top = stack.pop();
    if (top !== tag.toLowerCase()) mismatches.push(`</${tag}> closed <${top||'nothing'}>`);
  } else stack.push(tag.toLowerCase());
}
t('all tags balanced and correctly nested', mismatches.length === 0 && stack.length === 0,
  (mismatches.slice(0,3).join('; ') || '') + (stack.length ? ` unclosed: ${stack.slice(0,3)}` : ''));

console.log('\n— production paste safety —');
// Validate the artefact that actually ships: the widget built for the WordPress paste,
// with asset paths substituted. Checking the source instead would pass while the paste
// file 404s every image — which is exactly the class of defect this catches.
const WP = {
  'assets/asim-ahmed.webp':   'https://adscade.com/wp-content/uploads/2026/07/aasim.webp',
  'assets/adscade-mark.png':  'https://adscade.com/wp-content/uploads/2026/07/logo.png',
  'assets/residential.webp':  'https://adscade.com/wp-content/uploads/2026/07/residential.webp',
  'assets/before-after.webp': 'https://adscade.com/wp-content/uploads/2026/07/before-after.webp',
  'assets/pipeline.webp':     'https://adscade.com/wp-content/uploads/2026/07/pipeline.webp',
  'href="privacy.html"':      'href="/privacy/"',
  'href="terms.html"':        'href="/terms/"',
};
// Build the widget exactly as the paste-file generator does: the <style> block plus
// the body contents, never the </head><body> boundary that a naive slice would include.
const _i = src.indexOf('<style>'), _j = src.indexOf('</style>') + 8;
const _k = src.indexOf('<body>') + 6, _m = src.indexOf('</body>');
let widget = src.slice(_i, _j) + '\n' + src.slice(_k, _m);
t('source uses relative asset paths (substitutable)', /(?:src|href)="assets\//.test(widget));
for (const [from, to] of Object.entries(WP)) widget = widget.split(from).join(to);

t('paste file has no local asset paths',   !/(?:src|href)="assets\//.test(widget));
t('paste file has no document wrapper',    !/<(html|head|body)[\s>]/i.test(widget) && !/<!doctype/i.test(widget));
t('paste file carries the storage adapter', /window\.ADSCADE_ENDPOINT/.test(widget));
// Scoring was removed on 31 Jul 2026 — every stored lead now reaches the calendar.
// What must be present instead is the CTA state machine and the modal.
t('paste file carries the CTA state machine', /leadStored/.test(widget));
t('paste file carries the lead modal',        /id="lead-modal"/.test(widget));
t('no scoring model remains',                 !/__adscadeEvaluate|score_band/.test(widget));
t('privacy link resolves to a WP path',     /href="\/privacy\/"/.test(widget));
t('terms link resolves to a WP path',       /href="\/terms\/"/.test(widget));
t('no hard-coded /vsl- path anywhere',      !/\/vsl-\d/.test(widget));
t('no development comment markers',         !/<!--\s*(TODO|DEBUG|FIXME)/i.test(widget));
t('no JavaScript errors on load',           pageErrors.length === 0, pageErrors.join(' | '));

await b.close();
console.log(fails ? `\n${fails} FAILED\n` : '\nall passed\n');
process.exit(fails ? 1 : 0);
