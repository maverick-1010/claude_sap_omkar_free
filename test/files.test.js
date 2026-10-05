'use strict';
/** Spec §3.6, §8.5: getTemplate and downloadResult. */
process.env.CDS_CONFIG = JSON.stringify({
  mmc: { posting: { chunkSize: 10, backoffMs: 1 }, s4: { adapter: 'mock' } },
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    req2: { roles: ['MaterialRequester'] },
    appr: { roles: ['MaterialApprover'] },
  } } },
});

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const cdsTest = require('@cap-js/cds-test');
const mock = require('../srv/lib/s4/mock.adapter');
const { S4Error } = require('../srv/lib/s4/errors');
const { parseFile } = require('../srv/lib/parser');

const SVC = '/odata/v4/mass-material';
const as = (user, extra = {}) => ({ auth: { username: user, password: '' }, headers: { 'If-Match': '*' }, ...extra });
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

describe('template and result file', () => {
  const { GET, POST, PUT, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  beforeEach(() => mock.reset());

  async function load(res) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(res.data));
    return wb;
  }
  const download = (url, user = 'req1') => GET(url, as(user, { responseType: 'arraybuffer' }));
  const sheetRows = (wb, name) => {
    const ws = wb.getWorksheet(name), header = ws.getRow(1).values.slice(1), out = [];
    ws.eachRow((row, n) => { if (n > 1) out.push(Object.fromEntries(header.map((h, i) => [h, row.values[i + 1] ?? null]))); });
    return out;
  };

  async function job(file, { submit = false } = {}) {
    const { data } = await POST(`${SVC}/UploadJobs`, { description: file }, as('req1'));
    const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: data.ID, fileName: file }, as('req1'));
    await PUT(`${SVC}/JobFiles(${f.ID})/content`, fs.readFileSync(path.join(__dirname, 'uploads', file)), { auth: as('req1').auth, headers: { 'Content-Type': 'application/octet-stream' } });
    await POST(`${SVC}/UploadJobs(${data.ID})/MassMaterialService.parse`, {}, as('req1'));
    await POST(`${SVC}/UploadJobs(${data.ID})/MassMaterialService.validate`, {}, as('req1'));
    if (submit) {
      await POST(`${SVC}/UploadJobs(${data.ID})/MassMaterialService.submit`, {}, as('req1'));
      for (let i = 0; i < 300; i++) {
        if ((await GET(`${SVC}/UploadJobs(${data.ID})`, as('req1'))).data.status !== 'PROCESSING') break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    return data.ID;
  }

  describe('getTemplate', () => {
    test('returns an xlsx with every sheet, the headers and one sample row', async () => {
      const res = await download(`${SVC}/getTemplate()`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(XLSX);
      expect(res.headers['content-disposition']).toContain('material-upload-template.xlsx');
      const wb = await load(res);
      for (const name of ['Basic', 'Plant', 'Storage', 'Sales', 'Valuation', 'Purchasing']) {
        const rows = sheetRows(wb, name);
        expect(rows).toHaveLength(1);
        expect(rows[0].sourceKey).toBe('SAMPLE-001');
      }
      expect(Object.keys(sheetRows(wb, 'Basic')[0])).toEqual(expect.arrayContaining(['materialType', 'baseUnit', 'ean']));
    });

    test('the template itself is a valid upload', async () => {
      const wb = await load(await download(`${SVC}/getTemplate()`));
      const materials = await parseFile(Buffer.from(await wb.xlsx.writeBuffer()), 'template.xlsx');
      expect(materials).toHaveLength(1);
      expect(materials[0]).toMatchObject({ sourceKey: 'SAMPLE-001', isOrphan: false });
      expect(materials[0].plant).toHaveLength(1);
    });

    test('any authenticated user may download it, anonymous may not', async () => {
      expect((await download(`${SVC}/getTemplate()`, 'appr')).status).toBe(200);
      expect((await GET(`${SVC}/getTemplate()`)).status).toBe(401);
    });
  });

  describe('downloadResult', () => {
    test('after posting: one line per row with status and created material; org sheets carry the views', async () => {
      const ID = await job('happy-path.xlsx', { submit: true });
      const res = await download(`${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain(XLSX);
      const wb = await load(res);
      const basic = sheetRows(wb, 'Basic');
      expect(basic).toHaveLength(25);
      expect(basic.every((r) => r.resultStatus === 'SUCCESS' && r.createdMaterial)).toBe(true);
      expect(basic.find((r) => r.sourceKey === 'TST-FERT-0001')).toMatchObject({ materialType: 'FERT', baseUnit: 'EA' });
      expect(sheetRows(wb, 'Plant')).toHaveLength(30);
    });

    test('a failed row shows the S/4 error text', async () => {
      mock.behavior = async (_m, ctx) => { if (ctx.sourceKey === 'TST-ROH-0002') throw new S4Error('Plant 1010 is blocked', { kind: 'business', code: 'M3/123' }); };
      const ID = await job('happy-path.xlsx', { submit: true });
      const basic = sheetRows(await load(await download(`${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`)), 'Basic');
      expect(basic.find((r) => r.sourceKey === 'TST-ROH-0002')).toMatchObject({ resultStatus: 'FAILED', createdMaterial: null, errorText: '[M3/123] Plant 1010 is blocked' });
      expect(basic.filter((r) => r.resultStatus === 'SUCCESS')).toHaveLength(24);
    });

    test('validation errors are listed per row before anything is posted', async () => {
      const ID = await job('validation-errors.xlsx');
      const basic = sheetRows(await load(await download(`${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`)), 'Basic');
      expect(basic).toHaveLength(19);                                     // 20 rows minus the orphan (it has no Basic row)
      const row = basic.find((r) => r.sourceKey === 'TST-FERT-0101');
      expect(row.resultStatus).toBe('ERROR');
      expect(row.errorText).toMatch(/^ERROR: materialGroup is required/);
      expect(basic.find((r) => r.sourceKey === 'TST-VERP-0101')).toMatchObject({ resultStatus: 'VALID', errorText: null });
    });

    test('the result file can be corrected and uploaded again', async () => {
      const ID = await job('happy-path.xlsx', { submit: true });
      const wb = await load(await download(`${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`));
      const materials = await parseFile(Buffer.from(await wb.xlsx.writeBuffer()), 'result.xlsx');
      expect(materials).toHaveLength(25);
      expect(materials.reduce((n, m) => n + m.plant.length, 0)).toBe(30);
      expect(materials.every((m) => !m.isOrphan)).toBe(true);
    });

    test('a plain GET works without If-Match (it is a read, not a change)', async () => {
      const ID = await job('happy-path.xlsx');
      const res = await GET(`${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`, { auth: as('req1').auth, responseType: 'arraybuffer' });
      expect(res.status).toBe(200);
    });

    test('requesters only get their own jobs; an approver can download a submitted job', async () => {
      const ID = await job('happy-path.xlsx', { submit: true });
      const url = `${SVC}/UploadJobs(${ID})/MassMaterialService.downloadResult()`;
      expect((await download(url, 'req2')).status).toBe(403);
      expect((await download(url, 'appr')).status).toBe(200);
    });
  });
});
