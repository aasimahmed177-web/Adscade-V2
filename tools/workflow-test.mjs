#!/usr/bin/env node
// Actual Convex functions/HTTP router on convex-test's in-memory backend, a local
// Calendly HTTP server, and the actual Apps Script receiver on fake Google services.
// Does not contact a real account, book a meeting, or touch a live spreadsheet.
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { convexTest } from 'convex-test';
import schema from '../convex/schema.ts';
import { internal } from '../convex/_generated/api.js';
import { startMockCalendly, mockFixtures } from './calendlyMockServer.mjs';
import { makeSandbox, post, rows } from './lib/appsscript-harness.mjs';

const modules = Object.fromEntries(readdirSync('convex').filter(f => f.endsWith('.ts')).map(f => [
  './convex/' + f, () => import('../convex/' + f),
]));
modules['./convex/_generated/server.js'] = () => import('../convex/_generated/server.js');
const t = convexTest(schema, modules);
const { base, state, stop } = await startMockCalendly();
const fx = mockFixtures(base);
const sheet = makeSandbox({ scriptProperties: { ADSCADE_SYNC_SECRET: 'workflow-test-secret' } });
const realFetch = globalThis.fetch;
const envNames = ['CALENDLY_API_BASE', 'CALENDLY_PAT', 'CALENDLY_EVENT_TYPE_URI',
  'CALENDLY_CONTENT_EVENT_TYPE_URI', 'CALENDLY_CONTENT_SCHEDULING_URL',
  'GOOGLE_SHEETS_WEBHOOK_URL', 'GOOGLE_SHEETS_SYNC_SECRET'];
const oldEnv = Object.fromEntries(envNames.map(k => [k, process.env[k]]));
Object.assign(process.env, {
  CALENDLY_API_BASE: base, CALENDLY_PAT: state.token,
  GOOGLE_SHEETS_WEBHOOK_URL: 'https://script.google.com/macros/s/workflow-test/exec',
  GOOGLE_SHEETS_SYNC_SECRET: 'workflow-test-secret',
});
let failLookup = false, failInvitee = false;
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address === process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
    return Response.json(post(sheet.sandbox, JSON.parse(init.body)));
  }
  if (address.startsWith(base + '/event_types') && failLookup) return new Response('', { status: 503 });
  if (address.startsWith(base + '/invitees/') && failInvitee) return new Response('', { status: 503 });
  if (!address.startsWith(base + '/')) throw new Error('Unexpected external request in test: ' + address);
  return realFetch(url, init);
};

