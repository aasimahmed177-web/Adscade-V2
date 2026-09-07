#!/usr/bin/env node
// Read-only. Requires an authenticated Convex CLI for this project. No deployment,
// env writes, lead writes, or booking creation. Never print the raw env listing.
import { spawnSync } from 'node:child_process';
const required = ['CALENDLY_PAT','GOOGLE_SHEETS_WEBHOOK_URL','GOOGLE_SHEETS_SYNC_SECRET'];
const forbidden = ['ADSCADE_DEV_ORIGIN','CALENDLY_API_BASE'];
const result = spawnSync('npx', ['convex','env','list','--names-only','--prod'], { encoding:'utf8' });
if (result.status !== 0) {
  console.error('Could not read production configuration. Authenticate Convex for Adscade-V2 in this environment; do not paste credentials into chat.');
  process.exit(1);
}
const names = new Set(result.stdout.split('\n').map(line => line.trim()).filter(line => /^[A-Z][A-Z0-9_]*$/.test(line)));
const present = name => names.has(name);
let ok = true;
for (const name of required) {
  const found = present(name); if (!found) ok=false;
  console.log(`${name}: ${found ? 'set' : 'MISSING'}`);
}
for (const name of forbidden) {
  const found = present(name); if (found) ok=false;
  console.log(`${name}: ${found ? 'MUST REMOVE for production' : 'absent'}`);
}
for (const names of [
  ['CALENDLY_EVENT_TYPE_URI','CALENDLY_SCHEDULING_URL','CALENDLY_EVENT_TYPE_NAME'],
  ['CALENDLY_CONTENT_EVENT_TYPE_URI','CALENDLY_CONTENT_SCHEDULING_URL','CALENDLY_CONTENT_EVENT_TYPE_NAME'],
]) {
  const found=names.some(present); if (!found) ok=false;
  console.log(`${names[0].includes('CONTENT') ? 'Content' : 'Acquisition'} event explicitly configured: ${found}`);
}
console.log('Presence checks only. Verify calendar resolution, matching Apps Script secret and one live booking separately.');
process.exitCode=ok ? 0 : 1;
