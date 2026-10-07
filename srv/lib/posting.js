'use strict';
// Posting worker (spec §3.5, §7.4). One call handles one chunk of rows inside one transaction, so
// progress and counters are committed after every chunk; the caller chains the next chunk through the
// persistent outbox, which is what makes the job survive a restart.
const cds = require('@sap/cds');
const { getAdapter } = require('./s4/adapter');
const { recompute } = require('./counters');
const { S4Error } = require('./s4/errors');
const { ORG_VIEWS, SHEETS, SHEET_OF_VIEW } = require('./template');

// Rows still to post. FAILED is not listed: retryFailed moves failed rows back to QUEUED first,
// so a row that fails in this run is never picked up again by the same run. SUCCESS is never posted twice.
const POSTABLE = ['VALID', 'WARNING', 'QUEUED', 'POSTING'];

const config = () => ({
  chunkSize: 50, concurrency: 3, maxRetries: 3, backoffMs: 500,
  ...cds.env.mmc?.posting,
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();

class JobAbort extends Error {}

/** Posts the next chunk of the job. Returns { remaining } (rows still to post) or { skipped: true }. */
async function postChunk(jobID) {
  const db = cds.entities('mmc');
  const cfg = config();

  const job = await SELECT.one.from(db.UploadJobs).columns('ID', 'status', 'correlationId').where({ ID: jobID });
  if (!job || job.status !== 'PROCESSING') return { skipped: true };       // cancelled / already finished: nothing to do

  const rows = await SELECT.from(db.MaterialRequests).where({ job_ID: jobID, status: { in: POSTABLE } }).orderBy('rowNo').limit(cfg.chunkSize);
  const org = await loadOrg(db, rows);

  const adapter = getAdapter();
  const results = new Map();
  let abort = null;

  await runPool(rows, cfg.concurrency, async (row) => {
    if (abort) return;                                                       // a job-level failure stops the rest
    try {
      results.set(row.ID, await postRow(adapter, row, toMaterial(row, org.get(row.ID)), job.correlationId, cfg));
    } catch (e) {
      if (e instanceof JobAbort) abort ??= e;
      else throw e;
    }
  });

  for (const [id, r] of results) await UPDATE(db.MaterialRequests, id).with(r);
  await recompute(jobID);

  if (abort) {
    cds.log('posting').error(`job ${jobID} failed (correlationId ${job.correlationId}): ${abort.message}`);
    await finish(jobID, 'FAILED', { failureReason: abort.message.slice(0, 500) });
    return { remaining: 0 };
  }

  const { n: remaining } = await SELECT.one.from(db.MaterialRequests).columns('count(*) as n').where({ job_ID: jobID, status: { in: POSTABLE } });
  const { successRows, failedRows } = await SELECT.one.from(db.UploadJobs).columns('successRows', 'failedRows').where({ ID: jobID });
  const done = successRows + failedRows;
  await UPDATE(db.UploadJobs, jobID).with({ progressPct: remaining ? Math.floor((100 * done) / (done + remaining)) : 100 });

  if (!remaining) await finish(jobID, failedRows ? 'COMPLETED_WITH_ERRORS' : 'COMPLETED');
  return { remaining };
}

// One material: retries transient errors with exponential backoff, never throws for a row-level failure
async function postRow(adapter, row, material, correlationId, cfg) {
  const ctx = { externalRequestId: row.externalRequestId, correlationId, sourceKey: row.sourceKey };
  let attempts = row.attempts ?? 0;
  for (let retry = 0; ; retry++) {
    attempts++;
    try {
      const { material: createdMaterial } = await adapter.postMaterial(material, ctx);
      return { status: 'SUCCESS', createdMaterial, s4ErrorCode: null, s4ErrorText: null, attempts, lastAttemptAt: now() };
    } catch (e) {
      const err = e instanceof S4Error ? e : new S4Error(e.message, { kind: 'business', cause: e });
      if (err.kind === 'job') throw new JobAbort(err.message);
      if (err.kind === 'transient' && retry < cfg.maxRetries) { await sleep(cfg.backoffMs * 2 ** retry); continue; }
      return { status: 'FAILED', s4ErrorCode: (err.code ?? err.kind).toString().slice(0, 60), s4ErrorText: err.message.slice(0, 1000), attempts, lastAttemptAt: now() };
    }
  }
}

// Runs fn over items with at most `limit` in flight
async function runPool(items, limit, fn) {
  let next = 0;
  const lane = async () => { while (next < items.length) await fn(items[next++]); };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

async function finish(jobID, to, extra = {}) {
  const db = cds.entities('mmc');
  const changed = await UPDATE(db.UploadJobs).set({ status: to, postingEndedAt: now(), ...(to === 'FAILED' ? {} : { progressPct: 100 }), ...extra }).where({ ID: jobID, status: 'PROCESSING' });
  if (!changed) cds.log('posting').warn(`job ${jobID} could not move to ${to}: not PROCESSING any more`);
}

async function loadOrg(db, rows) {
  const org = new Map(rows.map((r) => [r.ID, Object.fromEntries(ORG_VIEWS.map((v) => [v, []]))]));
  if (!rows.length) return org;
  const ids = rows.map((r) => r.ID);
  for (const view of ORG_VIEWS)
    for (const rec of await SELECT.from(db[SHEETS[SHEET_OF_VIEW[view]].entity]).where({ request_ID: { in: ids } })) {
      const { request_ID, ...data } = rec;
      org.get(request_ID)[view].push(data);
    }
  return org;
}

// Domain-shaped material handed to the adapter; the adapter maps it to its own protocol
function toMaterial(row, org) {
  const { materialNumber, materialType, industrySector, materialGroup, description, language, baseUnit, grossWeight, netWeight, weightUnit, ean } = row;
  return { materialNumber, materialType, industrySector, materialGroup, description, language, baseUnit, grossWeight, netWeight, weightUnit, ean, ...org };
}

module.exports = { postChunk };
