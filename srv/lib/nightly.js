'use strict';
const cds = require('@sap/cds');
const { refreshValueHelps, refreshExistingMaterials } = require('./reference-data');

// Nightly refresh of both caches (spec §3.7). Config: cds.env.mmc.nightlyRefresh = { enabled, hour }.
// Off under test. With several app instances every instance runs it: harmless, the load replaces the cache.
const DAY = 24 * 60 * 60 * 1000;

function msUntil(hour, from = new Date()) {
  const next = new Date(from);
  next.setHours(hour, 0, 0, 0);
  if (next <= from) next.setTime(next.getTime() + DAY);
  return next - from;
}

async function refreshAll() {
  const log = cds.log('reference-data');
  for (const [name, load] of [['value helps', () => refreshValueHelps()], ['existing materials', () => refreshExistingMaterials()]]) {
    try { await load(); } catch (e) { log.error(`nightly refresh of ${name} failed:`, e.message); }   // one failure must not skip the other
  }
}

function schedule() {
  const config = cds.env.mmc?.nightlyRefresh ?? {};
  if (config.enabled === false || (config.enabled === undefined && process.env.NODE_ENV === 'test')) return;
  const next = () => cds.spawn({ after: msUntil(config.hour ?? 2) }, refreshAll).on('done', next);
  next();
}

module.exports = { schedule, refreshAll, msUntil };
