using { mmc } from '../db/schema';

// Upload / validation / posting API for mass material creation
service MaterialService @(path: '/odata/v4/material') {

  // Job header and its uploaded file
  entity UploadJobs             as projection on mmc.UploadJobs;
  entity JobFiles               as projection on mmc.JobFiles;

  // Material row and its org-level views
  entity MaterialRequests       as projection on mmc.MaterialRequests;
  entity MaterialPlantData      as projection on mmc.MaterialPlantData;
  entity MaterialStorageData    as projection on mmc.MaterialStorageData;
  entity MaterialSalesData      as projection on mmc.MaterialSalesData;
  entity MaterialValuationData  as projection on mmc.MaterialValuationData;
  entity MaterialPurchasingData as projection on mmc.MaterialPurchasingData;

  // Validation results are produced by the app, not edited by users
  @readonly entity ValidationMessages as projection on mmc.ValidationMessages;

  // Configuration and caches (reference data)
  @readonly entity MaterialTypeViewConfig as projection on mmc.MaterialTypeViewConfig;
  @readonly entity ValidationRules        as projection on mmc.ValidationRules;
  @readonly entity ValueHelpCache         as projection on mmc.ValueHelpCache;
  @readonly entity ExistingMaterialCache  as projection on mmc.ExistingMaterialCache;
}
