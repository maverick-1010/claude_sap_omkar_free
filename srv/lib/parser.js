'use strict';
// Reads an uploaded .xlsx / .csv into material objects (spec §3.2, §7.1).
// Pure: no database access. Structural problems throw ParseError (HTTP 400) and no rows are produced.
const ExcelJS = require('exceljs');
const { SHEETS, REQUIRED_COLUMNS, CODE_COLUMNS, NUMBER_COLUMNS, ORG_VIEWS, SHEET_OF_VIEW } = require('./template');

const MAX_MATERIALS = 5000;

class ParseError extends Error {
  constructor(message) { super(message); this.name = 'ParseError'; this.status = 400; }
}

// ---------------------------------------------------------------- readers: file -> { sheetName: { header: [], rows: [{ rowNo, cells: [] }] } }

// The streaming WorkbookReader of exceljs fails on small files (workbook.xml read after the sheets),
// so the workbook is loaded in memory; the 10 MB upload limit keeps this bounded.
async function readXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const known = new Map(Object.keys(SHEETS).map((n) => [n.toLowerCase(), n]));
  const tables = {};
  workbook.eachSheet((ws) => {
    const name = known.get(String(ws.name).trim().toLowerCase());
    if (!name) return;
    const table = tables[name] = { header: null, rows: [] };
    ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
      const cells = Array.from(row.values ?? []).slice(1).map(cellValue);
      if (!table.header) table.header = cells.map((c) => (c === null ? '' : String(c).trim()));
      else table.rows.push({ rowNo, cells });
    });
  });
  return tables;
}

function readCsv(buffer) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '');
  const firstLine = text.slice(0, Math.max(text.indexOf(LF), 0) || text.length);
  const delimiter = firstLine.includes(';') ? ';' : ',';
  const [head, ...body] = csvRecords(text, delimiter);
  if (!head) return {};
  return {
    CSV: {
      header: head.cells.map((h) => h.trim()),
      rows: body.map(({ rowNo, cells }) => ({ rowNo, cells: cells.map((c) => (c === '' ? null : c)) })),
    },
  };
}

// Minimal RFC 4180 reader with a configurable delimiter; skips empty lines, keeps the file line number
const LF = String.fromCharCode(10), CR = String.fromCharCode(13);

function csvRecords(text, delimiter) {
  const out = [];
  let cells = [], field = '', quoted = false, line = 1, start = 1;
  const endRecord = () => {
    cells.push(field); field = '';
    if (cells.length > 1 || cells[0] !== '') out.push({ rowNo: start, cells });
    cells = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else { if (c === LF) line++; field += c; }
    } else if (c === '"') quoted = true;
    else if (c === delimiter) { cells.push(field); field = ''; }
    else if (c === LF || c === CR) {
      if (c === CR && text[i + 1] === LF) i++;
      endRecord(); line++; start = line;
    } else field += c;
  }
  if (field !== '' || cells.length) endRecord();
  return out;
}

// ---------------------------------------------------------------- cell / column handling

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellValue(v.result);
    if ('text' in v) return cellValue(v.text);
    return null;                                          // error cells etc.
  }
  return v;
}

const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function distance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/** Maps header positions to template column names (case-insensitive, unknown columns ignored). */
function mapHeader(header, columns, required, label) {
  const index = {};
  const wanted = new Map(columns.map((c) => [c.toLowerCase(), c]));
  header.forEach((h, i) => {
    const col = wanted.get(h.toLowerCase());
    if (col && !(col in index)) index[col] = i;
  });
  for (const col of required) {
    if (col in index) continue;
    const unknown = header.filter((h) => h && !wanted.has(h.toLowerCase()) && distance(squash(h), squash(col)) <= 2);
    throw new ParseError(`Missing column ${col} on sheet ${label}${unknown.length ? ` (found "${unknown[0]}")` : ''}`);
  }
  return index;
}

function normalize(col, v, label, rowNo) {
  if (v === null || v === undefined) return null;
  if (NUMBER_COLUMNS.has(col)) {
    const n = typeof v === 'number' ? v : Number(String(v).trim().replace(/^$/, 'NaN'));
    if (!Number.isFinite(n)) throw new ParseError(`Invalid number "${v}" in column ${col} on sheet ${label}, row ${rowNo}`);
    return n;
  }
  const s = String(v).trim();
  if (s === '') return null;
  return CODE_COLUMNS.has(col) ? s.toUpperCase() : s;
}

