'use strict';
/**
 * Generates the upload test files in test/uploads/ plus expected-results.json and test-cases.md.
 *
 *   node scripts/generate-test-uploads.js
 *
 * Deterministic: everything random comes from SEED. Each file derives its own generator from
 * SEED + file name, so adding a case to one file does not change the others.
 *
 * Adding a case: add one entry to CASES (data files), STRUCTURAL (rejected files) or FAULTS
 * (a reusable single-rule defect, also used by the volume file).
 *
 * Before writing anything, a reference validator (built from the seed CSVs, independent of the
 * declared expectations) is run over every generated file. The script aborts if it disagrees with
 * the declared expectations, which proves: valid codes exist in the value helps, and every error
 * case breaks exactly the rule(s) it declares.
 */
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const JSZip = require('jszip'); // dependency of exceljs

const SEED = 20261003;
const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'test', 'uploads');
const VOLUME_ROWS = 5000;
const VOLUME_INVALID = 250; // 5 %

// ---------------------------------------------------------------- utilities
const hash = s => [...s].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) | 0, 7);
function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const shuffle = (rng, arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
const round = (x, d) => Number(x.toFixed(d));
const pad = (n, w = 4) => String(n).padStart(w, '0');
const M = (fieldName, ruleCode, severity = 'ERROR') => ({ fieldName, ruleCode, severity });
const msgKey = m => `${m.fieldName}|${m.ruleCode}|${m.severity}`;
const sortMsgs = ms => [...ms].sort((a, b) => msgKey(a).localeCompare(msgKey(b)));
const statusOf = ms => (ms.some(m => m.severity === 'ERROR') ? 'ERROR' : ms.some(m => m.severity === 'WARNING') ? 'WARNING' : 'VALID');

function parseCsv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ''])));
}
const readSeed = rel => parseCsv(fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/^﻿/, ''));

// ---------------------------------------------------------------- seed data
const seed = (() => {
  const vh = {};
  for (const r of readSeed('test/data/mmc-ValueHelpCache.csv')) (vh[r.category] ??= new Map()).set(r.code, r.text);
  const rules = readSeed('db/data/mmc-ValidationRules.csv').filter(r => r.active === 'true');
  const mandatory = {};
  for (const r of readSeed('db/data/mmc-MaterialTypeViewConfig.csv'))
    if (r.mandatory === 'true') (mandatory[r.materialType] ??= []).push(r.view.toLowerCase());
  const existing = new Set(readSeed('test/data/mmc-ExistingMaterialCache.csv').map(r => r.materialNumber));
  return { vh, rules, mandatory, existing };
})();
const company = p => seed.vh.PLANT_COMPANY.get(p);
const currencyOf = p => seed.vh.COMPANY_CURRENCY.get(company(p));
const storageLocs = p => [...seed.vh.STORAGE_LOCATION.keys()].filter(c => c.startsWith(p + '/')).map(c => c.split('/')[1]);
const PLANTS = [...seed.vh.PLANT.keys()];
const SALES_ORGS = [...seed.vh.SALES_ORG.keys()];

// ---------------------------------------------------------------- template layout
const SHEETS = {
  Basic: { view: 'basic', entity: 'MaterialRequests', cols: ['sourceKey', 'materialNumber', 'materialType', 'industrySector', 'materialGroup', 'description', 'language', 'baseUnit', 'grossWeight', 'netWeight', 'weightUnit', 'ean'] },
  Plant: { view: 'plant', entity: 'MaterialPlantData', cols: ['sourceKey', 'plant', 'purchasingGroup', 'mrpType', 'mrpController', 'lotSizeKey', 'reorderPoint', 'procurementType', 'availabilityCheck'] },
  Storage: { view: 'storage', entity: 'MaterialStorageData', cols: ['sourceKey', 'plant', 'storageLocation'] },
  Sales: { view: 'sales', entity: 'MaterialSalesData', cols: ['sourceKey', 'salesOrg', 'distributionChannel', 'taxClassification', 'itemCategoryGroup', 'deliveringPlant'] },
  Valuation: { view: 'valuation', entity: 'MaterialValuationData', cols: ['sourceKey', 'valuationArea', 'valuationClass', 'priceControl', 'standardPrice', 'movingAvgPrice', 'currency'] },
  Purchasing: { view: 'purchasing', entity: 'MaterialPurchasingData', cols: ['sourceKey', 'plant', 'purchasingGroup', 'orderUnit', 'grProcessingDays'] },
};
const ORG_VIEWS = ['plant', 'storage', 'sales', 'valuation', 'purchasing'];
const SHEET_OF_VIEW = Object.fromEntries(Object.entries(SHEETS).map(([n, s]) => [s.view, n]));
const FLAT_COLS = [...new Set(Object.values(SHEETS).flatMap(s => s.cols))];

