using { cuid, managed } from '@sap/cds/common';
using {
  mmc.JobStatus, mmc.RowStatus, mmc.Severity, mmc.ViewType, mmc.RuleType,
  mmc.MaterialNumber, mmc.Plant, mmc.UoM, mmc.Currency, mmc.Quantity, mmc.Amount
} from './common';

namespace mmc;

// ---------- Job header ----------

@title: '{i18n>UploadJobs_Entity}'
entity UploadJobs : cuid, managed {
  @title: '{i18n>JobNo}' jobNo            : Integer @readonly;          // set via sequence/handler
  @title: '{i18n>JobDescription}' description      : String(120);
  @title: '{i18n>FileName}' fileName         : String(255);
  @title: '{i18n>JobStatus}' status           : JobStatus default 'DRAFT';
  @title: '{i18n>CorrelationId}' correlationId    : UUID;                       // used in logs and S/4 calls
  @title: '{i18n>TotalRows}' totalRows        : Integer default 0;
  @title: '{i18n>ValidRows}' validRows        : Integer default 0;
  @title: '{i18n>WarningRows}' warningRows      : Integer default 0;
  @title: '{i18n>ErrorRows}' errorRows        : Integer default 0;
  @title: '{i18n>SuccessRows}' successRows      : Integer default 0;
  @title: '{i18n>FailedRows}' failedRows       : Integer default 0;
  @title: '{i18n>ProgressPct}' progressPct      : Integer default 0;          // updated by background worker
  @title: '{i18n>RequiresApproval}' requiresApproval : Boolean default false;
  @title: '{i18n>SubmittedBy}' submittedBy      : String(255);
  @title: '{i18n>SubmittedAt}' submittedAt      : Timestamp;
  @title: '{i18n>ApprovedBy}' approvedBy       : String(255);
  @title: '{i18n>ApprovedAt}' approvedAt       : Timestamp;
  @title: '{i18n>RejectionReason}' rejectionReason  : String(500);
  @title: '{i18n>PostingStartedAt}' postingStartedAt : Timestamp;
  @title: '{i18n>PostingEndedAt}' postingEndedAt   : Timestamp;

  // UI helpers (computed in an after-READ handler)
  @title: '{i18n>StatusCriticality}' virtual statusCriticality : Integer;

  @title: '{i18n>UploadedFile}' file     : Composition of one JobFiles on file.job = $self;
  @title: '{i18n>MaterialRequests}' requests : Composition of many MaterialRequests on requests.job = $self;
}

@title: '{i18n>JobFiles_Entity}'
entity JobFiles : cuid {
  @title: '{i18n>Job}' job       : Association to UploadJobs;
  @Core.MediaType: mediaType
  @title: '{i18n>FileContent}' content   : LargeBinary;
  @Core.IsMediaType: true
  @title: '{i18n>MediaType}' mediaType : String(100);
  @title: '{i18n>FileName}' fileName  : String(255);
  @title: '{i18n>FileSize}' fileSize  : Integer;
}

// ---------- Material row (one per spreadsheet row) ----------

