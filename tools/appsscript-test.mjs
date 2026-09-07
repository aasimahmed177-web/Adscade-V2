#!/usr/bin/env node
/* google-apps-script/google-sheets-convex-mirror-v4.gs — doPost, run for real.
 *
 * WHY THIS EXISTS. The mirror gained six new columns for the Brokerage Content Engine.
 * The HEADERS array was updated and Convex began sending the six values, but doPost's
 * rowData was not, and upsertLead_ writes '' for any header it cannot find in rowData.
 * The result: six permanently blank columns, with Convex, the schema and every other
 * test passing. Nothing in this repo executed the receiver, so nothing caught it.
 *
 * The script runs inside Google's runtime, so it is executed here in a VM with the
 * handful of Google services it touches replaced by in-memory fakes. That is enough to
 * test the part that was actually wrong — the payload -> row mapping, the upsert, and
 * the secret check — against the REAL file, not a copy.
 *
 * What this does NOT prove: that the deployed Apps Script is this version, that the
 * spreadsheet binding works, or that the web app is reachable. Those need the live
 * deployment.
 */
import { readFileSync } from 'fs';
import vm from 'vm';

let fails = 0;
const t = (n, c, d = '') => { if (!c) fails++; console.log((c ? '  ok  ' : 'FAIL  ') + n + (d ? ` — ${d}` : '')); };

const SRC = 'google-apps-script/google-sheets-convex-mirror-v4.gs';

/* ── the smallest believable Google runtime ───────────────────────── */
function makeSandbox({ scriptProperties = {} } = {}) {
  // setupAdscade() writes this in the real project; without it getSpreadsheet_ throws
  // the "not configured" error rather than reaching the mapping under test.
  scriptProperties = { ADSCADE_SPREADSHEET_ID: 'test-sheet-id', ...scriptProperties };
  // A sheet is a 2-D array of cells plus the handful of methods the script calls.
  const cells = [];
  const at = (r, c) => { // 1-indexed, auto-extend
    while (cells.length < r) cells.push([]);
    const row = cells[r - 1];
    while (row.length < c) row.push('');
    return row;
  };

  const sheet = {
    getLastRow: () => cells.length,
    getLastColumn: () => cells.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(r, c, numRows = 1, numCols = 1) {
      return {
        getValues() {
          const out = [];
          for (let i = 0; i < numRows; i++) {
            const row = at(r + i, c + numCols - 1);
            out.push(row.slice(c - 1, c - 1 + numCols).map((v) => (v === undefined ? '' : v)));
          }
          return out;
        },
        setValues(values) {
          values.forEach((row, i) => {
            const target = at(r + i, c + row.length - 1);
            row.forEach((v, j) => { target[c - 1 + j] = v; });
          });
          return this;
        },
        setFontWeight() { return this; },
        createFilter() { return { }; },
        // findSubmissionRow_ locates an existing row with a TextFinder. Modelled on the
        // real one only as far as the script uses it: whole-cell match, first hit,
        // returning the absolute (1-indexed) sheet row. Getting this wrong in the fake
        // would make every upsert look like an append and hide the row-growth bug.
        createTextFinder(query) {
          let entireCell = false;
          const finder = {
            matchEntireCell(flag) { entireCell = flag; return finder; },
            findNext() {
              for (let i = 0; i < numRows; i++) {
                const row = at(r + i, c + numCols - 1);
                for (let j = 0; j < numCols; j++) {
                  const cell = String(row[c - 1 + j] ?? '');
                  const hit = entireCell ? cell === String(query) : cell.includes(String(query));
                  if (hit) {
                    const absoluteRow = r + i;
                    return { getRow: () => absoluteRow, getColumn: () => c + j };
                  }
                }
              }
              return null;
            },
          };
          return finder;
        },
      };
    },
    appendRow(values) {
      cells.push(values.slice());
    },
    setFrozenRows() {},
    getFilter: () => null,
    _cells: cells,
  };

  const sandbox = {
    console,
    Date,
    JSON,
    Math,
    String,
    Number,
    Object,
    Array,
    RegExp,
    Error,
    isNaN,
    LockService: {
      getScriptLock: () => ({ waitLock() {}, releaseLock() {} }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => (k in scriptProperties ? scriptProperties[k] : null),
        setProperty: () => {},
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      openById: () => spreadsheet,
      flush() {},
    },
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (text) => ({ _text: text, setMimeType() { return this; } }),
    },
    Utilities: {
      formatDate: (d) => new Date(d).toISOString(),
    },
    Session: { getScriptTimeZone: () => 'Asia/Dubai' },
  };

  const spreadsheet = {
    getSheetByName: (n) => (n === 'Leads' ? sheet : null),
    insertSheet: () => sheet,
  };

  vm.createContext(sandbox);
  vm.runInContext(readFileSync(SRC, 'utf8'), sandbox, { filename: SRC });
  // Top-level `const` in the script lives in its lexical scope, not on the global
  // object, so HEADERS has to be read back by evaluating it inside the same context.
  const evalIn = (expr) => vm.runInContext(expr, sandbox);
  return { sandbox, sheet, evalIn, HEADERS: evalIn('HEADERS') };
}