// ---------------------------------------------------------------- material factory
const TYPES = {
  FERT: { name: 'Finished product', sector: 'M', group: 'MG-FIN', uom: 'EA', pc: 'S', proc: 'E', pg: '003', vc: '7920', mrp: 'PD', ean: true },
  HALB: { name: 'Semifinished product', sector: 'C', group: 'MG-SEMI', uom: 'KG', pc: 'S', proc: 'E', pg: '001', vc: '7900', mrp: 'PD', ean: false },
  ROH: { name: 'Raw material', sector: 'C', group: 'MG-RAW', uom: 'KG', pc: 'V', proc: 'F', pg: '001', vc: '3000', mrp: 'VB', ean: false },
  HAWA: { name: 'Trading good', sector: 'M', group: 'MG-TRADE', uom: 'PC', pc: 'V', proc: 'F', pg: '003', vc: '3100', mrp: 'VB', ean: true },
  VERP: { name: 'Packaging', sector: 'P', group: 'MG-PACK', uom: 'BOX', pc: 'S', proc: 'F', pg: '002', vc: '3040', mrp: 'ND', ean: false },
};
const TYPE_KEYS = Object.keys(TYPES);
const WORDS = ['Alpha', 'Bravo', 'Cobalt', 'Delta', 'Echo', 'Falcon', 'Granite', 'Helix'];

const gtinCheck = d12 => { let s = 0; [...d12].reverse().forEach((c, i) => { s += Number(c) * (i % 2 === 0 ? 3 : 1); }); return (10 - (s % 10)) % 10; };
const gtinValid = s => gtinCheck(s.slice(0, -1)) === Number(s.slice(-1));
const makeEan = rng => { const d = '40' + Array.from({ length: 10 }, () => Math.floor(rng() * 10)).join(''); return d + gtinCheck(d); };

const newEnv = (file, start, fan) => ({ file, rng: mulberry32(SEED + hash(file)), counters: {}, start, fan });

/** Valid material; o.plants / o.salesOrgs override the default fan-out. */
function make(env, type, o = {}) {
  const t = TYPES[type], rng = env.rng;
  const seq = (env.counters[type] ??= env.start); env.counters[type] = seq + 1;
  const no = `TST-${type}-${pad(seq)}`;
  const fanP = env.fan(seq, rng), fanS = env.fan(seq + 1, rng);
  const rot = (list, n) => Array.from({ length: n }, (_, i) => list[(seq + i) % list.length]);
  const plants = o.plants ?? rot(PLANTS, fanP);
  const orgs = o.salesOrgs ?? rot(SALES_ORGS, Math.min(fanS, SALES_ORGS.length));
  const gross = round(rng() * 49 + 1, 3);
  const mandatory = seed.mandatory[type];
  const item = {
    sourceKey: no,
    basic: {
      sourceKey: no, materialNumber: no, materialType: type, industrySector: t.sector, materialGroup: t.group,
      description: `${t.name} ${pick(rng, WORDS)} ${pad(seq)}`.slice(0, 40), language: 'EN', baseUnit: t.uom,
      grossWeight: gross, netWeight: round(gross * 0.9, 3), weightUnit: 'KG', ean: t.ean ? makeEan(rng) : '',
    },
    plant: [], storage: [], sales: [], valuation: [], purchasing: [],
  };
  for (const p of plants) {
    item.plant.push({ sourceKey: no, plant: p, purchasingGroup: t.pg, mrpType: t.mrp, mrpController: `00${1 + (seq % 3)}`, lotSizeKey: 'EX',
      reorderPoint: t.mrp === 'VB' ? Math.floor(rng() * 200) + 10 : '', procurementType: t.proc, availabilityCheck: '01' });
    const locs = storageLocs(p);
    item.storage.push({ sourceKey: no, plant: p, storageLocation: locs[0] });
    if (locs.length > 1 && seq % 3 === 0) item.storage.push({ sourceKey: no, plant: p, storageLocation: locs[1] });
    const price = round(rng() * 499 + 1, 2);
    item.valuation.push({ sourceKey: no, valuationArea: p, valuationClass: t.vc, priceControl: t.pc,
      standardPrice: t.pc === 'S' ? price : '', movingAvgPrice: t.pc === 'V' ? price : '', currency: currencyOf(p) });
    item.purchasing.push({ sourceKey: no, plant: p, purchasingGroup: t.pg, orderUnit: t.uom, grProcessingDays: Math.floor(rng() * 5) });
  }
  for (const so of orgs)
    item.sales.push({ sourceKey: no, salesOrg: so, distributionChannel: seq % 2 ? '10' : '20', taxClassification: '1', itemCategoryGroup: 'NORM', deliveringPlant: so });
  // Only keep the views the type requires (the others are optional and left out)
  for (const v of ORG_VIEWS) if (!mandatory.includes(v)) item[v] = [];
  item._expect = [];
  return item;
}
const setKey = (item, key) => { item.sourceKey = key; for (const v of ['basic', ...ORG_VIEWS]) [].concat(item[v] ?? []).forEach(r => { if (r) r.sourceKey = key; }); };

