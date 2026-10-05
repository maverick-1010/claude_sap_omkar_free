'use strict';
// Builds the two spreadsheets users download (spec §3.6): the empty upload template and the result file.
// Both use the upload layout of template.js, so a result file can be corrected and uploaded again.
const ExcelJS = require('exceljs');
const { SHEETS, REQUIRED_COLUMNS, NUMBER_COLUMNS, ORG_VIEWS, SHEET_OF_VIEW } = require('./template');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const RESULT_COLUMNS = ['resultStatus', 'createdMaterial', 'errorText'];       // appended to the Basic sheet; ignored on re-upload

const SAMPLE = {
  Basic:      { sourceKey: 'SAMPLE-001', materialNumber: '', materialType: 'FERT', industrySector: 'M', materialGroup: 'MG-FIN', description: 'Sample finished product', language: 'EN', baseUnit: 'EA', grossWeight: 1.5, netWeight: 1.2, weightUnit: 'KG', ean: '' },
  Plant:      { sourceKey: 'SAMPLE-001', plant: '1010', purchasingGroup: '003', mrpType: 'PD', mrpController: '001', lotSizeKey: 'EX', reorderPoint: '', procurementType: 'E', availabilityCheck: '01' },
  Storage:    { sourceKey: 'SAMPLE-001', plant: '1010', storageLocation: '0001' },
  Sales:      { sourceKey: 'SAMPLE-001', salesOrg: '1010', distributionChannel: '10', taxClassification: '1', itemCategoryGroup: 'NORM', deliveringPlant: '1010' },
  Valuation:  { sourceKey: 'SAMPLE-001', valuationArea: '1010', valuationClass: '7920', priceControl: 'S', standardPrice: 10, movingAvgPrice: '', currency: 'EUR' },
  Purchasing: { sourceKey: 'SAMPLE-001', plant: '1010', purchasingGroup: '003', orderUnit: 'EA', grProcessingDays: 2 },
};

function addSheet(wb, name, columns, rows, { required = [] } = {}) {
  const ws = wb.addWorksheet(name);
  ws.addRow(columns).font = { bold: true };
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  columns.forEach((col, i) => {
    const cell = ws.getRow(1).getCell(i + 1);
    if (required.includes(col)) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
    ws.getColumn(i + 1).width = Math.max(14, col.length + 4);
  });
  for (const row of rows) {
    const r = ws.addRow(columns.map((c) => (row[c] === '' || row[c] === undefined ? null : row[c])));
    r.eachCell((cell) => { if (typeof cell.value === 'string') cell.numFmt = '@'; });      // keep codes such as 0001 as text
  }
  return ws;
}

function instructions(wb) {
  const ws = wb.addWorksheet('Instructions');
  ws.getColumn(1).width = 110;
  [
    'Mass Material Creation - upload template',
    '',
    'One sheet per view. Rows are linked by the sourceKey column: use the same sourceKey on every sheet for one material.',
    'Only the Basic sheet is required. Add rows to Plant, Storage, Sales, Valuation and Purchasing as the material type needs them.',
    'Highlighted headers are mandatory columns: they must exist; empty values are reported when the file is validated.',
    'Column order does not matter and unknown columns are ignored. Maximum 5,000 materials and 10 MB per file.',
    'Delete the SAMPLE-001 rows before uploading.',
  ].forEach((line, i) => { const c = ws.addRow([line]).getCell(1); if (i === 0) c.font = { bold: true, size: 14 }; });
}

async function toBuffer(wb) {
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Empty template with all sheets, headers and one sample row. */
async function buildTemplate() {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mass Material Creation';
  instructions(wb);
  for (const [name, spec] of Object.entries(SHEETS)) addSheet(wb, name, spec.cols, [SAMPLE[name]], { required: REQUIRED_COLUMNS[name] });
  return toBuffer(wb);
}

const numeric = (col, v) => (NUMBER_COLUMNS.has(col) && v !== null && v !== undefined && v !== '' ? Number(v) : v);
const cleaned = (cols, rec) => Object.fromEntries(cols.map((c) => [c, numeric(c, rec[c])]));

/**
 * requests: MaterialRequests rows of the job (ordered); org: Map(requestID -> { plant: [..], ... });
 * messages: Map(requestID -> [ValidationMessages])
 */
async function buildResult(requests, org, messages) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Mass Material Creation';

  const basic = requests.filter((r) => !r.isOrphan).map((r) => ({
    ...cleaned(SHEETS.Basic.cols, r),
    resultStatus: r.status,
    createdMaterial: r.createdMaterial,
    errorText: errorText(r, messages.get(r.ID) ?? []),
  }));
  addSheet(wb, 'Basic', [...SHEETS.Basic.cols, ...RESULT_COLUMNS], basic, { required: REQUIRED_COLUMNS.Basic });

  for (const view of ORG_VIEWS) {
    const name = SHEET_OF_VIEW[view], cols = SHEETS[name].cols;
    const rows = requests.flatMap((r) => (org.get(r.ID)?.[view] ?? []).map((o) => cleaned(cols, { ...o, sourceKey: r.sourceKey })));
    addSheet(wb, name, cols, rows, { required: REQUIRED_COLUMNS[name] });
  }
  return toBuffer(wb);
}

// S/4 error for rows that were posted, otherwise the validation messages that explain the row status
function errorText(request, msgs) {
  if (request.s4ErrorText) return `${request.s4ErrorCode ? `[${request.s4ErrorCode}] ` : ''}${request.s4ErrorText}`;
  return msgs.filter((m) => m.severity !== 'INFO').map((m) => `${m.severity}: ${m.messageText}`).join('; ');
}

module.exports = { buildTemplate, buildResult, XLSX_TYPE };