let count = 0;
function check(name, condition) { assert.ok(condition, name); count++; console.log('PASS ' + name); }
const leads = () => t.run(ctx => ctx.db.query('leads').collect());
const byId = async id => (await leads()).find(l => l.submissionId === id);
async function submit(id, email, overrides = {}, content = true) {
  const body = { submissionId: id, name: 'Workflow Test', email,
    phone: content ? '+971501234567' : '9876543210', consent: true,
    ...(content ? {companyName:'Test Brokerage',teamSize:'5_9',monthlyShoot:'yes'} :
      {activeInventory:'50_99',monthlyMediaBudget:'aed_5000_15000'}), ...overrides };
  const res = await t.fetch(content ? '/submit-content-lead' : '/submit-lead', {
    method:'POST', headers:{'Content-Type':'application/json',Origin:'https://adscade.com'},
    body:JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}
async function mirror(id) {
  await t.action(internal.sheets.syncLead, { leadId: (await byId(id))._id });
  return rows(sheet.sheet).find(r => r.submission_id === id);
}
const inMinutes = m => new Date(Date.now()+m*60000).toISOString();
function booking(type, email) {
  const event = fx.event(type.uri, {startTime:inMinutes(60),endTime:inMinutes(90)});
  const invitee = fx.invitee(event.uri, {email,name:'Workflow Test'});
  state.events.set(new URL(event.uri).pathname,event);
  state.invitees.set(new URL(invitee.uri).pathname,invitee);
  return {event,invitee};
}

try {
  const acq = fx.eventType('Acquisition'), content = fx.eventType('Content');
  state.eventTypes.push(acq,content);
  process.env.CALENDLY_EVENT_TYPE_URI = acq.uri;
  process.env.CALENDLY_CONTENT_EVENT_TYPE_URI = content.uri;

  for (const teamSize of ['1_4','5_9','10_19','20_plus']) {
    for (const monthlyShoot of ['yes','no']) {
      const id = `matrix-${teamSize.replace('_','-')}-${monthlyShoot}`;
      const result = await submit(id, id+'@example.com', {teamSize,monthlyShoot});
      check('qualification '+teamSize+'/'+monthlyShoot,
        result.status === 200 && result.data.qualified === (teamSize !== '1_4' && monthlyShoot === 'yes'));
    }
  }
  check('rejects browser verdict', (await submit('invalid-verdict','x@example.com',{qualified:true})).status === 400);
  check('rejects missing country code', (await submit('invalid-phone','x@example.com',{phone:'0501234567'})).status === 422);
  check('rejects false consent', (await submit('invalid-consent','x@example.com',{consent:false})).status === 422);

  const email='both@example.com';
  check('content lead stored', (await submit('workflow-content',email)).data.stored);
  await submit('workflow-acquisition',email,{},false); // newer, but must not steal content booking
  const initial = await mirror('workflow-content');
  check('initial Sheet row contains content values', initial.offer==='brokerage_content_engine' && initial.company_name==='Test Brokerage' && initial.content_qualified==='TRUE');
  const beforeCount=(await leads()).length;
  const retry=await submit('workflow-content',email);
  check('retry does not duplicate lead',retry.data.duplicate===true && (await leads()).length===beforeCount);

  const booked = booking(content,email);
  await t.action(internal.calendly.sync,{});
  check('content event matches content lead despite newer acquisition application', (await byId('workflow-content')).calendlyInviteeUri===booked.invitee.uri && (await byId('workflow-acquisition')).calendlyStatus==='not_booked');
  let row=await mirror('workflow-content');
  check('booking updates the same Sheet row', row.calendly_status==='booked' && rows(sheet.sheet).filter(r=>r.submission_id==='workflow-content').length===1);
  check('actual Calendly current_organization recorded', (await t.query(internal.calendly.getSyncState,{})).calendlyOrganizationUri===state.user.current_organization);

  // Discovery sees the new invitee before Pass B sees the canceled old invitee.
  // A second application must never steal the reschedule and emit a second conversion.
  await submit('workflow-later-content',email);
  const interim=booking(content,email);
  const moved=booking(content,email);
  interim.invitee.old_invitee=booked.invitee.uri;
  interim.invitee.status='canceled';interim.invitee.rescheduled=true;interim.invitee.new_invitee=moved.invitee.uri;
  interim.event.status='canceled';
  moved.invitee.old_invitee=interim.invitee.uri;
  booked.invitee.status='canceled';booked.invitee.rescheduled=true;booked.invitee.new_invitee=interim.invitee.uri;
  booked.event.status='canceled';
  await t.action(internal.calendly.sync,{});
  check('rapid reschedule chain remains on original lead', (await byId('workflow-content')).calendlyInviteeUri===moved.invitee.uri && (await byId('workflow-later-content')).calendlyStatus==='not_booked');
  check('reschedule does not duplicate conversion', (await t.run(ctx=>ctx.db.query('bookedCallEvents').collect())).length===1);
  row=await mirror('workflow-content');
  check('rescheduled Sheet row is updated',row.calendly_status==='rescheduled' && row.calendly_rescheduled==='TRUE');

  // An already-unmatched invitee should be reconsidered when the correct lead exists.
  booking(content,'late@example.com');
  await t.action(internal.calendly.sync,{});
  await submit('workflow-late','late@example.com');
  await t.action(internal.calendly.sync,{});
  check('previously unmatched booking recovers', (await byId('workflow-late')).calendlyStatus==='booked');
  check('unmatched diagnostic marked resolved', (await t.run(ctx=>ctx.db.query('calendlyUnmatched').collect())).find(x=>x.inviteeEmail==='late@example.com')?.resolved===true);

  // Failure of lookup for an unpinned offer must not stop pinned acquisition discovery.
  delete process.env.CALENDLY_CONTENT_EVENT_TYPE_URI;
  process.env.CALENDLY_CONTENT_SCHEDULING_URL='https://calendly.com/test/content';
  failLookup=true;
  booking(acq,email);
  await t.action(internal.calendly.sync,{});
  check('pinned calendar survives lookup outage', (await byId('workflow-acquisition')).calendlyStatus==='booked');
  check('lookup outage is reported', (await t.query(internal.calendly.getSyncState,{})).lastRunOk===false);
  failLookup=false;
  process.env.CALENDLY_CONTENT_EVENT_TYPE_URI=content.uri;
  failInvitee=true;
  await t.action(internal.calendly.sync,{});
  check('recheck failure does not claim success', (await t.query(internal.calendly.getSyncState,{})).lastRunOk===false);
  failInvitee=false;
  moved.invitee.status='canceled';moved.invitee.cancellation={canceled_at:new Date().toISOString()};moved.event.status='canceled';
  await t.action(internal.calendly.sync,{});
  row=await mirror('workflow-content');
  check('cancellation updates the same Sheet row',row.calendly_status==='canceled' && rows(sheet.sheet).filter(r=>r.submission_id==='workflow-content').length===1);
  console.log(`\n${count} workflow checks passed (simulated external services).`);
} finally {
  // Let immediate queued mirrors settle before disposing of their test environment.
  await new Promise(resolve=>setTimeout(resolve,50));
  await t.finishInProgressScheduledFunctions();
  globalThis.fetch=realFetch;
  for (const key of envNames) oldEnv[key]===undefined ? delete process.env[key] : process.env[key]=oldEnv[key];
  await stop();
}
