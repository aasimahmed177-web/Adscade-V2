#!/usr/bin/env node
/* Builds the two paste artefacts for WordPress:
     dist/home-widget.txt — the Elementor HTML widget body for /vsl-4/
     dist/head-tags.txt   — the <head> block (theme header injection)

   This is the ONLY place the local→Media-Library substitution is defined.
   tools/integrity.mjs validates the file this produces, not its own copy of the
   transform, so the two cannot drift apart. */
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { pathToFileURL } from 'url';

/** Deployed Convex production HTTP Action. Public by design; not a credential. */
export const LEAD_ENDPOINT = "https://pastel-minnow-203.convex.site/submit-lead";

export const WP = {
  // asim-ahmed.webp is retired — the founder section now uses a single designed poster
  // image (adscade-founder-*) instead of a live bio card with a separate photo.
  'assets/adscade-mark.png':  'https://adscade.com/wp-content/uploads/2026/07/logo.png',
  'assets/residential.webp':  'https://adscade.com/wp-content/uploads/2026/07/residential.webp',
  'assets/before-after.webp': 'https://adscade.com/wp-content/uploads/2026/07/before-after.webp',
  'assets/pipeline.webp':     'https://adscade.com/wp-content/uploads/2026/07/pipeline.webp',
  'assets/favicon.png':       'https://adscade.com/wp-content/uploads/2026/07/favicon.png',
  'assets/adscade-hero-mobile.webp':        'https://adscade.com/wp-content/uploads/2026/08/adscade-hero-mobile.webp',
  'assets/adscade-hero-desktop.webp':       'https://adscade.com/wp-content/uploads/2026/08/adscade-hero-desktop.webp',
  'assets/adscade-before-after-mobile.webp':'https://adscade.com/wp-content/uploads/2026/08/adscade-before-after-mobile.webp',
  'assets/adscade-pipeline-mobile.webp':    'https://adscade.com/wp-content/uploads/2026/08/adscade-pipeline-mobile.webp',
  'assets/adscade-founder-mobile.webp':     'https://adscade.com/wp-content/uploads/2026/08/adscade-founder-mobile.webp',
  'assets/adscade-founder-desktop.webp':    'https://adscade.com/wp-content/uploads/2026/08/adscade-founder-desktop.webp',
  'href="privacy.html"':      'href="/privacy/"',
  'href="terms.html"':        'href="/terms/"',
};

export function buildWidget(src) {
  // The <style> block plus the body contents — never the </head><body> boundary that a
  // naive slice would include, and never a document wrapper Elementor would reject.
  const i = src.indexOf('<style>'), j = src.indexOf('</style>') + 8;
  const k = src.indexOf('<body>') + 6, m = src.indexOf('</body>');
  if (i < 0 || j < 8 || k < 6 || m < 0) throw new Error('cannot locate style/body boundaries');
  let out = src.slice(i, j) + '\n' + src.slice(k, m);
  for (const [from, to] of Object.entries(WP)) out = out.split(from).join(to);
  // Strip HTML comments. They are build notes for whoever edits site/index.html — VSL
  // integration steps, end-card wording, rationale — and none of it belongs in the source
  // of a public page a competitor can read. CSS comments inside <style> are preserved,
  // because removing them safely needs a real CSS parser and they carry no instructions.
  const styleEnd = out.indexOf('</style>') + 8;
  out = out.slice(0, styleEnd) + out.slice(styleEnd).replace(/<!--[\s\S]*?-->/g, '');
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim() + '\n';
}

export function buildHead(src) {
  const i = src.indexOf('<head>') + 6, j = src.indexOf('<style>');
  let out = src.slice(i, j);
  for (const [from, to] of Object.entries(WP)) out = out.split(from).join(to);
  // charset and viewport are emitted by WordPress itself; a duplicate is harmless but noisy.
  out = out.split('\n').filter(l => !/<meta charset|name="viewport"/.test(l)).join('\n');
  // The one configuration value the page needs. It is a PUBLIC URL, not a secret — no
  // deploy key, token or admin key may ever be placed here or anywhere in WordPress.
  // CHANGED 18 Aug 2026: site/index.html's own <head> now carries this assignment
  // directly (the owner edits and reviews it there), so auto-appending a second one
  // unconditionally produced a duplicate <script> block in the shipped head tags —
  // harmless in effect (same value, last one wins) but wrong to ship. Only inject the
  // fallback if the source doesn't already set it.
  if (!/ADSCADE_LEAD_ENDPOINT\s*=/.test(out)) {
    out += `
<!-- Adscade lead endpoint — public HTTP Action URL, safe to publish. -->
<script>window.ADSCADE_LEAD_ENDPOINT = "${LEAD_ENDPOINT}";</script>`;
  }
  return out.trim() + '\n';
}

// pathToFileURL, not a template string: this repo path contains a space, which
// import.meta.url percent-encodes and a raw argv path does not.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const src = readFileSync('site/index.html', 'utf8');
  mkdirSync('dist', { recursive: true });
  const w = buildWidget(src), h = buildHead(src);
  writeFileSync('dist/home-widget.txt', w);
  writeFileSync('dist/head-tags.txt', h);
  console.log(`dist/home-widget.txt  ${(w.length / 1024).toFixed(1)} KB`);
  console.log(`dist/head-tags.txt    ${(h.length / 1024).toFixed(1)} KB`);
}
