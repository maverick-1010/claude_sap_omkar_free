'use strict';
// Validation engine (spec §3.4, §7.2). Pure: takes already-loaded data and returns messages,
// so it can be tested and compared with the reference validator without a database.
const { SHEETS, ORG_VIEWS } = require('./template');

const VIEW_OF_ENTITY = Object.fromEntries(Object.values(SHEETS).map((s) => [s.entity, s.view]));

// Business key of an org row; the same key may not appear twice for one material (spec §6.3)
const ORG_KEYS = {
  plant: ['plant'],
  storage: ['plant', 'storageLocation'],
  sales: ['salesOrg', 'distributionChannel'],
  valuation: ['valuationArea'],
  purchasing: ['plant'],
};

const message = (severity, view, fieldName, ruleCode, messageText) =>
  ({ severity, viewType: view.toUpperCase(), fieldName, ruleCode, messageText });

const gtinValid = (digits) => {
  const body = digits.slice(0, -1);
  let sum = 0;
  [...body].reverse().forEach((c, i) => { sum += Number(c) * (i % 2 === 0 ? 3 : 1); });
  return (10 - (sum % 10)) % 10 === Number(digits.slice(-1));
};

/**
 * materials: [{ id, sourceKey, isOrphan, basic: {..}, org: { plant: [..], storage: [..], ... } }]
 *   org rows of materials sharing a sourceKey are pooled by the caller (duplicate Basic rows see the same views);
 *   optional own: { view: [..] } are the rows of this request alone, used for the duplicate-key check
 * ctx: { rules, mandatoryViews: { type: [view] }, valueHelps: { category: Map(code -> text) }, existing: Set }
 * returns Map(material.id -> [message])
 */
