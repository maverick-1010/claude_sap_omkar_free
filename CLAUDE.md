# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@docs/spec.md

## Nature of the repo

SAP CAP (Node.js, `@sap/cds` 10, SQLite locally / HANA on BTP) project "Mass Material Creation" (`mmc` namespace): upload an Excel/CSV of material master rows, validate them against configurable rules, review/correct, optionally approve (four-eyes), then post them to S/4HANA in the background. `docs/spec.md` is the specification (every decision traces to a section of it, see below for deviations). It replaces an earlier ABAP report that was never compiled; those files are deleted (still in git history, last version at commit `e504801` and earlier). `README.md` still describes the old ABAP report and is outdated; `abap_claude/` is an empty folder.

## Commands

- `npm start` (`cds-serve`) / `npm run watch` (`cds watch`) – OData V4 at `/odata/v4/mass-material` and `/odata/v4/material-admin`. Authentication is the custom token framework (`docs/auth.md`, no XSUAA): `npm run setup` deploys `db.sqlite` and creates the first administrator (`ADMIN_PASSWORD` or prompt); then `POST /auth/login` and send `Authorization: Bearer <token>`; create more users with `/admin/createUser`. Locally the S/4 adapter is the in-memory mock.
- `npm test` (jest, ~20 s, 9 files) – single file: `npx jest test/posting.test.js`. The business suites define their own mocked users via `process.env.CDS_CONFIG` (`auth.kind: 'mocked'`); `test/auth*.test.js` and `test/unit/` cover the custom auth. The `[test]` profile keeps the DB in memory.
- `npx cds lint` – must report 0 errors. `npx cds build --production` – builds `gen/` (git-ignored). `mbt build` was not run (not installed here).
- `npm run gen:uploads` – regenerates `test/uploads/*` (xlsx/csv), `expected-results.json` and `test-cases.md`. Deterministic (seeded); aborts if its reference validator disagrees with the declared expectations. Add cases to `CASES` / `STRUCTURAL` / `FAULTS` in `scripts/generate-test-uploads.js` rather than editing generated files. `expected-results.json` is the oracle for the validation engine.
- `test/requests.http` – REST Client requests for the §9 `$expand` examples and the main flow.

## Architecture

- `db/common.cds` – enums (`JobStatus`, `RowStatus`, `Severity`, `ViewType`, `RuleType`) and scalar domain types; every type carries `@title: '{i18n>...}'`.
- `db/schema.cds` – `UploadJobs` (header, counters) → `JobFiles` (media) and `MaterialRequests` (one per uploaded row) → org-level views and `ValidationMessages`; configuration: `MaterialTypeViewConfig`, `ValidationRules` (data-driven rules), `ValueHelpCache`, `ExistingMaterialCache`. System fields are `@readonly`; `modifiedAt` is the `@odata.etag` of jobs and rows.
- `srv/mass-material-service.cds` / `.js` – `MassMaterialService`; handlers are small modules in `srv/handlers/` (`jobs`, `requests`, `upload`, `parse`, `validate`, `actions`, `files`). `srv/material-admin-service.cds` / `.js` + `handlers/admin.handler.js` – `MaterialAdminService`. `srv/authorization.cds` – all `@restrict`/`@requires`; row filtering lives there, never in handler code. `srv/posting-service.cds` / `.js` – internal service (no protocol) behind the persistent outbox.
- `srv/lib/`: `lifecycle.js` (the §3.1 transition table, single source of truth), `template.js` (sheet/column layout shared by parser, template and result file), `parser.js`, `validation.js` (pure engine), `posting.js` (worker for one chunk), `posting-queue.js` (outbox hand-off), `result-writer.js`, `reference-data.js` + `nightly.js` (cache refresh), `rule-check.js`, `counters.js`, `audit.js`, `s4/` (adapter interface: `mock.adapter.js`, `product-srv.adapter.js`, `errors.js`; picked by `adapter.js`).
- Posting: `submit`/`approve`/`retryFailed` move the job to PROCESSING and send a `postChunk` message through the persistent outbox in the same transaction; each message posts one chunk (50 rows, 3 in parallel, 3 retries with backoff for transient errors) and queues the next, so a restart resumes. Only VALID/WARNING/QUEUED rows are picked; SUCCESS rows never. Config under `cds.mmc` in package.json.
- Seed data: `db/data/` (config + rules, loaded by cds), `test/data/` (caches, test only; also the default data of the mock S/4 adapter). Validation behaviour changes by editing rule data, not code.
- i18n: `db/i18n/` with `en` (default), `es`, `hi`. Keep all languages in sync; use the `/cap-add-language` and `/cap-lang-check` project commands.
- Auth: `db/auth-schema.cds` (namespace `auth`), `srv/lib/auth/` (config, keys, tokens, password, user-store, custom-auth, routes, permissions, rate-limit, audit), `server.js` (headers + `/auth` router), `srv/admin-service.*` + `handlers/auth-admin.handler.js` (`AuthAdminService` at `/admin`, needs `User.Admin`), `scripts/create-admin.js`. Selected by `cds.requires.auth.kind = mmc-auth`; `cds.User.id` = username and `roles` = role IDs + permission IDs, so `srv/authorization.cds` is unchanged. Progress and decisions: `PROGRESS.md`.
- Platform: `mta.yaml` (user-provided service `mmc-auth-keys` for the signing key, HANA, destination, audit log), `@cap-js/audit-logging` (approve/reject and all admin writes). `docs/` – spec and generated database design diagram (`/cap-export-design`).

