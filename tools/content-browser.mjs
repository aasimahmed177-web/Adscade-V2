#!/usr/bin/env node
/* VSL-5 brokerage content funnel — a real browser driving the real page against the
   real Convex backend.

   Covers the brief's frontend requirements 14-20:
     14  stored + qualified          -> Calendly redirect
     15  stored + unqualified        -> not-fit state, NO redirect
     16  failed Convex request       -> error shown, NO redirect
     17  double click                -> exactly one stored lead
     18  attribution preserved through to the stored row
     19  phone absent from the Calendly URL
     20  mobile modal remains usable

   Plus the two things that would otherwise only be caught in production: that the page
   uses the SERVER's verdict rather than recomputing one, and that first-party telemetry
   records the canonical stages with the right offer and no PII.

   Prereqs: `npx convex dev` running; `npx http-server site -p 8788 -s`.
*/
import { chromium } from 'playwright';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, rmSync } from 'fs';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const SITE = (readFileSync('.env.local', 'utf8').match(/^CONVEX_SITE_URL=(.+)$/m) || [])[1]?.trim();
if (!SITE) { console.error('CONVEX_SITE_URL missing — is `npx convex dev` running?'); process.exit(2); }
const BASE = SITE.replace(/\/$/, '');
const LEAD_ENDPOINT = BASE + '/submit-content-lead';
const ORIGIN = process.env.ADSCADE_TEST_ORIGIN || 'http://127.0.0.1:8788';
const CALENDLY = 'https://calendly.com/adscade-test/brokerage-content-engine';

/**
 * site/vsl-5.html is an Elementor FRAGMENT: no <html>, <head> or viewport meta, because
 * WordPress supplies all three. Loading the bare fragment in a mobile context therefore
 * gets Chrome's fallback 980px layout viewport, and every `max-width:560px` rule — the
 * sticky dock, the stacked grids, the mobile tap targets — silently fails to apply.
 *
 * That is a harness artifact, not a page defect, and papering over it by testing at
 * 980px would mean the mobile assertions below tested nothing. So the shell WordPress
 * provides is reconstructed here, generated from the real file at run time so the two
 * can never drift apart, and served from the same origin so CORS behaves normally.
 */
const SHELL_PATH = 'site/.vsl-5-shell.html';
const SHELL_URL = ORIGIN + '/.vsl-5-shell.html';

function writeShell() {
  const fragment = readFileSync('site/vsl-5.html', 'utf8');
  writeFileSync(SHELL_PATH, `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Adscade — Brokerage Content Engine (test shell)</title>
</head><body>
${fragment}
</body></html>`);
}
writeShell();

const run = (fn, args) => {
  const out = execSync(`npx convex run --no-push internal.${fn} '${JSON.stringify(args ?? {})}'`,
    { stdio: ['pipe', 'pipe', 'pipe'] }).toString().trim();
  return out ? JSON.parse(out) : null;
};

const PREFIX = 'content-browser-';
// Rows created from this run onwards. The leak check at the end is scoped to this so it
// reports what THIS run failed to clean up, rather than failing on unrelated leftovers.
const RUN_STARTED_AT = Date.now();
const leadByEmail = (email) =>
  run('admin.listLeads', { limit: 200 }).filter((l) => l.normalisedEmail === email);

console.log(`\npage: ${SHELL_URL}\nendpoint: ${LEAD_ENDPOINT}\n`);
run('admin.purgeBySubmissionIdPrefix', { prefix: PREFIX });
run('funnel.purgeAllEvents');

const browser = await chromium.launch();

/**
 * One page, wired to the real backend. `breakBackend` makes the lead POST fail so the
 * error path can be exercised without a second deployment.
 */
