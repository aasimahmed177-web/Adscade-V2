#!/usr/bin/env node
// Read-only diagnostics pinned to Adscade's production deployment. Never deploys,
// sets environment variables, creates a lead/booking, or writes a Sheet row.
// Run from an authenticated checkout: node tools/production-preflight.mjs
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const deployment = 'pastel-minnow-203';
const cli = fileURLToPath(new URL('../node_modules/convex/bin/main.js', import.meta.url));
const origin = 'https://adscade.com';
const endpoint = `https://${deployment}.convex.site/submit-content-lead`;
let ok = true;
function report(name, passed, detail) {
  if (!passed) ok = false;
  console.log(`${passed ? 'PASS' : 'CHECK'} ${name}: ${JSON.stringify(detail)}`);
}
function convex(args) {
  const result = spawnSync(process.execPath, [cli, ...args, '--deployment-name', deployment], {
    encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0' },
  });
  // Do not print stdout/stderr on failure: env get may contain a private webhook URL.
  return result.status === 0 ? result.stdout.trim() : null;
}
async function request(url, init) {
  try {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    return { response, text: await response.text() };
  } catch { return null; }
}
const parse = value => { try { return JSON.parse(value); } catch { return null; } };

console.log(`Adscade production diagnostics — ${deployment}`);
const [page, validation, cors, calendar] = await Promise.all([
  request(`${origin}/vsl-5-2/?adscade_check=${Date.now()}`),
  // Deliberately invalid: no submission ID, consent or contact fields; cannot save.
  request(endpoint, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{}' }),
  request(endpoint, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } }),
  request('https://calendly.com/aasim-ahmed177/brokerage-content-system-call'),
]);
const release = page?.text.match(/data-release=["']([^"']+)["']/)?.[1];
report('WordPress page release', page?.response.ok && release === '2026-09-08-open-booking', {
  http: page?.response.status ?? 'unreachable', release: release ?? 'not detected',
});
const metadata = {
  titles: (page?.text.match(/<title\b/gi) ?? []).length,
  descriptions: (page?.text.match(/<meta\b[^>]*name=["']description["']/gi) ?? []).length,
  canonicals: (page?.text.match(/<link\b[^>]*rel=["']canonical["']/gi) ?? []).length,
};
report('One set of page metadata', Object.values(metadata).every(count=>count===1), metadata);
report('Lead endpoint validation (no lead created)', validation?.response.status === 422 && parse(validation?.text)?.code === 'validation_error', {
  http: validation?.response.status ?? 'unreachable',
});
report('Browser CORS', cors?.response.status === 204 && cors.response.headers.get('access-control-allow-origin') === origin, {
  http: cors?.response.status ?? 'unreachable', allowedOrigin: cors?.response.headers.get('access-control-allow-origin'),
});
report('Calendly page reachable', calendar?.response.ok, { http: calendar?.response.status ?? 'unreachable' });

const listing = convex(['env', 'list', '--names-only']);
if (listing === null) {
  report('Production account access', false, 'Run this command in your authenticated Adscade-V2 checkout. No credentials need to be shared.');
} else {
  const names = new Set(listing.split('\n').map(s=>s.trim()).filter(s=>/^[A-Z][A-Z0-9_]*$/.test(s)));
  for (const name of ['CALENDLY_PAT','GOOGLE_SHEETS_WEBHOOK_URL','GOOGLE_SHEETS_SYNC_SECRET']) {
    report(name, names.has(name), names.has(name) ? 'set' : 'missing');
  }
  for (const name of ['ADSCADE_DEV_ORIGIN','CALENDLY_API_BASE']) {
    report(name, !names.has(name), names.has(name) ? 'remove from production' : 'absent');
  }
  for (const prefix of ['CALENDLY_', 'CALENDLY_CONTENT_']) {
    const configured = ['EVENT_TYPE_URI','SCHEDULING_URL','EVENT_TYPE_NAME'].some(suffix=>names.has(prefix+suffix));
    report(prefix + 'target configuration', configured, configured ? 'set' : 'missing');
  }
  const state = parse(convex(['run', 'calendly:getSyncState', '{}']));
  const age = state?.lastRunAt ? Math.max(0, Math.round((Date.now()-state.lastRunAt)/60_000)) : null;
  const offers = [...new Set((state?.calendlyTargets ?? []).flatMap(t=>t.offers ?? []))];
  report('Calendly sync', state?.lastRunOk === true && !state.lastError && age !== null && age <= 15 && offers.includes('brokerage_content_engine'), {
    lastRunOk: state?.lastRunOk ?? null, minutesSinceRun: age, offers, hasError: Boolean(state?.lastError),
  });
  const mirror = parse(convex(['run', 'admin:googleSheetsMirrorStatus', '{}']));
  report('Google Sheets mirror', mirror !== null && mirror.failed === 0 && mirror.pending === 0 && mirror.neverQueued === 0, mirror ?? 'query unavailable');

  const webhook = convex(['env', 'get', 'GOOGLE_SHEETS_WEBHOOK_URL']);
  if (webhook && /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(webhook)) {
    const health = await request(webhook);
    const data = parse(health?.text);
    report('Configured Apps Script receiver', health?.response.ok && data?.ok === true && data.configured === true && data.version === '2026-09-08-ordered-mirror', {
      http: health?.response.status ?? 'unreachable', configured: data?.configured ?? null, version: data?.version ?? 'not detected',
    });
  } else report('Configured Apps Script receiver', false, 'Missing or invalid /exec URL; its value is withheld.');
}
console.log('These checks do not create a live booking. Confirm one new application reaches Calendly and updates the same Sheet row after the five-minute sync.');
process.exitCode = ok ? 0 : 1;
