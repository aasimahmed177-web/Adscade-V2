#!/usr/bin/env node
// Actual Convex functions/HTTP router on convex-test's in-memory backend, a local
// Calendly HTTP server, and the actual Apps Script receiver on fake Google services.
// Does not contact a real account, book a meeting, or touch a live spreadsheet.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
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
const snapshots = [];
globalThis.fetch = async (url, init) => {
  const address = String(url);
  if (address === process.env.GOOGLE_SHEETS_WEBHOOK_URL) {
    const payload = JSON.parse(init.body);
    snapshots.push(payload);
    return Response.json(post(sheet.sandbox, payload));
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

// Optional full browser entry point: the actual Elementor widget talks to the actual
// Convex router above. Only external Google/Calendly services are simulated. Every
// request is intercepted; no browser request can create a live lead or booking.
async function submitInBrowser(id, email, answers) {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({
    headless: true,
    ...(process.env.ADSCADE_BROWSER_EXECUTABLE ? {executablePath:process.env.ADSCADE_BROWSER_EXECUTABLE} : {}),
    args: JSON.parse(process.env.ADSCADE_BROWSER_ARGS || '[]'),
  });
  try {
    const context = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
    let result, redirects = 0;
    const events = [], errors = [];
    const head = readFileSync('wordpress/vsl-5-head.html','utf8');
    const fragment = readFileSync('site/vsl-5.html','utf8');
    await context.route('**/*', async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.origin === 'https://adscade.com' && url.pathname === '/vsl-5-2/') {
        return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">${head}<body style="margin:0">${fragment}</body>`});
      }
      if (url.origin === 'https://pastel-minnow-203.convex.site' && url.pathname === '/submit-content-lead') {
        const response = await t.fetch(url.pathname, {method:req.method(),headers:await req.allHeaders(),body:req.postData()});
        result = {status:response.status,data:await response.json()};
        return route.fulfill({status:result.status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'https://adscade.com'},body:JSON.stringify(result.data)});
      }
      if (url.pathname === '/track-event') return route.fulfill({contentType:'application/json',body:'{"ok":true}'});
      if (url.origin === 'https://calendly.com') {
        redirects++;
        assert.equal(url.pathname,'/aasim-ahmed177/brokerage-content-system-call');
        assert.equal(url.searchParams.get('email'),email);
        assert.equal(url.searchParams.has('phone'),false);
        return route.fulfill({contentType:'text/html',body:'<title>Simulated Calendly</title>'});
      }
      return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error=>errors.push(error.message));
    await page.exposeFunction('captureAuditEvent', event=>events.push(event));
    await page.addInitScript(id=>{
      crypto.randomUUID=()=>id;
      window.ADSCADE_CONTENT_REQUIRE_QUALIFICATION=true; // deliberately stale header
      window.dataLayer=[];
      window.dataLayer.push=function(event){window.captureAuditEvent(event);return Array.prototype.push.call(this,event);};
    },id);
    await page.goto('https://adscade.com/vsl-5-2/', {waitUntil:'domcontentloaded'});
    await page.locator('.hero .js-content-cta').click();
    await page.locator('#content-name').fill('Workflow Test');
    await page.locator('#content-company').fill('Test Brokerage');
    await page.locator('#content-email').fill(email);
    await page.locator('#content-phone').fill('+971501234567');
    await page.locator(`input[name=team_size][value="${answers.teamSize}"]`).check();
    await page.locator(`input[name=monthly_shoot][value="${answers.monthlyShoot}"]`).check();
    await page.locator('#content-consent').check();
    await page.locator('button[type=submit]').click();
    await page.waitForURL('https://calendly.com/**');
    check('browser stores then redirects '+answers.teamSize+'/'+answers.monthlyShoot,
      result?.data.stored === true && result.data.submissionId === id && redirects === 1 && errors.length === 0);
    check('browser conversion follows real backend classification '+answers.teamSize+'/'+answers.monthlyShoot,
      events.some(e=>e.event==='content_qualified_application') === result.data.qualified);
    return result;
  } finally { await browser.close(); }
}

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
      const result = await (process.argv.includes('--browser') ? submitInBrowser : submit)(id, id+'@example.com', {teamSize,monthlyShoot});
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

  const oldSnapshot = snapshots.find(p => p.submission_id === 'workflow-content' && p.calendly_status === 'not_booked');
  const late = post(sheet.sandbox, oldSnapshot);
  check('late initial snapshot cannot undo cancellation', late.action === 'ignored_stale' && rows(sheet.sheet).find(r => r.submission_id === 'workflow-content').calendly_status === 'canceled');
  const current = await byId('workflow-content');
  await t.mutation(internal.sheets.recordFailure, {leadId:current._id,version:oldSnapshot.convex_sync_version,error:'late failure from obsolete snapshot'});
  check('obsolete request failure cannot reset newer sync health', (await byId('workflow-content')).googleSheetsSyncStatus === 'synced');
  await t.mutation(internal.sheets.recordFailure, {leadId:current._id,version:current.googleSheetsSyncVersion,error:'late failed duplicate after successful delivery'});
  check('failed duplicate cannot undo a successful delivery of the same version', (await byId('workflow-content')).googleSheetsSyncStatus === 'synced');
  await t.run(ctx => ctx.db.patch(current._id, {googleSheetsSyncStatus:'pending'}));
  await t.mutation(internal.sheets.markSuccess, {leadId:current._id,version:oldSnapshot.convex_sync_version});
  check('obsolete success cannot mark newer data synced', (await byId('workflow-content')).googleSheetsSyncStatus === 'pending');
  await t.mutation(internal.sheets.markSuccess, {leadId:current._id});
  check('in-flight legacy callback is accepted without marking newer data synced', (await byId('workflow-content')).googleSheetsSyncStatus === 'pending');
  await mirror('workflow-content');

  // Every answer combination can book. Reporting FALSE must not become TRUE just
  // because a small team (including the screenshot's 1_4/yes case) books a call.
  for (const teamSize of ['1_4','5_9','10_19','20_plus']) {
    for (const monthlyShoot of ['yes','no']) {
      const id = `matrix-${teamSize.replace('_','-')}-${monthlyShoot}`;
      await mirror(id);
      booking(content,id+'@example.com');
    }
  }
  await t.action(internal.calendly.sync,{});
  for (const teamSize of ['1_4','5_9','10_19','20_plus']) {
    for (const monthlyShoot of ['yes','no']) {
      const id = `matrix-${teamSize.replace('_','-')}-${monthlyShoot}`;
      const saved = await byId(id);
      const mirrored = await mirror(id);
      const expected = teamSize !== '1_4' && monthlyShoot === 'yes';
      check('booking and same-row Sheet update '+teamSize+'/'+monthlyShoot,
        saved.calendlyStatus === 'booked' && saved.contentQualified === expected &&
        mirrored.calendly_status === 'booked' && mirrored.content_qualified === (expected ? 'TRUE' : 'FALSE') &&
        rows(sheet.sheet).filter(r=>r.submission_id===id).length===1);
    }
  }
  check('successful recovery clears prior sync error', !(await t.query(internal.calendly.getSyncState,{})).lastError);
  delete process.env.CALENDLY_PAT;
  await t.action(internal.calendly.sync,{});
  const missingToken = await t.query(internal.calendly.getSyncState,{});
  check('missing token cannot leave a stale successful sync status', missingToken.lastRunOk === false && missingToken.lastError.includes('CALENDLY_PAT'));
  process.env.CALENDLY_PAT = state.token;

  // Opening booking to everyone makes total redirects larger than qualified leads.
  // Conversion percentages must intersect session cohorts, not divide unrelated totals.
  await t.run(async ctx => {
    for (const [sessionId, eventNames] of [
      ['audit-qualified', ['landing_page_view','lead_form_stored','lead_qualified','calendly_redirect']],
      ['audit-small-team', ['landing_page_view','lead_form_stored','calendly_redirect']],
      ['audit-missing-view', ['lead_form_stored','calendly_redirect']],
    ]) for (const eventName of eventNames) await ctx.db.insert('funnelEvents', {
      eventId: `${sessionId}-${eventName}`, sessionId, eventName, createdAt: Date.now(),
      offer: 'brokerage_content_engine',
    });
  });
  const funnel = await t.query(internal.admin.funnelSummary, {offer:'brokerage_content_engine'});
  check('qualified redirect rate uses only qualified sessions', funnel.conversion['qualified -> Calendly redirect'] === 100);
  check('missing upstream telemetry cannot inflate landing conversion', funnel.conversion['landing -> stored lead'] === 100);
  const breakdown = await t.query(internal.admin.funnelBreakdown, {offer:'brokerage_content_engine'});
  check('campaign breakdown uses intersecting sessions too', breakdown.groups[0].landingToStoredPct === 100);
  console.log(`\n${count} workflow checks passed (simulated external services).`);
} finally {
  // Let immediate queued mirrors settle before disposing of their test environment.
  await new Promise(resolve=>setTimeout(resolve,50));
  await t.finishInProgressScheduledFunctions();
  globalThis.fetch=realFetch;
  for (const key of envNames) oldEnv[key]===undefined ? delete process.env[key] : process.env[key]=oldEnv[key];
  await stop();
}
