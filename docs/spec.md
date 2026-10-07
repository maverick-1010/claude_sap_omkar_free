# SPEC DOCUMENT — Mass Material Creation Application
**OData Service Specification | MassMaterialService & MaterialAdminService**
Version 1.0 | October 2026

| | |
|---|---|
| Project | Mass Material Creation Application |
| Services | MassMaterialService \| MaterialAdminService |
| Stack | SAP BTP \| CAP (Node.js) \| SAP HANA Cloud \| OData V4 |
| Integration | S/4HANA via SAP Cloud SDK — API_PRODUCT_SRV |
| Auth | XSUAA \| JWT \| Row-level security |

---

## 01 Problem Statement

Master-data maintainers create materials one at a time in MM01 or pass spreadsheets to a power user. This is slow, error-prone, and gives no audit trail. The Mass Material Creation Application is a cloud-native BTP CAP solution that lets business users create materials in S/4HANA in bulk from a spreadsheet, with validation before posting and a full result log afterwards.

The application must address the following business needs:

- Upload an .xlsx or .csv file of up to 5,000 materials with basic data and org-level views (plant, storage location, sales, valuation, purchasing).
- Validate every row before anything reaches S/4HANA: mandatory fields per material type, formats, value-help codes, and duplicates within the file and against existing S/4 materials.
- Let the uploader review errors, correct rows inline, and re-validate without re-uploading.
- Optionally require approval by a second person (four-eyes principle) before posting.
- Post valid rows to S/4HANA in the background, in chunks, with retries for transient failures, and never create the same material twice.
- Provide a downloadable result file showing the created material number or the S/4 error for each row.
- Keep validation rules, material-type view requirements, and value helps as configuration maintained by administrators, not hard-coded logic.
- Restrict requesters to their own uploads; give approvers and administrators the visibility their roles need.

**Scope boundary:** This spec covers OData service definitions, entity relationships, CRUD restrictions, the job status lifecycle, authorization rules, custom actions and functions, the S/4 integration contract, and technical constraints. Fiori UI annotations, the CI/CD pipeline, and changes or extensions to existing materials are out of scope.

---

## 02 OData Service Architecture

### 2.1 MassMaterialService — Upload, Validation & Posting

Path: `/odata/v4/mass-material`

| Entity (CDS name) | Display name | CRUD restrictions | Access |
|---|---|---|---|
| UploadJobs | Upload Job | Create, Read, Update, Delete (status-dependent, §3.1) | Requester: own \| Approver: submitted jobs \| Admin: all |
| JobFiles | Upload File | Create (media upload), Read. No Update/Delete | Same as parent job |
| MaterialRequests | Material Request | Create, Read, Update, Delete while job is editable | Same as parent job |
| MaterialPlantData | Plant Data | Same as MaterialRequests | Same as parent job |
| MaterialStorageData | Storage Location Data | Same as MaterialRequests | Same as parent job |
| MaterialSalesData | Sales Data | Same as MaterialRequests | Same as parent job |
| MaterialValuationData | Valuation Data | Same as MaterialRequests | Same as parent job |
| MaterialPurchasingData | Purchasing Data | Same as MaterialRequests | Same as parent job |
| ValidationMessages | Validation Message | Read only — system generated | Same as parent job |
| ValueHelps | Value Help | Read only — projection on ValueHelpCache | Authenticated users |
| MaterialTypeViews | Required Views | Read only — projection on MaterialTypeViewConfig | Authenticated users |

### 2.2 MaterialAdminService — Configuration (Admin only)

Path: `/odata/v4/material-admin`. Restricted to MaterialAdmin via `@requires`.

| Entity / Operation | Type | Description | Access |
|---|---|---|---|
| ValidationRules | Entity | Data-driven validation rules | Admin only |
| MaterialTypeViewConfig | Entity | Mandatory views per material type | Admin only |
| ValueHelpCache | Entity | Cached S/4 code lists — Read only | Admin only |
| ExistingMaterialCache | Entity | Cached S/4 material numbers — Read only | Admin only |
| refreshValueHelps | Action | Reloads ValueHelpCache from S/4 (all or one category) | Admin only |
| refreshExistingMaterials | Action | Reloads ExistingMaterialCache from S/4 | Admin only |
| testS4Connection | Function | Checks the S/4 destination; returns status and latency | Admin only |