function validateMaterials(materials, ctx) {
  const { rules, mandatoryViews, valueHelps, existing } = ctx;
  const lookupFields = new Set(rules.filter((r) => r.ruleType === 'LOOKUP').map((r) => r.fieldName));
  const rulesByView = {};
  for (const r of rules) (rulesByView[VIEW_OF_ENTITY[r.entityName]] ??= []).push(r);

  const clean = (field, v) => {
    if (v === undefined || v === null) return '';
    const s = typeof v === 'string' ? v.trim() : String(v);
    return lookupFields.has(field) ? s.toUpperCase() : s;
  };
  const regexCache = new Map();
  const regex = (pattern) => {
    if (!regexCache.has(pattern)) { try { regexCache.set(pattern, new RegExp(pattern)); } catch { regexCache.set(pattern, null); } }
    return regexCache.get(pattern);
  };
  const bounds = (p) => String(p).split(',').map(Number);

  // Occurrence counts for in-file duplicates (Basic rows only)
  const realRows = materials.filter((m) => !m.isOrphan);
  const keyCount = {}, numberSeen = {};
  for (const m of realRows) if (m.sourceKey) keyCount[m.sourceKey] = (keyCount[m.sourceKey] ?? 0) + 1;

  const out = new Map();
  for (const m of materials) {
    if (m.isOrphan) {
      out.set(m.id, [message('ERROR', 'basic', 'sourceKey', 'ORPHAN_ROW', `No Basic row found for sourceKey ${m.sourceKey ?? ''}`.trim())]);
      continue;
    }
    const ms = [];
    const b = m.basic;
    const type = clean('materialType', b.materialType);
    const rowsOf = (view) => (view === 'basic' ? [b] : m.org[view] ?? []);

    // 1. data-driven rules
    for (const [view, viewRules] of Object.entries(rulesByView)) {
      const rows = rowsOf(view);
      for (const r of viewRules) {
        if (r.materialType && r.materialType !== type) continue;
        for (const row of rows) {
          const val = clean(r.fieldName, row[r.fieldName]);
          let bad = false, text = r.messageText;
          if (r.ruleType === 'REQUIRED') bad = val === '';
          else if (val !== '') {
            if (r.ruleType === 'LOOKUP') { bad = !valueHelps[r.parameter]?.has(val); text = `${r.messageText} (value "${val}")`; }
            else if (r.ruleType === 'LENGTH') { const [min, max] = bounds(r.parameter); bad = val.length < min || val.length > max; }
            else if (r.ruleType === 'REGEX') { const re = regex(r.parameter); bad = re ? !re.test(val) : false; }
            else if (r.ruleType === 'RANGE') { const [min, max] = bounds(r.parameter); const n = Number(val); bad = Number.isNaN(n) || n < min || n > max; }
          }
          if (bad) ms.push(message(r.severity ?? 'ERROR', view, r.fieldName, r.ruleCode, text));
        }
      }
    }

    // 2. duplicates
    if (m.sourceKey && keyCount[m.sourceKey] > 1) ms.push(message('ERROR', 'basic', 'sourceKey', 'DUPLICATE_SOURCEKEY', `sourceKey ${m.sourceKey} appears more than once in the file`));
    const number = clean('materialNumber', b.materialNumber);
    if (number !== '') {
      if (existing.has(number)) ms.push(message('ERROR', 'basic', 'materialNumber', 'DUPLICATE_EXISTING', `Material ${number} already exists in S/4HANA`));
      if (numberSeen[number]) ms.push(message('ERROR', 'basic', 'materialNumber', 'DUPLICATE_MATERIAL', `Material number ${number} appears more than once in this job`));
      numberSeen[number] = true;
    }
    for (const view of ORG_VIEWS) {
      const seen = new Set();
      for (const row of m.own?.[view] ?? rowsOf(view)) {            // own rows only: pooled rows of duplicate Basic rows are not duplicates
        const parts = ORG_KEYS[view].map((f) => clean(f, row[f]));
        if (parts.some((p) => p === '')) continue;
        const key = parts.join('/');
        if (seen.has(key)) ms.push(message('ERROR', view, ORG_KEYS[view][0], 'DUPLICATE_ORG_ROW', `${view} row ${key} appears more than once for this material`));
        seen.add(key);
      }
    }

    // 3. cross-field checks
    const gross = clean('grossWeight', b.grossWeight), net = clean('netWeight', b.netWeight);
    if (gross !== '' && Number(gross) === 0) ms.push(message('ERROR', 'basic', 'grossWeight', 'WEIGHT_NOT_POSITIVE', 'grossWeight must be greater than 0'));
    if (net !== '' && Number(net) === 0) ms.push(message('ERROR', 'basic', 'netWeight', 'WEIGHT_NOT_POSITIVE', 'netWeight must be greater than 0'));
    if (gross !== '' && net !== '' && Number(net) > Number(gross)) ms.push(message('ERROR', 'basic', 'netWeight', 'NETWEIGHT_GT_GROSS', 'netWeight must not exceed grossWeight'));
    if ((gross !== '' || net !== '') && clean('weightUnit', b.weightUnit) === '') ms.push(message('ERROR', 'basic', 'weightUnit', 'WEIGHTUNIT_REQUIRED', 'weightUnit is required when a weight is given'));
    const ean = clean('ean', b.ean);
    if (/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(ean) && !gtinValid(ean)) ms.push(message('ERROR', 'basic', 'ean', 'EAN_CHECKDIGIT', 'ean has an invalid check digit'));

    for (const view of mandatoryViews[type] ?? [])
      if (view !== 'basic' && rowsOf(view).length === 0)
        ms.push(message('ERROR', view, 'view', 'MISSING_VIEW', `The ${view} view is mandatory for material type ${type}`));

    const plants = valueHelps.PLANT;
    for (const s of rowsOf('storage')) {
      const plant = clean('plant', s.plant), loc = clean('storageLocation', s.storageLocation);
      if (loc !== '' && plants?.has(plant) && !valueHelps.STORAGE_LOCATION?.has(`${plant}/${loc}`))
        ms.push(message('ERROR', 'storage', 'storageLocation', 'STORAGELOC_PLANT', `Storage location ${loc} does not belong to plant ${plant}`));
    }
    for (const v of rowsOf('valuation')) {
      const area = clean('valuationArea', v.valuationArea), currency = clean('currency', v.currency).toUpperCase();
      const expected = valueHelps.COMPANY_CURRENCY?.get(valueHelps.PLANT_COMPANY?.get(area));
      if (currency !== '' && plants?.has(area) && expected !== currency)
        ms.push(message('ERROR', 'valuation', 'currency', 'CURRENCY_COMPANY', `Currency ${currency} does not match ${expected ?? 'the company code currency'} of plant ${area}`));
    }

    out.set(m.id, ms);
  }
  return out;
}

const rowStatus = (messages) =>
  messages.some((m) => m.severity === 'ERROR') ? 'ERROR' : messages.some((m) => m.severity === 'WARNING') ? 'WARNING' : 'VALID';

module.exports = { validateMaterials, rowStatus };
