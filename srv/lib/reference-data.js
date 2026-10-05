'use strict';
// Reloads the S/4 caches (spec §3.7): value helps for LOOKUP rules, existing materials for duplicate checks.
// Used by the admin actions and the nightly job. A failed or empty load never wipes the old cache.
const cds = require('@sap/cds');
const { getAdapter } = require('./s4/adapter');
const { S4Error } = require('./s4/errors');

const BATCH = 1000;
const now = () => new Date().toISOString();

async function insertAll(entity, rows) {
  for (let i = 0; i < rows.length; i += BATCH) await INSERT.into(entity).entries(rows.slice(i, i + BATCH));
}

/** category empty = all categories. Returns the number of codes loaded. */
async function refreshValueHelps(category) {
  const { ValueHelpCache } = cds.entities('mmc');
  const loaded = await getAdapter().loadValueHelps(category || undefined);
  if (!loaded.length) throw new S4Error(category ? `S/4 returned no codes for category ${category}` : 'S/4 returned no value help codes', { kind: 'business', code: 'EMPTY' });

  const stamp = now();
  const unique = new Map(loaded.map((r) => [`${r.category}\u0000${r.code}`, { category: r.category, code: r.code, text: r.text ?? null, lastRefreshedAt: stamp }]));
  const categories = category ? [category] : [...new Set(loaded.map((r) => r.category))];

  // replace what was loaded: with an empty category also categories S/4 no longer delivers
  await (category ? DELETE.from(ValueHelpCache).where({ category }) : DELETE.from(ValueHelpCache));
  await insertAll(ValueHelpCache, [...unique.values()]);
  cds.log('reference-data').info(`value helps refreshed: ${unique.size} codes in ${categories.length} categories`);
  return unique.size;
}

/** Returns the number of material numbers loaded. */
async function refreshExistingMaterials() {
  const { ExistingMaterialCache } = cds.entities('mmc');
  const loaded = await getAdapter().loadExistingMaterials();
  const stamp = now();
  const unique = new Map(loaded.map((r) => [r.materialNumber, { materialNumber: r.materialNumber, materialType: r.materialType ?? null, description: r.description ?? null, lastRefreshedAt: stamp }]));

  await DELETE.from(ExistingMaterialCache);
  await insertAll(ExistingMaterialCache, [...unique.values()]);
  cds.log('reference-data').info(`existing materials refreshed: ${unique.size}`);
  return unique.size;
}

/** Never throws: the answer is the status. */
async function testConnection() {
  const started = Date.now();
  try {
    await getAdapter().ping();
    return { status: 'OK', latencyMs: Date.now() - started };
  } catch (e) {
    return { status: `ERROR: ${e.message}`.slice(0, 200), latencyMs: Date.now() - started };
  }
}

module.exports = { refreshValueHelps, refreshExistingMaterials, testConnection };