### 2.3 Operations on UploadJobs (bound, MassMaterialService)

| Operation | Type | Description | Allowed from status | Role |
|---|---|---|---|---|
| parse | Action | Reads the uploaded file into MaterialRequests and child views | DRAFT (file uploaded) | Requester |
| validate | Action | Runs all validation rules; writes ValidationMessages and row statuses | DRAFT, VALIDATED, REJECTED | Requester |
| submit | Action | Sends to approval, or queues posting if approval not required | VALIDATED | Requester |
| approve | Action | Approves and queues posting | PENDING_APPROVAL | Approver |
| reject | Action (reason) | Returns the job to the requester | PENDING_APPROVAL | Approver |
| cancel | Action | Cancels the job; no further posting | Any status before PROCESSING | Requester, Admin |
| retryFailed | Action | Re-queues only FAILED rows | COMPLETED_WITH_ERRORS, FAILED | Requester, Admin |
| downloadResult | Function | Returns the result file (.xlsx) | Any | Requester, Approver, Admin |

Unbound function `getTemplate()` returns the empty upload template (.xlsx) to any authenticated user.

---

## 03 Functional Requirements

### 3.1 UploadJobs and Status Lifecycle

| From | Event | To |
|---|---|---|
| — | Create job | DRAFT |
| DRAFT | validate, no ERROR rows | VALIDATED |
| DRAFT / VALIDATED | validate, ERROR rows exist | DRAFT |
| VALIDATED | submit, approval required | PENDING_APPROVAL |
| VALIDATED | submit, no approval required | PROCESSING |
| PENDING_APPROVAL | approve | APPROVED → PROCESSING |
| PENDING_APPROVAL | reject | REJECTED |
| REJECTED | edit rows + validate | DRAFT or VALIDATED |
| PROCESSING | all rows SUCCESS | COMPLETED |
| PROCESSING | some rows FAILED | COMPLETED_WITH_ERRORS |
| PROCESSING | job-level failure (e.g. destination missing) | FAILED |
| COMPLETED_WITH_ERRORS / FAILED | retryFailed | PROCESSING |
| DRAFT / VALIDATED / PENDING_APPROVAL / REJECTED | cancel | CANCELLED |

- Any transition not in this table is rejected with 409.
- Any edit to rows (create, update, delete) on a VALIDATED job sets it back to DRAFT; it must be re-validated before submit.
- The job is editable (UPDATE description, row CRUD) only in DRAFT, VALIDATED, and REJECTED.
- Delete is allowed only in DRAFT, VALIDATED, REJECTED, and CANCELLED.
- `jobNo` is a human-readable sequential number assigned on CREATE.
- Counters (`totalRows`, `validRows`, `warningRows`, `errorRows`, `successRows`, `failedRows`) and `progressPct` are maintained by the system and are not writable via OData.
- `requiresApproval` is set from configuration at creation, not by the user.

### 3.2 Upload and Parse

- The file is uploaded as a media stream: `PUT /UploadJobs(ID)/file/content`.
- Accepted types: .xlsx (one sheet per view, linked by `sourceKey`) and .csv (flat, one org row per material).
- Maximum file size 10 MB; maximum 5,000 materials per job.
- Structural problems (missing sheet, missing or misspelled mandatory column, no data rows, unreadable file) reject the whole file; no rows are created.
- Unknown columns are ignored; column order does not matter; values are trimmed and codes upper-cased.
- `parse` replaces any previously parsed rows of the same job.

### 3.3 MaterialRequests and Org-Level Views

- One MaterialRequest per material; child views are compositions (deleting a row deletes its views).
- `materialNumber` is optional when the material type uses internal numbering.
- `externalRequestId` is generated on CREATE and never changes; it is the idempotency key for posting.
- Result fields (`createdMaterial`, `s4ErrorCode`, `s4ErrorText`, `attempts`, `lastAttemptAt`) are system-maintained and read-only.

### 3.4 Validation

