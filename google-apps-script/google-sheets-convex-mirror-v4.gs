/**
 * ADSCADE — CONVEX → GOOGLE SHEETS MIRROR v4
 *
 * Convex is the source of truth. The browser no longer writes to this webhook.
 * Convex POSTs the latest lead snapshot after:
 *   - a new lead is stored
 *   - Calendly booking is detected
 *   - cancellation is detected
 *   - reschedule is detected
 *
 * Rows are UPSERTED by submission_id, so the same lead is updated rather than duplicated.
 * Existing columns are preserved; missing booking columns are appended automatically.
 *
 * One-time setup:
 *   1. Run setupAdscade() manually once from this bound Apps Script project.
 *   2. Deploy / update the Web App as a NEW VERSION, Execute as: Me,
 *      Who has access: Anyone.
 *   3. Keep the /exec URL — Convex will use it as GOOGLE_SHEETS_WEBHOOK_URL.
 */

const SHEET_NAME = 'Leads';
const TIMEZONE = 'Asia/Dubai';
const SPREADSHEET_ID_PROPERTY = 'ADSCADE_SPREADSHEET_ID';
const SYNC_SECRET_PROPERTY = 'ADSCADE_SYNC_SECRET'; // optional hardening

// Keep the existing columns first so today's Sheet remains aligned. New mirror/booking
// columns are appended automatically when setupAdscade() or a webhook runs.
const HEADERS = [
  'submission_id',
  'lead_timestamp',
  'sheet_received_at',
  // Which funnel produced this row: real_estate_acquisition | brokerage_content_engine.
  // One sheet holds every offer — filter or pivot on this column. Rows mirrored before
  // this column existed arrive with it blank, which means real_estate_acquisition.
  'offer',
  'name',
  'email',
  'phone',
  // Acquisition (VSL-4) answers — blank on a content row.
  'active_inventory',
  'monthly_media_budget',
  // Brokerage Content Engine (VSL-5) answers — blank on an acquisition row.
  'company_name',
  'team_size',
  'monthly_shoot',
  // Convex's server-side qualification verdict for offers that gate the calendar.
  // Blank on offers that have no gate; TRUE/FALSE on content rows.
  'content_qualified',
  'device',
  'landing_page',
  'referrer',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'gclid',
  'gbraid',
  'wbraid',
  'consent',
  'convex_status',
  'convex_updated_at',
  'source',

  // Convex / booking mirror fields
  'lead_status',
  'calendly_status',
  'booked_once',
  'calendly_booked_at',
  'calendly_start_time',
  'calendly_end_time',
  'calendly_canceled_at',
  'calendly_rescheduled',
  'calendly_event_uri',
  'calendly_invitee_uri',
  'calendly_event_type_uri',
  'calendly_questions_and_answers',
  'calendly_last_synced_at',
  'convex_id',
  'mirror_last_updated_at',
  'active_inventory_label',
  'monthly_media_budget_label',
  'team_size_label'
];

function setupAdscade() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error(
      'Open the Google Sheet, then Extensions → Apps Script, and run setupAdscade() from that bound project.'
    );
  }

  PropertiesService.getScriptProperties()
    .setProperty(SPREADSHEET_ID_PROPERTY, ss.getId());

  const sheet = getLeadSheet_();
  const headers = ensureHeaders_(sheet);

  Logger.log('Adscade Convex mirror configured.');
  Logger.log('Spreadsheet ID: ' + ss.getId());
  Logger.log('Sheet tab: ' + sheet.getName());
  Logger.log('Columns: ' + headers.length);

  return { ok: true, spreadsheetId: ss.getId(), sheetName: sheet.getName() };
}