const post = (sandbox, payload) => {
  const res = sandbox.doPost({ postData: { contents: JSON.stringify(payload), type: 'application/json' } });
  return JSON.parse(res._text);
};

/** The sheet as an array of {header: value} objects. */
const rows = (sheet) => {
  const [headers, ...body] = sheet._cells;
  if (!headers) return [];
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
};

/* ── the payload Convex actually sends ────────────────────────────── */
const contentPayload = (over = {}) => ({
  sync_secret: 'test-secret',
  source: 'convex_mirror',
  convex_id: 'k17abc',
  submission_id: 'content-1',
  lead_timestamp: '2026-09-07T10:00:00.000Z',
  offer: 'brokerage_content_engine',
  name: 'Test Broker',
  email: 'Broker@Example.COM',
  phone: '+971501234567',
  active_inventory: '',
  monthly_media_budget: '',
  active_inventory_label: '',
  monthly_media_budget_label: '',
  company_name: 'Gulf Brokerage LLC',
  team_size: '10_19',
  team_size_label: '10–19 people',
  monthly_shoot: 'yes',
  content_qualified: true,
  device: 'mobile',
  landing_page: 'https://adscade.com/vsl-5-2/',
  referrer: '',
  utm_source: 'google',
  utm_medium: 'cpc',
  utm_campaign: 'vsl5_launch',
  utm_content: 'creative_a',
  utm_term: '',
  gclid: 'g-1',
  gbraid: 'gb-1',
  wbraid: '',
  consent: true,
  lead_status: 'submitted',
  calendly_status: 'not_booked',
  booked_once: false,
  calendly_booked_at: '',
  calendly_start_time: '',
  calendly_end_time: '',
  calendly_canceled_at: '',
  calendly_rescheduled: false,
  calendly_event_uri: '',
  calendly_invitee_uri: '',
  calendly_event_type_uri: '',
  calendly_questions_and_answers: '[]',
  calendly_last_synced_at: '',
  convex_status: 'stored',
  convex_updated_at: '2026-09-07T10:00:01.000Z',
  ...over,
});

const acquisitionPayload = (over = {}) => ({
  sync_secret: 'test-secret',
  source: 'convex_mirror',
  submission_id: 'acq-1',
  lead_timestamp: '2026-09-07T09:00:00.000Z',
  offer: 'real_estate_acquisition',
  name: 'Developer Co',
  email: 'dev@example.com',
  phone: '+919876543210',
  active_inventory: '50_99',
  monthly_media_budget: 'aed_5000_15000',
  active_inventory_label: '50–99',
  monthly_media_budget_label: 'AED 5,000–15,000',
  consent: true,
  lead_status: 'submitted',
  calendly_status: 'not_booked',
  convex_status: 'stored',
  ...over,
});

console.log(`\nreceiver: ${SRC}\n`);