async function openPage({ mobile = false, query = '', breakBackend = false } = {}) {
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
          userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' }
      : { viewport: { width: 1280, height: 900 } },
  );

  const telemetry = [];
  const leadPosts = [];
  const dataLayer = [];

  // The page is an Elementor fragment with no <head> of its own, so the WordPress
  // header snippet is simulated here — exactly the two globals the page reads.
  //
  // dataLayer pushes are mirrored out to Node as they happen. Reading window.dataLayer
  // after the run would return [] for any journey that ends at Calendly: the redirect
  // replaces the document, taking the array with it. That would silently turn every
  // GTM assertion into a no-op rather than a failure.
  await context.addInitScript(([endpoint, calendly, prefix]) => {
    window.ADSCADE_CONTENT_LEAD_ENDPOINT = endpoint;
    window.ADSCADE_CONTENT_CALENDLY_URL = calendly;

    // Stamp every generated id with a known prefix so cleanup can find these rows
    // exactly. admin.purgeTestLeads matches on user-agent, which cannot see the mobile
    // context: it sends a real iPhone UA, so those rows would survive every run and
    // accumulate in the dev database looking like genuine leads.
    if (window.crypto && crypto.randomUUID) {
      const real = crypto.randomUUID.bind(crypto);
      crypto.randomUUID = () => prefix + real().slice(0, 32);
    }

    window.dataLayer = [];
    const push = window.dataLayer.push.bind(window.dataLayer);
    window.dataLayer.push = function (...args) {
      for (const a of args) {
        try { if (window.__adscadeDlSink) window.__adscadeDlSink(JSON.stringify(a)); } catch (e) {}
      }
      return push(...args);
    };
  }, [LEAD_ENDPOINT, CALENDLY, PREFIX]);

  const page = await context.newPage();
  await page.exposeFunction('__adscadeDlSink', (json) => {
    try { dataLayer.push(JSON.parse(json)); } catch { /* ignore */ }
  });

  page.on('request', (req) => {
    const u = req.url();
    if (u.endsWith('/track-event')) {
      try { telemetry.push(JSON.parse(req.postData() || '{}')); } catch { /* ignore */ }
    }
    if (u.endsWith('/submit-content-lead')) leadPosts.push(req.postData());
  });

  if (breakBackend) {
    await page.route('**/submit-content-lead', (route) =>
      route.fulfill({ status: 500, contentType: 'application/json',
        body: JSON.stringify({ ok: false, code: 'server_error' }) }));
  }

  // Never actually leave for Calendly — capture the URL instead.
  const redirects = [];
  await page.route('https://calendly.com/**', (route) => {
    redirects.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>calendly stub</h1>' });
  });

  await page.goto(SHELL_URL + query, { waitUntil: 'domcontentloaded' });
  return { context, page, telemetry, leadPosts, redirects, dataLayer };
}

async function fillForm(page, { email, teamSize, monthlyShoot, phone = '+971 50 123 4567' }) {
  await page.click('.hero__action .js-content-cta');
  await page.waitForSelector('#content-modal:not([hidden])');
  await page.fill('#content-name', 'Test Broker');
  await page.fill('#content-email', email);
  await page.fill('#content-company', 'Gulf Brokerage LLC');
  await page.fill('#content-phone', phone);
  await page.check(`input[name="team_size"][value="${teamSize}"]`);
  await page.check(`input[name="monthly_shoot"][value="${monthlyShoot}"]`);
  await page.check('#content-consent');
}

