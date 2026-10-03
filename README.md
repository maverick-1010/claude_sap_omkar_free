# ZMM_MATERIAL_MAINTENANCE – Material master create / update / extend

ABAP 7.40 SP08+ (new syntax, local classes). **Not compiled or tested** – written offline; run a syntax check (SE38/ADT) first.

## Objects (create as report + includes)

| Include | Content |
|---|---|
| `ZMM_MATERIAL_MAINTENANCE` | Main report |
| `..._TOP` | Global types |
| `..._S01` | Selection screen (unchanged from your design) |
| `..._C01` | `lcx_error`, `lcl_file_io`, `lcl_template`, `lcl_config`, `lcl_bapi` (generic dynamic BAPI wrapper) |
| `..._C02` | `lcl_log`, `lcl_validator`, `lcl_output`, `lcl_app` |
| `..._E01` | Events |

## Text symbols

| ID | Text |
|---|---|
| 001 | Input file |
| 002 | default local path |
| 003 | default AL11 input path |
| 004 | Operation / selection |
| 005 | Output |
| 006 | AL11 output folder (or full file name) |
| **007** | **AL11 path of the template file (.xlsx/.csv) used by "Download Template"** – new |
| 008 | default e-mail |
| R01/R02/R03 | Create / Update / Extend |

## Flow

1. **Download Template** – reads the file in text symbol 007 from AL11 (binary) and saves it to a local folder (save dialog).
2. Dropdowns (`P_MTART`, `P_INDSEC`, `P_BUSPRF`) are filled from `ZTMM_MATMAS_MAST` (active, valid today, `OPERATION_ID` = C/U/E of the radio button) and cascade (indsec filtered by mtart, busprf by mtart+indsec).
3. File check (`.xlsx`/`.csv` only), template read (local or AL11).
4. Active `VARIANT_VIEW` from `ZTMM_MATMAS_MAST`; field config read from the view tables of the ticked views (basic data is always read) + `ZTMM_COND_MAND`.
5. Per template row: mandatory / optional / system-derived / conditional-mandatory check (your 5.5.1), then **one `BAPI_MATERIAL_SAVEREPLICA` call per row**, commit (or rollback in test run) per row.
6. Result: ALV (one line per message, red/yellow/green, row number, template field), CSV on AL11 (`P_FILE3`), same CSV mailed to `P_EMAIL`.

## Dynamic mapping – how to maintain `BAPI_STRUCT_NAME` / `BAPI_FIELD_NAME`

No program change is needed for new fields. The interface of the BAPI is read at runtime from `FUPARAREF`, so use the real parameter names:

| Template field | BAPI_STRUCT_NAME | BAPI_FIELD_NAME |
|---|---|---|
| MATKL | CLIENTDATA | MATL_GROUP |
| WERKS | PLANTDATA | PLANT |
| VKORG | SALESDATA | SALES_ORG |
| MAKTX | MATERIALDESCRIPTION | MATL_DESC |
| SPRAS | MATERIALDESCRIPTION | LANGU |
| PO_TEXT | MATERIALLONGTEXT | TEXT_LINE |
| CLASS_TYPE | CLASSTYPENEW | *(empty – scalar parameter)* |
| CLASS_NAME | CLASSNUMNEW | *(empty – scalar parameter)* |
| CHAR_NAME_1 | ALLOCVALUESCHARNEW | CHARACT |
| CHAR_VALUE_1 | ALLOCVALUESCHARNEW | VALUE_CHAR |

Rules implemented by `lcl_bapi`:

* `<STRUCT>X` is filled automatically: `'X'` for 1-char flag fields, value copy for key fields (PLANT, SALES_ORG, …). Do **not** maintain X structures in the config.
* For table parameters the trailing `_<n>` of the template field name is the line key: `CHAR_NAME_1` + `CHAR_VALUE_1` become one line, `_2` the next. Fields without suffix share line 0.
* Values are converted to the BAPI field type (conversion exits such as MATN1/CUNIT/ISOLA, dates `DD.MM.YYYY`/`YYYYMMDD`/Excel serial, `1,234.50` or `1234,50` numbers, length checks). Errors name the row, template field and BAPI field.
* `HEADDATA` MATERIAL / MATL_TYPE / IND_SECTOR and the view flags (BASIC/SALES/PURCHASE/MRP/STORAGE/ACCOUNT_VIEW) are set from the selection screen if not mapped.
* Classification is not part of `SAVEREPLICA`: if class-BAPI parameters are mapped, `BAPI_OBJCL_CREATE` (or `BAPI_OBJCL_CHANGE` if the material is already in that class) is called after the material was committed. In test run classification is not simulated.

## Decisions / assumptions – please confirm

1. `OPERATION_ID` in `ZTMM_MATMAS_MAST` is `C`, `U`, `E`.
2. Exactly **one** active `VARIANT_VIEW` must exist for operation + mtart + indsec + busprf, otherwise the run stops.
3. `P_BUSPRF` is CHAR20 but `BUS_PROF` is CHAR40: the first 20 characters are used as listbox key / selection.
4. **Conditional mandatory:** a field flagged conditional-mandatory only requires its `CONDMAT_FIELD` when the field itself is filled in the template (your text could also be read as "always"). Change in `lcl_validator=>validate` if you want it unconditional.
5. `ACTION` (C/U/E or Create/Update/Extend) must match the selected radio button; `MTART` in the template must match `P_MTART`; create fails if the material exists, update/extend fail if it does not. Empty MATNR on create = internal numbering.
6. Reference-material columns (`REFERENCE_MATNR`, `COPY_*`, …) are treated like any other template field (mapped only if configured); copy-from-reference is not implemented (no BAPI support).
7. CSV: UTF-8, delimiter `,` `;` or tab auto-detected, quotes supported. Excel: first worksheet, row 1 = header (column names are matched case-insensitive, duplicates rejected).
8. Material number after create is taken from message M3 800/801 – verify in your release.
9. Authority checks: only `S_DATASET` for AL11 access; add material authority checks if required.
10. Test run (`P_TEST`, default on) calls the BAPI and rolls back.
