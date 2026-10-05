'use strict';
// Audit logging through @cap-js/audit-logging (spec §4.7): approve / reject and every write of MaterialAdminService.
// The plugin adds user, tenant and time, and writes in the request transaction, so a rolled-back change leaves no entry.
const cds = require('@sap/cds');

async function service() {
  return cds.services['audit-log'] ?? (cds.requires['audit-log'] ? cds.connect.to('audit-log') : null);   // no-op without the plugin
}

/** Business decisions, e.g. approve / reject of an upload. */
async function securityEvent(action, data) {
  const audit = await service();
  if (audit) await audit.log('SecurityEvent', { data: { action, ...data } });
}

/** One entry per changed attribute: changes = { field: [oldValue, newValue] }. */
async function configChange(type, id, changes) {
  const audit = await service();
  if (!audit) return;
  for (const [name, [old, value]] of Object.entries(changes))
    await audit.log('ConfigurationModified', { object: { type, id }, attributes: [{ name, old: format(old), new: format(value) }] });
}

const format = (v) => (v === null || v === undefined ? '' : String(v));

/** Differences between two versions of a record; either side may be missing (create / delete). */
function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    const b = before?.[f] ?? null, a = after?.[f] ?? null;
    if (String(b) !== String(a)) out[f] = [b, a];
  }
  return out;
}

module.exports = { securityEvent, configChange, diff };