/* ── 14: qualified -> Calendly ────────────────────────────────────── */
console.log('— 14. stored + qualified -> Calendly redirect —');
{
  const email = `qualified-${Date.now()}@adscade-test.com`;
  const { context, page, telemetry, redirects } = await openPage({ query: '?utm_source=google&utm_campaign=vsl5_launch&utm_content=creative_a&gclid=g-vsl5&gbraid=gb-vsl5' });
  await fillForm(page, { email, teamSize: '10_19', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  const rows = leadByEmail(email);
  t('exactly one lead stored', rows.length === 1, String(rows.length));
  t('server recorded it as qualified', rows[0]?.contentQualified === true);
  t('redirected to Calendly', redirects.length === 1, JSON.stringify(redirects));

  const url = new URL(redirects[0] ?? 'https://x.invalid');
  t('used the CONFIGURED Calendly url, not the hardcoded fallback',
    url.origin + url.pathname === CALENDLY, url.origin + url.pathname);
  t('name prefilled', url.searchParams.get('name') === 'Test Broker');
  t('email prefilled', url.searchParams.get('email') === email);

  /* ── 19: no phone in the Calendly URL ──────────────────────────── */
  const raw = redirects[0] ?? '';
  t('19. phone is NOT in the Calendly URL',
    !url.searchParams.has('phone') && !raw.includes('971') && !raw.includes('501234567'), raw);
  t('19. no other PII leaked into the URL',
    !raw.includes('Gulf') && !url.searchParams.has('teamSize') &&
    !url.searchParams.has('company') && !url.searchParams.has('monthlyShoot'), raw);
  t('safe campaign attribution IS forwarded',
    url.searchParams.get('utm_source') === 'google' &&
    url.searchParams.get('utm_campaign') === 'vsl5_launch');

  /* ── 18: attribution preserved into the stored row ─────────────── */
  t('18. utm attribution reached the lead row',
    rows[0]?.utmSource === 'google' && rows[0]?.utmCampaign === 'vsl5_launch' &&
    rows[0]?.utmContent === 'creative_a');
  t('18. gclid and gbraid reached the lead row',
    rows[0]?.gclid === 'g-vsl5' && rows[0]?.gbraid === 'gb-vsl5');
  t('18. landingPage recorded', String(rows[0]?.landingPage || '').includes('vsl-5'));

  /* ── telemetry ─────────────────────────────────────────────────── */
  const stages = telemetry.map((e) => e.eventName);
  for (const s of ['landing_page_view', 'initial_cta_click', 'lead_modal_open',
                   'lead_form_start', 'lead_form_submit', 'lead_form_stored',
                   'lead_qualified', 'calendly_redirect']) {
    t(`telemetry recorded ${s}`, stages.includes(s), JSON.stringify(stages));
  }
  t('every telemetry event carries the content offer',
    telemetry.length > 0 && telemetry.every((e) => e.offer === 'brokerage_content_engine'));
  t('one session id across the whole journey',
    new Set(telemetry.map((e) => e.sessionId)).size === 1);
  t('every event has a distinct eventId',
    new Set(telemetry.map((e) => e.eventId)).size === telemetry.length);

  const blob = JSON.stringify(telemetry);
  t('no PII anywhere in telemetry',
    !blob.includes(email) && !blob.includes('Test Broker') && !blob.includes('Gulf') &&
    !blob.includes('501234567') && !/"team_?[Ss]ize"/.test(blob) &&
    !/"monthly_?[Ss]hoot"/.test(blob) && !/"consent"/.test(blob), blob.slice(0, 400));

  t('landing_page_view fired exactly once',
    stages.filter((s) => s === 'landing_page_view').length === 1);

  await context.close();
}

/* ── 15: unqualified -> polite state, no redirect ─────────────────── */
console.log('\n— 15. stored + unqualified -> not-fit state, no redirect —');
{
  const email = `unqualified-${Date.now()}@adscade-test.com`;
  const { context, page, telemetry, redirects } = await openPage();
  await fillForm(page, { email, teamSize: '1_4', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  const rows = leadByEmail(email);
  t('the application is still stored', rows.length === 1, String(rows.length));
  t('server recorded it as NOT qualified', rows[0]?.contentQualified === false);
  t('no Calendly redirect happened', redirects.length === 0, JSON.stringify(redirects));
  t('still on the landing page', page.url().includes('vsl-5'), page.url());

  const text = await page.textContent('#content-lead-form');
  t('the polite not-fit message is shown',
    text.includes('established brokerages with an active sales team'), text.slice(-200));
  t('submit button reads "Application received"',
    (await page.textContent('#content-lead-form button[type=submit]')).trim() === 'Application received');
  t('no error state is shown',
    !(await page.locator('#submit-err').evaluate((el) => el.classList.contains('on'))));

  const stages = telemetry.map((e) => e.eventName);
  t('telemetry recorded lead_form_stored', stages.includes('lead_form_stored'));
  t('telemetry did NOT record lead_qualified', !stages.includes('lead_qualified'),
    JSON.stringify(stages));
  t('telemetry did NOT record calendly_redirect', !stages.includes('calendly_redirect'));

  await context.close();
}

/* ── the page must use the SERVER's verdict, not its own ──────────── */
console.log('\n— the page trusts the server, not its own arithmetic —');
{
  const email = `verdict-${Date.now()}@adscade-test.com`;
  const { context, page, redirects } = await openPage();

  // Answers that WOULD qualify (20_plus + yes), but the server is made to say otherwise.
  // A page that recomputed the verdict locally would redirect anyway; this one must not.
  await page.route('**/submit-content-lead', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ ...body, qualified: false }) });
  });

  await fillForm(page, { email, teamSize: '20_plus', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  t('no redirect when the SERVER says unqualified, despite qualifying answers',
    redirects.length === 0, JSON.stringify(redirects));
  t('the not-fit state is shown instead',
    (await page.textContent('#content-lead-form')).includes('established brokerages'));
  t('the row itself was still stored, and by the real server verdict',
    leadByEmail(email)[0]?.contentQualified === true);

  await context.close();
}

/* ── and the browser cannot smuggle a verdict in ──────────────────── */
console.log('\n— the browser cannot assert its own verdict —');
{
  const { context, page, leadPosts } = await openPage();
  await fillForm(page, { email: `nopayload-${Date.now()}@adscade-test.com`,
    teamSize: '5_9', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2000);

  const sent = JSON.parse(leadPosts[0] || '{}');
  t('payload contains no "qualified" key', !('qualified' in sent), JSON.stringify(Object.keys(sent)));
  t('payload contains no score/outcome/status',
    !('score' in sent) && !('outcome' in sent) && !('status' in sent));
  t('payload does send the two factual answers',
    sent.teamSize === '5_9' && sent.monthlyShoot === 'yes');
  t('payload offer is the non-geographic identifier',
    sent.offer === 'brokerage_content_engine', sent.offer);

  await context.close();
}

/* ── 16: backend failure -> error, no redirect ────────────────────── */
console.log('\n— 16. failed Convex request -> error shown, NO redirect —');
{
  const email = `failure-${Date.now()}@adscade-test.com`;
  const { context, page, redirects } = await openPage({ breakBackend: true });
  await fillForm(page, { email, teamSize: '20_plus', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  t('no lead was stored', leadByEmail(email).length === 0);
  t('no Calendly redirect happened', redirects.length === 0, JSON.stringify(redirects));
  t('the error message is visible',
    await page.locator('#submit-err').evaluate((el) => el.classList.contains('on')));
  t('the submit button is re-enabled so they can retry',
    await page.isEnabled('#content-lead-form button[type=submit]'));
  t('button label is restored',
    (await page.textContent('#content-lead-form button[type=submit]')).trim() === 'Choose My Time');

  // And a retry after recovery must work, reusing the same submissionId.
  await page.unroute('**/submit-content-lead');
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);
  t('a retry after recovery stores exactly one lead', leadByEmail(email).length === 1,
    String(leadByEmail(email).length));
  t('and then redirects', redirects.length === 1, JSON.stringify(redirects));

  await context.close();
}

/* ── 17: double submit -> one lead ────────────────────────────────── */
console.log('\n— 17. double-click submits once —');
{
  const email = `double-${Date.now()}@adscade-test.com`;
  const { context, page } = await openPage();
  await fillForm(page, { email, teamSize: '20_plus', monthlyShoot: 'yes' });

  const btn = page.locator('#content-lead-form button[type=submit]');
  await btn.click({ force: true });
  await btn.click({ force: true }).catch(() => {});
  await btn.click({ force: true }).catch(() => {});
  await page.waitForTimeout(3000);

  t('exactly one lead stored despite three clicks', leadByEmail(email).length === 1,
    String(leadByEmail(email).length));
  await context.close();
}

/* ── telemetry must never block the funnel ────────────────────────── */
console.log('\n— telemetry failure never blocks the application —');
{
  const email = `telemetry-down-${Date.now()}@adscade-test.com`;
  const { context, page, redirects } = await openPage();
  await page.route('**/track-event', (route) => route.abort('failed'));

  await fillForm(page, { email, teamSize: '10_19', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  t('lead still stored with telemetry hard-down', leadByEmail(email).length === 1);
  t('Calendly redirect still happened', redirects.length === 1, JSON.stringify(redirects));
  await context.close();
}

/* ── telemetry disabled when the endpoint cannot be derived ───────── */
console.log('\n— telemetry fails closed rather than posting to the lead endpoint —');
{
  const context = await browser.newContext();
  await context.addInitScript((endpoint) => {
    window.ADSCADE_CONTENT_LEAD_ENDPOINT = endpoint; // not a /submit-content-lead url
    window.dataLayer = [];
  }, 'https://example.invalid/some-other-path');
  const page = await context.newPage();
  const posts = [];
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()); });
  await page.goto(SHELL_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(600);

  const derived = await page.evaluate(() => window.__adscadeTrackEndpoint());
  t('derivation returns empty for an unrecognised endpoint', derived === '', derived);
  t('and nothing was POSTed anywhere', posts.length === 0, JSON.stringify(posts));
  await context.close();
}

/* ── 20: mobile modal remains usable ──────────────────────────────── */
console.log('\n— 20. mobile modal remains usable —');
{
  const email = `mobile-${Date.now()}@adscade-test.com`;
  const { context, page, redirects } = await openPage({ mobile: true });

  // The sticky dock deliberately hides itself while a real CTA is on screen, and the
  // hero CTA is on screen at the top of the page. Scroll past it first — that IS the
  // behaviour under test, so assert it rather than working around it.
  t('dock is hidden while the hero CTA is visible',
    await page.locator('#content-dock').evaluate((el) => el.classList.contains('hide')));
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await page.waitForTimeout(700);
  t('dock appears once no CTA is on screen',
    await page.locator('#content-dock .js-content-cta').isVisible());

  await page.click('#content-dock .js-content-cta');
  await page.waitForSelector('#content-modal:not([hidden])');

  const panel = await page.locator('.modal__panel').boundingBox();
  t('modal fits the 390px viewport', panel.width <= 390, JSON.stringify(panel));
  t('modal top is on screen', panel.y >= 0, String(panel.y));

  t('body scroll is locked behind the modal',
    await page.evaluate(() => document.body.classList.contains('modal-open')));
  t('sticky dock is hidden behind the modal',
    await page.locator('#content-dock').evaluate((el) =>
      getComputedStyle(el).transform !== 'none' || el.classList.contains('hide')));

  // Tap targets: the documented 44px floor.
  const small = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('#content-modal .opt, #content-modal .modal__x, #content-modal button[type=submit]')
      .forEach((el) => { const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 44) out.push((el.className || el.tagName) + ':' + Math.round(r.height)); });
    return out;
  });
  t('every modal control clears the 44px tap-target floor', small.length === 0, JSON.stringify(small));

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  t('no horizontal overflow on mobile', !overflow);

  // Escape closes and returns focus.
  await page.keyboard.press('Escape');
  t('Escape closes the modal', await page.locator('#content-modal').evaluate((el) => el.hidden));

  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight * 0.45));
  await page.waitForTimeout(700);
  await page.click('#content-dock .js-content-cta');
  await page.waitForSelector('#content-modal:not([hidden])');
  await page.fill('#content-name', 'Mobile Broker');
  await page.fill('#content-email', email);
  await page.fill('#content-company', 'Mobile Brokerage');
  await page.fill('#content-phone', '+971501234599');
  await page.check('input[name="team_size"][value="5_9"]');
  await page.check('input[name="monthly_shoot"][value="yes"]');
  await page.check('#content-consent');
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  t('a mobile visitor can complete the whole flow', leadByEmail(email).length === 1);
  t('and reaches Calendly', redirects.length === 1);
  t('the mobile row is tagged as mobile', leadByEmail(email)[0]?.deviceCategory === 'mobile',
    leadByEmail(email)[0]?.deviceCategory);

  await context.close();
}