- Rules are read from ValidationRules (active only), filtered by entity, field, and material type. Rule types: REQUIRED, LENGTH, REGEX, RANGE, LOOKUP.
- Mandatory views per material type come from MaterialTypeViewConfig.
- LOOKUP rules check against ValueHelpCache; duplicate checks use the job itself and ExistingMaterialCache.
- Cross-field checks: netWeight ≤ grossWeight, weights > 0, storage location belongs to its plant, currency matches the valuation area, price control consistent with material type (WARNING).
- Each failure creates one ValidationMessage with severity, view, field, ruleCode, and text. Re-validation deletes the row's previous messages first.
- Row status: ERROR if any ERROR message, WARNING if only warnings, otherwise VALID. Warnings never block submit.
- `validate` never fails the HTTP request because of data errors; it returns 200 with the counts.

### 3.5 Posting to S/4HANA

- Posting runs asynchronously in the CAP persistent outbox; `submit` and `approve` return immediately.
- Only VALID and WARNING rows are posted, in chunks of 50 (configurable), with at most 3 concurrent requests.
- Integration through SAP Cloud SDK, destination `S4_MATERIAL`, OData service `API_PRODUCT_SRV`, behind an adapter interface so a BAPI-based adapter can replace it.
- Rows already SUCCESS are skipped (idempotency via `externalRequestId`).
- Transient errors (timeouts, 5xx, lock errors) are retried up to 3 times with exponential backoff; business errors are not retried.
- One failing row never stops the job.
- `progressPct` and counters are updated after every chunk.

### 3.6 Result File and Template

- `downloadResult` returns the original columns plus status, created material number, and error text per row, so failed rows can be corrected and re-uploaded.
- `getTemplate` returns the empty upload template with all sheets and headers and one sample row.

### 3.7 Configuration (MaterialAdminService)

- ValidationRules and MaterialTypeViewConfig support full CRUD for administrators; changes apply to the next `validate` call, not to jobs already validated.
- ValueHelpCache and ExistingMaterialCache are read-only via OData and filled only by the refresh actions and a nightly scheduled job.
- `refreshValueHelps(category: String)` refreshes one category or all if empty; returns the number of codes loaded.

---

## 04 Technical Constraints

### 4.1 Language — JavaScript Only

All handlers, utilities, adapters, and scripts are written in JavaScript (Node.js). No TypeScript and no `.ts` files in `srv/` or `scripts/`.

### 4.2 Generic Handler Pattern

Business logic is split into small handler modules registered from the service implementation, not one monolithic file.

```js
// srv/handlers/jobs.handler.js
module.exports = (srv) => {
  const { UploadJobs } = srv.entities;

  srv.before('UPDATE', UploadJobs, requireEditable);
  srv.on('validate', UploadJobs, require('../lib/validation').validateJob);

  srv.after('READ', UploadJobs, (data) => {
    (Array.isArray(data) ? data : [data]).forEach(setCriticality);
  });
};

const CRITICALITY = { COMPLETED: 3, COMPLETED_WITH_ERRORS: 2, FAILED: 1, REJECTED: 1 };
const setCriticality = (d) => { if (d) d.statusCriticality = CRITICALITY[d.status] ?? 0; };
```

Suggested layout: `srv/handlers/` (one file per area: jobs, requests, upload, posting, admin), `srv/lib/` (parser, validation engine, S/4 adapter, result writer).

### 4.3 Computed Fields

| Field | Rule |
|---|---|
| statusCriticality (UploadJobs, MaterialRequests) | Virtual, never stored; computed in `after('READ')` from status |
| Counters, progressPct | Stored, but `@readonly` / `@Core.Computed`; written only by the system |
| jobNo | Assigned on CREATE; not writable via OData |
| Result fields on MaterialRequests | Written only by the posting worker |

### 4.4 OData Protocol

- OData V4 is the native protocol of both services.
- OData V2 is additionally exposed through the `@cap-js-community/odata-v2-adapter` plugin (proxy under `/odata/v2/...`, e.g. `/odata/v2/mass-material`) for V2 clients. No service code depends on it; V4 remains the reference contract for §7 and §8.
- No Fiori draft (`@odata.draft.enabled` is not used). Rationale: the job status already provides the edit lifecycle, and drafts would duplicate up to 5,000 rows per job.

### 4.5 ETag / Concurrency

