/** Local VSL-5 review. All backend, tracking and Calendly requests are intercepted.
 * Run: node tools/content-ui-review.mjs (requires Playwright Chromium).
 * Optional ADSCADE_REVIEW_ASSETS: downloaded hero.png, planning.png, logo.png,
 * fonts.css and font files, for repeatable offline visual review.
 * Optional ADSCADE_BROWSER_EXECUTABLE / ADSCADE_BROWSER_ARGS for a local browser.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = process.env.ADSCADE_REVIEW_ASSETS;
const output = process.env.ADSCADE_REVIEW_OUTPUT;
if (output) fs.mkdirSync(output, { recursive: true });
const fragment = fs.readFileSync(path.join(repo, 'site/vsl-5.html'), 'utf8');
const head = fs.readFileSync(path.join(repo, 'wordpress/vsl-5-head.html'), 'utf8');
const server = http.createServer((req, res) => {
  if (assets && req.url.startsWith('/font-')) {
    res.setHeader('Content-Type', 'font/woff2');
    res.end(fs.readFileSync(path.join(assets, path.basename(req.url))));
    return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{margin:0}.elementor-widget-container{transform:translateZ(0)}
    button{background:red;color:white;border-radius:30px}
    h2{color:red;font-family:Arial;font-size:30px}input{padding:20px}</style>
    ${head}</head><body><div class="elementor-widget-container">${fragment}</div></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const imageNames = {
  'ChatGPT-Image-Sep-5-2026-08_24_58-AM-1.png': 'hero.png',
  'ChatGPT-Image-Sep-5-2026-08_24_59-AM-2.png': 'planning.png',
  'logo.png': 'logo.png',
};
let checks = 0;
function check(value, message) { assert.ok(value, message); checks++; }
const results = [];
try {
  for (const [width, scenario] of [[1440, 'qualified'], [1024, 'retry'], [768, 'strict'], [390, 'open'], [320, 'not-stored']]) {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.ADSCADE_BROWSER_EXECUTABLE ? { executablePath: process.env.ADSCADE_BROWSER_EXECUTABLE } : {}),
      args: JSON.parse(process.env.ADSCADE_BROWSER_ARGS || '[]'),
    });
    try {
      const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 1000 }, isMobile: width < 500, hasTouch: width < 500 });
      const leads = [], telemetry = [], events = [], errors = [], redirects = [];
      // Deny unanticipated external requests. No live leads, events or bookings.
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === origin) return route.continue();
        if (url.hostname === 'adscade.com' && url.pathname.startsWith('/wp-content/')) {
          const name = imageNames[path.basename(url.pathname)];
          return assets && name ? route.fulfill({ path: path.join(assets, name) }) : route.continue();
        }
        if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') return route.continue();
        return route.abort();
      });
      if (assets) await context.route('https://fonts.googleapis.com/**', route => route.fulfill({
        contentType: 'text/css', body: fs.readFileSync(path.join(assets, 'fonts.css'), 'utf8').replaceAll('__ORIGIN__', origin),
      }));
      await context.route('**/track-event', route => {
        telemetry.push(route.request().postDataJSON());
        return route.fulfill({ contentType: 'application/json', body: '{"ok":true}' });
      });
      await context.route('**/submit-content-lead', async route => {
        leads.push(route.request().postDataJSON());
        await new Promise(resolve => setTimeout(resolve, 150));
        const failed = scenario === 'retry' && leads.length === 1;
        return route.fulfill({ status: failed ? 503 : 200, contentType: 'application/json', body: JSON.stringify({
          ok: !failed, stored: !failed && scenario !== 'not-stored', qualified: scenario === 'qualified' || scenario === 'retry',
        }) });
      });
      await context.route('https://calendly.com/**', route => {
        redirects.push(route.request().url());
        return route.fulfill({ contentType: 'text/html', body: '<title>Intercepted calendar</title><p>Calendar destination verified locally.</p>' });
      });
      const page = await context.newPage();
      page.on('pageerror', error => errors.push(error.message));
      await page.exposeFunction('captureEvent', event => events.push(event));
      await page.addInitScript(({ strict }) => {
        window.dataLayer = [];
        window.dataLayer.push = function(event) { window.captureEvent(event); return Array.prototype.push.call(this, event); };
        if (strict) window.ADSCADE_CONTENT_REQUIRE_QUALIFICATION = true;
      }, { strict: scenario === 'strict' });
      await page.goto(origin + '/?utm_source=review&utm_campaign=content', { waitUntil: 'domcontentloaded' });
      await page.evaluate(() => document.fonts.ready);
      for (const img of await page.locator('#adscade-content img').all()) {
        await img.scrollIntoViewIfNeeded();
        await img.evaluate(el => el.decode());
      }
      await page.evaluate(() => scrollTo(0, 0));
      await page.waitForTimeout(250);
      check(await page.evaluate(() => document.documentElement.scrollWidth === innerWidth), `No horizontal overflow at ${width}`);
      check(await page.locator('.hero__title').evaluate(el => getComputedStyle(el).fontFamily.includes('Instrument Serif')), 'Scoped headline font');
      if (output) {
        await page.screenshot({ path: `${output}/page-${width}.png`, fullPage: true });
        await page.screenshot({ path: `${output}/hero-${width}.png` });
      }
      const heroCTA = page.locator('.hero .js-content-cta');
      await heroCTA.click();
      check(await page.locator('#content-modal').isVisible(), 'CTA opens dialog');
      check(await page.locator('#adscade-content-overlay').evaluate(el => el.parentElement === document.body), 'Dialog escapes Elementor transform');
      const panel = page.locator('.modal__panel');
      const box = await panel.boundingBox();
      check(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= page.viewportSize().height, 'Dialog fits viewport');
      check(await page.locator('#adscade-content').evaluate(el => el.inert), 'Background inert while dialog open');
      if (output) await page.screenshot({ path: `${output}/form-${width}.png` });
      await page.locator('.modal__x').focus();
      await page.keyboard.press('Shift+Tab');
      check(await page.locator('button[type=submit]').evaluate(el => el === document.activeElement), 'Reverse tab wraps to submit');
      await page.keyboard.press('Tab');
      check(await page.locator('.modal__x').evaluate(el => el === document.activeElement), 'Forward tab wraps to close');
      await page.keyboard.press('Escape');
      check(await heroCTA.evaluate(el => el === document.activeElement), 'Escape restores opener focus');
      check(!(await page.locator('#adscade-content').evaluate(el => el.inert)), 'Background restored');
      for (const question of await page.locator('.faq__q').all()) {
        await question.click();
        const answer = page.locator('#' + await question.getAttribute('aria-controls'));
        check(await answer.isVisible(), 'FAQ expands');
        await question.click();
        check(!(await answer.isVisible()), 'FAQ collapses');
      }
      for (const cta of await page.locator('#adscade-content .js-content-cta').all()) {
        await cta.click();
        check(await page.locator('#content-modal').isVisible(), 'Every inline CTA opens form');
        await page.locator('.modal__x').click();
      }
      if (width <= 820) {
        await page.locator('#content-problem-title').scrollIntoViewIfNeeded();
        await page.waitForTimeout(350);
        const dock = page.locator('#content-dock');
        check(await dock.isVisible(), 'Mobile dock visible away from inline CTAs');
        const dockBox = await dock.boundingBox();
        check(Math.abs(dockBox.y + dockBox.height - page.viewportSize().height) < 2, 'Dock stays at viewport bottom through Elementor transforms');
        await dock.locator('.js-content-cta').click();
        check(await page.locator('#content-modal').isVisible(), 'Mobile dock opens form');
        await page.keyboard.press('Escape');
        await page.locator('#content-dock-x').click();
        check(!(await dock.isVisible()), 'Dock can be dismissed');
      }
      await heroCTA.click();
      const submit = page.locator('button[type=submit]');
      await submit.click();
      check(leads.length === 0, 'Invalid form never submits');
      check(await page.locator('#consent-err').isVisible(), 'Missing consent has a visible error');
      check(await page.locator('#content-name').evaluate(el => el === document.activeElement), 'First invalid field receives focus');
      await page.locator('#content-name').fill('Review Applicant');
      await page.locator('#content-company').fill('Review Brokerage');
      await page.locator('#content-email').fill('review@example.com');
      await page.locator('#content-phone').fill('501234567');
      await page.locator(`input[name=team_size][value="${scenario === 'qualified' ? '10_19' : '1_4'}"]`).check();
      await page.locator(`input[name=monthly_shoot][value="${scenario === 'qualified' ? 'yes' : 'no'}"]`).check();
      await page.locator('#content-consent').check();
      await submit.click();
      check(leads.length === 0, 'Unprefixed phone never submits');
      check(await page.locator('#content-phone').getAttribute('aria-invalid') === 'true', 'Phone error marks its input');
      await page.locator('#content-phone').fill('+971501234567');
      await submit.click();
      await page.locator('#content-lead-form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
      await page.waitForTimeout(400);
      check(leads.length === 1, 'Duplicate click does not duplicate request');
      if (scenario === 'retry') {
        check(await page.locator('#submit-err').isVisible() && redirects.length === 0, 'Failed save stays on form with error');
        await page.keyboard.press('Escape');
        await heroCTA.click();
        await submit.click();
        await page.waitForTimeout(400);
        check(leads.length === 2 && leads[0].submissionId === leads[1].submissionId, 'Retry after reopening retains submission ID');
      }
      if (scenario === 'not-stored') {
        check(await page.locator('#submit-err').isVisible() && redirects.length === 0, 'ok:true without stored:true never redirects');
      } else if (scenario === 'strict') {
        check(redirects.length === 0 && await submit.isDisabled(), 'Optional strict gate still holds unqualified applications');
      } else {
        await page.waitForURL('https://calendly.com/**');
        check(redirects.length === 1, 'Stored application opens calendar once');
        const url = new URL(redirects[0]);
        check(url.pathname === '/aasim-ahmed177/brokerage-content-system-call', 'Correct content calendar');
        check(url.searchParams.get('name') === 'Review Applicant' && url.searchParams.get('email') === 'review@example.com', 'Calendly prefills name and email');
        check(url.searchParams.get('utm_campaign') === 'content' && !url.searchParams.has('phone'), 'Attribution retained without phone in URL');
      }
      check(!Object.hasOwn(leads[0], 'qualified') && leads[0].consent === true, 'Payload preserves server-owned qualification and consent');
      const qualified = scenario === 'qualified' || scenario === 'retry';
      check(events.some(e => e.event === 'content_qualified_application') === qualified, 'Qualified conversion follows server verdict');
      check(telemetry.some(e => e.eventName === 'lead_qualified') === qualified, 'Canonical qualification follows server verdict');
      check(telemetry.every(e => !['name', 'email', 'phone', 'companyName', 'team_size', 'monthly_shoot'].some(k => Object.hasOwn(e, k))), 'Telemetry excludes lead answers and contact fields');
      check(errors.length === 0, 'No browser JavaScript errors');
      results.push({ width, scenario, requests: leads.length, redirects: redirects.length });
      await context.close();
    } finally { await browser.close(); }
  }
  console.log(JSON.stringify({ checks, results }, null, 2));
} finally { server.close(); }
