'use strict';
const cds = require('@sap/cds');

// Row counters on UploadJobs are system-maintained (spec §3.1, §4.3); this is the only
// place that writes them from row statuses. Row statuses map to one counter each.
const COUNTER = { VALID: 'validRows', WARNING: 'warningRows', ERROR: 'errorRows', SUCCESS: 'successRows', FAILED: 'failedRows' };

async function recompute(jobID) {
  const { UploadJobs, MaterialRequests } = cds.entities('mmc');
  const groups = await SELECT.from(MaterialRequests).columns('status', 'count(*) as n').where({ job_ID: jobID }).groupBy('status');

  const counters = { totalRows: 0, validRows: 0, warningRows: 0, errorRows: 0, successRows: 0, failedRows: 0 };
  for (const { status, n } of groups) {
    counters.totalRows += n;
    if (COUNTER[status]) counters[COUNTER[status]] = n;
  }
  await UPDATE(UploadJobs, jobID).with(counters);
  return counters;
}

module.exports = { recompute };
