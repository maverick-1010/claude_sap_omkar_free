'use strict';
const cds = require('@sap/cds');
const { keyOf } = require('../lib/util');
const { checkRule } = require('../lib/rule-check');
const audit = require('../lib/audit');
const { refreshValueHelps, refreshExistingMaterials, testConnection } = require('../lib/reference-data');

module.exports = (srv) => {
  const { ValidationRules } = srv.entities;
  const db = cds.entities('mmc');

  // Rules are data: reject the ones the engine could not evaluate
  srv.before(['CREATE', 'UPDATE'], ValidationRules, async (req) => {
    const stored = req.event === 'UPDATE' ? await SELECT.one.from(db.ValidationRules).where({ ID: keyOf(req) }) : null;
    const error = checkRule({ ...stored, ...req.data });
    if (error) req.reject(400, error);
  });

  // Every write of this service is audit-logged (spec §4.7): the old row is read before the change
  const configs = {
    ValidationRules: { fields: ['ruleCode', 'entityName', 'fieldName', 'ruleType', 'parameter', 'severity', 'materialType', 'messageText', 'active'], id: (r) => ({ ID: r.ID }) },
    MaterialTypeViewConfig: { fields: ['mandatory'], id: (r) => ({ materialType: r.materialType, view: r.view }) },
  };
  const olds = new WeakMap();
  for (const [name, cfg] of Object.entries(configs)) {
    const entity = srv.entities[name];
    srv.before(['UPDATE', 'DELETE'], entity, async (req) => {
      const key = req.params.at(-1);                       // { ID } / { materialType, view }, or a bare UUID
      olds.set(req, await SELECT.one.from(db[name]).where(typeof key === 'object' ? key : { ID: key }));
    });
    srv.after(['CREATE', 'UPDATE', 'DELETE'], entity, async (result, req) => {
      const before = olds.get(req) ?? null;
      const after = req.event === 'DELETE' ? null : { ...before, ...req.data, ...result };
      const row = after ?? before;
      await audit.configChange(name, cfg.id(row), audit.diff(before, after, cfg.fields));
    });
  }

  srv.on('refreshValueHelps', async (req) => {
    const count = await fromS4(req, () => refreshValueHelps(req.data.category));
    await audit.configChange('ValueHelpCache', { category: req.data.category || '*' }, { codes: [null, count] });
    return count;
  });
  srv.on('refreshExistingMaterials', async (req) => {
    const count = await fromS4(req, () => refreshExistingMaterials());
    await audit.configChange('ExistingMaterialCache', {}, { materials: [null, count] });
    return count;
  });
  srv.on('testS4Connection', () => testConnection());

  // S/4 problems are a bad gateway for the admin, not a bug of this service; the old cache stays in place
  async function fromS4(req, load) {
    try {
      return await load();
    } catch (e) {
      if (!e.kind) throw e;
      req.reject(e.code === 'EMPTY' ? 404 : 502, `S/4HANA: ${e.message}`);
    }
  }
};
