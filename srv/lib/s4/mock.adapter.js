'use strict';
// In-memory S/4 stand-in for local development and tests (spec §3.5, §8.5).
// Idempotent like the real contract requires: the same externalRequestId never creates a second material.
// Tests steer it through `behavior`, which may throw an S4Error or return nothing to succeed.

const fs = require('fs');
const path = require('path');
const { csvRecords } = require('../parser');

// Default reference data: the files under test/data (the same codes the test uploads are built from)
function csvRows(file) {
  const full = path.join(__dirname, '..', '..', '..', 'test', 'data', file);
  if (!fs.existsSync(full)) return [];
  const [head, ...body] = csvRecords(fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, ''), ',');
  return body.map((r) => Object.fromEntries(head.cells.map((h, i) => [h.trim(), r.cells[i] ?? ''])));
}

const mock = {
  calls: [],                       // every postMaterial call: { externalRequestId, sourceKey, materialNumber }
  created: new Map(),              // externalRequestId -> material number
  behavior: null,                  // async (material, ctx, attempt) => void | throws S4Error
  valueHelps: null,                // [{ category, code, text }]; null = test/data/mmc-ValueHelpCache.csv
  existingMaterials: null,         // [{ materialNumber, materialType, description }]; null = test/data/mmc-ExistingMaterialCache.csv
  pingBehavior: null,              // async () => void | throws S4Error
  counter: 0,

  reset() {
    this.calls.length = 0;
    this.created.clear();
    this.behavior = null;
    this.valueHelps = null;
    this.existingMaterials = null;
    this.pingBehavior = null;
    this.counter = 0;
  },

  async postMaterial(material, ctx) {
    this.calls.push({ externalRequestId: ctx.externalRequestId, sourceKey: ctx.sourceKey, materialNumber: material.materialNumber });
    const attempt = this.calls.filter((c) => c.externalRequestId === ctx.externalRequestId).length;
    if (this.behavior) await this.behavior(material, ctx, attempt);
    if (!this.created.has(ctx.externalRequestId)) {
      this.created.set(ctx.externalRequestId, material.materialNumber || `MAT${String(++this.counter).padStart(8, '0')}`);
    }
    return { material: this.created.get(ctx.externalRequestId) };
  },
};

// Reference data and connection check (spec §3.7)
mock.loadValueHelps = async function (category) {
  const rows = (this.valueHelps ?? csvRows('mmc-ValueHelpCache.csv')).map(({ category: c, code, text }) => ({ category: c, code, text }));
  return category ? rows.filter((r) => r.category === category) : rows;
};
mock.loadExistingMaterials = async function () {
  return (this.existingMaterials ?? csvRows('mmc-ExistingMaterialCache.csv')).map(({ materialNumber, materialType, description }) => ({ materialNumber, materialType, description }));
};
mock.ping = async function () {
  if (this.pingBehavior) await this.pingBehavior();
};

module.exports = mock;
