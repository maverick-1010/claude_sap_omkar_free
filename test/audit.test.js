'use strict';
/** Spec §4.7: audit logging on approve, reject and all MaterialAdminService writes. */
process.env.CDS_CONFIG = JSON.stringify({
  mmc: { s4: { adapter: 'mock' }, posting: { backoffMs: 1 } },
  requires: { auth: { kind: 'mocked', users: {
    req1: { roles: ['MaterialRequester'] },
    appr: { roles: ['MaterialApprover'] },
    adm:  { roles: ['MaterialAdmin'] },
  } } },
});

const path = require('path');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const mock = require('../srv/lib/s4/mock.adapter');

const ADMIN = '/odata/v4/material-admin';
const SVC = '/odata/v4/mass-material';
const as = (user) => ({ auth: { username: user, password: '' }, headers: { 'If-Match': '*' } });

describe('audit logging', () => {
  const { POST, PATCH, DELETE, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  let log;
  beforeAll(async () => { log = jest.spyOn(await cds.connect.to('audit-log'), 'log'); });
  beforeEach(() => { mock.reset(); log.mockClear(); });

  const events = (type) => log.mock.calls.filter(([event]) => event === type).map(([, data]) => data);

  async function pendingJob() {
    const { data } = await POST(`${SVC}/UploadJobs`, {}, as('req1'));
    await cds.db.run(UPDATE('mmc.UploadJobs', data.ID).with({ status: 'PENDING_APPROVAL', requiresApproval: true }));
    return data.ID;
  }

  test('approve is logged with the job and the requester', async () => {
    const ID = await pendingJob();
    expect((await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.approve`, {}, as('appr'))).status).toBe(204);
    expect(events('SecurityEvent')).toEqual([{ data: { action: 'approve', jobID: ID, requester: 'req1' } }]);
  });

  test('reject is logged with the reason', async () => {
    const ID = await pendingJob();
    await POST(`${SVC}/UploadJobs(${ID})/MassMaterialService.reject`, { reason: 'wrong plant' }, as('appr'));
    expect(events('SecurityEvent')).toEqual([{ data: { action: 'reject', jobID: ID, requester: 'req1', reason: 'wrong plant' } }]);
  });

  test('a refused approve (wrong status) is not logged', async () => {
    const { data } = await POST(`${SVC}/UploadJobs`, {}, as('req1'));
    await cds.db.run(UPDATE('mmc.UploadJobs', data.ID).with({ status: 'VALIDATED' }));     // not PENDING_APPROVAL, and visible to the approver
    expect((await POST(`${SVC}/UploadJobs(${data.ID})/MassMaterialService.approve`, {}, as('appr'))).status).toBe(409);
    expect(events('SecurityEvent')).toEqual([]);
  });

  test('rule create / update / delete are logged per changed attribute', async () => {
    const rule = { ruleCode: 'AUD_1', entityName: 'MaterialRequests', fieldName: 'ean', ruleType: 'REQUIRED', severity: 'ERROR', messageText: 'ean is required' };
    const created = await POST(`${ADMIN}/ValidationRules`, rule, as('adm'));
    const ID = created.data.ID;
    const createdNames = events('ConfigurationModified').map((e) => e.attributes[0].name);
    expect(createdNames).toEqual(expect.arrayContaining(['ruleCode', 'fieldName', 'messageText']));
    expect(events('ConfigurationModified')[0].object).toEqual({ type: 'ValidationRules', id: { ID } });

    log.mockClear();
    await PATCH(`${ADMIN}/ValidationRules(${ID})`, { active: false, messageText: 'changed' }, as('adm'));
    const updated = events('ConfigurationModified');
    expect(updated.map((e) => e.attributes[0])).toEqual(expect.arrayContaining([
      { name: 'active', old: 'true', new: 'false' }, { name: 'messageText', old: 'ean is required', new: 'changed' },
    ]));
    expect(updated.every((e) => e.object.id.ID === ID)).toBe(true);
    expect(updated.find((e) => e.attributes[0].name === 'ruleCode')).toBeUndefined();   // unchanged: not logged

    log.mockClear();
    await DELETE(`${ADMIN}/ValidationRules(${ID})`, as('adm'));
    expect(events('ConfigurationModified').map((e) => e.attributes[0].name)).toEqual(expect.arrayContaining(['ruleCode', 'messageText']));
    expect(events('ConfigurationModified')[0].attributes[0].new).toBe('');
  });

  test('view configuration changes are logged with their composite key', async () => {
    await POST(`${ADMIN}/MaterialTypeViewConfig`, { materialType: 'ZAUD', view: 'SALES', mandatory: true }, as('adm'));
    expect(events('ConfigurationModified')[0]).toMatchObject({ object: { type: 'MaterialTypeViewConfig', id: { materialType: 'ZAUD', view: 'SALES' } } });
    log.mockClear();
    await PATCH(`${ADMIN}/MaterialTypeViewConfig(materialType='ZAUD',view='SALES')`, { mandatory: false }, as('adm'));
    expect(events('ConfigurationModified')[0].attributes[0]).toEqual({ name: 'mandatory', old: 'true', new: 'false' });
  });

  test('cache refreshes are logged with the number loaded', async () => {
    await POST(`${ADMIN}/refreshValueHelps`, { category: 'PLANT' }, as('adm'));
    expect(events('ConfigurationModified')[0]).toMatchObject({ object: { type: 'ValueHelpCache', id: { category: 'PLANT' } }, attributes: [{ name: 'codes', old: '', new: '4' }] });
    log.mockClear();
    await POST(`${ADMIN}/refreshExistingMaterials`, {}, as('adm'));
    expect(events('ConfigurationModified')[0].attributes[0]).toMatchObject({ name: 'materials', new: '10' });
  });

  test('a rejected write (invalid rule) leaves no audit entry', async () => {
    const res = await POST(`${ADMIN}/ValidationRules`, { ruleCode: 'X', entityName: 'Nope', fieldName: 'a', ruleType: 'REQUIRED', messageText: 'm' }, as('adm'));
    expect(res.status).toBe(400);
    expect(events('ConfigurationModified')).toEqual([]);
  });
});