/* ── the bug this file was written for ────────────────────────────── */
console.log('— the six content columns are actually written —');
{
  const { sandbox, sheet, HEADERS } = makeSandbox({ scriptProperties: { ADSCADE_SYNC_SECRET: 'test-secret' } });
  const res = post(sandbox, contentPayload());
  t('doPost stored the row', res.ok === true && res.stored === true, JSON.stringify(res));

  const r = rows(sheet)[0];
  t('offer', r.offer === 'brokerage_content_engine', r.offer);
  t('company_name', r.company_name === 'Gulf Brokerage LLC', r.company_name);
  t('team_size', r.team_size === '10_19', r.team_size);
  t('team_size_label', r.team_size_label === '10–19 people', r.team_size_label);
  t('monthly_shoot', r.monthly_shoot === 'yes', r.monthly_shoot);
  t('content_qualified', r.content_qualified === 'TRUE', r.content_qualified);

  t('every HEADERS column exists in the sheet',
    HEADERS.every((h) => h in r),
    HEADERS.filter((h) => !(h in r)).join(','));
  // The failure mode that started this: a header present but never populated.
  const blank = HEADERS.filter((h) => r[h] === '' &&
    ['offer', 'company_name', 'team_size', 'team_size_label', 'monthly_shoot', 'content_qualified'].includes(h));
  t('no content column is silently blank', blank.length === 0, blank.join(','));
}

/* ── the three states of content_qualified ────────────────────────── */
console.log('\n— content_qualified is three-state, not two —');
{
  const { sandbox, sheet } = makeSandbox();
  post(sandbox, contentPayload({ submission_id: 'q-true', content_qualified: true }));
  post(sandbox, contentPayload({ submission_id: 'q-false', content_qualified: false }));
  post(sandbox, acquisitionPayload({ submission_id: 'q-absent' }));

  const by = Object.fromEntries(rows(sheet).map((r) => [r.submission_id, r]));
  t('qualified content row -> TRUE', by['q-true'].content_qualified === 'TRUE');
  t('UNQUALIFIED content row -> FALSE, not blank',
    by['q-false'].content_qualified === 'FALSE', by['q-false'].content_qualified);
  t('acquisition row -> blank, not FALSE',
    by['q-absent'].content_qualified === '', JSON.stringify(by['q-absent'].content_qualified));

  // The reason blank and FALSE must differ: otherwise every acquisition lead reads as a
  // rejected application when the column is filtered.
  t('a filter on FALSE returns only the real rejection',
    rows(sheet).filter((r) => r.content_qualified === 'FALSE').length === 1);
}

/* ── acquisition rows are untouched ───────────────────────────────── */
console.log('\n— acquisition rows keep working —');
{
  const { sandbox, sheet } = makeSandbox();
  post(sandbox, acquisitionPayload());
  const r = rows(sheet)[0];
  t('active_inventory preserved', r.active_inventory === '50_99');
  t('monthly_media_budget preserved', r.monthly_media_budget === 'aed_5000_15000');
  t('labels preserved', r.monthly_media_budget_label === 'AED 5,000–15,000');
  t('content columns blank on an acquisition row',
    r.company_name === '' && r.team_size === '' && r.monthly_shoot === '');
  t('offer defaults to acquisition when the payload omits it', (() => {
    const p = acquisitionPayload({ submission_id: 'legacy' });
    delete p.offer;
    post(sandbox, p);
    return rows(sheet).find((x) => x.submission_id === 'legacy').offer === 'real_estate_acquisition';
  })());
}