/* ── frontend phone rule matches the backend exactly ──────────────── */
console.log('\n— the form enforces the same phone rule as the server —');
{
  // If these two ever disagree, a visitor gets a generic "could not save your details"
  // after submit instead of being corrected in the field they can fix.
  const { context, page, leadPosts } = await openPage();
  await page.click('.hero__action .js-content-cta');
  await page.waitForSelector('#content-modal:not([hidden])');

  const fillRest = async (email) => {
    await page.fill('#content-name', 'Phone Test');
    await page.fill('#content-email', email);
    await page.fill('#content-company', 'Phone Co');
    await page.check('input[name="team_size"][value="5_9"]');
    await page.check('input[name="monthly_shoot"][value="yes"]');
    await page.check('#content-consent');
  };
  await fillRest(`phone-${Date.now()}@adscade-test.com`);

  const rejected = ['0501234567', '9876543210', 'abcdefghij', '123',
                    'call me on +971501234567', '+++971501234567', '+0501234567'];
  for (const bad of rejected) {
    await page.fill('#content-phone', bad);
    await page.click('#content-lead-form button[type=submit]');
    await page.waitForTimeout(120);
    const marked = await page.locator('#content-phone').evaluate(
      (el) => el.closest('.field').classList.contains('invalid'));
    t(`form rejects ${JSON.stringify(bad)}`, marked && leadPosts.length === 0,
      `invalid=${marked} posts=${leadPosts.length}`);
  }
  t('nothing was submitted while the phone was invalid', leadPosts.length === 0,
    String(leadPosts.length));

  for (const good of ['+971501234567', '+971 50 123 4567', '00971501234567',
                      '+44 7700 900123']) {
    await page.fill('#content-phone', good);
    const marked = await page.locator('#content-phone').evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return el.closest('.field').classList.contains('invalid');
    });
    t(`form accepts ${JSON.stringify(good)}`, !marked);
  }

  // And the accepted one really does go through end to end.
  await page.fill('#content-phone', '+971501234567');
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);
  t('a country-coded number submits successfully', leadPosts.length === 1,
    String(leadPosts.length));

  await context.close();
}

