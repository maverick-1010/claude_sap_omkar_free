# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Nature of the repo

ABAP (7.40 SP08+, new syntax, local classes) report for SAP material master mass maintenance (Create / Update / Extend) via Excel/CSV templates. There is no build, lint or test tooling: the code was written offline and has **never been compiled**. Verification is a syntax check (SE38 / ADT) on an SAP system. Not a git repo. See `README.md` for text symbols, the dynamic-mapping table and the list of design assumptions to confirm — keep it in sync when behavior changes.

## Two parallel versions

- **Include-based**: `zmm_material_maintenance.abap` (main report) includes `_top` (global types), `_s01` (selection screen), `_c01` (`lcx_error`, `lcl_file_io`, `lcl_template`, `lcl_config`, `lcl_bapi`), `_c02` (`lcl_log`, `lcl_validator`, `lcl_output`, `lcl_app`), `_e01` (events).
- **Single-file**: `zmm_material_maintenance_single.abap` is a consolidation of the above into one report (`ZMM_MATERIAL_MAINTENANCE_SINGLE`). The two copies are not linked, so a logic change must be applied to both (the single file says the include project "remains untouched").

## Architecture (big picture)

Pipeline driven by `lcl_app`: file check → read template (`lcl_template`, local or AL11, .xlsx/.csv) → load config (`lcl_config`) → per template row validate (`lcl_validator`) → map to BAPI → `lcl_bapi` → commit/rollback per row → `lcl_log` / `lcl_output` (ALV, CSV on AL11, mail).

- Behavior is **configuration-driven** by Z tables: `ZTMM_MATMAS_MAST` (active `VARIANT_VIEW` per operation C/U/E + mtart + indsec + busprf; also feeds the cascading dropdowns), per-view field-config tables sharing the `ztmm_basic_data` structure (`ty_cfg` in `_top`), and `ZTMM_COND_MAND` (conditional mandatory).
- `lcl_bapi` is a **generic dynamic wrapper** for `BAPI_MATERIAL_SAVEREPLICA`: the BAPI interface is read at runtime from `FUPARAREF`, and config rows (`BAPI_STRUCT_NAME` / `BAPI_FIELD_NAME`) map template fields to real BAPI parameters. New fields need config only, not code. It auto-fills the `<STRUCT>X` flag structures, treats trailing `_<n>` of a template field as the table-line key, and does type/conversion-exit conversion. Classification goes through `BAPI_OBJCL_CREATE/CHANGE` after the material commit (not simulated in test run).
- Template rows are modeled as hashed `name/value` lists (`ty_row`/`ty_fv`); results as `ty_log` lines (one per message).
- One BAPI call and one commit (or rollback when `P_TEST`, default on) per template row.