## Behaviour to know about

- CAP requires `If-Match` on every PATCH/DELETE **and every bound action** of `UploadJobs`/`MaterialRequests` (ETag entities); `*` means any version. Exception: `downloadResult` defaults it (see `MassMaterialService.handle`).
- Bound action by another user's job or by an approver on a DRAFT job is 403 (not 404); 404 only for PATCH on rows.
- Approvers cannot see DRAFT jobs (spec §5.2 `where`).

## Deviations from the spec / decisions not in it

- `ValidationMessages.ruleCode` has no foreign key to `ValidationRules`: rule codes are not unique in the seed data (e.g. `REQUIRED_PLANT` per entity) and cross-field checks use codes that are not rules.
- Duplicate `sourceKey` is reported on **every** row with that key (what `expected-results.json` requires), not only on the second and later ones. Org rows are pooled per `sourceKey` for rules and mandatory-view checks.
- Orphan org rows (no Basic row) become a `MaterialRequests` row with `isOrphan = true` (extra field) and get only `ORPHAN_ROW`.
- Extra checks beyond the seed rules: `DUPLICATE_MATERIAL`, `DUPLICATE_ORG_ROW`, `WEIGHT_NOT_POSITIVE`, `WEIGHTUNIT_REQUIRED` (spec §3.4 / §6.3 wording; no fixture covers them).
- `UploadJobs.failureReason` (extra field) holds the message of a job-level posting failure (§7.4).
- OData V2 is exposed via the `@cap-js-community/odata-v2-adapter` cds-plugin (`/odata/v2/mass-material`, `/odata/v2/material-admin`), changing spec §4.4 ("V4 only"). Not covered by tests.
- `.xlsx` is read and written in memory (exceljs streaming reader crashed on small files); bounded by the 10 MB limit.
- `POSTING` row status is never set (a chunk is one transaction). `retryFailed` sets FAILED rows back to `QUEUED`.
- `product-srv.adapter.js` (real S/4) is **unverified**: field names and the value-help source mapping (`cds.mmc.s4.valueHelps`) must be checked against the target system.
- `description` is `String(40)` but test case E07 has 41 characters: SQLite accepts it, HANA would reject the insert before validation can report `LENGTH_DESCRIPTION`.

- Auth deviations from its spec: `@sap/cds` 10 and express 5 (not 9 / 4); no sample `DocumentService`; the admin service is `AuthAdminService` at `/admin`; the `Administrator` role cannot lose `User.Admin`; deleting an assigned role or `Administrator` is 409. `@sap/xssec` and `xs-security.json` were removed; the XSUAA mentions in `docs/spec.md` §4.7/§5 are superseded by `docs/auth.md`.

## Conventions

- Keys are `cuid`; auditing via `managed`. New enums/types go in `common.cds`, not inline in `schema.cds`.
- JavaScript only in `srv/` and `scripts/` (spec §4.1). Record any architecture decision not covered by the spec here.
- `db.sqlite`, `gen/` and `node_modules/` are git-ignored. `/commit` project command: Conventional Commits, shows the message and waits for confirmation before committing/pushing.
