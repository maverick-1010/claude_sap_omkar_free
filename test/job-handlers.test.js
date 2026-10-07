'use strict';
/**
 * Spec §3.1 / §3.3 / §4.5 / §7.3 / §7.6: job + row handlers (editability, ETag, counters).
 * Mocked users are defined here until the project-wide auth config exists.
 */
process.env.CDS_CONFIG = JSON.stringify({
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    req2: { roles: ['MaterialRequester'] },
    adm:  { roles: ['MaterialAdmin'] },
  } } }
});

const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');

const SVC = '/odata/v4/mass-material';
const asReq1 = { auth: { username: 'req1', password: '' } };
const asReq2 = { auth: { username: 'req2', password: '' } };

describe('job and row handlers', () => {
  const { GET, POST, PATCH, DELETE, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;           // assert on status codes ourselves

  const setStatus = (ID, status) => cds.db.run(UPDATE('mmc.UploadJobs', ID).with({ status }));
  const newJob = async () => (await POST(`${SVC}/UploadJobs`, { description: 'jest' }, asReq1)).data;
  const etagOf = async (url) => (await GET(url, asReq1)).data['@odata.etag'];

  test('create assigns jobNo, DRAFT status and correlationId', async () => {
    const res = await POST(`${SVC}/UploadJobs`, { description: 'x', status: 'COMPLETED', jobNo: 99 }, asReq1);
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ status: 'DRAFT', requiresApproval: false });
    expect(res.data.jobNo).not.toBe(99);
    expect(res.data.correlationId).toBeTruthy();
  });

  test('PATCH needs If-Match (428), stale ETag fails (412), valid ETag works', async () => {
    const job = await newJob();
    const url = `${SVC}/UploadJobs(${job.ID})`;
    expect((await PATCH(url, { description: 'a' }, asReq1)).status).toBe(428);

    const etag = await etagOf(url);
    const ok = await PATCH(url, { description: 'a', status: 'COMPLETED' }, { ...asReq1, headers: { 'If-Match': etag } });
    expect(ok.status).toBe(200);
    expect(ok.data.status).toBe('DRAFT');                // read-only field ignored
    expect(await etagOf(url)).not.toBe(etag);       // modifiedAt (ETag) moved on

    const stale = await PATCH(url, { description: 'b' }, { ...asReq1, headers: { 'If-Match': etag } });
    expect(stale.status).toBe(412);
  });

  test('requester cannot see another requester\'s job', async () => {
    const job = await newJob();
    const { data } = await GET(`${SVC}/UploadJobs?$filter=ID eq ${job.ID}`, asReq2);
    expect(data.value).toEqual([]);
  });

  test('row create sets rowNo/externalRequestId and updates job counters', async () => {
    const job = await newJob();
    const res = await POST(`${SVC}/MaterialRequests`, { job_ID: job.ID, materialType: 'FERT', externalRequestId: cds.utils.uuid() }, asReq1);
    expect(res.status).toBe(201);
    expect(res.data.rowNo).toBe(1);
    expect(res.data.externalRequestId).toBeTruthy();
    const { data } = await GET(`${SVC}/UploadJobs(${job.ID})`, asReq1);
    expect(data.totalRows).toBe(1);
  });

  test('editing a row of a VALIDATED job sets the job back to DRAFT', async () => {
    const job = await newJob();
    const { data: row } = await POST(`${SVC}/MaterialRequests`, { job_ID: job.ID, materialType: 'FERT' }, asReq1);
    await setStatus(job.ID, 'VALIDATED');
    const url = `${SVC}/MaterialRequests(${row.ID})`;
    const res = await PATCH(url, { description: 'changed' }, { ...asReq1, headers: { 'If-Match': await etagOf(url) } });
    expect(res.status).toBe(200);
    expect((await GET(`${SVC}/UploadJobs(${job.ID})`, asReq1)).data.status).toBe('DRAFT');
  });

  test.each(['PENDING_APPROVAL', 'PROCESSING', 'COMPLETED'])('rows and job are locked in %s', async (status) => {
    const job = await newJob();
    const { data: row } = await POST(`${SVC}/MaterialRequests`, { job_ID: job.ID, materialType: 'FERT' }, asReq1);
    await setStatus(job.ID, status);

    const rowUrl = `${SVC}/MaterialRequests(${row.ID})`;
    const patchRow = await PATCH(rowUrl, { description: 'x' }, { ...asReq1, headers: { 'If-Match': await etagOf(rowUrl) } });
    expect(patchRow.status).toBe(409);
    expect(patchRow.data.error.message).toBe(`Job is locked in status ${status}`);

    const jobUrl = `${SVC}/UploadJobs(${job.ID})`;
    expect((await PATCH(jobUrl, { description: 'x' }, { ...asReq1, headers: { 'If-Match': await etagOf(jobUrl) } })).status).toBe(409);
    const del = await DELETE(jobUrl, { ...asReq1, headers: { 'If-Match': await etagOf(jobUrl) } });
    if (status !== 'PENDING_APPROVAL') expect(del.status).toBe(409);
  });

  test('job delete is allowed in DRAFT and blocked in PROCESSING', async () => {
    const draft = await newJob();
    const url = `${SVC}/UploadJobs(${draft.ID})`;
    expect((await DELETE(url, { ...asReq1, headers: { 'If-Match': await etagOf(url) } })).status).toBe(204);

    const busy = await newJob();
    await setStatus(busy.ID, 'PROCESSING');
    const busyUrl = `${SVC}/UploadJobs(${busy.ID})`;
    const res = await DELETE(busyUrl, { ...asReq1, headers: { 'If-Match': await etagOf(busyUrl) } });
    expect(res.status).toBe(409);
    expect(res.data.error.message).toBe('Job cannot be deleted in status PROCESSING');
  });

  test('upload accepts .xlsx and rejects other types (415)', async () => {
    const job = await newJob();
    expect((await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: 'a.pdf' }, asReq1)).status).toBe(415);
    expect((await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: 'a.xlsx' }, asReq1)).status).toBe(201);
  });
});
