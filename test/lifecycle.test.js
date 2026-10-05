'use strict';
/** Spec §3.1, §5.3, §7.3, §7.5, §8.4: lifecycle actions, four-eyes, transition matrix. */
process.env.CDS_CONFIG = JSON.stringify({
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    req2: { roles: ['MaterialRequester'] },
    appr: { roles: ['MaterialApprover'] },
    both: { roles: ['MaterialRequester', 'MaterialApprover'] },
    adm:  { roles: ['MaterialAdmin'] },
  } } }
});

const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const queue = require('../srv/lib/posting-queue');
const { TRANSITIONS } = require('../srv/lib/lifecycle');

const SVC = '/odata/v4/mass-material';
const as = (user) => ({ auth: { username: user, password: '' }, headers: { 'If-Match': '*' } });   // CAP needs If-Match on actions
const STATUSES = ['DRAFT', 'VALIDATED', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'PROCESSING', 'COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED', 'CANCELLED'];

describe('lifecycle actions', () => {
  const { GET, POST, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  let enqueue;
  beforeEach(() => { enqueue = jest.spyOn(queue, 'enqueue').mockResolvedValue(); });
  afterEach(() => jest.restoreAllMocks());

  const setJob = (ID, fields) => cds.db.run(UPDATE('mmc.UploadJobs', ID).with(fields));
  const addRow = (job_ID, status, n = 1) => cds.db.run(INSERT.into('mmc.MaterialRequests').entries(
    Array.from({ length: n }, (_, i) => ({ ID: cds.utils.uuid(), job_ID, status, rowNo: i + 1, sourceKey: `K-${status}-${i}` }))));
  async function job(status = 'DRAFT', { requiresApproval = false, rows = [], owner = 'req1' } = {}) {
    const { data } = await POST(`${SVC}/UploadJobs`, { description: 'lifecycle' }, as(owner));
    await setJob(data.ID, { status, requiresApproval });
    for (const [s, n] of rows) await addRow(data.ID, s, n);
    return data.ID;
  }
  const act = (ID, name, user, body = {}) => POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.${name}`, body, as(user));
  const get = async (ID) => (await GET(`${SVC}/UploadJobs(${ID})`, as('adm'))).data;

  describe('submit', () => {
    test('without approval goes straight to PROCESSING and queues posting', async () => {
      const ID = await job('VALIDATED', { rows: [['VALID', 2], ['WARNING', 1]] });
      const res = await act(ID, 'submit', 'req1');
      expect(res.status).toBe(204);
      expect(await get(ID)).toMatchObject({ status: 'PROCESSING', submittedBy: 'req1', progressPct: 0 });
      expect((await get(ID)).submittedAt).toBeTruthy();
      expect(enqueue).toHaveBeenCalledWith(ID);
    });

    test('with approval goes to PENDING_APPROVAL and does not queue posting', async () => {
      const ID = await job('VALIDATED', { requiresApproval: true, rows: [['VALID', 1]] });
      expect((await act(ID, 'submit', 'req1')).status).toBe(204);
      expect(await get(ID)).toMatchObject({ status: 'PENDING_APPROVAL', submittedBy: 'req1' });
      expect(enqueue).not.toHaveBeenCalled();
    });

    test('with ERROR rows is 409', async () => {
      const ID = await job('VALIDATED', { rows: [['VALID', 1], ['ERROR', 1]] });
      const res = await act(ID, 'submit', 'req1');
      expect(res.status).toBe(409);
      expect(res.data.error.message).toBe('Fix all errors before submitting');
      expect((await get(ID)).status).toBe('VALIDATED');
    });

    test('on a job that is not VALIDATED is 409', async () => {
      const res = await act(await job('DRAFT', { rows: [['VALID', 1]] }), 'submit', 'req1');
      expect(res.status).toBe(409);
      expect(res.data.error.message).toBe('Job must be validated before submit');
    });
  });

  describe('approve / reject (four-eyes)', () => {
    test('approver approves: PROCESSING, audit fields set, posting queued', async () => {
      const ID = await job('PENDING_APPROVAL', { requiresApproval: true, rows: [['VALID', 1]] });
      expect((await act(ID, 'approve', 'appr')).status).toBe(204);
      expect(await get(ID)).toMatchObject({ status: 'PROCESSING', approvedBy: 'appr' });
      expect(enqueue).toHaveBeenCalledWith(ID);
    });

    test('approving your own upload is 403', async () => {
      const ID = await job('PENDING_APPROVAL', { owner: 'both' });
      const res = await act(ID, 'approve', 'both');
      expect(res.status).toBe(403);
      expect(res.data.error.message).toBe('You cannot approve your own upload');
      expect((await get(ID)).status).toBe('PENDING_APPROVAL');
    });

    test('approve on a job that is not PENDING_APPROVAL is 409', async () => {
      expect((await act(await job('VALIDATED'), 'approve', 'appr')).status).toBe(409);
    });

    test('a requester cannot approve (403, role not granted)', async () => {
      expect((await act(await job('PENDING_APPROVAL'), 'approve', 'req1')).status).toBe(403);
    });

    test('reject returns the job to the requester with the reason', async () => {
      const ID = await job('PENDING_APPROVAL');
      expect((await act(ID, 'reject', 'appr', { reason: '  Wrong plants  ' })).status).toBe(204);
      expect(await get(ID)).toMatchObject({ status: 'REJECTED', rejectionReason: 'Wrong plants' });
    });

    test.each([undefined, '', '   '])('reject without a reason (%p) is 400', async (reason) => {
      const ID = await job('PENDING_APPROVAL');
      const res = await act(ID, 'reject', 'appr', reason === undefined ? {} : { reason });
      expect(res.status).toBe(400);
      expect(res.data.error.message).toBe('A rejection reason is required');
      expect((await get(ID)).status).toBe('PENDING_APPROVAL');
    });

    test('rejecting your own upload is 403', async () => {
      expect((await act(await job('PENDING_APPROVAL', { owner: 'both' }), 'reject', 'both', { reason: 'x' })).status).toBe(403);
    });

    test('two approvers: the second one gets 409', async () => {
      const ID = await job('PENDING_APPROVAL');
      expect((await act(ID, 'approve', 'appr')).status).toBe(204);
      expect((await act(ID, 'approve', 'adm')).status).toBe(409);
    });

    test('a rejected job can be validated again (REJECTED -> DRAFT / VALIDATED)', async () => {
      const ID = await job('PENDING_APPROVAL', { rows: [] });
      await act(ID, 'reject', 'appr', { reason: 'fix it' });
      // no rows: validate answers 409 for that reason, not for the status
      const res = await act(ID, 'validate', 'req1');
      expect(res.data.error.message).toBe('The job has no rows to validate');
    });
  });

  describe('cancel', () => {
    test.each(['DRAFT', 'VALIDATED', 'PENDING_APPROVAL', 'REJECTED'])('is allowed in %s', async (status) => {
      const ID = await job(status);
      expect((await act(ID, 'cancel', 'req1')).status).toBe(204);
      expect((await get(ID)).status).toBe('CANCELLED');
    });

    test('on a PROCESSING job is 409 "Posting already started"', async () => {
      const res = await act(await job('PROCESSING'), 'cancel', 'req1');
      expect(res.status).toBe(409);
      expect(res.data.error.message).toBe('Posting already started');
    });

    test('an admin can cancel any job; another requester is refused', async () => {
      const ID = await job('VALIDATED');
      expect((await act(ID, 'cancel', 'req2')).status).toBe(403);
      expect((await act(ID, 'cancel', 'adm')).status).toBe(204);
    });
  });

  describe('retryFailed', () => {
    test('queues only the FAILED rows and returns the count; SUCCESS rows are left alone', async () => {
      const ID = await job('COMPLETED_WITH_ERRORS', { rows: [['SUCCESS', 3], ['FAILED', 2]] });
      const res = await act(ID, 'retryFailed', 'req1');
      expect(res.status).toBe(200);
      expect(res.data.queued).toBe(2);
      expect(await get(ID)).toMatchObject({ status: 'PROCESSING' });
      expect(enqueue).toHaveBeenCalledWith(ID);
      const { data } = await GET(`${SVC}/MaterialRequests?$filter=job_ID eq ${ID} and status eq 'SUCCESS'&$count=true&$top=0`, as('adm'));
      expect(data['@odata.count']).toBe(3);
    });

    test('after a job-level FAILED it also retries the rows that were never posted', async () => {
      const ID = await job('FAILED', { rows: [['VALID', 2]] });
      expect((await act(ID, 'retryFailed', 'req1')).data.queued).toBe(2);
    });

    test('with nothing to retry returns 0 and does not throw or change the job', async () => {
      const ID = await job('COMPLETED_WITH_ERRORS', { rows: [['SUCCESS', 2]] });
      const res = await act(ID, 'retryFailed', 'req1');
      expect(res.status).toBe(200);
      expect(res.data.queued).toBe(0);
      expect((await get(ID)).status).toBe('COMPLETED_WITH_ERRORS');
      expect(enqueue).not.toHaveBeenCalled();
    });
  });

  // Every transition not in §3.1 is rejected with 409
  // (approve / reject are driven as admin here: an approver cannot see DRAFT jobs at all and would get 403)
  describe('transition matrix', () => {
    const actions = { parse: 'req1', validate: 'req1', submit: 'req1', approve: 'adm', reject: 'adm', cancel: 'req1', retryFailed: 'req1' };
    const cases = Object.entries(actions).flatMap(([name, user]) =>
      STATUSES.filter((s) => !TRANSITIONS[name].from.includes(s)).map((s) => [name, s, user]));

    test.each(cases)('%s in %s is 409', async (name, status, user) => {
      const ID = await job(status, { rows: [['VALID', 1]] });
      const res = await act(ID, name, user, name === 'reject' ? { reason: 'x' } : {});
      expect(res.status).toBe(409);
      expect((await get(ID)).status).toBe(status);
    });
  });
});
