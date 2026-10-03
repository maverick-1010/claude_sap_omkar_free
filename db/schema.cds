using { cuid, managed } from '@sap/cds/common';

namespace mmc;

// ---------- Types & enums ----------

type JobStatus : String(25) enum {
  DRAFT; VALIDATED; PENDING_APPROVAL; APPROVED; REJECTED;
  PROCESSING; COMPLETED; COMPLETED_WITH_ERRORS; FAILED; CANCELLED;
}

type RowStatus : String(10) enum {
  NEW; VALID; WARNING; ERROR; QUEUED; POSTING; SUCCESS; FAILED;
}

type Severity : String(8) enum { ERROR; WARNING; INFO; }

type ViewType : String(12) enum {
  BASIC; PLANT; STORAGE; SALES; VALUATION; PURCHASING;
}

type RuleType : String(10) enum { REQUIRED; REGEX; RANGE; LOOKUP; LENGTH; }

type MaterialNumber : String(40);
type Plant          : String(4);
type UoM            : String(3);
type Currency       : String(5);
type Quantity       : Decimal(13,3);
type Amount         : Decimal(11,2);

// ---------- Job header ----------

entity UploadJobs : cuid, managed {
  jobNo            : Integer @readonly;          // set via sequence/handler
  description      : String(120);
  fileName         : String(255);
  status           : JobStatus default 'DRAFT';
  correlationId    : UUID;                       // used in logs and S/4 calls
  totalRows        : Integer default 0;
  validRows        : Integer default 0;
  warningRows      : Integer default 0;
  errorRows        : Integer default 0;
  successRows      : Integer default 0;
  failedRows       : Integer default 0;
  progressPct      : Integer default 0;          // updated by background worker
  requiresApproval : Boolean default false;
  submittedBy      : String(255);
  submittedAt      : Timestamp;
  approvedBy       : String(255);
  approvedAt       : Timestamp;
  rejectionReason  : String(500);
  postingStartedAt : Timestamp;
  postingEndedAt   : Timestamp;

  // UI helpers (computed in an after-READ handler)
  virtual statusCriticality : Integer;

  file     : Composition of one JobFiles on file.job = $self;
  requests : Composition of many MaterialRequests on requests.job = $self;
}

entity JobFiles : cuid {
  job       : Association to UploadJobs;
  @Core.MediaType: mediaType
  content   : LargeBinary;
  @Core.IsMediaType: true
  mediaType : String(100);
  fileName  : String(255);
  fileSize  : Integer;
}

// ---------- Material row (one per spreadsheet row) ----------

entity MaterialRequests : cuid, managed {
  job               : Association to UploadJobs;
  rowNo             : Integer;
  sourceKey         : String(60);                // links the template sheets; used to match test results
  status            : RowStatus default 'NEW';
  externalRequestId : UUID;                      // idempotency key for S/4 posting

  // Basic data
  materialNumber    : MaterialNumber;            // optional if internal numbering
  materialType      : String(4);
  industrySector    : String(1);
  materialGroup     : String(9);
  description       : String(40);
  language          : String(2) default 'EN';
  baseUnit          : UoM;
  grossWeight       : Quantity;
  netWeight         : Quantity;
  weightUnit        : UoM;
  ean               : String(18);

  // Posting outcome
  createdMaterial   : MaterialNumber;            // number returned by S/4
  s4ErrorCode       : String(60);
  s4ErrorText       : String(1000);
  attempts          : Integer default 0;
  lastAttemptAt     : Timestamp;

  plantData         : Composition of many MaterialPlantData     on plantData.request     = $self;
  storageData       : Composition of many MaterialStorageData   on storageData.request   = $self;
  salesData         : Composition of many MaterialSalesData     on salesData.request     = $self;
  valuationData     : Composition of many MaterialValuationData on valuationData.request = $self;
  purchasingData    : Composition of many MaterialPurchasingData on purchasingData.request = $self;
  messages          : Composition of many ValidationMessages    on messages.request      = $self;

  virtual statusCriticality : Integer;
}

// ---------- Org-level views ----------

entity MaterialPlantData : cuid {
  request           : Association to MaterialRequests;
  plant             : Plant;
  purchasingGroup   : String(3);
  mrpType           : String(2);
  mrpController     : String(3);
  lotSizeKey        : String(2);
  reorderPoint      : Quantity;
  procurementType   : String(1);                 // E in-house, F external, X both
  availabilityCheck : String(2);
}

entity MaterialStorageData : cuid {
  request         : Association to MaterialRequests;
  plant           : Plant;
  storageLocation : String(4);
}

entity MaterialSalesData : cuid {
  request              : Association to MaterialRequests;
  salesOrg             : String(4);
  distributionChannel  : String(2);
  taxClassification    : String(1);
  itemCategoryGroup    : String(4);
  deliveringPlant      : Plant;
}

entity MaterialValuationData : cuid {
  request          : Association to MaterialRequests;
  valuationArea    : String(4);                  // usually the plant
  valuationClass   : String(4);
  priceControl     : String(1);                  // S standard, V moving average
  standardPrice    : Amount;
  movingAvgPrice   : Amount;
  currency         : Currency;
}

entity MaterialPurchasingData : cuid {
  request            : Association to MaterialRequests;
  plant              : Plant;
  purchasingGroup    : String(3);
  orderUnit          : UoM;
  grProcessingDays   : Integer;
}

// ---------- Validation results ----------

entity ValidationMessages : cuid {
  request    : Association to MaterialRequests;
  severity   : Severity;
  viewType   : ViewType;
  fieldName  : String(60);
  ruleCode   : String(30);
  messageText: String(500);
  createdAt  : Timestamp @cds.on.insert: $now;
}

// ---------- Configuration (data-driven validation) ----------

// Which views are mandatory for which material type
entity MaterialTypeViewConfig {
  key materialType : String(4);
  key view         : ViewType;
  mandatory        : Boolean default true;
}

// Generic rules evaluated by the validation engine
entity ValidationRules : cuid {
  ruleCode    : String(30);      // reported in ValidationMessages.ruleCode
  entityName  : String(40);     // e.g. 'MaterialRequests', 'MaterialPlantData'
  fieldName   : String(60);
  ruleType    : RuleType;
  parameter   : String(500);     // regex, "min,max", or value-help category
  severity    : Severity default 'ERROR';
  messageText : String(500);
  materialType: String(4);       // null = applies to all types
  active      : Boolean default true;
}

// Cache of S/4 value helps, refreshed on a schedule
entity ValueHelpCache {
  key category    : String(30);  // MATERIAL_TYPE, PLANT, SALES_ORG, UOM, ...
  key code        : String(40);
  text            : String(120);
  lastRefreshedAt : Timestamp;
}

// Cache of existing S/4 materials for duplicate detection (optional)
entity ExistingMaterialCache {
  key materialNumber : MaterialNumber;
  materialType       : String(4);
  description        : String(40);
  lastRefreshedAt    : Timestamp;
}
