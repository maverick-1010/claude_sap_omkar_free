using { mmc } from '../db/schema';

// Upload / validation / posting API for mass material creation (spec §2.1, §2.3)
service MassMaterialService @(path: '/odata/v4/mass-material') {

  // Job header, its uploaded file, and lifecycle operations
  entity UploadJobs as projection on mmc.UploadJobs
    actions {
      action   parse()                    returns ParseResult;
      action   validate()                 returns ValidationResult;
      action   submit();
      action   approve();
      action   reject(reason : String(500));
      action   cancel();
      action   retryFailed()              returns RetryResult;
      function downloadResult()           returns @Core.MediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' LargeBinary;
    };

  // Created through the media stream; no delete (spec §2.1)
  @Capabilities.DeleteRestrictions.Deletable: false
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

  // Reference data for value helps and required views
  @readonly entity ValueHelps         as projection on mmc.ValueHelpCache;
  @readonly entity MaterialTypeViews  as projection on mmc.MaterialTypeViewConfig;

  // Empty upload template (.xlsx) for any authenticated user
  function getTemplate() returns @Core.MediaType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' LargeBinary;

  type ParseResult {
    totalRows : Integer;
  }

  type ValidationResult {
    status      : String;
    totalRows   : Integer;
    validRows   : Integer;
    warningRows : Integer;
    errorRows   : Integer;
  }

  type RetryResult {
    queued : Integer;
  }
}
