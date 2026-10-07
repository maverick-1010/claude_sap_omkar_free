'use strict';
// Upload template layout (spec §3.2, §3.6): one sheet per view, linked by sourceKey.
// Shared by the parser, the template download and the result file.

const SHEETS = {
  Basic:      { view: 'basic',      entity: 'MaterialRequests',      cols: ['sourceKey', 'materialNumber', 'materialType', 'industrySector', 'materialGroup', 'description', 'language', 'baseUnit', 'grossWeight', 'netWeight', 'weightUnit', 'ean'] },
  Plant:      { view: 'plant',      entity: 'MaterialPlantData',     cols: ['sourceKey', 'plant', 'purchasingGroup', 'mrpType', 'mrpController', 'lotSizeKey', 'reorderPoint', 'procurementType', 'availabilityCheck'] },
  Storage:    { view: 'storage',    entity: 'MaterialStorageData',   cols: ['sourceKey', 'plant', 'storageLocation'] },
  Sales:      { view: 'sales',      entity: 'MaterialSalesData',     cols: ['sourceKey', 'salesOrg', 'distributionChannel', 'taxClassification', 'itemCategoryGroup', 'deliveringPlant'] },
  Valuation:  { view: 'valuation',  entity: 'MaterialValuationData', cols: ['sourceKey', 'valuationArea', 'valuationClass', 'priceControl', 'standardPrice', 'movingAvgPrice', 'currency'] },
  Purchasing: { view: 'purchasing', entity: 'MaterialPurchasingData', cols: ['sourceKey', 'plant', 'purchasingGroup', 'orderUnit', 'grProcessingDays'] },
};

// Columns that must exist in the header (their values may still be blank: that is a validation error, not a file error)
const REQUIRED_COLUMNS = {
  Basic:      ['sourceKey', 'materialType', 'industrySector', 'materialGroup', 'description', 'baseUnit'],
  Plant:      ['sourceKey', 'plant'],
  Storage:    ['sourceKey', 'plant', 'storageLocation'],
  Sales:      ['sourceKey', 'salesOrg', 'distributionChannel'],
  Valuation:  ['sourceKey', 'valuationArea', 'valuationClass', 'priceControl'],
  Purchasing: ['sourceKey', 'plant', 'orderUnit'],
};

// Codes are upper-cased on import; everything else is only trimmed
const CODE_COLUMNS = new Set([
  'materialType', 'industrySector', 'materialGroup', 'language', 'baseUnit', 'weightUnit', 'plant', 'purchasingGroup',
  'mrpType', 'mrpController', 'lotSizeKey', 'procurementType', 'availabilityCheck', 'storageLocation', 'salesOrg',
  'distributionChannel', 'taxClassification', 'itemCategoryGroup', 'deliveringPlant', 'valuationArea', 'valuationClass',
  'priceControl', 'currency', 'orderUnit',
]);
const NUMBER_COLUMNS = new Set(['grossWeight', 'netWeight', 'reorderPoint', 'standardPrice', 'movingAvgPrice', 'grProcessingDays']);

const ORG_VIEWS = ['plant', 'storage', 'sales', 'valuation', 'purchasing'];
const SHEET_OF_VIEW = Object.fromEntries(Object.entries(SHEETS).map(([name, s]) => [s.view, name]));
const FLAT_COLUMNS = [...new Set(Object.values(SHEETS).flatMap((s) => s.cols))];

module.exports = { SHEETS, REQUIRED_COLUMNS, CODE_COLUMNS, NUMBER_COLUMNS, ORG_VIEWS, SHEET_OF_VIEW, FLAT_COLUMNS };
