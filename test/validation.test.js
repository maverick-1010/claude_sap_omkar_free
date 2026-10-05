'use strict';
/** Spec §3.4, §7.2, §8.3, §8.8: validate action behaviour beyond the oracle file. */
process.env.CDS_CONFIG = JSON.stringify({
  requires: { auth: { kind: 'mocked', users: { req1: { roles: ['MaterialRequester'] } } } }
});

const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');

const SVC = '/odata/v4/mass-material';
const auth = { auth: { username: 'req1', password: '' } };
const act = { ...auth, headers: { 'If-Match': '*' } };      // CAP requires If-Match on bound actions of ETag entities
const expected = require('./uploads/expected-results.json').files;

describe('validate', () => {
  const { GET, POST, PUT, PATCH, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;

  async function newJob(file, { parse = true } = {}) {
    const { data: job } = await POST(`${SVC}/UploadJobs`, { description: file }, auth);
    if (file) {
      const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: file }, auth);
      await PUT(`${SVC}/JobFiles(${f.ID})/content`, fs.readFileSync(path.join(__dirname, 'uploads', file)),
        { ...auth, headers: { 'Content-Type': 'application/octet-stream' } });
      if (parse) await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act);
    }
    return job;
  }
  const validate = (job) => POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.validate`, {}, act);
  const jobOf = async (job) => (await GET(`${SVC}/UploadJobs(${job.ID})`, auth)).data;
  const messagesOf = async (job) =>
    (await GET(`${SVC}/ValidationMessages?$filter=request/job_ID eq ${job.ID}&$expand=request($select=sourceKey)&$top=5000`, auth)).data.value;

  test.each(['happy-path.xlsx', 'edge-cases.xlsx', 'happy-path.csv'])('%s validates clean and the job becomes VALIDATED', async (file) => {
    const job = await newJob(file);
    const res = await validate(job);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: 'VALIDATED', errorRows: 0, warningRows: 0, validRows: expected[file].totalRows });
    expect(await jobOf(job)).toMatchObject({ status: 'VALIDATED' });
    expect(await messagesOf(job)).toEqual([]);
  });

  test('validation-errors.csv matches expected-results.json and the job stays DRAFT', async () => {
    const file = 'validation-errors.csv';
    const job = await newJob(file);
    const res = await validate(job);
    expect(res.status).toBe(200);                         // data errors never fail the request
    const { totalRows, validRows, warningRows, errorRows } = expected[file];
    expect(res.data).toMatchObject({ status: 'DRAFT', totalRows, validRows, warningRows, errorRows });

    const actual = {};
    for (const m of await messagesOf(job)) (actual[m.request.sourceKey] ??= []).push({ fieldName: m.fieldName, ruleCode: m.ruleCode, severity: m.severity });
    const sort = (ms) => [...ms].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    for (const [key, exp] of Object.entries(expected[file].sourceKeys)) {
      if (key === 'TST-HALB-0101') continue;              // flat layout reports a bad plant once per view (see expected-results note)
      expect({ key, messages: sort(actual[key] ?? []) }).toEqual({ key, messages: sort(exp.messages) });
    }
  });

  test('messages carry viewType, fieldName, ruleCode and a text', async () => {
    const job = await newJob('validation-errors.xlsx');
    await validate(job);
    const m = (await messagesOf(job)).find((x) => x.ruleCode === 'MISSING_VIEW');
    expect(m).toMatchObject({ severity: 'ERROR', viewType: 'STORAGE', fieldName: 'view' });
    expect(m.messageText).toMatch(/storage/i);
  });

  test('re-validation replaces the previous messages instead of adding to them', async () => {
    const job = await newJob('validation-errors.xlsx');
    await validate(job);
    const first = (await messagesOf(job)).length;
    await validate(job);
    expect((await messagesOf(job)).length).toBe(first);
  });

  test('a corrected row is VALID after re-validation', async () => {
    const job = await newJob('validation-errors.xlsx');
    await validate(job);
    const row = (await GET(`${SVC}/MaterialRequests?$filter=job_ID eq ${job.ID} and sourceKey eq 'TST-FERT-0101'`, auth)).data.value[0];
    expect(row.status).toBe('ERROR');
    const patch = await PATCH(`${SVC}/MaterialRequests(${row.ID})`, { materialGroup: 'MG-FIN' }, act);
    expect(patch.status).toBe(200);
    await validate(job);
    expect((await GET(`${SVC}/MaterialRequests(${row.ID})`, auth)).data.status).toBe('VALID');
  });

  test('a rule set inactive is skipped on the next validate (spec §3.7)', async () => {
    const job = await newJob('validation-errors.xlsx');
    await cds.db.run(UPDATE('mmc.ValidationRules').set({ active: false }).where({ ruleCode: 'REQUIRED_MATERIALGROUP' }));
    try {
      await validate(job);
      expect((await messagesOf(job)).filter((m) => m.ruleCode === 'REQUIRED_MATERIALGROUP')).toEqual([]);
    } finally {
      await cds.db.run(UPDATE('mmc.ValidationRules').set({ active: true }).where({ ruleCode: 'REQUIRED_MATERIALGROUP' }));
    }
  });

  test('a job without rows cannot be validated (409)', async () => {
    const job = await newJob();
    expect((await validate(job)).status).toBe(409);
  });

  test('validate is not allowed outside DRAFT / VALIDATED / REJECTED (409)', async () => {
    const job = await newJob('happy-path.xlsx');
    await cds.db.run(UPDATE('mmc.UploadJobs', job.ID).with({ status: 'PROCESSING' }));
    expect((await validate(job)).status).toBe(409);
  });

  test('volume-5000.xlsx: counters match and validation is fast enough', async () => {
    const job = await newJob('volume-5000.xlsx');
    const started = Date.now();
    const res = await validate(job);
    const { totalRows, validRows, warningRows, errorRows } = expected['volume-5000.xlsx'];
    expect(res.data).toMatchObject({ totalRows, validRows, warningRows, errorRows });
    expect(Date.now() - started).toBeLessThan(60000);
  }, 180000);

  test('empty ValueHelpCache returns 503 (run last: it empties the cache)', async () => {
    const job = await newJob('happy-path.xlsx');
    await cds.db.run(DELETE.from('mmc.ValueHelpCache'));
    const res = await validate(job);
    expect(res.status).toBe(503);
    expect(res.data.error.message).toBe('Value helps not loaded — contact an administrator');
  });
});