// ---------------------------------------------------------------- reusable single-rule faults
const ALL = TYPE_KEYS, PRICED = ['FERT', 'HALB', 'ROH', 'HAWA'];
const priceField = i => (i.valuation[0].priceControl === 'S' ? 'standardPrice' : 'movingAvgPrice');
const FAULTS = {
  missingGroup: { types: ALL, desc: 'mandatory field materialGroup blank', mutate: i => { i.basic.materialGroup = ''; }, expect: () => [M('materialGroup', 'REQUIRED_MATERIALGROUP')] },
  badPlant: { types: ALL, csvDiffers: true, desc: 'plant 9999 not in value help', mutate: i => { i.plant[0].plant = '9999'; }, expect: () => [M('plant', 'LOOKUP_PLANT')] },
  dupExisting: { types: ALL, desc: 'duplicate of existing S/4 material', mutate: i => { i.basic.materialNumber = `EXS-${i.basic.materialType}-0001`; }, expect: () => [M('materialNumber', 'DUPLICATE_EXISTING')] },
  netGtGross: { types: ALL, desc: 'netWeight 6 > grossWeight 5', mutate: i => { i.basic.grossWeight = 5; i.basic.netWeight = 6; }, expect: () => [M('netWeight', 'NETWEIGHT_GT_GROSS')] },
  negWeight: { types: ALL, desc: 'negative grossWeight', mutate: i => { i.basic.grossWeight = -2; i.basic.netWeight = ''; }, expect: () => [M('grossWeight', 'RANGE_GROSSWEIGHT')] },
  longDesc: { types: ALL, desc: 'description 41 chars', mutate: i => { i.basic.description = 'Very long description exceeding the limit by one'.slice(0, 41); }, expect: () => [M('description', 'LENGTH_DESCRIPTION')] },
  eanCheck: { types: ALL, desc: 'EAN13 with wrong check digit', mutate: (i, env) => { const e = i.basic.ean || makeEan(env.rng); i.basic.ean = e.slice(0, 12) + ((Number(e[12]) + 1) % 10); }, expect: () => [M('ean', 'EAN_CHECKDIGIT')] },
  eanLength: { types: ALL, desc: 'EAN with 10 digits', mutate: i => { i.basic.ean = '4012345678'; }, expect: () => [M('ean', 'REGEX_EAN')] },
  missingView: { types: ALL, desc: 'mandatory Storage view missing', mutate: i => { i.storage = []; }, expect: () => [M('view', 'MISSING_VIEW')] },
  storageLoc: { types: ALL, plants: ['1010'], desc: 'storage location 0002 does not belong to plant 1010', mutate: i => { i.storage[0].storageLocation = '0002'; }, expect: () => [M('storageLocation', 'STORAGELOC_PLANT')] },
  currency: { types: ALL, desc: 'currency not the plant company-code currency', mutate: i => { i.valuation[0].currency = currencyOf(i.valuation[0].valuationArea) === 'EUR' ? 'USD' : 'EUR'; }, expect: () => [M('currency', 'CURRENCY_COMPANY')] },
  badUom: { types: ALL, desc: 'baseUnit XYZ not in value help', mutate: i => { i.basic.baseUnit = 'XYZ'; }, expect: () => [M('baseUnit', 'LOOKUP_BASEUNIT')] },
  negPrice: { types: ALL, desc: 'negative price', mutate: i => { i.valuation[0][priceField(i)] = -10; }, expect: i => [M(priceField(i), `RANGE_${priceField(i).toUpperCase()}`)] },
  priceWarn: { types: PRICED, warning: true, desc: 'price control inconsistent with material type', mutate: i => {
    const v = i.valuation[0], p = v.priceControl === 'S' ? v.standardPrice : v.movingAvgPrice;
    if (v.priceControl === 'S') { v.priceControl = 'V'; v.movingAvgPrice = p; v.standardPrice = ''; } else { v.priceControl = 'S'; v.standardPrice = p; v.movingAvgPrice = ''; }
  }, expect: () => [M('priceControl', 'PRICECTRL_MTYPE', 'WARNING')] },
};
function applyFault(env, item, name) {
  const f = FAULTS[name]; f.mutate(item, env); item._expect = f.expect(item); item._csvDiffers = !!f.csvDiffers; return item;
}
const faulty = (type, fault) => env => [applyFault(env, make(env, type, { plants: FAULTS[fault].plants }), fault)];

// structural cases that need more than one mutation
function buildDupKey(env) {
  const a = make(env, 'ROH'), b = make(env, 'ROH');
  const bOnly = { sourceKey: a.sourceKey, basic: { ...b.basic, sourceKey: a.sourceKey }, plant: [], storage: [], sales: [], valuation: [], purchasing: [], _expect: [] };
  a._expect = [M('sourceKey', 'DUPLICATE_SOURCEKEY')]; bOnly._expect = [M('sourceKey', 'DUPLICATE_SOURCEKEY')];
  return [a, bOnly]; // both Basic rows share a's org rows
}
function buildOrphan(env) {
  const m = make(env, 'ROH'); const key = 'TST-ORPHAN-0001';
  const o = { sourceKey: key, basic: null, plant: [{ ...m.plant[0], sourceKey: key }], storage: [], sales: [], valuation: [], purchasing: [], _expect: [M('sourceKey', 'ORPHAN_ROW')], _noCsv: true };
  return [o];
}

