import { readFileSync } from 'fs';
import vm from 'vm';
const SRC = 'google-apps-script/google-sheets-convex-mirror-v4.gs';
/* ── the smallest believable Google runtime ───────────────────────── */
export function makeSandbox({ scriptProperties = {} } = {}) {
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

export const post = (sandbox, payload) => {
  const res = sandbox.doPost({ postData: { contents: JSON.stringify(payload), type: 'application/json' } });
  return JSON.parse(res._text);
};

/** The sheet as an array of {header: value} objects. */
export const rows = (sheet) => {
  const [headers, ...body] = sheet._cells;
  if (!headers) return [];
  return body.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])));
};