- `@odata.etag` on `modifiedAt` for UploadJobs and MaterialRequests.
- PATCH and DELETE require an `If-Match` header; CAP does not enforce this by default, so a generic `before('UPDATE'|'DELETE')` handler returns 428 when it is missing.
- Stale ETag returns 412.

### 4.6 Service Naming

| Service | CDS name | OData V4 path |
|---|---|---|
| Upload & Posting | MassMaterialService | /odata/v4/mass-material |
| Configuration | MaterialAdminService | /odata/v4/material-admin |

### 4.7 Infrastructure

- Runtime: SAP BTP Cloud Foundry.
- Database: SAP HANA Cloud; SQLite only for local `cds watch` and tests.
- Node.js: 20.x LTS or later.
- @sap/cds: pin the current major version at project start; do not mix majors.
- S/4 connectivity: BTP Destination service (+ Connectivity service / Cloud Connector for on-premise).
- Auth: XSUAA; mocked users only in local development.
- Audit logging: @cap-js/audit-logging on approve, reject, and all MaterialAdminService writes.
- Excel handling: streaming reader/writer (e.g. exceljs) so large files do not exhaust memory.

---

## 05 Authorization & Security

Every endpoint in both services requires `authenticated-user`. No anonymous access.

### 5.1 Roles

| Role | Scope | Description |
|---|---|---|
| Requester | MaterialRequester | Upload, edit, validate, submit, cancel, retry, and download own jobs only |
| Approver | MaterialApprover | Read submitted jobs; approve or reject jobs created by others |
| Administrator | MaterialAdmin | Full access to all jobs and to MaterialAdminService |

### 5.2 CDS Annotation Pattern

```cds
annotate MassMaterialService.UploadJobs with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE','parse','validate','submit',
            'cancel','retryFailed','downloadResult'],
    to: 'MaterialRequester', where: 'createdBy = $user' },
  { grant: ['READ','approve','reject','downloadResult'],
    to: 'MaterialApprover', where: 'status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

annotate MassMaterialService.MaterialRequests with @restrict: [
  { grant: ['READ','CREATE','UPDATE','DELETE'], to: 'MaterialRequester',
    where: 'job.createdBy = $user' },
  { grant: 'READ', to: 'MaterialApprover', where: 'job.status <> ''DRAFT''' },
  { grant: '*', to: 'MaterialAdmin' }
];

annotate MaterialAdminService with @requires: 'MaterialAdmin';
```

Apply the MaterialRequests pattern to every child view and ValidationMessages, using the path to the job.

### 5.3 Row-Level Filtering and Four-Eyes

- Row filtering is done only with `@restrict where` clauses, never in handler code.
- An approver cannot approve or reject a job they created; this is checked in the `approve`/`reject` handler (403).
- Requesters never see other requesters' jobs, files, rows, or results.

---

## 06 API Contracts

### 6.1 UploadJobs

| Property | CDS type | Constraint | Description |
|---|---|---|---|
| ID | UUID | key, generated | Job ID |
| jobNo | Integer | read-only, unique | Human-readable job number |
| description | String(120) | optional | User description |
| fileName | String(255) | read-only | Uploaded file name |
| status | JobStatus | read-only, default DRAFT | Lifecycle status (§3.1) |
| requiresApproval | Boolean | read-only | Set from configuration |
| totalRows … failedRows | Integer | read-only | Row counters |
| progressPct | Integer | read-only, 0–100 | Posting progress |
| correlationId | UUID | read-only | Log and S/4 trace ID |
| submittedBy / submittedAt | String(255) / Timestamp | read-only | Submission audit |
| approvedBy / approvedAt | String(255) / Timestamp | read-only | Approval audit |
| rejectionReason | String(500) | set by reject | Reason returned to requester |
| postingStartedAt / postingEndedAt | Timestamp | read-only | Posting window |
| statusCriticality | Integer | virtual | UI colour, never stored |
| createdBy / createdAt / modifiedAt | managed | modifiedAt = @odata.etag | Audit and concurrency |
| file | Composition of one JobFiles | | Uploaded file |
| requests | Composition of many MaterialRequests | | Parsed rows |

### 6.2 MaterialRequests

