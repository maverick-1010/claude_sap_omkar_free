# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Nature of the repo

SAP CAP (Node.js, `@sap/cds` 10, SQLite via `@cap-js/sqlite`) project "Mass Material Creation" (`mmc` namespace): upload an Excel/CSV of material master rows, validate them against configurable rules, and later post them to SAP. It replaces an earlier ABAP report (`zmm_material_maintenance*.abap`) that was never compiled; those files are deleted in the working tree (still in git history, last version at commit `e504801` and earlier). `README.md` still describes the old ABAP report and is outdated; `abap_claude/` is an empty folder.

## Commands

- `npm start` (`cds-serve`) / `npm run watch` (`cds watch`) – run the service; OData V4 at `/odata/v4/material`.
- `npm test` (jest) – single file: `npx jest test/validation-errors.test.js`. That test skips itself until the service implements the `validate` action (`srv/` currently only has the `.cds` definition, no `.js` handler).
- `npm run gen:uploads` – regenerates `test/uploads/*` (xlsx/csv), `expected-results.json` and `test-cases.md`. Deterministic (seeded); it aborts if its reference validator disagrees with the declared expectations. Add cases to `CASES` / `STRUCTURAL` / `FAULTS` in `scripts/generate-test-uploads.js` rather than editing the generated files.

## Architecture

- `db/common.cds` – single source of truth for enums (`JobStatus`, `RowStatus`, `Severity`, `ViewType`, `RuleType`) and scalar domain types; every type carries `@title: '{i18n>...}'`.
- `db/schema.cds` – data model: `UploadJobs` (header, counters) → `JobFiles` (media) and `MaterialRequests` (one per uploaded row) → org-level views (`MaterialPlantData`, `…StorageData`, `…SalesData`, `…ValuationData`, `…PurchasingData`) and `ValidationMessages`. Configuration/reference entities: `MaterialTypeViewConfig` (which views are mandatory per material type), `ValidationRules` (data-driven REQUIRED/REGEX/RANGE/LOOKUP/LENGTH rules), `ValueHelpCache`, `ExistingMaterialCache`.
- `srv/material-service.cds` – `MaterialService` projecting those entities; `ValidationMessages` and the config/cache entities are `@readonly`. Bound actions such as `UploadJobs/validate` are expected by the test but not yet defined.
- Seed data: `db/data/` (config + rules, loaded by cds), `test/data/` (caches, test only). Rules are CSV rows, so validation behavior is changed by editing data, not code.
- i18n: `db/i18n/` with `en` (default), `es`, `hi`. Keep all languages in sync; use the `/cap-add-language` and `/cap-lang-check` project commands.
- `docs/` – generated database design diagram (`/cap-export-design`).

## Conventions

- Keys are `cuid`; auditing via `managed`. New enums/types go in `common.cds`, not inline in `schema.cds`.
- `db.sqlite` and `node_modules/` are git-ignored. `/commit` project command: Conventional Commits, shows the message and waits for confirmation before committing/pushing.