/** Optional: run manually to prove Apps Script can write/update the Sheet. */
function testConvexMirrorWrite() {
  const sheet = getLeadSheet_();
  const headers = ensureHeaders_(sheet);
  const id = 'CONVEX_MIRROR_TEST_' + Date.now();
  const nowIso = new Date().toISOString();

  upsertLead_(sheet, headers, {
    submission_id: id,
    lead_timestamp: nowIso,
    sheet_received_at: formatNow_(),
    name: 'Convex Mirror Test',
    email: 'test@example.com',
    phone: '',
    active_inventory: '50_99',
    monthly_media_budget: 'aed_5000_15000',
    device: 'manual_test',
    consent: 'TRUE',
    convex_status: 'stored',
    convex_updated_at: nowIso,
    source: 'manual_test',
    lead_status: 'submitted',
    calendly_status: 'not_booked',
    booked_once: 'FALSE',
    mirror_last_updated_at: nowIso
  });

  SpreadsheetApp.flush();
  Logger.log('Test mirror row written: ' + id);
}

function doGet() {
  const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  return jsonResponse_({
    ok: true,
    service: 'Adscade Convex → Google Sheets Mirror',
    configured: Boolean(id),
    sheetName: SHEET_NAME,
    timestamp: new Date().toISOString()
  });
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(15000);

    const payload = parseRequest_(e);
    if (!payload || Object.keys(payload).length === 0) {
      return jsonResponse_({ ok: false, stored: false, error: 'EMPTY_PAYLOAD' });
    }

    // Optional server-to-server secret. If the Script Property is not configured,
    // the endpoint stays backward-compatible with the existing deployment.
    const expectedSecret = PropertiesService.getScriptProperties().getProperty(SYNC_SECRET_PROPERTY);
    if (expectedSecret && clean_(payload.sync_secret) !== expectedSecret) {
      return jsonResponse_({ ok: false, stored: false, error: 'UNAUTHORIZED' });
    }

    const submissionId = clean_(payload.submission_id || payload.submissionId);
    if (!submissionId) {
      return jsonResponse_({ ok: false, stored: false, error: 'MISSING_SUBMISSION_ID' });
    }

    const sheet = getLeadSheet_();
    const headers = ensureHeaders_(sheet);
    const nowIso = new Date().toISOString();

    const rowData = {
      submission_id: submissionId,
      lead_timestamp: clean_(payload.lead_timestamp || payload.timestamp),
      sheet_received_at: formatNow_(),
      name: safeCell_(payload.name),
      email: safeCell_(clean_(payload.email).toLowerCase()),
      phone: safeCell_(payload.phone),
      active_inventory: safeCell_(payload.active_inventory || payload.activeInventory),
      monthly_media_budget: safeCell_(payload.monthly_media_budget || payload.monthlyMediaBudget),
      active_inventory_label: safeCell_(payload.active_inventory_label),
      monthly_media_budget_label: safeCell_(payload.monthly_media_budget_label),
      device: safeCell_(payload.device),
      landing_page: safeCell_(payload.landing_page || payload.landingPage),
      referrer: safeCell_(payload.referrer),
      utm_source: safeCell_(payload.utm_source),
      utm_medium: safeCell_(payload.utm_medium),
      utm_campaign: safeCell_(payload.utm_campaign),
      utm_content: safeCell_(payload.utm_content),
      utm_term: safeCell_(payload.utm_term),
      gclid: safeCell_(payload.gclid),
      gbraid: safeCell_(payload.gbraid),
      wbraid: safeCell_(payload.wbraid),
      consent: normalizeBoolean_(payload.consent),
      convex_status: safeCell_(payload.convex_status || 'stored'),
      convex_updated_at: clean_(payload.convex_updated_at || nowIso),
      source: safeCell_(payload.source || 'convex_mirror'),

      lead_status: safeCell_(payload.lead_status),
      calendly_status: safeCell_(payload.calendly_status || 'not_booked'),
      booked_once: normalizeBoolean_(payload.booked_once),
      calendly_booked_at: clean_(payload.calendly_booked_at),
      calendly_start_time: clean_(payload.calendly_start_time),
      calendly_end_time: clean_(payload.calendly_end_time),
      calendly_canceled_at: clean_(payload.calendly_canceled_at),
      calendly_rescheduled: normalizeBoolean_(payload.calendly_rescheduled),
      calendly_event_uri: safeCell_(payload.calendly_event_uri),
      calendly_invitee_uri: safeCell_(payload.calendly_invitee_uri),
      calendly_event_type_uri: safeCell_(payload.calendly_event_type_uri),
      calendly_questions_and_answers: safeCell_(payload.calendly_questions_and_answers),
      calendly_last_synced_at: clean_(payload.calendly_last_synced_at),
      convex_id: safeCell_(payload.convex_id),
      mirror_last_updated_at: nowIso
    };

    const action = upsertLead_(sheet, headers, rowData);
    SpreadsheetApp.flush();

    return jsonResponse_({
      ok: true,
      stored: true,
      action: action,
      submissionId: submissionId
    });
  } catch (err) {
    console.error(err);
    return jsonResponse_({
      ok: false,
      stored: false,
      error: String(err && err.message ? err.message : err)
    });
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function getSpreadsheet_() {
  const id = PropertiesService.getScriptProperties().getProperty(SPREADSHEET_ID_PROPERTY);
  if (!id) {
    throw new Error(
      'Spreadsheet is not configured. Run setupAdscade() once from the bound Apps Script editor, then redeploy.'
    );
  }
  return SpreadsheetApp.openById(id);
}

function getLeadSheet_() {
  const ss = getSpreadsheet_();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

/**
 * Preserve any existing column order and append only missing mirror columns.
 */
function ensureHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  } else {
    const width = Math.max(sheet.getLastColumn(), 1);
    const existing = sheet.getRange(1, 1, 1, width).getValues()[0]
      .map(function(v) { return clean_(v); });

    const missing = HEADERS.filter(function(header) {
      return existing.indexOf(header) === -1;
    });

    if (missing.length) {
      const start = existing.length + 1;
      sheet.getRange(1, start, 1, missing.length).setValues([missing]);
    }
  }

  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0]
    .map(function(v) { return clean_(v); });

  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (!sheet.getFilter() && sheet.getLastRow() >= 1) {
    sheet.getRange(1, 1, Math.max(sheet.getLastRow(), 1), headers.length).createFilter();
  }

  return headers;
}