| Property | CDS type | Constraint | Description |
|---|---|---|---|
| ID | UUID | key, generated | Row ID |
| job | Association to UploadJobs | mandatory | Parent job |
| rowNo | Integer | read-only | Row number in the file |
| status | RowStatus | read-only | NEW … SUCCESS / FAILED |
| externalRequestId | UUID | read-only, unique | Idempotency key |
| materialNumber | String(40) | optional | External number, if used |
| materialType | String(4) | mandatory | e.g. FERT, ROH |
| industrySector | String(1) | mandatory | e.g. M |
| materialGroup | String(9) | mandatory | Material group |
| description | String(40) | mandatory | Material description |
| language | String(2) | default EN | Description language |
| baseUnit | String(3) | mandatory | Base unit of measure |
| grossWeight / netWeight | Decimal(13,3) | optional, > 0, net ≤ gross | Weights |
| weightUnit | String(3) | mandatory if a weight is given | Weight unit |
| ean | String(18) | optional, valid check digit | EAN/UPC |
| createdMaterial | String(40) | read-only | Number returned by S/4 |
| s4ErrorCode / s4ErrorText | String(60) / String(1000) | read-only | S/4 error |
| attempts / lastAttemptAt | Integer / Timestamp | read-only | Retry tracking |
| plantData, storageData, salesData, valuationData, purchasingData | Composition of many | | Org-level views |
| messages | Composition of many ValidationMessages | read-only | Validation results |

### 6.3 Org-Level Views (summary)

| Entity | Key business fields |
|---|---|
| MaterialPlantData | plant, purchasingGroup, mrpType, mrpController, lotSizeKey, reorderPoint, procurementType, availabilityCheck |
| MaterialStorageData | plant, storageLocation |
| MaterialSalesData | salesOrg, distributionChannel, taxClassification, itemCategoryGroup, deliveringPlant |
| MaterialValuationData | valuationArea, valuationClass, priceControl, standardPrice, movingAvgPrice, currency |
| MaterialPurchasingData | plant, purchasingGroup, orderUnit, grProcessingDays |

Each has `ID` (UUID key) and `request` (Association to MaterialRequests, mandatory). The same org key may not appear twice for one material (e.g. two rows for plant 1010).

### 6.4 ValidationMessages

| Property | CDS type | Constraint | Description |
|---|---|---|---|
| ID | UUID | key | Message ID |
| request | Association to MaterialRequests | mandatory | Row the message belongs to |
| severity | Severity | mandatory | ERROR / WARNING / INFO |
| viewType | ViewType | mandatory | View where the problem is |
| fieldName | String(60) | optional | Field in error |
| ruleCode | String(30) | mandatory, FK to ValidationRules | Rule that fired |
| messageText | String(500) | mandatory | User-facing text |

### 6.5 ValidationRules

| Property | CDS type | Constraint | Description |
|---|---|---|---|
| ruleCode | String(30) | key | Stable rule identifier, referenced by messages |
| entityName | String(40) | mandatory | Entity the rule applies to |
| fieldName | String(60) | mandatory | Field checked |
| ruleType | RuleType | mandatory | REQUIRED / LENGTH / REGEX / RANGE / LOOKUP |
| parameter | String(500) | depends on type | Regex, "min,max", or value-help category |
| severity | Severity | default ERROR | Result severity |
| materialType | String(4) | optional | Empty = all material types |
| messageText | String(500) | mandatory | Message shown to the user |
| active | Boolean | default true | Inactive rules are skipped |

### 6.6 Configuration and Caches

| Entity | Keys | Other fields |
|---|---|---|
| MaterialTypeViewConfig | materialType, view | mandatory (Boolean) |
| ValueHelpCache | category, code | text, lastRefreshedAt |
| ExistingMaterialCache | materialNumber | materialType, description, lastRefreshedAt |

---

## 07 Edge Cases & Error Handling

### 7.1 Upload and Parse

