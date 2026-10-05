'use strict';
/**
 * EXAMPLE: uploads validation-errors.xlsx through the service, runs "validate" and compares the
 * resulting ValidationMessages with test/uploads/expected-results.json.
 *
 * The CAP service does not exist in this repo yet, so the test skips itself until a srv/ folder is
 * present. Adjust the assumptions below to the real service:
 *   - service path:  /odata/v4/mass-material
 *   - entities:      UploadJobs, JobFiles (media entity), ValidationMessages (with request -> MaterialRequests)
 *   - bound action:  UploadJobs/validate, which parses JobFiles.content and fills MaterialRequests
 *                    (incl. sourceKey) and ValidationMessages synchronously
 *
 * Run:  npx jest test/validation-errors.test.js
 */
const fs = require('fs');
const path = require('path');
// mocked users; project-wide auth config comes with step 10
process.env.CDS_CONFIG = JSON.stringify({ requires: { auth: { kind: 'mocked', users: { req1: { roles: ['MaterialRequester'] } } } } });
const cds = require('@cap-js/cds-test');

const ROOT = path.join(__dirname, '..');
const FILE = 'validation-errors.xlsx';
const SVC = '/odata/v4/mass-material';
const expected = require('./uploads/expected-results.json').files[FILE];

const hasService = fs.existsSync(path.join(ROOT, 'srv'));
(hasService ? describe : describe.skip)(`validate ${FILE}`, () => {
  const { GET, POST, PUT, axios } = cds.test(ROOT);
  axios.defaults.auth = { username: 'req1', password: '' }; // mocked requester
  const act = { headers: { 'If-Match': '*' } };      // CAP requires If-Match on bound actions of ETag entities

  let jobId;
  beforeAll(async () => {
    ({ data: { ID: jobId } } = await POST(`${SVC}/UploadJobs`, { description: 'jest', fileName: FILE }));
    const { data: file } = await POST(`${SVC}/JobFiles`, { job_ID: jobId, fileName: FILE, mediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    await PUT(`${SVC}/JobFiles(${file.ID})/content`, fs.readFileSync(path.join(__dirname, 'uploads', FILE)),
      { headers: { 'Content-Type': 'application/octet-stream' } });
    await POST(`${SVC}/UploadJobs(${jobId})/MassMaterialService.parse`, {}, act);
    await POST(`${SVC}/UploadJobs(${jobId})/MassMaterialService.validate`, {}, act);
  });

  test('job counters match', async () => {
    const { data: job } = await GET(`${SVC}/UploadJobs(${jobId})`);
    expect({ totalRows: job.totalRows, validRows: job.validRows, warningRows: job.warningRows, errorRows: job.errorRows })
      .toEqual({ totalRows: expected.totalRows, validRows: expected.validRows, warningRows: expected.warningRows, errorRows: expected.errorRows });
  });

  test('messages per sourceKey match expected-results.json', async () => {
    const { data } = await GET(`${SVC}/ValidationMessages?$filter=request/job_ID eq ${jobId}&$expand=request($select=sourceKey)&$top=5000`);
    const actual = {};
    for (const m of data.value) {
      (actual[m.request.sourceKey] ??= []).push({ fieldName: m.fieldName, ruleCode: m.ruleCode, severity: m.severity });
    }
    const sort = ms => [...ms].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const [key, exp] of Object.entries(expected.sourceKeys)) {
      expect({ key, messages: sort(actual[key] ?? []) }).toEqual({ key, messages: sort(exp.messages) });
    }
    // nothing unexpected on other keys
    expect(Object.keys(actual).filter(k => !(k in expected.sourceKeys))).toEqual([]);
  });
});