function upsertLead_(sheet, headers, rowData) {
  const idCol = headers.indexOf('submission_id') + 1;
  if (idCol < 1) throw new Error('submission_id header is missing');

  const rowNumber = findSubmissionRow_(sheet, idCol, rowData.submission_id);
  if (!rowNumber) {
    const values = headers.map(function(header) {
      return rowData[header] !== undefined ? rowData[header] : '';
    });
    sheet.appendRow(values);
    return 'created';
  }

  const current = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  const next = current.slice();

  headers.forEach(function(header, i) {
    if (rowData[header] !== undefined) {
      // Convex sends a full snapshot. Empty values intentionally clear stale booking
      // fields (for example when data is normalized), so do not skip empty strings.
      next[i] = rowData[header];
    }
  });

  // Preserve the time of the very first Sheet receipt; mirror_last_updated_at carries
  // the current update time instead.
  const receivedIndex = headers.indexOf('sheet_received_at');
  if (receivedIndex >= 0 && current[receivedIndex]) next[receivedIndex] = current[receivedIndex];

  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([next]);
  return 'updated';
}

function findSubmissionRow_(sheet, idColumn, submissionId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  const range = sheet.getRange(2, idColumn, lastRow - 1, 1);
  const match = range.createTextFinder(submissionId).matchEntireCell(true).findNext();
  return match ? match.getRow() : null;
}

function parseRequest_(e) {
  if (!e) return null;

  if (e.postData && e.postData.contents) {
    try {
      const parsed = JSON.parse(e.postData.contents);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }

  const data = {};
  if (e.parameter) {
    Object.keys(e.parameter).forEach(function(key) { data[key] = e.parameter[key]; });
  }
  return data;
}

function clean_(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function safeCell_(value) {
  const s = clean_(value);
  // Prevent spreadsheet formula injection from user-controlled fields.
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function normalizeBoolean_(value) {
  return (value === true || value === 'true' || value === '1' || value === 1 || value === 'yes')
    ? 'TRUE'
    : 'FALSE';
}

function formatNow_() {
  return Utilities.formatDate(new Date(), TIMEZONE, 'yyyy-MM-dd HH:mm:ss');
}

function jsonResponse_(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