// ---------------------------------------------------------------- case table (data files)
const fan1 = () => 1;
const fanSome = seq => (seq % 7 === 0 ? 3 : seq % 5 === 0 ? 2 : 1);
const fanRandom = (seq, rng) => 1 + Math.floor(rng() * 3);
const FILES = {
  'happy-path.xlsx': { start: 1, fan: fanSome },
  'validation-errors.xlsx': { start: 101, fan: fan1 },
  'edge-cases.xlsx': { start: 201, fan: fan1, shuffle: true, extra: { Basic: ['legacyId'] } },
  'volume-5000.xlsx': { start: 1001, fan: fanRandom },
};
const CASES = [
  // 1. happy path: 25 valid materials; every 5th has 2 plants/sales orgs, every 7th has 3
  { id: 'H-FERT', file: 'happy-path.xlsx', count: 7, type: 'FERT', desc: 'valid finished product' },
  { id: 'H-HALB', file: 'happy-path.xlsx', count: 4, type: 'HALB', desc: 'valid semifinished product' },
  { id: 'H-ROH', file: 'happy-path.xlsx', count: 5, type: 'ROH', desc: 'valid raw material' },
  { id: 'H-HAWA', file: 'happy-path.xlsx', count: 6, type: 'HAWA', desc: 'valid trading good' },
  { id: 'H-VERP', file: 'happy-path.xlsx', count: 3, type: 'VERP', desc: 'valid packaging' },
  // 2. validation errors: each fails exactly one rule
  { id: 'E01', file: 'validation-errors.xlsx', type: 'FERT', fault: 'missingGroup' },
  { id: 'E02', file: 'validation-errors.xlsx', type: 'HALB', fault: 'badPlant' },
  { id: 'E03', file: 'validation-errors.xlsx', build: buildDupKey, desc: 'duplicate sourceKey within the file (2 Basic rows)' },
  { id: 'E04', file: 'validation-errors.xlsx', type: 'HAWA', fault: 'dupExisting' },
  { id: 'E05', file: 'validation-errors.xlsx', type: 'FERT', fault: 'netGtGross' },
  { id: 'E06', file: 'validation-errors.xlsx', type: 'ROH', fault: 'negWeight' },
  { id: 'E07', file: 'validation-errors.xlsx', type: 'HALB', fault: 'longDesc' },
  { id: 'E08', file: 'validation-errors.xlsx', type: 'FERT', fault: 'eanCheck' },
  { id: 'E09', file: 'validation-errors.xlsx', type: 'HAWA', fault: 'missingView' },
  { id: 'E10', file: 'validation-errors.xlsx', build: buildOrphan, desc: 'org row whose sourceKey has no Basic row (xlsx only)' },
  { id: 'E11', file: 'validation-errors.xlsx', type: 'ROH', fault: 'storageLoc' },
  { id: 'E12', file: 'validation-errors.xlsx', type: 'FERT', fault: 'currency' },
  { id: 'E13', file: 'validation-errors.xlsx', type: 'FERT', fault: 'priceWarn' },
  { id: 'E14', file: 'validation-errors.xlsx', type: 'HALB', fault: 'badUom' },
  { id: 'E15', file: 'validation-errors.xlsx', type: 'FERT', fault: 'negPrice' },
  { id: 'E16', file: 'validation-errors.xlsx', type: 'HAWA', fault: 'eanLength' },
  { id: 'E17', file: 'validation-errors.xlsx', type: 'ROH', fault: 'priceWarn' },
  { id: 'V01', file: 'validation-errors.xlsx', type: 'VERP', desc: 'valid row in mixed file' },
  { id: 'V02', file: 'validation-errors.xlsx', type: 'FERT', desc: 'valid row in mixed file' },
  // 3. edge cases: all accepted (VALID); expectedValues = normalised values the app should store
  { id: 'G01', file: 'edge-cases.xlsx', type: 'FERT', desc: 'description exactly 40 chars',
    edit: i => { i.basic.description = ('Forty-character description ' + '1234567890123456789').slice(0, 40); } },
  { id: 'G02', file: 'edge-cases.xlsx', type: 'HALB', desc: 'German characters', edit: i => { i.basic.description = 'Größenverstellbare Schraube ÄÖÜ äöü ß'; i.basic.language = 'DE'; } },
  { id: 'G03', file: 'edge-cases.xlsx', type: 'ROH', desc: 'French characters', edit: i => { i.basic.description = 'Crème brûlée à la française éàçùêô'; i.basic.language = 'FR'; } },
  { id: 'G04', file: 'edge-cases.xlsx', type: 'HAWA', desc: 'Japanese characters', edit: i => { i.basic.description = '六角ボルト M8×40 ステンレス製 ISO 4017'; i.basic.language = 'JA'; } },
  { id: 'G05', file: 'edge-cases.xlsx', type: 'FERT', desc: 'leading/trailing spaces are trimmed',
    edit: i => { i.basic.materialType = ' FERT '; i.basic.baseUnit = ' EA '; i.basic.description = '  Padded description  '; i.plant[0].plant = ' 1000 '; },
    expectedValues: { materialType: 'FERT', baseUnit: 'EA', description: 'Padded description' } },
  { id: 'G06', file: 'edge-cases.xlsx', type: 'VERP', desc: 'material number with leading zeros stored as text (exception to the TST- pattern; sourceKey keeps it)',
    edit: i => { i.basic.materialNumber = '000000000000990206'; }, expectedValues: { materialNumber: '000000000000990206' } },
  { id: 'G07', file: 'edge-cases.xlsx', type: 'FERT', desc: 'numbers entered as text',
    edit: i => { i.basic.grossWeight = '12.5'; i.basic.netWeight = '10'; i.plant[0].reorderPoint = '100'; i.valuation[0].standardPrice = '99.90'; },
    expectedValues: { grossWeight: 12.5, netWeight: 10 } },
  { id: 'G08', file: 'edge-cases.xlsx', type: 'FERT', desc: 'lower-case codes are upper-cased',
    edit: i => { Object.assign(i.basic, { materialType: 'fert', baseUnit: 'ea', weightUnit: 'kg', language: 'de' }); i.plant[0].mrpType = 'pd'; i.valuation[0].priceControl = 's'; i.valuation[0].currency = 'eur'; },
    expectedValues: { materialType: 'FERT', baseUnit: 'EA', weightUnit: 'KG', language: 'DE' } },
  { id: 'G09', file: 'edge-cases.xlsx', type: 'HALB', desc: 'all optional columns blank (internal numbering)',
    edit: i => {
      Object.assign(i.basic, { materialNumber: '', language: '', grossWeight: '', netWeight: '', weightUnit: '', ean: '' });
      i.plant = i.plant.map(r => ({ sourceKey: r.sourceKey, plant: r.plant, purchasingGroup: '', mrpType: '', mrpController: '', lotSizeKey: '', reorderPoint: '', procurementType: '', availabilityCheck: '' }));
      i.valuation.forEach(r => Object.assign(r, { standardPrice: '', movingAvgPrice: '', currency: '' }));
    } },
  { id: 'G10', file: 'edge-cases.xlsx', type: 'HAWA', desc: 'plain valid row; the file itself has shuffled column order and an extra "legacyId" column on Basic' },
];

