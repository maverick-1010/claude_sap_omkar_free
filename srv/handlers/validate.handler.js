'use strict';
const cds = require('@sap/cds');
const { assertTransition } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');
const { recompute } = require('../lib/counters');
const { validateMaterials, rowStatus } = require('../lib/validation');
const { SHEETS, ORG_VIEWS } = require('../lib/template');

const CHUNK = 500;
const EXTRA_CATEGORIES = ['PLANT', 'STORAGE_LOCATION', 'PLANT_COMPANY', 'COMPANY_CURRENCY'];   // used by cross-field checks

const chunks = (list, size = CHUNK) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

module.exports = (srv) => {
  const { UploadJobs } = srv.entities;
  const db = cds.entities('mmc');

  // Runs all rules over every row of the job; data errors never fail the request (spec §3.4)
  srv.on('validate', UploadJobs, async (req) => {
    const jobID = keyOf(req);
    const job = await SELECT.one.from(db.UploadJobs).columns('status').where({ ID: jobID });
    if (!job) return req.reject(404, 'Job not found');
    assertTransition(req, job.status, 'validate');

    const requests = await SELECT.from(db.MaterialRequests).where({ job_ID: jobID }).orderBy('rowNo');
    if (!requests.length) return req.reject(409, 'The job has no rows to validate');

    const ctx = await loadContext(req, requests);
    const materials = await buildMaterials(requests);
    const results = validateMaterials(materials, ctx);

    await DELETE.from(db.ValidationMessages).where({ request_ID: { in: requests.map((r) => r.ID) } });   // fresh start per row
    const rows = [], byStatus = {};
    for (const [id, messages] of results) {
      (byStatus[rowStatus(messages)] ??= []).push(id);
      for (const m of messages) rows.push({ ID: cds.utils.uuid(), request_ID: id, ...m });
    }
    for (const part of chunks(rows, 1000)) await INSERT.into(db.ValidationMessages).entries(part);
    for (const [status, ids] of Object.entries(byStatus))
      for (const part of chunks(ids)) await UPDATE(db.MaterialRequests).set({ status }).where({ ID: { in: part } });

    const counters = await recompute(jobID);
    const status = counters.errorRows > 0 ? 'DRAFT' : 'VALIDATED';
    await UPDATE(db.UploadJobs, jobID).with({ status });
    return { status, totalRows: counters.totalRows, validRows: counters.validRows, warningRows: counters.warningRows, errorRows: counters.errorRows };
  });

  async function loadContext(req, requests) {
    const { n } = await SELECT.one.from(db.ValueHelpCache).columns('count(*) as n');
    if (!n) return req.reject(503, 'Value helps not loaded — contact an administrator');

    const rules = await SELECT.from(db.ValidationRules).where({ active: true });
    const categories = [...new Set([...rules.filter((r) => r.ruleType === 'LOOKUP').map((r) => r.parameter), ...EXTRA_CATEGORIES])];
    const valueHelps = {};
    for (const row of await SELECT.from(db.ValueHelpCache).where({ category: { in: categories } }))
      (valueHelps[row.category] ??= new Map()).set(row.code, row.text);

    const mandatoryViews = {};
    for (const c of await SELECT.from(db.MaterialTypeViewConfig).where({ mandatory: true }))
      (mandatoryViews[c.materialType] ??= []).push(c.view.toLowerCase());

    // only the numbers of this job are looked up in the (possibly large) cache
    const numbers = [...new Set(requests.map((r) => r.materialNumber?.trim()).filter(Boolean))];
    const existing = new Set();
    for (const part of chunks(numbers, 1000))
      for (const row of await SELECT.from(db.ExistingMaterialCache).columns('materialNumber').where({ materialNumber: { in: part } })) existing.add(row.materialNumber);

    return { rules, mandatoryViews, valueHelps, existing };
  }

  // Org rows are pooled per sourceKey: duplicate Basic rows share the views of that key
  async function buildMaterials(requests) {
    const poolKey = (r) => r.sourceKey || `id:${r.ID}`;
    const keyOfRequest = new Map(requests.map((r) => [r.ID, poolKey(r)]));
    const pools = new Map(), own = new Map();
    const ids = requests.map((r) => r.ID);
    for (const view of ORG_VIEWS) {
      for (const part of chunks(ids)) {
        for (const row of await SELECT.from(db[SHEETS[viewSheet(view)].entity]).where({ request_ID: { in: part } })) {
          const pool = pools.get(keyOfRequest.get(row.request_ID)) ?? pools.set(keyOfRequest.get(row.request_ID), emptyPool()).get(keyOfRequest.get(row.request_ID));
          pool[view].push(row);
          (own.get(row.request_ID) ?? own.set(row.request_ID, emptyPool()).get(row.request_ID))[view].push(row);
        }
      }
    }
    return requests.map((r) => ({ id: r.ID, sourceKey: r.sourceKey, isOrphan: !!r.isOrphan, basic: r, org: pools.get(poolKey(r)) ?? emptyPool(), own: own.get(r.ID) }));
  }
};

const emptyPool = () => Object.fromEntries(ORG_VIEWS.map((v) => [v, []]));
const viewSheet = (view) => Object.keys(SHEETS).find((name) => SHEETS[name].view === view);