@title: '{i18n>MaterialRequests_Entity}'
entity MaterialRequests : cuid, managed {
  @title: '{i18n>Job}' job               : Association to UploadJobs;
  @title: '{i18n>RowNo}' rowNo             : Integer;
  @title: '{i18n>SourceKey}' sourceKey         : String(60);                // links the template sheets; used to match test results
  @title: '{i18n>RowStatus}' status            : RowStatus default 'NEW';
  @title: '{i18n>ExternalRequestId}' externalRequestId : UUID;                      // idempotency key for S/4 posting

  // Basic data
  @title: '{i18n>MaterialNumber}' materialNumber    : MaterialNumber;            // optional if internal numbering
  @title: '{i18n>MaterialType}' materialType      : String(4);
  @title: '{i18n>IndustrySector}' industrySector    : String(1);
  @title: '{i18n>MaterialGroup}' materialGroup     : String(9);
  @title: '{i18n>MaterialDescription}' description       : String(40);
  @title: '{i18n>Language}' language          : String(2) default 'EN';
  @title: '{i18n>BaseUnit}' baseUnit          : UoM;
  @title: '{i18n>GrossWeight}' grossWeight       : Quantity;
  @title: '{i18n>NetWeight}' netWeight         : Quantity;
  @title: '{i18n>WeightUnit}' weightUnit        : UoM;
  @title: '{i18n>Ean}' ean               : String(18);

  // Posting outcome
  @title: '{i18n>CreatedMaterial}' createdMaterial   : MaterialNumber;            // number returned by S/4
  @title: '{i18n>S4ErrorCode}' s4ErrorCode       : String(60);
  @title: '{i18n>S4ErrorText}' s4ErrorText       : String(1000);
  @title: '{i18n>Attempts}' attempts          : Integer default 0;
  @title: '{i18n>LastAttemptAt}' lastAttemptAt     : Timestamp;

  @title: '{i18n>PlantData}' plantData         : Composition of many MaterialPlantData     on plantData.request     = $self;
  @title: '{i18n>StorageData}' storageData       : Composition of many MaterialStorageData   on storageData.request   = $self;
  @title: '{i18n>SalesData}' salesData         : Composition of many MaterialSalesData     on salesData.request     = $self;
  @title: '{i18n>ValuationData}' valuationData     : Composition of many MaterialValuationData on valuationData.request = $self;
  @title: '{i18n>PurchasingData}' purchasingData    : Composition of many MaterialPurchasingData on purchasingData.request = $self;
  @title: '{i18n>ValidationMessages}' messages          : Composition of many ValidationMessages    on messages.request      = $self;

  @title: '{i18n>StatusCriticality}' virtual statusCriticality : Integer;
}

// ---------- Org-level views ----------

@title: '{i18n>MaterialPlantData_Entity}'
entity MaterialPlantData : cuid {
  @title: '{i18n>Request}' request           : Association to MaterialRequests;
  @title: '{i18n>Plant}' plant             : Plant;
  @title: '{i18n>PurchasingGroup}' purchasingGroup   : String(3);
  @title: '{i18n>MrpType}' mrpType           : String(2);
  @title: '{i18n>MrpController}' mrpController     : String(3);
  @title: '{i18n>LotSizeKey}' lotSizeKey        : String(2);
  @title: '{i18n>ReorderPoint}' reorderPoint      : Quantity;
  @title: '{i18n>ProcurementType}' procurementType   : String(1);                 // E in-house, F external, X both
  @title: '{i18n>AvailabilityCheck}' availabilityCheck : String(2);
}

@title: '{i18n>MaterialStorageData_Entity}'
entity MaterialStorageData : cuid {
  @title: '{i18n>Request}' request         : Association to MaterialRequests;
  @title: '{i18n>Plant}' plant           : Plant;
  @title: '{i18n>StorageLocation}' storageLocation : String(4);
}

@title: '{i18n>MaterialSalesData_Entity}'
entity MaterialSalesData : cuid {
  @title: '{i18n>Request}' request              : Association to MaterialRequests;
  @title: '{i18n>SalesOrg}' salesOrg             : String(4);
  @title: '{i18n>DistributionChannel}' distributionChannel  : String(2);
  @title: '{i18n>TaxClassification}' taxClassification    : String(1);
  @title: '{i18n>ItemCategoryGroup}' itemCategoryGroup    : String(4);
  @title: '{i18n>DeliveringPlant}' deliveringPlant      : Plant;
}