function toRecords(table, columns, index, label) {
  const records = [];
  for (const { rowNo, cells } of table.rows) {
    if (cells.every((c) => c === null || String(c).trim() === '')) continue;      // blank line
    const rec = { rowNo };
    for (const col of columns) rec[col] = col in index ? normalize(col, cells[index[col]], label, rowNo) : null;
    records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------- assembly

/** sheets: { Basic: [rec], Plant: [rec], ... } -> materials in file order, orphans last */
function assemble(sheets) {
  const materials = [];
  const bySourceKey = new Map(), byRowNo = new Map();
  const blank = () => Object.fromEntries(ORG_VIEWS.map((v) => [v, []]));

  for (const rec of sheets.Basic) {
    const { rowNo, sourceKey, ...basic } = rec;
    const material = { sourceKey, rowNo, isOrphan: false, basic, ...blank() };
    materials.push(material);
    byRowNo.set(rowNo, material);
    if (sourceKey && !bySourceKey.has(sourceKey)) bySourceKey.set(sourceKey, material);   // duplicates: org rows join the first
  }

  for (const view of ORG_VIEWS) {
    for (const rec of sheets[SHEET_OF_VIEW[view]] ?? []) {
      const { rowNo, sourceKey, ownerRow, ...data } = rec;
      // flat CSV rows carry their own org data; sheet rows are linked by sourceKey (first Basic row wins)
      let material = ownerRow !== undefined ? byRowNo.get(ownerRow) : sourceKey ? bySourceKey.get(sourceKey) : null;
      if (!material) {                                                           // org row without a Basic row
        material = { sourceKey, rowNo, isOrphan: true, basic: {}, ...blank() };
        materials.push(material);
        if (sourceKey) bySourceKey.set(sourceKey, material);
      }
      material[view].push(data);
    }
  }
  return materials;
}

// Flat CSV: one organisational row per material; a view exists when one of its own columns is filled
const FLAT_VIEW_KEYS = {
  plant: ['plant', 'mrpType', 'mrpController', 'lotSizeKey', 'reorderPoint', 'procurementType', 'availabilityCheck'],
  storage: ['storageLocation'],
  sales: ['salesOrg', 'distributionChannel', 'taxClassification', 'itemCategoryGroup', 'deliveringPlant'],
  valuation: ['valuationArea', 'valuationClass', 'priceControl', 'standardPrice', 'movingAvgPrice', 'currency'],
  purchasing: ['orderUnit', 'grProcessingDays'],
};

function expandFlat(records) {
  const sheets = Object.fromEntries(Object.keys(SHEETS).map((n) => [n, []]));
  for (const rec of records) {
    sheets.Basic.push(Object.fromEntries(['rowNo', ...SHEETS.Basic.cols].map((c) => [c, rec[c] ?? null])));
    for (const [view, keys] of Object.entries(FLAT_VIEW_KEYS)) {
      if (!keys.some((k) => rec[k] !== null && rec[k] !== undefined)) continue;
      const cols = SHEETS[SHEET_OF_VIEW[view]].cols;
      sheets[SHEET_OF_VIEW[view]].push({ ...Object.fromEntries(['rowNo', ...cols].map((c) => [c, rec[c] ?? null])), ownerRow: rec.rowNo });
    }
  }
  return sheets;
}

// ---------------------------------------------------------------- entry point

async function parseFile(buffer, fileName) {
  const csv = /\.csv$/i.test(fileName ?? '');
  let tables;
  try {
    tables = csv ? readCsv(buffer) : await readXlsx(buffer);
  } catch (e) {
    if (e instanceof ParseError) throw e;
    throw new ParseError(`The file is not a valid ${csv ? '.csv' : '.xlsx'} file`);
  }

  let sheets;
  if (csv) {
    const table = tables.CSV;
    if (!table) throw new ParseError('The file contains no data rows');
    const allColumns = [...new Set(Object.values(SHEETS).flatMap((s) => s.cols))];
    const index = mapHeader(table.header, allColumns, REQUIRED_COLUMNS.Basic, 'Basic');
    sheets = expandFlat(toRecords(table, allColumns, index, 'Basic'));
  } else {
    if (!tables.Basic?.header) throw new ParseError('Missing sheet Basic');
    sheets = {};
    for (const [name, spec] of Object.entries(SHEETS)) {
      const table = tables[name];
      if (!table?.header) { sheets[name] = []; continue; }                       // org sheets are optional
      const index = mapHeader(table.header, spec.cols, REQUIRED_COLUMNS[name], name);
      sheets[name] = toRecords(table, spec.cols, index, name);
    }
  }

  if (sheets.Basic.length === 0) throw new ParseError('The file contains no data rows');
  if (sheets.Basic.length > MAX_MATERIALS) throw new ParseError('Maximum 5,000 materials per upload');
  return assemble(sheets);
}

module.exports = { parseFile, ParseError, MAX_MATERIALS, csvRecords };
