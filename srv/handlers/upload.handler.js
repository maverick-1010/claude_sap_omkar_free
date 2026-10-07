'use strict';
const cds = require('@sap/cds');
const { isEditable } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED = /\.(xlsx|csv)$/i;

module.exports = (srv) => {
  const { JobFiles } = srv.entities;
  const db = cds.entities('mmc');

  // Upload is a two step media upload: POST JobFiles (metadata), PUT JobFiles(ID)/content
  srv.before('CREATE', JobFiles, async (req) => {
    const { job_ID, fileName } = req.data;
    if (!ALLOWED.test(fileName ?? '')) req.reject(415, 'Only .xlsx and .csv files are supported');
    await assertJobEditable(req, job_ID);
    await DELETE.from(db.JobFiles).where({ job_ID });    // one file per job: a new upload replaces the old one
    await UPDATE(db.UploadJobs, job_ID).with({ fileName });
  });

  // Only the content stream may change (spec §2.1: no update of file metadata)
  srv.before('UPDATE', JobFiles, async (req) => {
    for (const f of ['job_ID', 'fileName', 'mediaType', 'fileSize']) delete req.data[f];
    const size = Number(req.headers?.['content-length']);
    if (size > MAX_BYTES) req.reject(413, 'File exceeds 10 MB');
    if (Number.isFinite(size) && size > 0) req.data.fileSize = size;
    const file = await SELECT.one.from(db.JobFiles).columns('job_ID').where({ ID: keyOf(req) });
    if (file) await assertJobEditable(req, file.job_ID);
  });

  async function assertJobEditable(req, jobID) {
    const job = jobID && await SELECT.one.from(db.UploadJobs).columns('status').where({ ID: jobID });
    if (job && !isEditable(job.status)) req.reject(409, `Job is locked in status ${job.status}`);
  }
};