// ---------------------------------------------------------------- structural (whole-file rejection) cases
const STRUCTURAL = [
  { id: 'S01', file: 'missing-column.xlsx', messageContains: 'materialType', desc: 'Basic sheet has no materialType column', opts: { dropColumn: { Basic: 'materialType' } } },
  { id: 'S02', file: 'wrong-header.xlsx', messageContains: 'Material Typ', desc: 'Basic header "Material Typ"', opts: { renameHeader: { Basic: { materialType: 'Material Typ' } } } },
  { id: 'S03', file: 'empty.xlsx', messageContains: 'no data rows', desc: 'headers only', empty: true },
  { id: 'S04', file: 'missing-sheet.xlsx', messageContains: 'Basic', desc: 'no Basic sheet', opts: { skipSheets: ['Basic'] } },
  { id: 'S05', file: 'not-a-spreadsheet.xlsx', messageContains: 'not a valid', desc: 'text file renamed to .xlsx', text: 'This is a plain text file, not a spreadsheet.\n' },
];

// ---------------------------------------------------------------- reference validator
const LOOKUP_FIELDS = new Set(seed.rules.filter(r => r.ruleType === 'LOOKUP').map(r => r.fieldName));
const norm = (field, v) => { if (v === undefined || v === null) return ''; let s = typeof v === 'string' ? v.trim() : String(v); if (LOOKUP_FIELDS.has(field)) s = s.toUpperCase(); return s; };
const hasRows = (item, view) => (item[view] ?? []).length > 0;

