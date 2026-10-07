'use strict';
/** Spec §2.2, §3.7, §5, §7.5, §7.6, §8.6, §8.8: MaterialAdminService. */
process.env.CDS_CONFIG = JSON.stringify({
  mmc: { s4: { adapter: 'mock' } },
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    appr: { roles: ['MaterialApprover'] },
    adm:  { roles: ['MaterialAdmin'] },
  } } },
});

const fs = require('fs');
const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const mock = require('../srv/lib/s4/mock.adapter');
const { S4Error } = require('../srv/lib/s4/errors');
const { msUntil } = require('../srv/lib/nightly');

const ADMIN = '/odata/v4/material-admin';
const SVC = '/odata/v4/mass-material';
const as = (user) => ({ auth: { username: user, password: '' } });

describe('MaterialAdminService', () => {
  const { GET, POST, PATCH, DELETE, PUT, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  beforeEach(() => mock.reset());

  const cacheCount = (entity, where = '') => cds.db.run(SELECT.one.from(entity).columns('count(*) as n').where(where || '1 = 1')).then((r) => r.n);

  describe('access', () => {
    test.each(['req1', 'appr'])('%s is blocked (403)', async (user) => {
      expect((await GET(`${ADMIN}/ValidationRules`, as(user))).status).toBe(403);
      expect((await POST(`${ADMIN}/refreshValueHelps`, {}, as(user))).status).toBe(403);
      expect((await GET(`${ADMIN}/testS4Connection()`, as(user))).status).toBe(403);
    });
    test('anonymous is 401', async () => {
      expect((await GET(`${ADMIN}/ValidationRules`)).status).toBe(401);
    });
    test('an administrator can read the configuration', async () => {
      const res = await GET(`${ADMIN}/ValidationRules?$count=true&$top=1`, as('adm'));
      expect(res.status).toBe(200);
      expect(res.data['@odata.count']).toBeGreaterThan(40);
    });
  });

  describe('read-only caches', () => {
    test('PATCH / POST / DELETE on ValueHelpCache and ExistingMaterialCache are 405', async () => {
      const vh = `${ADMIN}/ValueHelpCache(category='PLANT',code='1000')`;
      expect((await PATCH(vh, { text: 'x' }, as('adm'))).status).toBe(405);
      expect((await POST(`${ADMIN}/ValueHelpCache`, { category: 'X', code: 'Y' }, as('adm'))).status).toBe(405);
      expect((await DELETE(vh, as('adm'))).status).toBe(405);
      expect((await PATCH(`${ADMIN}/ExistingMaterialCache('EXS-FERT-0001')`, { description: 'x' }, as('adm'))).status).toBe(405);
    });
  });

  describe('refreshValueHelps', () => {
    test('with an empty category reloads everything and returns the number of codes', async () => {
      mock.valueHelps = [
        { category: 'PLANT', code: '1010', text: 'Walldorf' }, { category: 'PLANT', code: '1020', text: 'Berlin' },
        { category: 'UOM', code: 'EA', text: 'Each' },
      ];
      const res = await POST(`${ADMIN}/refreshValueHelps`, {}, as('adm'));
      expect(res.status).toBe(200);
      expect(res.data.value).toBe(3);
      expect(await cacheCount('mmc.ValueHelpCache')).toBe(3);                  // the previous codes are gone
      const { data } = await GET(`${ADMIN}/ValueHelpCache?$filter=category eq 'PLANT'&$orderby=code`, as('adm'));
      expect(data.value.map((r) => [r.code, r.text])).toEqual([['1010', 'Walldorf'], ['1020', 'Berlin']]);
      expect(data.value[0].lastRefreshedAt).toBeTruthy();
    });

    test('with a category reloads only that category', async () => {
      const before = await cacheCount('mmc.ValueHelpCache', "category <> 'PLANT'");
      mock.valueHelps = [{ category: 'PLANT', code: '9999', text: 'New plant' }, { category: 'UOM', code: 'ZZ', text: 'must not load' }];
      const res = await POST(`${ADMIN}/refreshValueHelps`, { category: 'PLANT' }, as('adm'));
      expect(res.data.value).toBe(1);
      expect(await cacheCount('mmc.ValueHelpCache', "category = 'PLANT'")).toBe(1);
      expect(await cacheCount('mmc.ValueHelpCache', "category <> 'PLANT'")).toBe(before);
    });

    test('loads all categories of the default mock data (the codes the test uploads use)', async () => {
      const res = await POST(`${ADMIN}/refreshValueHelps`, {}, as('adm'));
      const expected = fs.readFileSync(path.join(__dirname, 'data', 'mmc-ValueHelpCache.csv'), 'utf8').trim().split(/\r?\n/).length - 1;
      expect(res.data.value).toBe(expected);
      expect(await cacheCount('mmc.ValueHelpCache')).toBe(expected);
    });

    test('a category S/4 knows nothing about is 404 and the cache stays as it was', async () => {
      const before = await cacheCount('mmc.ValueHelpCache');
      const res = await POST(`${ADMIN}/refreshValueHelps`, { category: 'NOPE' }, as('adm'));
      expect(res.status).toBe(404);
      expect(await cacheCount('mmc.ValueHelpCache')).toBe(before);
    });

    test('an S/4 failure is 502 and the cache stays as it was', async () => {
      const before = await cacheCount('mmc.ValueHelpCache');
      mock.valueHelps = [];
      jest.spyOn(mock, 'loadValueHelps').mockRejectedValueOnce(new S4Error('Destination S4_MATERIAL not found', { kind: 'job' }));
      const res = await POST(`${ADMIN}/refreshValueHelps`, {}, as('adm'));
      expect(res.status).toBe(502);
      expect(res.data.error.message).toContain('Destination S4_MATERIAL not found');
      expect(await cacheCount('mmc.ValueHelpCache')).toBe(before);
    });
  });

  describe('refreshExistingMaterials', () => {
    test('replaces the cache and returns the count', async () => {
      mock.existingMaterials = [{ materialNumber: 'A-1', materialType: 'FERT', description: 'one' }, { materialNumber: 'A-2', materialType: 'ROH', description: 'two' }, { materialNumber: 'A-1', materialType: 'FERT', description: 'dup' }];
      const res = await POST(`${ADMIN}/refreshExistingMaterials`, {}, as('adm'));
      expect(res.data.value).toBe(2);
      const { data } = await GET(`${ADMIN}/ExistingMaterialCache?$orderby=materialNumber`, as('adm'));
      expect(data.value.map((r) => r.materialNumber)).toEqual(['A-1', 'A-2']);
    });
  });

  describe('testS4Connection', () => {
    test('reports OK with the latency', async () => {
      const res = await GET(`${ADMIN}/testS4Connection()`, as('adm'));
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('OK');
      expect(res.data.latencyMs).toBeGreaterThanOrEqual(0);
    });
    test('reports the problem instead of failing', async () => {
      mock.pingBehavior = async () => { throw new S4Error('401 Unauthorized', { kind: 'job' }); };
      const res = await GET(`${ADMIN}/testS4Connection()`, as('adm'));
      expect(res.status).toBe(200);
      expect(res.data.status).toBe('ERROR: 401 Unauthorized');
    });
  });

  describe('rule maintenance', () => {
    const rule = (over = {}) => ({ ruleCode: 'T_RULE', entityName: 'MaterialRequests', fieldName: 'ean', ruleType: 'REQUIRED', severity: 'ERROR', messageText: 'ean is required', ...over });

    test.each([
      ['unknown entity', { entityName: 'Foo' }],
      ['unknown field', { fieldName: 'nope' }],
      ['association as field', { fieldName: 'job' }],
      ['broken regex', { ruleType: 'REGEX', parameter: '([' }],
      ['regex without pattern', { ruleType: 'REGEX', parameter: '' }],
      ['range without parameter', { ruleType: 'RANGE' }],
      ['range min > max', { ruleType: 'RANGE', parameter: '10,1' }],
      ['length not numeric', { ruleType: 'LENGTH', parameter: 'a,b' }],
      ['lookup without category', { ruleType: 'LOOKUP', parameter: '' }],
      ['no message text', { messageText: ' ' }],
    ])('rejects %s (400)', async (_name, over) => {
      const res = await POST(`${ADMIN}/ValidationRules`, rule(over), as('adm'));
      expect(res.status).toBe(400);
    });

    test('an update is checked against the stored rule too', async () => {
      const { data } = await POST(`${ADMIN}/ValidationRules`, rule({ ruleCode: 'T_RANGE', fieldName: 'grossWeight', ruleType: 'RANGE', parameter: '0,10' }), as('adm'));
      expect((await PATCH(`${ADMIN}/ValidationRules(${data.ID})`, { parameter: '5' }, as('adm'))).status).toBe(400);
      expect((await PATCH(`${ADMIN}/ValidationRules(${data.ID})`, { parameter: '0,20' }, as('adm'))).status).toBe(200);
      expect((await DELETE(`${ADMIN}/ValidationRules(${data.ID})`, as('adm'))).status).toBe(204);
    });

    test('a new rule applies on the next validate call (spec §8.8) and not to the one before', async () => {
      const upload = async () => {
        const { data: job } = await POST(`${SVC}/UploadJobs`, {}, { ...as('req1'), headers: {} });
        const { data: f } = await POST(`${SVC}/JobFiles`, { job_ID: job.ID, fileName: 'happy-path.xlsx' }, as('req1'));
        await PUT(`${SVC}/JobFiles(${f.ID})/content`, fs.readFileSync(path.join(__dirname, 'uploads', 'happy-path.xlsx')), { ...as('req1'), headers: { 'Content-Type': 'application/octet-stream' } });
        const act = { ...as('req1'), headers: { 'If-Match': '*' } };
        await POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.parse`, {}, act);
        return { job, validate: () => POST(`${SVC}/UploadJobs(${job.ID})/MassMaterialService.validate`, {}, act) };
      };
      const { job, validate } = await upload();
      expect((await validate()).data).toMatchObject({ status: 'VALIDATED', errorRows: 0 });

      const created = await POST(`${ADMIN}/ValidationRules`, rule({ ruleCode: 'REQUIRED_EAN_T' }), as('adm'));
      expect(created.status).toBe(201);
      expect((await GET(`${SVC}/UploadJobs(${job.ID})`, as('req1'))).data.status).toBe('VALIDATED');   // already validated: untouched

      const after = await validate();
      expect(after.data.status).toBe('DRAFT');
      expect(after.data.errorRows).toBeGreaterThan(0);
      const { data } = await GET(`${SVC}/ValidationMessages?$filter=ruleCode eq 'REQUIRED_EAN_T' and request/job_ID eq ${job.ID}&$top=1`, as('req1'));
      expect(data.value[0]).toMatchObject({ fieldName: 'ean', severity: 'ERROR' });

      await DELETE(`${ADMIN}/ValidationRules(${created.data.ID})`, as('adm'));
    });

    test('material type view configuration supports full CRUD', async () => {
      const key = "MaterialTypeViewConfig(materialType='ZTST',view='SALES')";
      expect((await POST(`${ADMIN}/MaterialTypeViewConfig`, { materialType: 'ZTST', view: 'SALES', mandatory: true }, as('adm'))).status).toBe(201);
      expect((await PATCH(`${ADMIN}/${key}`, { mandatory: false }, as('adm'))).status).toBe(200);
      expect((await GET(`${SVC}/MaterialTypeViews?$filter=materialType eq 'ZTST'`, as('req1'))).data.value[0].mandatory).toBe(false);
      expect((await DELETE(`${ADMIN}/${key}`, as('adm'))).status).toBe(204);
    });
  });

  describe('nightly schedule', () => {
    test('the next run is at the configured hour, within 24 hours', () => {
      const from = new Date(2026, 9, 5, 14, 30, 0);
      const ms = msUntil(2, from);
      expect(new Date(from.getTime() + ms)).toEqual(new Date(2026, 9, 6, 2, 0, 0));
      expect(msUntil(16, from)).toBe(90 * 60 * 1000);
    });
  });
});
