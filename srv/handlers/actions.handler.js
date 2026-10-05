'use strict';
const cds = require('@sap/cds');
const { assertTransition } = require('../lib/lifecycle');
const { keyOf } = require('../lib/util');
const { recompute } = require('../lib/counters');
const queue = require('../lib/posting-queue');
const audit = require('../lib/audit');

// Rows a retry will post: failed ones, plus rows a job-level failure never got to. SUCCESS rows are never posted twice.
const RETRY_STATUSES = ['FAILED', 'VALID', 'WARNING'];

module.exports = (srv) => {
  const { UploadJobs } = srv.entities;
  const db = cds.entities('mmc');
  const now = () => new Date().toISOString();

  async function loadJob(req) {
    const job = await SELECT.one.from(db.UploadJobs).columns('ID', 'status', 'createdBy', 'requiresApproval').where({ ID: keyOf(req) });
    if (!job) req.reject(404, 'Job not found');
    return job;
  }

  // Compare-and-set on the status: a concurrent action that moved the job first makes this one fail with 409
  async function moveJob(req, job, event, to, extra = {}) {
    assertTransition(req, job.status, event);
    const changed = await UPDATE(db.UploadJobs).set({ status: to, ...extra }).where({ ID: job.ID, status: job.status });
    if (!changed) req.reject(409, `Job status changed concurrently, reload and retry`);
  }

  const startPosting = { postingStartedAt: now, postingEndedAt: () => null, progressPct: () => 0 };
  const postingFields = () => Object.fromEntries(Object.entries(startPosting).map(([k, f]) => [k, f()]));

  srv.on('submit', UploadJobs, async (req) => {
    const job = await loadJob(req);
    assertTransition(req, job.status, 'submit');
    const { n } = await SELECT.one.from(db.MaterialRequests).columns('count(*) as n').where({ job_ID: job.ID, status: 'ERROR' });
    if (n) req.reject(409, 'Fix all errors before submitting');

    const audit = { submittedBy: req.user.id, submittedAt: now() };
    if (job.requiresApproval) return moveJob(req, job, 'submit', 'PENDING_APPROVAL', audit);

    await moveJob(req, job, 'submit', 'PROCESSING', { ...audit, ...postingFields() });
    await queue.enqueue(job.ID);
  });

  srv.on('approve', UploadJobs, async (req) => {
    const job = await loadJob(req);
    if (job.createdBy === req.user.id) req.reject(403, 'You cannot approve your own upload');
    assertTransition(req, job.status, 'approve');

    await moveJob(req, job, 'approve', 'PROCESSING', { approvedBy: req.user.id, approvedAt: now(), ...postingFields() });   // APPROVED -> PROCESSING
    await audit.securityEvent('approve', { jobID: job.ID, requester: job.createdBy });
    await queue.enqueue(job.ID);
  });

  srv.on('reject', UploadJobs, async (req) => {
    const reason = req.data.reason?.trim();
    if (!reason) req.reject(400, 'A rejection reason is required');
    const job = await loadJob(req);
    if (job.createdBy === req.user.id) req.reject(403, 'You cannot reject your own upload');
    await moveJob(req, job, 'reject', 'REJECTED', { rejectionReason: reason });
    await audit.securityEvent('reject', { jobID: job.ID, requester: job.createdBy, reason });
  });

  srv.on('cancel', UploadJobs, async (req) => {
    const job = await loadJob(req);
    await moveJob(req, job, 'cancel', 'CANCELLED');
  });

  srv.on('retryFailed', UploadJobs, async (req) => {
    const job = await loadJob(req);
    assertTransition(req, job.status, 'retryFailed');
    const { n: queued } = await SELECT.one.from(db.MaterialRequests).columns('count(*) as n').where({ job_ID: job.ID, status: { in: RETRY_STATUSES } });
    if (!queued) return { queued: 0 };                      // nothing to retry: not an error

    await moveJob(req, job, 'retryFailed', 'PROCESSING', postingFields());
    // back into the queue: the worker only picks VALID / WARNING / QUEUED rows, so a row failing again is not looped
    await UPDATE(db.MaterialRequests).set({ status: 'QUEUED' }).where({ job_ID: job.ID, status: 'FAILED' });
    await recompute(job.ID);
    await queue.enqueue(job.ID);
    return { queued };
  });
};
