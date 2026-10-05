'use strict';
const { Readable } = require('stream');
const cds = require('@sap/cds');
const { keyOf } = require('../lib/util');
const { buildTemplate, buildResult } = require('../lib/result-writer');
const { ORG_VIEWS, SHEETS, SHEET_OF_VIEW } = require('../lib/template');

const CHUNK = 500;
const chunks = (list) => Array.from({ length: Math.ceil(list.length / CHUNK) }, (_, i) => list.slice(i * CHUNK, (i + 1) * CHUNK));

// Binary function result: CAP streams a Readable with the @Core.MediaType of the function; the file name goes in a header
const file = (req, buffer, name) => {
  req.http?.res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  return Readable.from(buffer);
};

module.exports = (srv) => {
  const { UploadJobs } = srv.entities;
  const db = cds.entities('mmc');

  srv.on('getTemplate', async (req) => file(req, await buildTemplate(), 'material-upload-template.xlsx'));

  // One line per uploaded row: original columns + status, created material number or the error (spec §3.6)
  srv.on('downloadResult', UploadJobs, async (req) => {
    const jobID = keyOf(req);
    const job = await SELECT.one.from(db.UploadJobs).columns('jobNo').where({ ID: jobID });
    if (!job) return req.reject(404, 'Job not found');

    const requests = await SELECT.from(db.MaterialRequests).where({ job_ID: jobID }).orderBy('rowNo');
    const org = new Map(requests.map((r) => [r.ID, Object.fromEntries(ORG_VIEWS.map((v) => [v, []]))]));
    const messages = new Map();
    for (const part of chunks(requests.map((r) => r.ID))) {
      for (const view of ORG_VIEWS)
        for (const { request_ID, ...data } of await SELECT.from(db[SHEETS[SHEET_OF_VIEW[view]].entity]).where({ request_ID: { in: part } }))
          org.get(request_ID)[view].push(data);                       // keeps the row ID: harmless, never written out
      for (const m of await SELECT.from(db.ValidationMessages).where({ request_ID: { in: part } }))
        (messages.get(m.request_ID) ?? messages.set(m.request_ID, []).get(m.request_ID)).push(m);
    }
    return file(req, await buildResult(requests, org, messages), `material-upload-${job.jobNo}-result.xlsx`);
  });
};