/* ── the booking update must UPDATE, not append ───────────────────── */
console.log('\n— a later booking updates the same row —');
{
  const { sandbox, sheet } = makeSandbox();
  post(sandbox, contentPayload());
  t('one row after the lead', rows(sheet).length === 1);

  const booked = post(sandbox, contentPayload({
    calendly_status: 'booked',
    booked_once: true,
    calendly_booked_at: '2026-09-07T11:00:00.000Z',
    calendly_start_time: '2026-09-09T09:30:00.000Z',
    calendly_end_time: '2026-09-09T10:00:00.000Z',
    calendly_event_type_uri: 'https://api.calendly.com/event_types/CONTENT',
    calendly_invitee_uri: 'https://api.calendly.com/invitees/INV1',
  }));
  t('the booking update reports updated, not created',
    booked.action === 'updated', JSON.stringify(booked));
  t('STILL one row — the row count does not grow', rows(sheet).length === 1,
    String(rows(sheet).length));

  const r = rows(sheet)[0];
  t('calendly_status became booked', r.calendly_status === 'booked');
  t('booking time recorded', r.calendly_booked_at === '2026-09-07T11:00:00.000Z');
  t('event type recorded', r.calendly_event_type_uri.endsWith('/CONTENT'));
  t('the content answers survived the booking update',
    r.company_name === 'Gulf Brokerage LLC' && r.team_size === '10_19' &&
    r.content_qualified === 'TRUE');
}

/* ── formula neutralisation on the new fields ─────────────────────── */
console.log('\n— spreadsheet formula neutralisation —');
{
  const { sandbox, sheet } = makeSandbox();
  post(sandbox, contentPayload({
    submission_id: 'formula-1',
    company_name: '=HYPERLINK("http://evil","x")',
    name: '+cmd|calc',
  }));
  const r = rows(sheet)[0];
  t('company_name starting with = is escaped', r.company_name.startsWith("'="), r.company_name);
  t('name starting with + is escaped', r.name.startsWith("'+"), r.name);
}

/* ── the shared secret ────────────────────────────────────────────── */
console.log('\n— shared secret —');
{
  const { sandbox, sheet } = makeSandbox({ scriptProperties: { ADSCADE_SYNC_SECRET: 'right' } });
  const bad = post(sandbox, contentPayload({ sync_secret: 'wrong' }));
  t('a wrong secret is refused', bad.ok === false && bad.error === 'UNAUTHORIZED', JSON.stringify(bad));
  t('and nothing was written', rows(sheet).length === 0);

  const missing = post(sandbox, (() => { const p = contentPayload(); delete p.sync_secret; return p; })());
  t('a missing secret is refused when one is configured', missing.ok === false);

  const good = post(sandbox, contentPayload({ sync_secret: 'right' }));
  t('the right secret is accepted', good.ok === true && good.stored === true);
}
{
  // Documented behaviour, worth pinning: the check is skipped when unconfigured, so the
  // script stays compatible with an existing deployment that never had the property.
  const { sandbox } = makeSandbox({ scriptProperties: {} });
  const res = post(sandbox, contentPayload({ sync_secret: 'anything' }));
  t('with NO script property configured the secret check is skipped',
    res.ok === true, JSON.stringify(res));
}

/* ── malformed input ──────────────────────────────────────────────── */
console.log('\n— malformed input —');
{
  const { sandbox, sheet } = makeSandbox();
  const empty = sandbox.doPost({ postData: { contents: '{}', type: 'application/json' } });
  t('an empty payload is refused', JSON.parse(empty._text).error === 'EMPTY_PAYLOAD');
  const noId = post(sandbox, (() => { const p = contentPayload(); delete p.submission_id; return p; })());
  t('a payload with no submission_id is refused', noId.error === 'MISSING_SUBMISSION_ID');
  t('neither wrote a row', rows(sheet).length === 0);
}

/* ── header/value alignment ───────────────────────────────────────── */
console.log('\n— header order and alignment —');
{
  const { sandbox, sheet } = makeSandbox();
  post(sandbox, contentPayload());
  post(sandbox, acquisitionPayload());
  const headers = sheet._cells[0];
  t('headers are unique', new Set(headers).size === headers.length);
  t('every data row is the same width as the header row',
    sheet._cells.slice(1).every((r) => r.length <= headers.length));
  t('email is lowercased into the sheet',
    rows(sheet)[0].email === 'broker@example.com', rows(sheet)[0].email);
}

console.log(fails === 0
  ? '\nall Apps Script receiver tests passed\n'
  : `\n${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
