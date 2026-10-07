'use strict';
const cds = require('@sap/cds');
const { assertTransition } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');
const { recompute } = require('../lib/counters');
const { parseFile, ParseError } = require('../lib/parser');
const { ORG_VIEWS, SHEET_OF_VIEW, SHEETS } = require('../lib/template');

const BATCH = 500;

module.exports = (srv) => {
  const { UploadJobs } = srv.entities;
  const db = cds.entities('mmc');

  // Reads the uploaded file into MaterialRequests + org views; replaces earlier parse results (spec §3.2)
  srv.on('parse', UploadJobs, async (req) => {
    const jobID = keyOf(req);
    const job = await SELECT.one.from(db.UploadJobs).columns('status').where({ ID: jobID });
    if (!job) return req.reject(404, 'Job not found');
    assertTransition(req, job.status, 'parse');

    const file = await SELECT.one.from(db.JobFiles).columns('content', 'fileName').where({ job_ID: jobID });
    const content = file?.content ? await toBuffer(file.content) : null;
    if (!content?.length) return req.reject(409, 'Upload a file before parsing');

    let materials;
    try {
      materials = await parseFile(content, file.fileName);
    } catch (e) {
      if (e instanceof ParseError) return req.reject(e.status, e.message);
      throw e;
    }

    await DELETE.from(db.MaterialRequests).where({ job_ID: jobID });
    for (let i = 0; i < materials.length; i += BATCH) await insertBatch(jobID, materials.slice(i, i + BATCH));

    const { totalRows } = await recompute(jobID);
    return { totalRows };
  });

  async function insertBatch(jobID, materials) {
    const requests = [];
    const orgRows = Object.fromEntries(ORG_VIEWS.map((v) => [v, []]));
    for (const m of materials) {
      const ID = cds.utils.uuid();
      requests.push({
        ID, job_ID: jobID, rowNo: m.rowNo, sourceKey: m.sourceKey, status: 'NEW',
        externalRequestId: cds.utils.uuid(), isOrphan: m.isOrphan, ...withoutNulls(m.basic),
      });
      for (const view of ORG_VIEWS) for (const data of m[view]) orgRows[view].push({ ID: cds.utils.uuid(), request_ID: ID, ...withoutNulls(data) });
    }
    await INSERT.into(db.MaterialRequests).entries(requests);
    for (const view of ORG_VIEWS) {
      if (orgRows[view].length) await INSERT.into(db[SHEETS[SHEET_OF_VIEW[view]].entity]).entries(orgRows[view]);
    }
  }
};

// Omitted (not null) values let the model defaults apply, e.g. language = EN
const withoutNulls = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

async function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content;
  const chunks = [];
  for await (const chunk of content) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
