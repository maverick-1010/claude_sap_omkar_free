'use strict';
/** Spec §3.5, §7.4, §8.5: asynchronous posting through the persistent outbox, against the mock S/4 adapter. */
process.env.CDS_CONFIG = JSON.stringify({
  mmc: { posting: { chunkSize: 4, backoffMs: 1 }, s4: { adapter: 'mock' } },
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    appr: { roles: ['MaterialApprover'] },
  } } },
});

const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const mock = require('../srv/lib/s4/mock.adapter');
const { S4Error } = require('../srv/lib/s4/errors');

const SVC = '/odata/v4/mass-material';
const as = (user) => ({ auth: { username: user, password: '' }, headers: { 'If-Match': '*' } });

describe('posting to S/4 (mock)', () => {
  const { GET, POST, PUT, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  beforeEach(() => mock.reset());

  async function validatedJob(file = 'happy-path.xlsx', { requiresApproval = false } = {}) {
    const { data: job } = await POST(`${SVC}/UploadJobs`, { description: 'posting' }, as('req1'));
    const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: file }, as('req1'));
    await PUT(`${SVC}/JobFiles(${f.ID})/content`, fs.readFileSync(path.join(__dirname, 'uploads', file)),
      { auth: as('req1').auth, headers: { 'Content-Type': 'application/octet-stream' } });
    await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, as('req1'));
    const res = await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.validate`, {}, as('req1'));
    expect(res.data.status).toBe('VALIDATED');
    if (requiresApproval) await cds.db.run(UPDATE('mmc.UploadJobs', job.ID).with({ requiresApproval: true }));
    return job.ID;
  }
  const submit = (ID) => POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.submit`, {}, as('req1'));
  const jobOf = async (ID) => (await GET(`${SVC}/UploadJobs(${ID})`, as('req1'))).data;
  const rowsOf = async (ID) => (await GET(`${SVC}/MaterialRequests?$filter=job_ID eq ${ID}&$orderby=rowNo&$top=6000`, as('req1'))).data.value;

  async function untilFinished(ID, timeoutMs = 30000) {
    const end = Date.now() + timeoutMs;
    for (;;) {
      const job = await jobOf(ID);
      if (job.status !== 'PROCESSING') return job;
      if (Date.now() > end) throw new Error(`job still PROCESSING after ${timeoutMs} ms (${job.successRows} ok, ${job.failedRows} failed)`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  test('submit returns immediately; all VALID rows become SUCCESS with createdMaterial', async () => {
    const ID = await validatedJob();
    const res = await submit(ID);
    expect(res.status).toBe(204);                                       // did not wait for the posting

    const job = await untilFinished(ID);
    expect(job).toMatchObject({ status: 'COMPLETED', totalRows: 25, successRows: 25, failedRows: 0, progressPct: 100 });
    expect(job.postingStartedAt).toBeTruthy();
    expect(job.postingEndedAt).toBeTruthy();
    const rows = await rowsOf(ID);
    expect(rows.every((r) => r.status === 'SUCCESS' && r.createdMaterial && r.attempts === 1 && !r.s4ErrorCode)).toBe(true);
    expect(mock.calls).toHaveLength(25);
  });

  test('the material handed to S/4 carries the basic data and the org views', async () => {
    const seen = [];
    mock.behavior = async (material) => { seen.push(material); };
    const ID = await validatedJob();
    await submit(ID);
    await untilFinished(ID);
    const fert = seen.find((m) => m.materialNumber === 'TST-FERT-0001');
    expect(fert).toMatchObject({ materialType: 'FERT', baseUnit: 'EA', language: 'EN' });
    expect(fert.plant.length).toBeGreaterThan(0);
    expect(fert.storage.length).toBeGreaterThan(0);
    expect(fert.valuation.length).toBeGreaterThan(0);
  });

  test('a business error fails only that row; the job ends COMPLETED_WITH_ERRORS and is not retried', async () => {
    mock.behavior = async (_m, ctx) => {
      if (ctx.sourceKey === 'TST-ROH-0002') throw new S4Error('Material group MG-RAW is not allowed for plant 1010', { kind: 'business', code: 'M3/897' });
    };
    const ID = await validatedJob();
    await submit(ID);
    const job = await untilFinished(ID);
    expect(job).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', successRows: 24, failedRows: 1 });
    const failed = (await rowsOf(ID)).filter((r) => r.status === 'FAILED');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ sourceKey: 'TST-ROH-0002', s4ErrorCode: 'M3/897', attempts: 1 });
    expect(failed[0].s4ErrorText).toContain('not allowed');
    expect(mock.calls.filter((c) => c.sourceKey === 'TST-ROH-0002')).toHaveLength(1);
  });

  test('a transient error is retried and then succeeds (attempts = 2)', async () => {
    mock.behavior = async (_m, ctx, attempt) => {
      if (ctx.sourceKey === 'TST-FERT-0003' && attempt === 1) throw new S4Error('timeout', { kind: 'transient', code: 'ETIMEDOUT' });
    };
    const ID = await validatedJob();
    await submit(ID);
    expect(await untilFinished(ID)).toMatchObject({ status: 'COMPLETED', successRows: 25 });
    const row = (await rowsOf(ID)).find((r) => r.sourceKey === 'TST-FERT-0003');
    expect(row).toMatchObject({ status: 'SUCCESS', attempts: 2 });
  });

  test('a transient error that never clears fails after 3 retries (4 attempts)', async () => {
    mock.behavior = async (_m, ctx) => {
      if (ctx.sourceKey === 'TST-FERT-0004') throw new S4Error('HTTP 503', { kind: 'transient', code: '503' });
    };
    const ID = await validatedJob();
    await submit(ID);
    expect(await untilFinished(ID)).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', failedRows: 1 });
    expect((await rowsOf(ID)).find((r) => r.sourceKey === 'TST-FERT-0004')).toMatchObject({ status: 'FAILED', attempts: 4, s4ErrorCode: '503' });
  });

  test('retryFailed re-posts only the FAILED rows; no SUCCESS row is posted twice', async () => {
    let broken = true;
    mock.behavior = async (_m, ctx) => {
      if (broken && ctx.sourceKey === 'TST-ROH-0002') throw new S4Error('rejected', { kind: 'business', code: 'X1' });
    };
    const ID = await validatedJob();
    await submit(ID);
    await untilFinished(ID);
    expect(mock.calls).toHaveLength(25);

    broken = false;
    const res = await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.retryFailed`, {}, as('req1'));
    expect(res.data.queued).toBe(1);
    const job = await untilFinished(ID);
    expect(job).toMatchObject({ status: 'COMPLETED', successRows: 25, failedRows: 0 });
    expect(mock.calls).toHaveLength(26);                                // exactly one more call
    expect(mock.calls.slice(25)[0].sourceKey).toBe('TST-ROH-0002');
    expect((await rowsOf(ID)).find((r) => r.sourceKey === 'TST-ROH-0002')).toMatchObject({ status: 'SUCCESS', attempts: 2, s4ErrorCode: null });
  });

  test('a row failing again on retry ends the retry run instead of looping', async () => {
    mock.behavior = async (_m, ctx) => {
      if (ctx.sourceKey === 'TST-ROH-0002') throw new S4Error('still rejected', { kind: 'business', code: 'X1' });
    };
    const ID = await validatedJob();
    await submit(ID);
    await untilFinished(ID);
    await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.retryFailed`, {}, as('req1'));
    expect(await untilFinished(ID)).toMatchObject({ status: 'COMPLETED_WITH_ERRORS', failedRows: 1 });
    expect(mock.calls.filter((c) => c.sourceKey === 'TST-ROH-0002')).toHaveLength(2);
  });

  test('a job-level failure (destination missing) marks the job FAILED with a message and no SUCCESS rows', async () => {
    mock.behavior = async () => { throw new S4Error('Destination S4_MATERIAL not found', { kind: 'job', code: 'DESTINATION' }); };
    const ID = await validatedJob();
    await submit(ID);
    const job = await untilFinished(ID);
    expect(job).toMatchObject({ status: 'FAILED', successRows: 0, failureReason: 'Destination S4_MATERIAL not found' });
    expect((await rowsOf(ID)).filter((r) => r.status === 'SUCCESS')).toEqual([]);

    mock.behavior = null;                                               // destination fixed
    const retry = await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.retryFailed`, {}, as('req1'));
    expect(retry.data.queued).toBe(25);
    expect(await untilFinished(ID)).toMatchObject({ status: 'COMPLETED', successRows: 25 });
  });

  test('an interrupted job resumes: rows already SUCCESS are skipped', async () => {
    const ID = await validatedJob();
    const rows = await rowsOf(ID);
    for (const r of rows.slice(0, 10)) await cds.db.run(UPDATE('mmc.MaterialRequests', r.ID).with({ status: 'SUCCESS', createdMaterial: 'DONE' }));
    await cds.db.run(UPDATE('mmc.UploadJobs', ID).with({ status: 'PROCESSING' }));
    await require('../srv/lib/posting-queue').enqueue(ID);              // what the outbox does again after a restart

    const job = await untilFinished(ID);
    expect(job).toMatchObject({ status: 'COMPLETED', successRows: 25 });
    expect(mock.calls).toHaveLength(15);
    expect(mock.calls.map((c) => c.sourceKey)).not.toContain(rows[0].sourceKey);
  });

  test('with approval: submit -> approve -> posted', async () => {
    const ID = await validatedJob('happy-path.xlsx', { requiresApproval: true });
    await submit(ID);
    expect((await jobOf(ID)).status).toBe('PENDING_APPROVAL');
    expect(mock.calls).toHaveLength(0);
    expect((await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.approve`, {}, as('appr'))).status).toBe(204);
    expect(await untilFinished(ID)).toMatchObject({ status: 'COMPLETED', approvedBy: 'appr' });
  });

  test('a cancelled-in-time job is not posted: only PROCESSING jobs are worked on', async () => {
    const ID = await validatedJob();
    await require('../srv/lib/posting-queue').enqueue(ID);              // job is VALIDATED, not PROCESSING
    await new Promise((r) => setTimeout(r, 1500));
    expect(mock.calls).toHaveLength(0);
    expect((await jobOf(ID)).status).toBe('VALIDATED');
  });
});