@title: '{i18n>MaterialValuationData_Entity}'
entity MaterialValuationData : cuid {
  @title: '{i18n>Request}' request          : Association to MaterialRequests;
  @title: '{i18n>ValuationArea}' valuationArea    : String(4);                  // usually the plant
  @title: '{i18n>ValuationClass}' valuationClass   : String(4);
  @title: '{i18n>PriceControl}' priceControl     : String(1);                  // S standard, V moving average
  @title: '{i18n>StandardPrice}' standardPrice    : Amount;
  @title: '{i18n>MovingAvgPrice}' movingAvgPrice   : Amount;
  @title: '{i18n>Currency}' currency         : Currency;
}

@title: '{i18n>MaterialPurchasingData_Entity}'
entity MaterialPurchasingData : cuid {
  @title: '{i18n>Request}' request            : Association to MaterialRequests;
  @title: '{i18n>Plant}' plant              : Plant;
  @title: '{i18n>PurchasingGroup}' purchasingGroup    : String(3);
  @title: '{i18n>OrderUnit}' orderUnit          : UoM;
  @title: '{i18n>GrProcessingDays}' grProcessingDays   : Integer;
}

// ---------- Validation results ----------

@title: '{i18n>ValidationMessages_Entity}'
entity ValidationMessages : cuid {
  @title: '{i18n>Request}' request    : Association to MaterialRequests;
  @title: '{i18n>Severity}' severity   : Severity;
  @title: '{i18n>ViewType}' viewType   : ViewType;
  @title: '{i18n>FieldName}' fieldName  : String(60);
  @title: '{i18n>RuleCode}' ruleCode   : String(30);
  @title: '{i18n>MessageText}' messageText: String(500);
  @title: '{i18n>MessageCreatedAt}' createdAt  : Timestamp @cds.on.insert: $now;
}

// ---------- Configuration (data-driven validation) ----------

// Which views are mandatory for which material type
@title: '{i18n>MaterialTypeViewConfig_Entity}'
entity MaterialTypeViewConfig {
  @title: '{i18n>MaterialType}' key materialType : String(4);
  @title: '{i18n>ViewType}' key view         : ViewType;
  @title: '{i18n>Mandatory}' mandatory        : Boolean default true;
}

// Generic rules evaluated by the validation engine
@title: '{i18n>ValidationRules_Entity}'
entity ValidationRules : cuid {
  @title: '{i18n>RuleCode}' ruleCode    : String(30);      // reported in ValidationMessages.ruleCode
  @title: '{i18n>EntityName}' entityName  : String(40);     // e.g. 'MaterialRequests', 'MaterialPlantData'
  @title: '{i18n>FieldName}' fieldName   : String(60);
  @title: '{i18n>RuleType}' ruleType    : RuleType;
  @title: '{i18n>RuleParameter}' parameter   : String(500);     // regex, "min,max", or value-help category
  @title: '{i18n>Severity}' severity    : Severity default 'ERROR';
  @title: '{i18n>MessageText}' messageText : String(500);
  @title: '{i18n>MaterialType}' materialType: String(4);       // null = applies to all types
  @title: '{i18n>Active}' active      : Boolean default true;
}

// Cache of S/4 value helps, refreshed on a schedule
@title: '{i18n>ValueHelpCache_Entity}'
entity ValueHelpCache {
  @title: '{i18n>ValueHelpCategory}' key category    : String(30);  // MATERIAL_TYPE, PLANT, SALES_ORG, UOM, ...
  @title: '{i18n>ValueHelpCode}' key code        : String(40);
  @title: '{i18n>ValueHelpText}' text            : String(120);
  @title: '{i18n>LastRefreshedAt}' lastRefreshedAt : Timestamp;
}

// Cache of existing S/4 materials for duplicate detection (optional)
@title: '{i18n>ExistingMaterialCache_Entity}'
entity ExistingMaterialCache {
  @title: '{i18n>MaterialNumber}' key materialNumber : MaterialNumber;
  @title: '{i18n>MaterialType}' materialType       : String(4);
  @title: '{i18n>MaterialDescription}' description        : String(40);
  @title: '{i18n>LastRefreshedAt}' lastRefreshedAt    : Timestamp;
}