function pool(items) {
  const p = {};
  for (const it of items) {
    const e = (p[it.sourceKey] ??= { hasBasic: false, plant: [], storage: [], sales: [], valuation: [], purchasing: [] });
    if (it.basic) e.hasBasic = true;
    for (const v of ORG_VIEWS) e[v].push(...(it[v] ?? []));
  }
  return p;
}
/** Returns one { sourceKey, messages } per Basic row (plus one per orphan sourceKey). */
function refValidate(items) {
  const pooled = pool(items), out = [];
  const keyCount = {};
  items.filter(i => i.basic).forEach(i => { keyCount[i.sourceKey] = (keyCount[i.sourceKey] ?? 0) + 1; });
  for (const it of items.filter(i => i.basic)) {
    const ms = [], p = pooled[it.sourceKey];
    const type = norm('materialType', it.basic.materialType);
    const rowsOf = view => (view === 'basic' ? [it.basic] : p[view]);
    for (const r of seed.rules) {
      if (r.materialType && r.materialType !== type) continue;
      const view = Object.values(SHEETS).find(s => s.entity === r.entityName).view;
      for (const row of rowsOf(view)) {
        const val = norm(r.fieldName, row[r.fieldName]);
        let bad = false;
        if (r.ruleType === 'REQUIRED') bad = val === '';
        else if (val !== '') {
          if (r.ruleType === 'LOOKUP') bad = !seed.vh[r.parameter].has(val);
          else if (r.ruleType === 'LENGTH') { const [a, b] = r.parameter.split(',').map(Number); bad = val.length < a || val.length > b; }
          else if (r.ruleType === 'REGEX') bad = !new RegExp(r.parameter).test(val);
          else if (r.ruleType === 'RANGE') { const [a, b] = r.parameter.split(',').map(Number), n = Number(val); bad = Number.isNaN(n) || n < a || n > b; }
        }
        if (bad) ms.push(M(r.fieldName, r.ruleCode, r.severity));
      }
    }
    const b = it.basic;
    if (keyCount[it.sourceKey] > 1) ms.push(M('sourceKey', 'DUPLICATE_SOURCEKEY'));
    if (seed.existing.has(norm('materialNumber', b.materialNumber))) ms.push(M('materialNumber', 'DUPLICATE_EXISTING'));
    const g = norm('grossWeight', b.grossWeight), n = norm('netWeight', b.netWeight);
    if (g !== '' && n !== '' && Number(n) > Number(g)) ms.push(M('netWeight', 'NETWEIGHT_GT_GROSS'));
    const ean = norm('ean', b.ean);
    if (/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(ean) && !gtinValid(ean)) ms.push(M('ean', 'EAN_CHECKDIGIT'));
    for (const v of seed.mandatory[type] ?? []) if (v !== 'basic' && p[v].length === 0) ms.push(M('view', 'MISSING_VIEW'));
    for (const s of p.storage) {
      const pl = norm('plant', s.plant), loc = norm('storageLocation', s.storageLocation);
      if (loc !== '' && seed.vh.PLANT.has(pl) && !seed.vh.STORAGE_LOCATION.has(`${pl}/${loc}`)) ms.push(M('storageLocation', 'STORAGELOC_PLANT'));
    }
    for (const v of p.valuation) {
      const area = norm('valuationArea', v.valuationArea), cur = norm('currency', v.currency).toUpperCase();
      if (cur !== '' && seed.vh.PLANT.has(area) && currencyOf(area) !== cur) ms.push(M('currency', 'CURRENCY_COMPANY'));
    }
    out.push({ sourceKey: it.sourceKey, messages: ms });
  }
  for (const [k, e] of Object.entries(pooled)) if (!e.hasBasic) out.push({ sourceKey: k, messages: [M('sourceKey', 'ORPHAN_ROW')] });
  return out;
}