| Scenario | Expected behaviour | HTTP | Handler location |
|---|---|---|---|
| File larger than 10 MB | req.error(413, 'File exceeds 10 MB') | 413 | before media upload |
| File is not .xlsx or .csv | req.error(415, 'Only .xlsx and .csv files are supported') | 415 | before media upload |
| Missing Basic sheet or mandatory column | req.error(400, 'Missing column <name> on sheet <sheet>'); no rows created | 400 | parse |
| Header misspelled | Treated as missing column; message names the expected header | 400 | parse |
| File has headers but no rows | req.error(400, 'The file contains no data rows') | 400 | parse |
| More than 5,000 materials | req.error(400, 'Maximum 5,000 materials per upload') | 400 | parse |
| Org row whose sourceKey has no Basic row | Row-level ERROR message, not a file rejection | 200 | validate |
| parse called with no file uploaded | req.error(409, 'Upload a file before parsing') | 409 | parse |

### 7.2 Validation

| Scenario | Expected behaviour | HTTP | Handler location |
|---|---|---|---|
| Mandatory field empty | ERROR message with ruleCode, row status ERROR | 200 | validate |
| Code not in ValueHelpCache | ERROR message naming the field and value | 200 | validate |
| Duplicate material in same job | ERROR on the second and later occurrences | 200 | validate |
| Material already exists in S/4 | ERROR message, row status ERROR | 200 | validate |
| netWeight > grossWeight | ERROR message | 200 | validate |
| Mandatory view missing for material type | ERROR message with viewType | 200 | validate |
| Price control unusual for material type | WARNING; does not block submit | 200 | validate |
| ValueHelpCache empty (never refreshed) | req.error(503, 'Value helps not loaded — contact an administrator') | 503 | validate |
| Row edited on a VALIDATED job | Job returns to DRAFT | 200 | before UPDATE MaterialRequests |

### 7.3 Lifecycle and Actions

| Scenario | Expected behaviour | HTTP | Handler location |
|---|---|---|---|
| submit with ERROR rows | req.error(409, 'Fix all errors before submitting') | 409 | submit |
| submit on a job that is not VALIDATED | req.error(409, 'Job must be validated before submit') | 409 | submit |
| Edit rows on PENDING_APPROVAL or later | req.error(409, 'Job is locked in status <status>') | 409 | before CUD on rows |
| Delete job in PROCESSING or COMPLETED | req.error(409, 'Job cannot be deleted in status <status>') | 409 | before DELETE UploadJobs |
| Approver approves own job | req.error(403, 'You cannot approve your own upload') | 403 | approve |
| reject without reason | req.error(400, 'A rejection reason is required') | 400 | reject |
| approve on job not PENDING_APPROVAL | req.error(409, …) | 409 | approve |
| retryFailed when no FAILED rows | Return 0 rows queued; do not throw | 200 | retryFailed |
| cancel on PROCESSING job | req.error(409, 'Posting already started') | 409 | cancel |

### 7.4 Posting

| Scenario | Expected behaviour | Notes |
|---|---|---|
| S/4 business error on a row | Row FAILED with s4ErrorCode/Text; job continues | No retry |
| Timeout / 5xx / lock error | Retry up to 3× with backoff, then FAILED | attempts incremented |
| Destination missing or auth fails | Job FAILED with a clear message; no rows marked SUCCESS | Logged with correlationId |
| App restarts during posting | Outbox resumes; SUCCESS rows skipped | Idempotency via externalRequestId |
| Row already SUCCESS on retryFailed | Skipped | No duplicate material in S/4 |

### 7.5 Access Control

| Scenario | Expected behaviour | HTTP |
|---|---|---|
| Requester reads another requester's job | Filtered out — empty result | 200 (empty) |
| Requester PATCHes another requester's row | No match | 404 |
| Requester calls approve | Not granted | 403 |
| Non-admin calls MaterialAdminService | Blocked by @requires | 403 |
| Unauthenticated request | Blocked | 401 |

### 7.6 Concurrency and Protocol

| Scenario | Expected behaviour | HTTP |
|---|---|---|
| PATCH without If-Match | 428 Precondition Required | 428 |
| PATCH with stale ETag | 412 Precondition Failed | 412 |
| Two approvers act on the same job | Second gets 412 (ETag) or 409 (status already changed) | 412 / 409 |
| PATCH on ValidationMessages | @readonly | 405 |
| PATCH on ValueHelpCache via admin service | @readonly | 405 |
| PATCH on read-only system field (e.g. status) | Ignored by framework (@readonly / @Core.Computed) | 200 |
| $batch with mixed valid and invalid row updates | Each operation succeeds or fails individually | 200 with per-operation results |

