'use strict';
// S/4HANA adapter on API_PRODUCT_SRV through the SAP Cloud SDK and the BTP destination S4_MATERIAL (spec §3.5).
//
// NOT YET VERIFIED against a real system: the field names in toProduct() follow the published
// API_PRODUCT_SRV entity types (A_Product, A_ProductDescription, A_ProductPlant, ...) but must be
// checked against the $metadata of the target S/4 before the first real posting.
// A BAPI-based adapter can replace this one: it only has to implement postMaterial(material, ctx).
const { S4Error } = require('./errors');

const DESTINATION = require('@sap/cds').env.mmc?.s4?.destination ?? 'S4_MATERIAL';
const BASE_PATH = '/sap/opu/odata/sap/API_PRODUCT_SRV';

const num = (v) => (v === null || v === undefined || v === '' ? undefined : String(v));
const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

function toProduct(m) {
  return strip({
    Product: m.materialNumber,
    ProductType: m.materialType,
    IndustrySector: m.industrySector,
    ProductGroup: m.materialGroup,
    BaseUnit: m.baseUnit,
    GrossWeight: num(m.grossWeight),
    NetWeight: num(m.netWeight),
    WeightUnit: m.weightUnit,
    ProductStandardID: m.ean,
    to_Description: [strip({ Language: m.language ?? 'EN', ProductDescription: m.description })],
    to_Plant: m.plant.map((p) => strip({
      Plant: p.plant, PurchasingGroup: p.purchasingGroup, MRPType: p.mrpType, MRPResponsible: p.mrpController,
      ProcurementType: p.procurementType, AvailabilityCheckType: p.availabilityCheck,
      to_StorageLocation: m.storage.filter((s) => s.plant === p.plant).map((s) => ({ Plant: s.plant, StorageLocation: s.storageLocation })),
    })),
    to_SalesDelivery: m.sales.map((s) => strip({
      ProductSalesOrg: s.salesOrg, ProductDistributionChnl: s.distributionChannel, ItemCategoryGroup: s.itemCategoryGroup,
    })),
    to_Valuation: m.valuation.map((v) => strip({
      ValuationArea: v.valuationArea, ValuationClass: v.valuationClass, PriceControl: v.priceControl,
      StandardPrice: num(v.standardPrice), MovingAveragePrice: num(v.movingAvgPrice), Currency: v.currency,
    })),
  });
}

function classify(e) {
  if (e instanceof S4Error) return e;
  const status = e.response?.status ?? e.status;
  const sap = e.response?.data?.error;
  const code = sap?.code ?? e.code ?? null;
  const text = sap?.message?.value ?? sap?.message ?? e.message;
  if (/destination/i.test(e.message) && /not found|could not be found|no destination/i.test(e.message)) return new S4Error(text, { kind: 'job', code: 'DESTINATION', cause: e });
  if (status === 401 || status === 403) return new S4Error(text, { kind: 'job', code: String(status), cause: e });
  const lock = /lock|enqueue/i.test(`${code} ${text}`);
  if (['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND'].includes(e.code) || status === 429 || status >= 500 || lock)
    return new S4Error(text, { kind: 'transient', code: String(code ?? status ?? ''), cause: e });
  return new S4Error(text, { kind: 'business', code: String(code ?? status ?? ''), cause: e });
}

async function postMaterial(material, ctx) {
  // loaded lazily so local development and tests do not need the SDK or a destination
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  try {
    const res = await executeHttpRequest(
      { destinationName: DESTINATION },
      {
        method: 'POST',
        url: `${BASE_PATH}/A_Product`,
        headers: { 'Content-Type': 'application/json', 'sap-correlation-id': ctx.correlationId, 'x-external-request-id': ctx.externalRequestId },
        data: toProduct(material),
      },
      { fetchCsrfToken: true },
    );
    return { material: res.data?.d?.Product ?? res.data?.Product };
  } catch (e) {
    throw classify(e);
  }
}

// ---- reference data and connection check (spec §3.7). Also NOT verified against a real system. ----
// S/4 has no single API for all code lists, so each category is mapped to a service path in configuration:
//   cds.env.mmc.s4.valueHelps = { PLANT: { path: '/sap/opu/odata/sap/API_PLANT_SRV/A_Plant', code: 'Plant', text: 'PlantName' }, ... }
async function get(url) {
  const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');
  try {
    return (await executeHttpRequest({ destinationName: DESTINATION }, { method: 'GET', url, headers: { Accept: 'application/json' } })).data;
  } catch (e) {
    throw classify(e);
  }
}
const resultsOf = (data) => data?.d?.results ?? data?.value ?? [];

async function loadValueHelps(category) {
  const cds = require('@sap/cds');
  const config = cds.env.mmc?.s4?.valueHelps ?? {};
  const categories = category ? [category] : Object.keys(config);
  const out = [];
  for (const cat of categories) {
    const c = config[cat];
    if (!c) throw new S4Error(`No S/4 source configured for value help category ${cat}`, { kind: 'business', code: 'NOT_CONFIGURED' });
    const data = await get(`${c.path}?$select=${c.code},${c.text}&$top=${c.top ?? 5000}`);
    for (const r of resultsOf(data)) out.push({ category: cat, code: String(r[c.code]), text: r[c.text] ?? null });
  }
  return out;
}

async function loadExistingMaterials() {
  const out = [], page = 5000;
  for (let skip = 0; ; skip += page) {
    const rows = resultsOf(await get(`${BASE_PATH}/A_Product?$select=Product,ProductType&$top=${page}&$skip=${skip}&$orderby=Product`));
    out.push(...rows.map((r) => ({ materialNumber: r.Product, materialType: r.ProductType, description: null })));
    if (rows.length < page) return out;
  }
}

async function ping() {
  await get(`${BASE_PATH}/A_Product?$select=Product&$top=1`);
}

module.exports = { postMaterial, loadValueHelps, loadExistingMaterials, ping, toProduct, classify };