/* ── client-side validation still gates submission ────────────────── */
console.log('\n— client-side validation still blocks an incomplete form —');
{
  const { context, page, leadPosts } = await openPage();
  await page.click('.hero__action .js-content-cta');
  await page.waitForSelector('#content-modal:not([hidden])');
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(500);
  t('an empty form POSTs nothing', leadPosts.length === 0, String(leadPosts.length));
  t('invalid fields are marked',
    (await page.locator('.field.invalid').count()) > 0);

  // Consent alone must still gate it.
  await page.fill('#content-name', 'X');
  await page.fill('#content-email', 'x@example.com');
  await page.fill('#content-company', 'C');
  await page.fill('#content-phone', '+971501234500');
  await page.check('input[name="team_size"][value="5_9"]');
  await page.check('input[name="monthly_shoot"][value="yes"]');
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(500);
  t('unchecked consent still blocks submission', leadPosts.length === 0, String(leadPosts.length));
  await context.close();
}

/* ── GTM dataLayer vocabulary is unchanged ────────────────────────── */
console.log('\n— the page keeps its own dataLayer event names —');
{
  const { context, page, dataLayer } = await openPage();
  await fillForm(page, { email: `dl-${Date.now()}@adscade-test.com`,
    teamSize: '5_9', monthlyShoot: 'yes' });
  await page.click('#content-lead-form button[type=submit]');
  await page.waitForTimeout(2500);

  const dl = dataLayer.map((e) => e.event);
  for (const e of ['content_landing_view', 'content_cta_click', 'content_form_open',
                   'content_form_start', 'content_application_submit',
                   'content_qualified_application', 'content_calendly_redirect']) {
    t(`dataLayer still pushes ${e}`, dl.includes(e), JSON.stringify(dl));
  }
  const pushes = JSON.stringify(dataLayer);
  t('dataLayer carries the non-geographic offer',
    pushes.includes('brokerage_content_engine') && !pushes.includes('dubai_brokerage'));
  t('no client-side verdict is pushed at submit time',
    !('qualified' in (dataLayer.find((e) => e.event === 'content_application_submit') || {})),
    JSON.stringify(dataLayer.find((e) => e.event === 'content_application_submit')));
  await context.close();
}

/* ── cleanup ──────────────────────────────────────────────────────── */
await browser.close();
console.log('\n— cleanup —');
{
  rmSync(SHELL_PATH, { force: true });
  t('generated test shell removed', true);
  run('admin.purgeTestLeads');           // desktop runs (HeadlessChrome UA)
  run('admin.purgeBySubmissionIdPrefix', { prefix: PREFIX }); // mobile runs (iPhone UA)
  run('funnel.purgeAllEvents');
  const left = run('admin.listLeads', { limit: 200 })
    .filter((l) => l.createdAt >= RUN_STARTED_AT &&
                   String(l.normalisedEmail).endsWith('@adscade-test.com'));
  t('every row this run created was cleaned up', left.length === 0,
    left.map((l) => l.normalisedEmail).join(','));
}

console.log(fails === 0
  ? '\nall VSL-5 browser tests passed\n'
  : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