function summarize(rows) {
  const s = { totalRows: rows.length, validRows: 0, warningRows: 0, errorRows: 0, sourceKeys: {} };
  for (const r of rows) {
    const st = statusOf(r.messages);
    s[st === 'VALID' ? 'validRows' : st === 'WARNING' ? 'warningRows' : 'errorRows']++;
    const k = (s.sourceKeys[r.sourceKey] ??= { status: 'VALID', rowCount: 0, messages: [] });
    k.rowCount++; k.messages.push(...r.messages);
  }
  for (const k of Object.values(s.sourceKeys)) { k.status = statusOf(k.messages); k.messages = sortMsgs(k.messages); }
  return s;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function diffSummaries(declared, actual, allowKeys = new Set()) {
  const bad = [];
  for (const k of new Set([...Object.keys(declared.sourceKeys), ...Object.keys(actual.sourceKeys)]))
    if (!allowKeys.has(k) && !same(declared.sourceKeys[k], actual.sourceKeys[k]))
      bad.push(`${k}\n    declared: ${JSON.stringify(declared.sourceKeys[k])}\n    reference: ${JSON.stringify(actual.sourceKeys[k])}`);
  return bad;
}

// ---------------------------------------------------------------- writers
async function writeXlsx(file, items, opts = {}, rng = mulberry32(SEED)) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'generate-test-uploads'; wb.created = wb.modified = new Date(Date.UTC(2026, 9, 3)); // fixed, keeps output byte-identical
  const pooled = items;
  for (const [name, spec] of Object.entries(SHEETS)) {
    if (opts.skipSheets?.includes(name)) continue;
    let cols = spec.cols.filter(c => c !== opts.dropColumn?.[name]).map(c => ({ col: c, header: opts.renameHeader?.[name]?.[c] ?? c }));
    if (opts.shuffle) cols = shuffle(rng, cols);
    for (const x of opts.extra?.[name] ?? []) cols.splice(Math.floor(rng() * (cols.length + 1)), 0, { col: null, header: x });
    const ws = wb.addWorksheet(name);
    ws.addRow(cols.map(c => c.header)).font = { bold: true };
    let n = 0;
    for (const it of pooled) {
      for (const row of spec.view === 'basic' ? (it.basic ? [it.basic] : []) : it[spec.view] ?? []) {
        n++;
        const r = ws.addRow(cols.map(c => { const v = c.col ? row[c.col] : `LEGACY-${n}`; return v === '' || v === undefined ? null : v; }));
        r.eachCell(cell => { if (typeof cell.value === 'string') cell.numFmt = '@'; });
      }
    }
  }
  // re-pack with fixed entry dates so repeated runs are byte-identical
  const zip = await JSZip.loadAsync(await wb.xlsx.writeBuffer());
  zip.forEach((_, entry) => { entry.date = new Date(Date.UTC(2026, 9, 3)); });
  fs.writeFileSync(path.join(OUT, file), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}

function flatRows(items) {
  const p = pool(items);
  return items.filter(i => i.basic && !i._noCsv).map(it => {
    const r = { ...it.basic };
    for (const v of ORG_VIEWS) for (const c of SHEETS[SHEET_OF_VIEW[v]].cols.slice(1)) if (!(c in r)) r[c] = p[it.sourceKey][v][0]?.[c] ?? '';
    return r;
  });
}
function expandFlat(r) {
  const sub = cols => Object.fromEntries(cols.map(c => [c, r[c]]));
  const k = r.sourceKey, cols = v => SHEETS[SHEET_OF_VIEW[v]].cols;
  return {
    sourceKey: k, basic: sub(cols('basic')),
    plant: r.plant !== '' ? [sub(cols('plant'))] : [],
    storage: r.storageLocation !== '' ? [{ sourceKey: k, plant: r.plant, storageLocation: r.storageLocation }] : [],
    sales: r.salesOrg !== '' ? [sub(cols('sales'))] : [],
    valuation: r.valuationArea !== '' ? [sub(cols('valuation'))] : [],
    purchasing: r.orderUnit !== '' || r.grProcessingDays !== '' ? [{ sourceKey: k, plant: r.plant, purchasingGroup: r.purchasingGroup, orderUnit: r.orderUnit, grProcessingDays: r.grProcessingDays }] : [],
  };
}
function writeCsv(file, rows) {
  const q = v => { const s = v === undefined || v === null ? '' : String(v); return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [FLAT_COLS.join(';'), ...rows.map(r => FLAT_COLS.map(c => q(r[c])).join(';'))];
  fs.writeFileSync(path.join(OUT, file), '﻿' + lines.join('\r\n') + '\r\n', 'utf8');
}

// ---------------------------------------------------------------- build
// no fault means "valid material"
const faultyOrValid = (type, fault) => env => (fault ? faulty(type, fault)(env) : [make(env, type)]);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) fs.rmSync(path.join(OUT, f), { force: true });
  const expected = {}, md = [], problems = [];
  const mdRow = (id, file, key, outcome) => md.push(`| ${id} | ${file} | ${key} | ${outcome} |`);
  const outcome = (st, ms) => (ms.length ? `${st}: ${[...new Set(ms.map(m => m.ruleCode))].join(', ')}` : st);

  // --- data files (xlsx)
  const built = {};
  for (const file of ['happy-path.xlsx', 'validation-errors.xlsx', 'edge-cases.xlsx']) {
    const env = newEnv(file, FILES[file].start, FILES[file].fan), items = [], rows = [];
    const expectedValues = {};
    for (const c of CASES.filter(c => c.file === file)) {
      for (let n = 1; n <= (c.count ?? 1); n++) {
        const made = c.build ? c.build(env) : faultyOrValid(c.type, c.fault)(env);
        made.forEach(i => { i._case = c; });
        if (c.edit) { const key = made[0].sourceKey; c.edit(made[0]); setKey(made[0], key); } // edits must not change the sourceKey
        const caseId = c.count ? `${c.id}-${pad(n, 2)}` : c.id;
        if (c.expectedValues) expectedValues[made[0].sourceKey] = c.expectedValues;
        items.push(...made);
        made.forEach(i => { rows.push({ sourceKey: i.sourceKey, messages: i._expect }); });
        const desc = c.desc ?? FAULTS[c.fault]?.desc ?? '';
        const msgs = made[0]._expect;
        mdRow(caseId, file, made[0].sourceKey, `${outcome(statusOf(msgs), msgs)}${made.length > 1 ? ` (x${made.length} rows)` : ''} — ${desc}`);
      }
    }
    const declared = summarize(rows), actual = summarize(refValidate(items));
    const bad = diffSummaries(declared, actual);
    if (bad.length) problems.push(`${file}:\n  ${bad.join('\n  ')}`);
    expected[file] = { ...declared, ...(Object.keys(expectedValues).length ? { expectedValues } : {}) };
    built[file] = { items, env };
    await writeXlsx(file, items, FILES[file], mulberry32(SEED + hash(file) + 1));
  }

  // --- csv variants (single org, flat)
  for (const [csv, src] of [['happy-path.csv', 'happy-path.xlsx'], ['validation-errors.csv', 'validation-errors.xlsx']]) {
    const items = built[src].items, rows = flatRows(items);
    writeCsv(csv, rows);
    const actual = summarize(refValidate(rows.map(expandFlat)));
    const declaredRows = items.filter(i => i.basic && !i._noCsv).map(i => ({ sourceKey: i.sourceKey, messages: i._expect }));
    const allow = new Set(items.filter(i => i._csvDiffers).map(i => i.sourceKey));
    const bad = diffSummaries(summarize(declaredRows), actual, allow);
    if (bad.length) problems.push(`${csv}:\n  ${bad.join('\n  ')}`);
    expected[csv] = actual;
    if (allow.size) expected[csv].note = 'The flat layout has one shared "plant" column, so a bad plant is reported once per view that uses it (Plant, Storage, Purchasing).';
    mdRow('(same ids)', csv, `${actual.totalRows} rows`, `single-org flat version of ${src}; expectations in expected-results.json`);
  }

  // --- structural files
  {
    const env = newEnv('structural', 301, fan1);
    const base = [make(env, 'FERT'), make(env, 'ROH')];
    for (const s of STRUCTURAL) {
      if (s.text) fs.writeFileSync(path.join(OUT, s.file), s.text);
      else await writeXlsx(s.file, s.empty ? [] : base, s.opts ?? {});
      expected[s.file] = { rejected: true, messageContains: s.messageContains };
      mdRow(s.id, s.file, '(whole file)', `rejected, message contains "${s.messageContains}" — ${s.desc}`);
    }
  }

  // --- volume
  {
    const file = 'volume-5000.xlsx', env = newEnv(file, FILES[file].start, FILES[file].fan), items = [];
    const bad = new Set(shuffle(env.rng, Array.from({ length: VOLUME_ROWS }, (_, i) => i)).slice(0, VOLUME_INVALID));
    const faultNames = Object.keys(FAULTS).filter(f => !FAULTS[f].warning);
    for (let i = 0; i < VOLUME_ROWS; i++) {
      if (bad.has(i)) {
        const name = pick(env.rng, faultNames);
        const type = pick(env.rng, FAULTS[name].types);
        items.push(...faulty(type, name)(env));
      } else items.push(make(env, pick(env.rng, TYPE_KEYS)));
    }
    const declared = summarize(items.map(i => ({ sourceKey: i.sourceKey, messages: i._expect })));
    const diffs = diffSummaries(declared, summarize(refValidate(items)));
    if (diffs.length) problems.push(`${file}:\n  ${diffs.slice(0, 5).join('\n  ')}`);
    const { totalRows, validRows, warningRows, errorRows } = declared;
    expected[file] = { totalRows, validRows, warningRows, errorRows };
    await writeXlsx(file, items, {});
    mdRow('VOL', file, `TST-*-1001 …`, `${totalRows} rows: ${validRows} valid, ${warningRows} warning, ${errorRows} error (one random single-rule fault each)`);
  }

  if (problems.length) { console.error('SELF-CHECK FAILED — declared expectations disagree with the reference validator:\n' + problems.join('\n')); process.exit(1); }

  const meta = {
    seed: SEED,
    generator: 'scripts/generate-test-uploads.js',
    assumptions: [
      'totalRows counts Basic rows plus one stub row per orphan sourceKey (an org row with no Basic row).',
      'Rows sharing a duplicated sourceKey each raise DUPLICATE_SOURCEKEY and share the org rows of that key.',
      'Non-REQUIRED rules are skipped for blank values.',
      'Built-in check field names: DUPLICATE_SOURCEKEY->sourceKey, DUPLICATE_EXISTING->materialNumber, NETWEIGHT_GT_GROSS->netWeight, EAN_CHECKDIGIT->ean, MISSING_VIEW->view, ORPHAN_ROW->sourceKey, STORAGELOC_PLANT->storageLocation, CURRENCY_COMPANY->currency.',
      'EAN_CHECKDIGIT is only evaluated when the EAN already passes REGEX_EAN.',
      'Structural messageContains strings are guesses and must be aligned with the real parser messages.',
    ],
  };
  fs.writeFileSync(path.join(OUT, 'expected-results.json'), JSON.stringify({ _meta: meta, files: expected }, null, 2) + '\n');
  fs.writeFileSync(path.join(OUT, 'test-cases.md'),
    ['# Test cases', '', 'Generated by scripts/generate-test-uploads.js — do not edit.', '', '| Case | File | sourceKey | Expected outcome |', '|---|---|---|---|', ...md, ''].join('\n'));
  console.log(`Generated ${fs.readdirSync(OUT).length} files in ${path.relative(ROOT, OUT)} (self-check passed)`);
}

main().catch(e => { console.error(e); process.exit(1); });
