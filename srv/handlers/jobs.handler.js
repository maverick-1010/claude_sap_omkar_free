'use strict';
const cds = require('@sap/cds');
const { isEditable, isDeletable } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');

const CRITICALITY = { COMPLETED: 3, COMPLETED_WITH_ERRORS: 2, FAILED: 1, REJECTED: 1 };
const setCriticality = (d) => { if (d) d.statusCriticality = CRITICALITY[d.status] ?? 0; };

module.exports = (srv) => {
  const { UploadJobs } = srv.entities;
  const db = cds.entities('mmc');

  srv.before('CREATE', UploadJobs, async (req) => {
    const { maxNo } = await SELECT.one.from(db.UploadJobs).columns('max(jobNo) as maxNo') ?? {};
    req.data.jobNo = (maxNo ?? 0) + 1;
    req.data.status = 'DRAFT';
    req.data.requiresApproval = !!cds.env.mmc?.requiresApproval;
    req.data.correlationId = cds.utils.uuid();
  });

  srv.before('UPDATE', UploadJobs, async (req) => {
    const status = await statusOf(req);
    if (status && !isEditable(status)) req.reject(409, `Job is locked in status ${status}`);
  });

  srv.before('DELETE', UploadJobs, async (req) => {
    const status = await statusOf(req);
    if (status && !isDeletable(status)) req.reject(409, `Job cannot be deleted in status ${status}`);
  });

  srv.after('READ', UploadJobs, (data) => {
    (Array.isArray(data) ? data : [data]).forEach(setCriticality);
  });

  async function statusOf(req) {
    const job = await SELECT.one.from(db.UploadJobs).columns('status').where({ ID: keyOf(req) });
    return job?.status;
  }
};
