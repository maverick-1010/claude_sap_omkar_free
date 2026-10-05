'use strict';
const cds = require('@sap/cds');
const { isEditable } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');
const { recompute } = require('../lib/counters');

const CRITICALITY = { VALID: 3, SUCCESS: 3, WARNING: 2, ERROR: 1, FAILED: 1 };
const setCriticality = (d) => { if (d) d.statusCriticality = CRITICALITY[d.status] ?? 0; };

const VIEWS = ['MaterialPlantData', 'MaterialStorageData', 'MaterialSalesData', 'MaterialValuationData', 'MaterialPurchasingData'];

module.exports = (srv) => {
  const { MaterialRequests } = srv.entities;
  const views = VIEWS.map((name) => srv.entities[name]);
  const db = cds.entities('mmc');

  // Rows and views are editable only while the job is (spec §3.1, §7.3). An edit on a
  // VALIDATED job sends it back to DRAFT so it must be re-validated before submit.
  srv.before(['CREATE', 'UPDATE', 'DELETE'], [MaterialRequests, ...views], async (req) => {
    const jobID = await jobIdOf(req);
    if (!jobID) return;                                  // not found / no parent: let the framework answer
    const job = await SELECT.one.from(db.UploadJobs).columns('status').where({ ID: jobID });
    if (!job) return;
    if (!isEditable(job.status)) req.reject(409, `Job is locked in status ${job.status}`);
    if (job.status === 'VALIDATED') await UPDATE(db.UploadJobs, jobID).with({ status: 'DRAFT' });
    jobs.set(req, jobID);
  });

  srv.before('CREATE', MaterialRequests, async (req) => {
    req.data.externalRequestId = cds.utils.uuid();       // idempotency key, never changes (spec §3.3)
    const { maxNo } = await SELECT.one.from(db.MaterialRequests).columns('max(rowNo) as maxNo').where({ job_ID: req.data.job_ID }) ?? {};
    req.data.rowNo = (maxNo ?? 0) + 1;
  });

  // Row count changes with create / delete
  srv.after(['CREATE', 'DELETE'], MaterialRequests, async (_, req) => {
    const jobID = jobs.get(req);
    if (jobID) await recompute(jobID);
  });

  srv.after('READ', MaterialRequests, (data) => {
    (Array.isArray(data) ? data : [data]).forEach(setCriticality);
  });

  const jobs = new WeakMap();

  // Resolves the parent job of the row or view being changed
  async function jobIdOf(req) {
    const entity = req.target.name.split('.').pop();
    if (entity === 'MaterialRequests') {
      if (req.event === 'CREATE') return req.data.job_ID ?? keyOf({ params: req.params?.slice(0, 1) });
      const row = await SELECT.one.from(db.MaterialRequests).columns('job_ID').where({ ID: keyOf(req) });
      return row?.job_ID;
    }
    let requestID = req.data.request_ID;
    if (req.event !== 'CREATE') {
      const view = await SELECT.one.from(db[entity]).columns('request_ID').where({ ID: keyOf(req) });
      requestID = view?.request_ID;
    }
    if (!requestID) return;
    const row = await SELECT.one.from(db.MaterialRequests).columns('job_ID').where({ ID: requestID });
    return row?.job_ID;
  }
};