---

## 08 Acceptance Criteria

### 8.1 Build & Lint
- `cds watch` starts without errors; all entities appear in `$metadata`.
- `cds lint` reports zero errors.
- `npm test` passes all Jest tests.
- `mbt build` completes without errors.

### 8.2 Upload and Parse
- Uploading `test/uploads/happy-path.xlsx` then calling `parse` creates the expected number of MaterialRequests and child views.
- Each structural-error test file is rejected with the documented status and message; no rows are created.
- Files over 10 MB → 413; wrong type → 415.

### 8.3 Validation
- `validate` on `validation-errors.xlsx` produces exactly the messages listed in `test/uploads/expected-results.json`.
- Job counters match the row statuses after every validate.
- Editing a row on a VALIDATED job sets the job to DRAFT.

### 8.4 Lifecycle
- Every transition in §3.1 succeeds; every other transition returns 409.
- Approver cannot approve own job (403); reject without reason → 400.
- Delete is blocked in PROCESSING and COMPLETED.

### 8.5 Posting (mocked S/4)
- All VALID rows become SUCCESS with `createdMaterial` set.
- A mocked business error makes only that row FAILED; job ends COMPLETED_WITH_ERRORS.
- A mocked timeout is retried and then succeeds; `attempts` = 2.
- `retryFailed` re-posts only FAILED rows; no SUCCESS row is posted twice.
- `downloadResult` contains one line per row with status and material number or error.

### 8.6 Authorization
- Requester sees only own jobs and rows.
- Approver sees non-DRAFT jobs only and cannot edit rows.
- Any non-admin call to MaterialAdminService → 403.

### 8.7 Concurrency
- PATCH without If-Match → 428; stale ETag → 412; correct ETag → 200 with new `modifiedAt`.

### 8.8 Configuration
- A new ValidationRule applies on the next `validate` call.
- `refreshValueHelps` with a mocked S/4 loads all categories and returns the count.

---

## 09 $expand Reference

All examples use OData V4.

### 9.1 Job with rows and messages
```
GET /odata/v4/mass-material/UploadJobs(<ID>)
    ?$expand=requests($expand=messages)

GET /odata/v4/mass-material/UploadJobs(<ID>)
    ?$select=jobNo,status,totalRows,errorRows,progressPct
    &$expand=requests($filter=status eq 'ERROR';$select=rowNo,materialType,description,status;
                      $expand=messages($select=severity,fieldName,messageText))
```

### 9.2 Material request with all views
```
GET /odata/v4/mass-material/MaterialRequests(<ID>)
    ?$expand=plantData,storageData,salesData,valuationData,purchasingData,messages
```

### 9.3 Job monitoring
```
GET /odata/v4/mass-material/UploadJobs
    ?$filter=status eq 'PROCESSING'
    &$select=jobNo,description,progressPct,successRows,failedRows
    &$orderby=createdAt desc

GET /odata/v4/mass-material/MaterialRequests
    ?$filter=job_ID eq <ID> and status eq 'FAILED'
    &$select=rowNo,description,s4ErrorCode,s4ErrorText,attempts
```

### 9.4 Value helps
```
GET /odata/v4/mass-material/ValueHelps?$filter=category eq 'PLANT'
GET /odata/v4/mass-material/MaterialTypeViews?$filter=materialType eq 'FERT'
```

---

## 10 Claude Code Integration

Spec-driven development: every generation decision must trace back to a section of this spec.

- Save this file as `docs/spec.md` and commit it before any `.cds` or `.js` file is created.
- Add `@docs/spec.md` to `CLAUDE.md` at the project root.
- Prompt by section, e.g. *"Implement the job lifecycle per §3.1 using the handler pattern in §4.2."*
- Ask Claude to check the validation engine against §3.4 and §7.2 before finalising.
- Generate tests from acceptance criteria: *"Write Jest tests for §8.4."*
- Use §9 for the requests in the `.http` test file.
- Record any architecture decision not covered here in `CLAUDE.md` and update this spec.