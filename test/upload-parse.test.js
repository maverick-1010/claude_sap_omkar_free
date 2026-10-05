'use strict';
/** Spec §3.2, §7.1, §8.2: upload + parse (structural rejection, row creation, replacement). */
process.env.CDS_CONFIG = JSON.stringify({
  requires: { auth: { kind: 'mocked', users: { req1: { roles: ['MaterialRequester'] } } } }
});

const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');

const SVC = '/odata/v4/mass-material';
const UPLOADS = path.join(__dirname, 'uploads');
const auth = { auth: { username: 'req1', password: '' } };
// CAP requires If-Match on bound actions of ETag entities; '*' means "any version"
const act = { ...auth, headers: { 'If-Match': '*' } };
const expected = require('./uploads/expected-results.json').files;

describe('upload and parse', () => {
  const { GET, POST, PUT, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;

  async function upload(file, { parse = true, buffer } = {}) {
    const { data: job } = await POST(`${SVC}/UploadJobs`, { description: file }, auth);
    const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: file, mediaType: 'application/octet-stream' }, auth);
    const put = await PUT(`${SVC}/JobFiles(${f.ID})/content`, buffer ?? fs.readFileSync(path.join(UPLOADS, file)),
      { ...auth, headers: { 'Content-Type': 'application/octet-stream' } });
    const res = parse ? await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act) : null;
    return { job, put, res };
  }
  const count = async (entity, jobID, key = 'request/job_ID') =>
    (await GET(`${SVC}/${entity}?$filter=${key} eq ${jobID}&$count=true&$top=0`, auth)).data['@odata.count'];
  const rowsOf = async (jobID) =>
    (await GET(`${SVC}/MaterialRequests?$filter=job_ID eq ${jobID}&$top=6000`, auth)).data.value;

  test.each(['happy-path.xlsx', 'validation-errors.xlsx', 'edge-cases.xlsx', 'happy-path.csv', 'validation-errors.csv'])(
    '%s creates the expected number of rows', async (file) => {
      const { res, job } = await upload(file);
      expect(res.status).toBe(200);
      expect(res.data.totalRows).toBe(expected[file].totalRows);
      expect((await GET(`${SVC}/UploadJobs(${job.ID})`, auth)).data).toMatchObject({ status: 'DRAFT', totalRows: expected[file].totalRows });
    });

  test('happy-path.xlsx creates the child views', async () => {
    const { job } = await upload('happy-path.xlsx');
    expect(await count('MaterialPlantData', job.ID)).toBe(30);
    expect(await count('MaterialStorageData', job.ID)).toBeGreaterThan(0);
    expect(await count('MaterialValuationData', job.ID)).toBeGreaterThan(0);
  });

  test('rows get rowNo, externalRequestId and are NEW', async () => {
    const { job } = await upload('happy-path.xlsx');
    const rows = await rowsOf(job.ID);
    expect(new Set(rows.map((r) => r.externalRequestId)).size).toBe(rows.length);
    expect(rows.every((r) => r.status === 'NEW' && r.rowNo > 1 && r.sourceKey)).toBe(true);
  });

  test('org row without Basic row becomes an orphan request (not a file rejection)', async () => {
    const { job } = await upload('validation-errors.xlsx');
    const orphans = (await rowsOf(job.ID)).filter((r) => r.isOrphan);
    expect(orphans.map((r) => r.sourceKey)).toEqual(['TST-ORPHAN-0001']);
  });

  test('values are trimmed, codes upper-cased, numbers converted', async () => {
    const { job } = await upload('edge-cases.xlsx');
    const byKey = Object.fromEntries((await rowsOf(job.ID)).map((r) => [r.sourceKey, r]));
    for (const [key, values] of Object.entries(expected['edge-cases.xlsx'].expectedValues)) {
      // OData V4 serialises Decimal as a string ("12.500"), so numbers are compared numerically
      const actual = Object.fromEntries(Object.keys(values).map((f) => [f, typeof values[f] === 'number' ? Number(byKey[key][f]) : byKey[key][f]]));
      expect(actual).toEqual(values);
    }
  });

  test.each([
    ['missing-column.xlsx', 'Missing column materialType on sheet Basic'],
    ['wrong-header.xlsx', 'Missing column materialType on sheet Basic'],
    ['empty.xlsx', 'The file contains no data rows'],
    ['missing-sheet.xlsx', 'Missing sheet Basic'],
    ['not-a-spreadsheet.xlsx', 'The file is not a valid .xlsx file'],
  ])('%s is rejected with 400 and creates no rows', async (file, message) => {
    const { res, job } = await upload(file);
    expect(res.status).toBe(400);
    expect(res.data.error.message).toContain(message);
    expect(await rowsOf(job.ID)).toEqual([]);
  });

  test('misspelled header message names the found header', async () => {
    const { res } = await upload('wrong-header.xlsx');
    expect(res.data.error.message).toContain('Material Typ');
  });

  test('parse without an uploaded file is 409', async () => {
    const { data: job } = await POST(`${SVC}/UploadJobs`, {}, auth);
    const res = await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act);
    expect(res.status).toBe(409);
    expect(res.data.error.message).toBe('Upload a file before parsing');
  });

  test('parse replaces previously parsed rows', async () => {
    const { job } = await upload('happy-path.xlsx');
    const again = await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act);
    expect(again.status).toBe(200);
    expect(await rowsOf(job.ID)).toHaveLength(25);
    expect(await count('MaterialPlantData', job.ID)).toBe(30);
  });

  test('parse is only allowed in DRAFT', async () => {
    const { job } = await upload('happy-path.xlsx');
    await cds.db.run(UPDATE('mmc.UploadJobs', job.ID).with({ status: 'PENDING_APPROVAL' }));
    const res = await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act);
    expect(res.status).toBe(409);
  });

  test('wrong file type is 415 and a file over 10 MB is 413', async () => {
    const { data: job } = await POST(`${SVC}/UploadJobs`, {}, auth);
    expect((await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: 'a.txt' }, auth)).status).toBe(415);
    const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: 'big.xlsx' }, auth);
    const big = await PUT(`${SVC}/JobFiles(${f.ID})/content`, Buffer.alloc(10 * 1024 * 1024 + 1),
      { ...auth, headers: { 'Content-Type': 'application/octet-stream' } });
    expect(big.status).toBe(413);
  });

  test('volume-5000.xlsx parses all 5000 materials', async () => {
    const { res } = await upload('volume-5000.xlsx');
    expect(res.status).toBe(200);
    expect(res.data.totalRows).toBe(5000);
  }, 120000);
});
