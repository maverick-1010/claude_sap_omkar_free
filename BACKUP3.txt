*&---------------------------------------------------------------------*
*& Report ZMM_MATERIAL_MAINTENANCE_T5
*&---------------------------------------------------------------------*
*&
*&---------------------------------------------------------------------*
REPORT zom_material_maintenance_v2.

*&---------------------------------------------------------------------*
*& Report ZMM_MATERIAL_MAINTENANCE
*&---------------------------------------------------------------------*
*& Material master Create / Update / Extend from an upload template
*&---------------------------------------------------------------------*

*INCLUDE zmm_material_maintenance_top.
*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_TOP
*&---------------------------------------------------------------------*
*& Mapping syntax in the view tables (BAPI_STRUCT_NAME / BAPI_FIELD_NAME
*&---------------------------------------------------------------------*
TABLES sscrfields.

*----------------------------------------------------------------------*
* Constants
*----------------------------------------------------------------------*
CONSTANTS:
  BEGIN OF gc_op,                             "ZTMM_MATMAS_MAST-OPERATION_ID
    create TYPE z_de_op_id VALUE 'C',
    update TYPE z_de_op_id VALUE 'U',
    extend TYPE z_de_op_id VALUE 'E',
  END OF gc_op,

  BEGIN OF gc_view,                           "view tables
    basic  TYPE char10 VALUE 'BASIC',
    class  TYPE char10 VALUE 'CLASS',
    purch  TYPE char10 VALUE 'PURCH',
    mrp    TYPE char10 VALUE 'MRP',
    plntst TYPE char10 VALUE 'PLNTST',
    sales  TYPE char10 VALUE 'SALES',
    val    TYPE char10 VALUE 'VAL',
  END OF gc_view,

  BEGIN OF gc_col,                            "template columns with fixed meaning
    action     TYPE fieldname VALUE 'ACTION',
    message    TYPE fieldname VALUE 'MESSAGE',
    profile    TYPE fieldname VALUE 'PROCESS_PROFILE',
    ref_matnr  TYPE fieldname VALUE 'REFERENCE_MATNR',
    ref_werks  TYPE fieldname VALUE 'REF_WERKS',
    ref_vkorg  TYPE fieldname VALUE 'REF_VKORG',
    ref_vtweg  TYPE fieldname VALUE 'REF_VTWEG',
    ref_ekorg  TYPE fieldname VALUE 'REF_EKORG',
    def_mode   TYPE fieldname VALUE 'DEFAULT_MODE',
    copy_basic TYPE fieldname VALUE 'COPY_BASIC',
    copy_purch TYPE fieldname VALUE 'COPY_PURCH',
    copy_mrp   TYPE fieldname VALUE 'COPY_MRP',
    copy_sales TYPE fieldname VALUE 'COPY_SALES',
    copy_acct  TYPE fieldname VALUE 'COPY_ACCOUNTING',
    matnr      TYPE fieldname VALUE 'MATNR',
    mtart      TYPE fieldname VALUE 'MTART',
    mbrsh      TYPE fieldname VALUE 'MBRSH',
    werks      TYPE fieldname VALUE 'WERKS',
    vkorg      TYPE fieldname VALUE 'VKORG',
    vtweg      TYPE fieldname VALUE 'VTWEG',
    prdha      TYPE fieldname VALUE 'PRDHA',
  END OF gc_col,

  gc_hdr_row        TYPE i         VALUE 3,          "header = technical names
  gc_data_row       TYPE i         VALUE 5,          "first data row
  gc_prodh_levels   TYPE i         VALUE 5,          "PRODH_LVL1..5 -> PRDHA
  gc_objtab_mara    TYPE tabelle   VALUE 'MARA',     "classification object table
  gc_def_classtype  TYPE klassenart VALUE '001',     "default class type
  "Conditional mandatory: check CONDMAT_FIELD only if SOURCE_FIELD is filled
  gc_cond_if_source TYPE abap_bool VALUE abap_true,
  "Test run + Create without MATNR: draw internal number to simulate?
  "(the number is lost after the rollback)
  gc_sim_int_num    TYPE abap_bool VALUE abap_false.

*----------------------------------------------------------------------*
* Types
*----------------------------------------------------------------------*
TYPES:
  tt_fieldname TYPE STANDARD TABLE OF fieldname WITH EMPTY KEY,
  tt_raw       TYPE STANDARD TABLE OF string_table WITH EMPTY KEY,  "file rows/columns

  "View table directory
  BEGIN OF ty_viewtab,
    view    TYPE char10,
    tabname TYPE tabname,
    active  TYPE abap_bool,
  END OF ty_viewtab,
  tt_viewtab TYPE STANDARD TABLE OF ty_viewtab WITH EMPTY KEY,

  "Mapping target (parsed from BAPI_STRUCT_NAME / BAPI_FIELD_NAME)
  BEGIN OF ty_fixed,
    comp  TYPE fieldname,
    value TYPE string,
  END OF ty_fixed,
  tt_fixed TYPE STANDARD TABLE OF ty_fixed WITH EMPTY KEY,

  BEGIN OF ty_target,
    param   TYPE fieldname,          "BAPI parameter, e.g. PLANTDATA
    comp    TYPE fieldname,          "component,      e.g. MRP_TYPE
    table   TYPE abap_bool,          "TABLES parameter
    linekey TYPE string,             "explicit line (LINE=...)
    fixed   TYPE tt_fixed,           "fixed component values
  END OF ty_target,
  tt_target TYPE STANDARD TABLE OF ty_target WITH EMPTY KEY.

"Field catalogue = view table line + view id + parsed targets
TYPES BEGIN OF ty_fcat.
INCLUDE TYPE ztmm_basic_data.
TYPES:
  view    TYPE char10,
  targets TYPE tt_target,
  END OF ty_fcat.

TYPES:
  tt_fcat TYPE STANDARD TABLE OF ty_fcat WITH EMPTY KEY
          WITH NON-UNIQUE SORTED KEY k_field COMPONENTS temp_field_name,
  tt_cond TYPE STANDARD TABLE OF ztmm_cond_mand WITH EMPTY KEY,

  "Template content (only non-empty cells)
  BEGIN OF ty_cell,
    row   TYPE i,
    field TYPE fieldname,
    value TYPE string,
  END OF ty_cell,
  tt_cell TYPE SORTED TABLE OF ty_cell WITH UNIQUE KEY row field,

  BEGIN OF ty_rowfield,
    row   TYPE i,
    field TYPE fieldname,
  END OF ty_rowfield,
  tt_rowfield TYPE SORTED TABLE OF ty_rowfield WITH UNIQUE KEY row field,

  "Template row
  BEGIN OF ty_row,
    row    TYPE i,
    matkey TYPE string,              "MATNR or '#<row>' (internal numbering)
    werks  TYPE werks_d,
    vkorg  TYPE vkorg,
    vtweg  TYPE vtweg,
  END OF ty_row,
  tt_row TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY,

  "Log / ALV output
  BEGIN OF ty_msg,
    icon  TYPE icon_d,
    msgty TYPE symsgty,
    row   TYPE i,
    matnr TYPE char40,
    werks TYPE werks_d,
    vkorg TYPE vkorg,
    vtweg TYPE vtweg,
    view  TYPE char10,
    field TYPE fieldname,
    fdesc TYPE z_de_field_desc,
    text  TYPE bapi_msg,
  END OF ty_msg,
  tt_msg TYPE STANDARD TABLE OF ty_msg WITH EMPTY KEY,

  "Line index of table parameters (param + line key -> index)
  BEGIN OF ty_linekey,
    param TYPE fieldname,
    key   TYPE string,
    idx   TYPE i,
  END OF ty_linekey,
  tt_linekey TYPE STANDARD TABLE OF ty_linekey WITH EMPTY KEY,

  tt_views   TYPE SORTED TABLE OF char10 WITH UNIQUE KEY table_line,

  "Template data of one row, mapped to the structures of
  "BAPI_MATERIAL_SAVEREPLICA (one line per org. level parameter).
  "Component names = BAPI parameter names (used dynamically!)
  BEGIN OF ty_bapi,
    headdata            TYPE bapie1matheader,
    clientdata          TYPE bapie1mara,
    plantdata           TYPE bapie1marc,
    forecastparameters  TYPE bapie1mpop,
    planningdata        TYPE bapie1mpgd,
    storagelocationdata TYPE bapie1mard,
    valuationdata       TYPE bapie1mbew,
    warehousenumberdata TYPE bapie1mlgn,
    salesdata           TYPE bapie1mvke,
    storagetypedata     TYPE bapie1mlgt,
    materialdescription TYPE STANDARD TABLE OF bapie1makt WITH EMPTY KEY,
    unitsofmeasure      TYPE STANDARD TABLE OF bapie1marm WITH EMPTY KEY,
    internationalartnos TYPE STANDARD TABLE OF bapie1mean WITH EMPTY KEY,
    materiallongtext    TYPE STANDARD TABLE OF bapie1mltx WITH EMPTY KEY,
    taxclassifications  TYPE STANDARD TABLE OF bapie1mlan WITH EMPTY KEY,


    prtdata             TYPE bapie1mfhm,
    extensionin         TYPE bapie1parex,
    forecastvalues      TYPE bapie1mprw,
    unplndconsumption   TYPE bapie1mveu,
    totalconsumption    TYPE bapie1mveg,
    returnmessages      TYPE bapie1ret2,
    clientdatacwm       TYPE /cwm/bapie1mara,
    unitsofmeasurecwm   TYPE /cwm/bapie1marm,
    valuationdatacwm    TYPE /cwm/bapie1mbew,
    matplstadata        TYPE bapie1matplsta,
    marc_aps_extdata    TYPE bapie1marc_aps_ext,
    demand_penaltydata  TYPE bapie1ppo_dmnd_penalty,

    "classification (BAPI_OBJCL_*)
    classkey            TYPE bapi1003_key,
    allocvalueschar     TYPE STANDARD TABLE OF bapi1003_alloc_values_char WITH EMPTY KEY,
    allocvaluesnum      TYPE STANDARD TABLE OF bapi1003_alloc_values_num  WITH EMPTY KEY,
    allocvaluescurr     TYPE STANDARD TABLE OF bapi1003_alloc_values_curr WITH EMPTY KEY,
    "meta data
    row                 TYPE i,
    matkey              TYPE string,
    views               TYPE tt_views,           "views with data in this row
    line_keys           TYPE tt_linekey,
  END OF ty_bapi,
  tt_bapi TYPE STANDARD TABLE OF ty_bapi WITH EMPTY KEY,

  "Origin of a BAPI table line (for message -> template row)
  BEGIN OF ty_origin,
    param TYPE fieldname,
    idx   TYPE i,
    row   TYPE i,
  END OF ty_origin,
  tt_origin TYPE STANDARD TABLE OF ty_origin WITH EMPTY KEY,

  "One BAPI_MATERIAL_SAVEREPLICA call = one material, all org. levels.
  "Component names = TABLES parameter names of the BAPI
  BEGIN OF ty_call,
*    headdata             TYPE STANDARD TABLE OF bapie1mathead  WITH EMPTY KEY,
*    clientdata           TYPE STANDARD TABLE OF bapie1marart   WITH EMPTY KEY,
*    clientdatax          TYPE STANDARD TABLE OF bapie1marartx  WITH EMPTY KEY,
*    plantdata            TYPE STANDARD TABLE OF bapie1marcrt   WITH EMPTY KEY,
*    plantdatax           TYPE STANDARD TABLE OF bapie1marcrtx  WITH EMPTY KEY,
*    forecastparameters   TYPE STANDARD TABLE OF bapie1mpoprt   WITH EMPTY KEY,
*    forecastparametersx  TYPE STANDARD TABLE OF bapie1mpoprtx  WITH EMPTY KEY,
*    planningdata         TYPE STANDARD TABLE OF bapie1mpgdrt   WITH EMPTY KEY,
*    planningdatax        TYPE STANDARD TABLE OF bapie1mpgdrtx  WITH EMPTY KEY,
*    storagelocationdata  TYPE STANDARD TABLE OF bapie1mardrt   WITH EMPTY KEY,
*    storagelocationdatax TYPE STANDARD TABLE OF bapie1mardrtx  WITH EMPTY KEY,
*    valuationdata        TYPE STANDARD TABLE OF bapie1mbewrt   WITH EMPTY KEY,
*    valuationdatax       TYPE STANDARD TABLE OF bapie1mbewrtx  WITH EMPTY KEY,
*    warehousenumberdata  TYPE STANDARD TABLE OF bapie1mlgnrt   WITH EMPTY KEY,
*    warehousenumberdatax TYPE STANDARD TABLE OF bapie1mlgnrtx  WITH EMPTY KEY,
*    salesdata            TYPE STANDARD TABLE OF bapie1mvkert   WITH EMPTY KEY,
*    salesdatax           TYPE STANDARD TABLE OF bapie1mvkertx  WITH EMPTY KEY,
*    storagetypedata      TYPE STANDARD TABLE OF bapie1mlgtrt   WITH EMPTY KEY,
*    storagetypedatax     TYPE STANDARD TABLE OF bapie1mlgtrtx  WITH EMPTY KEY,
*    materialdescription  TYPE STANDARD TABLE OF bapie1maktrt   WITH EMPTY KEY,
*    unitsofmeasure       TYPE STANDARD TABLE OF bapie1marmrt   WITH EMPTY KEY,
*    unitsofmeasurex      TYPE STANDARD TABLE OF bapie1marmrtx  WITH EMPTY KEY,
*    internationalartnos  TYPE STANDARD TABLE OF bapie1meanrt   WITH EMPTY KEY,
*    materiallongtext     TYPE STANDARD TABLE OF bapie1mltxrt   WITH EMPTY KEY,
*    taxclassifications   TYPE STANDARD TABLE OF bapie1mlanrt   WITH EMPTY KEY,

    headdata             TYPE STANDARD TABLE OF bapie1matheader            WITH EMPTY KEY,
    clientdata           TYPE STANDARD TABLE OF bapie1mara                 WITH EMPTY KEY,
    clientdatax          TYPE STANDARD TABLE OF bapie1marax                WITH EMPTY KEY,
    plantdata            TYPE STANDARD TABLE OF bapie1marc                 WITH EMPTY KEY,
    plantdatax           TYPE STANDARD TABLE OF bapie1marcx                WITH EMPTY KEY,
    forecastparameters   TYPE STANDARD TABLE OF bapie1mpop                 WITH EMPTY KEY,
    forecastparametersx  TYPE STANDARD TABLE OF bapie1mpopx                WITH EMPTY KEY,
    planningdata         TYPE STANDARD TABLE OF bapie1mpgd                 WITH EMPTY KEY,
    planningdatax        TYPE STANDARD TABLE OF bapie1mpgdx                WITH EMPTY KEY,
    storagelocationdata  TYPE STANDARD TABLE OF bapie1mard                 WITH EMPTY KEY,
    storagelocationdatax TYPE STANDARD TABLE OF bapie1mardx                WITH EMPTY KEY,
    valuationdata        TYPE STANDARD TABLE OF bapie1mbew                 WITH EMPTY KEY,
    valuationdatax       TYPE STANDARD TABLE OF bapie1mbewx                WITH EMPTY KEY,
    warehousenumberdata  TYPE STANDARD TABLE OF bapie1mlgn                 WITH EMPTY KEY,
    warehousenumberdatax TYPE STANDARD TABLE OF bapie1mlgnx                WITH EMPTY KEY,
    salesdata            TYPE STANDARD TABLE OF bapie1mvke                 WITH EMPTY KEY,
    salesdatax           TYPE STANDARD TABLE OF bapie1mvkex                WITH EMPTY KEY,
    storagetypedata      TYPE STANDARD TABLE OF bapie1mlgt                 WITH EMPTY KEY,
    storagetypedatax     TYPE STANDARD TABLE OF bapie1mlgtx                WITH EMPTY KEY,
    materialdescription  TYPE STANDARD TABLE OF bapie1makt                 WITH EMPTY KEY,
    unitsofmeasure       TYPE STANDARD TABLE OF bapie1marm                 WITH EMPTY KEY,
    unitsofmeasurex      TYPE STANDARD TABLE OF bapie1marmx                WITH EMPTY KEY,
    internationalartnos  TYPE STANDARD TABLE OF bapie1mean                 WITH EMPTY KEY,
    materiallongtext     TYPE STANDARD TABLE OF bapie1mltx                 WITH EMPTY KEY,
    taxclassifications   TYPE STANDARD TABLE OF bapie1mlan                 WITH EMPTY KEY,
    prtdata              TYPE STANDARD TABLE OF bapie1mfhm                 WITH EMPTY KEY,
    prtdatax             TYPE STANDARD TABLE OF bapie1mfhmx                WITH EMPTY KEY,
    extensionin          TYPE STANDARD TABLE OF bapie1parex                WITH EMPTY KEY,
    extensioninx         TYPE STANDARD TABLE OF bapie1parexx               WITH EMPTY KEY,
    forecastvalues       TYPE STANDARD TABLE OF bapie1mprw                 WITH EMPTY KEY,
    unplndconsumption    TYPE STANDARD TABLE OF bapie1mveu                 WITH EMPTY KEY,
    totalconsumption     TYPE STANDARD TABLE OF bapie1mveg                 WITH EMPTY KEY,
    returnmessages       TYPE STANDARD TABLE OF bapie1ret2                 WITH EMPTY KEY,
    clientdatacwm        TYPE STANDARD TABLE OF /cwm/bapie1mara            WITH EMPTY KEY,
    clientdatacwmx       TYPE STANDARD TABLE OF /cwm/bapie1marax           WITH EMPTY KEY,
    unitsofmeasurecwm    TYPE STANDARD TABLE OF /cwm/bapie1marm            WITH EMPTY KEY,
    unitsofmeasurecwmx   TYPE STANDARD TABLE OF /cwm/bapie1marmx           WITH EMPTY KEY,
    valuationdatacwm     TYPE STANDARD TABLE OF /cwm/bapie1mbew            WITH EMPTY KEY,
    valuationdatacwmx    TYPE STANDARD TABLE OF /cwm/bapie1mbewx           WITH EMPTY KEY,
    matplstadata         TYPE STANDARD TABLE OF bapie1matplsta             WITH EMPTY KEY,
    matplstadatax        TYPE STANDARD TABLE OF bapie1matplstax            WITH EMPTY KEY,
    marc_aps_extdata     TYPE STANDARD TABLE OF bapie1marc_aps_ext         WITH EMPTY KEY,
    marc_aps_extdatax    TYPE STANDARD TABLE OF bapie1marc_aps_extx        WITH EMPTY KEY,
    demand_penaltydata   TYPE STANDARD TABLE OF bapie1ppo_dmnd_penalty     WITH EMPTY KEY,
    demand_penaltydatax  TYPE STANDARD TABLE OF bapie1ppo_dmnd_penaltyx    WITH EMPTY KEY,

    origin               TYPE tt_origin,

  END OF ty_call,

  "Reference material cache
  BEGIN OF ty_refcache,
    key  TYPE string,
    data TYPE ty_bapi,
  END OF ty_refcache,
  tt_refcache TYPE STANDARD TABLE OF ty_refcache WITH EMPTY KEY.

*INCLUDE zmm_material_maintenance_s01.
*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_S01
*&---------------------------------------------------------------------*

SELECTION-SCREEN BEGIN OF BLOCK b1.
  SELECTION-SCREEN PUSHBUTTON /2(25) p_btn USER-COMMAND btn_clk.
  SELECTION-SCREEN SKIP.
SELECTION-SCREEN END OF BLOCK b1.

SELECTION-SCREEN BEGIN OF BLOCK b2 WITH FRAME TITLE TEXT-001.
  PARAMETERS : r_local RADIOBUTTON GROUP rbg1 DEFAULT 'X' USER-COMMAND ucmd,
               p_file1 TYPE string LOWER CASE DEFAULT TEXT-002 MODIF ID md1,
               r_unix  RADIOBUTTON GROUP rbg1,
               p_file2 TYPE string LOWER CASE DEFAULT TEXT-003 MODIF ID md2.
SELECTION-SCREEN END OF BLOCK b2.

SELECTION-SCREEN BEGIN OF BLOCK b3 WITH FRAME TITLE TEXT-004.
  SELECTION-SCREEN BEGIN OF LINE.
    PARAMETERS : r_create RADIOBUTTON GROUP rbg2 DEFAULT 'X' USER-COMMAND ucmd.
    SELECTION-SCREEN COMMENT 3(7) TEXT-r01.
    SELECTION-SCREEN POSITION 12.
    PARAMETERS : r_update RADIOBUTTON GROUP rbg2.
    SELECTION-SCREEN COMMENT 14(7) TEXT-r02.
    SELECTION-SCREEN POSITION 22.
    PARAMETERS : r_extend RADIOBUTTON GROUP rbg2.
    SELECTION-SCREEN COMMENT 24(7) TEXT-r03.
  SELECTION-SCREEN END OF LINE.
  SELECTION-SCREEN SKIP 1.
  PARAMETERS : p_mtart  TYPE mtart AS LISTBOX VISIBLE LENGTH 10, " USER-COMMAND ucmd,
               p_indsec TYPE char1 AS LISTBOX VISIBLE LENGTH 4, " USER-COMMAND ucmd,
               p_busprf TYPE char20 AS LISTBOX VISIBLE LENGTH 20, " USER-COMMAND ucmd,
               p_class  AS CHECKBOX DEFAULT 'X',
               p_mrp    AS CHECKBOX DEFAULT 'X',
               p_plntst AS CHECKBOX DEFAULT 'X',
               p_purch  AS CHECKBOX DEFAULT 'X',
               p_sales  AS CHECKBOX DEFAULT 'X',
               p_val    AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN END OF BLOCK b3.

SELECTION-SCREEN BEGIN OF BLOCK b4 WITH FRAME TITLE TEXT-005.
  PARAMETERS : p_file3 TYPE string LOWER CASE DEFAULT TEXT-006 MODIF ID md3,
               p_email TYPE ad_smtpadr DEFAULT TEXT-008 MODIF ID md3,
               p_test  AS CHECKBOX DEFAULT abap_true USER-COMMAND ucmd.
SELECTION-SCREEN END OF BLOCK b4.


*INCLUDE zmm_material_maintenance_c01.
*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_C01
*&---------------------------------------------------------------------*
*& Class definitions
*&   lcx_error          - local exception
*&   lcl_log            - message log (= output ALV)
*&   lcl_mapper         - dynamic mapping template value -> BAPI field
*&   lcl_file_reader    - .xlsx / .csv reader (PC or application server)
*&   lcl_config         - variant + field catalogue + cond. rules
*&   lcl_material_bapi  - BAPI_MATERIAL_SAVEREPLICA / BAPI_OBJCL_* calls
*&   lcl_output         - ALV, server file, e-mail
*&   lcl_screen         - selection-screen logic
*&   lcl_app            - controller
*&---------------------------------------------------------------------*

CLASS lcx_error DEFINITION INHERITING FROM cx_static_check.
  PUBLIC SECTION.
    METHODS constructor IMPORTING iv_text TYPE csequence.
    METHODS get_text REDEFINITION.
  PRIVATE SECTION.
    DATA mv_text TYPE string.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_log DEFINITION FINAL.
  PUBLIC SECTION.
    DATA mt_msg TYPE tt_msg READ-ONLY.

    METHODS:
      add IMPORTING iv_type  TYPE symsgty
                    iv_text  TYPE csequence
                    is_row   TYPE ty_row    OPTIONAL
                    iv_matnr TYPE csequence OPTIONAL
                    iv_view  TYPE char10    OPTIONAL
                    iv_field TYPE csequence OPTIONAL
                    iv_fdesc TYPE csequence OPTIONAL,
      count            IMPORTING iv_type TYPE symsgty RETURNING VALUE(rv_count) TYPE i,
      has_error        IMPORTING iv_row TYPE i       RETURNING VALUE(rv_error) TYPE abap_bool,
      has_global_error RETURNING VALUE(rv_error) TYPE abap_bool.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_mapper DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      trim          IMPORTING iv_value TYPE any RETURNING VALUE(rv_value) TYPE string,
      is_dummy_key  IMPORTING iv_key TYPE string RETURNING VALUE(rv_dummy) TYPE abap_bool,
      resolve_param IMPORTING iv_struct TYPE csequence
                    EXPORTING ev_param  TYPE fieldname
                              ev_table  TYPE abap_bool,
      target_exists IMPORTING is_target TYPE ty_target RETURNING VALUE(rv_exists) TYPE abap_bool,
      map_value     IMPORTING is_target TYPE ty_target
                              iv_field  TYPE fieldname
                              iv_value  TYPE string
                    EXPORTING ev_error  TYPE string
                    CHANGING  cs_bapi   TYPE ty_bapi,
      move_value    IMPORTING iv_value  TYPE string
                    EXPORTING ev_error  TYPE string
                    CHANGING  cv_target TYPE any,
      set_x         IMPORTING iv_value TYPE any
                    CHANGING  cv_x     TYPE any,
      set_all_x     IMPORTING is_data TYPE any
                    CHANGING  cs_x    TYPE any,
      merge_struct  IMPORTING is_src TYPE any
                    CHANGING  cs_tgt TYPE any,
      append_unique IMPORTING is_line TYPE any
                    CHANGING  ct_tab  TYPE STANDARD TABLE,
      "--- BAPI_MATERIAL_SAVEREPLICA call assembly
      add_line         IMPORTING iv_param TYPE fieldname
                                 is_line  TYPE any
                                 iv_row   TYPE i
                       CHANGING  cs_call  TYPE ty_call,
      set_matnr        IMPORTING iv_matnr TYPE matnr
                       CHANGING  cs_line  TYPE any,

      set_func        IMPORTING iv_function TYPE bapifn
                      CHANGING  cs_line     TYPE any,
      set_material_all IMPORTING iv_matnr TYPE matnr
                       CHANGING  cs_call  TYPE ty_call,
      build_x_tables   CHANGING  cs_call  TYPE ty_call,
      set_default      IMPORTING iv_comp  TYPE csequence
                                 iv_value TYPE any
                       CHANGING  cs_line  TYPE any.
  PRIVATE SECTION.
    CLASS-METHODS get_line IMPORTING iv_param TYPE fieldname
                                     iv_key   TYPE string
                           EXPORTING er_line  TYPE REF TO data
                           CHANGING  cs_bapi  TYPE ty_bapi.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_file_reader DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      read          IMPORTING iv_file       TYPE string
                              iv_server     TYPE abap_bool
                    RETURNING VALUE(rt_raw) TYPE tt_raw
                    RAISING   lcx_error,
      get_extension IMPORTING iv_file       TYPE string
                    RETURNING VALUE(rv_ext) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS:
      read_binary     IMPORTING iv_file TYPE string iv_server TYPE abap_bool
                      RETURNING VALUE(rv_xdata) TYPE xstring RAISING lcx_error,
      read_text_lines IMPORTING iv_file TYPE string iv_server TYPE abap_bool
                      RETURNING VALUE(rt_lines) TYPE string_table RAISING lcx_error,
      parse_xlsx      IMPORTING iv_xdata TYPE xstring iv_file TYPE string
                      RETURNING VALUE(rt_raw) TYPE tt_raw RAISING lcx_error,
      parse_csv       IMPORTING it_lines TYPE string_table
                      RETURNING VALUE(rt_raw) TYPE tt_raw,
      split_csv_line  IMPORTING iv_line TYPE string iv_sep TYPE string
                      RETURNING VALUE(rt_fields) TYPE string_table.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_config DEFINITION FINAL.
  PUBLIC SECTION.
    DATA: mv_variant TYPE z_de_var_view READ-ONLY,
          mt_fcat    TYPE tt_fcat      READ-ONLY,
          mt_cond    TYPE tt_cond      READ-ONLY.

    CLASS-METHODS:
      view_tables     RETURNING VALUE(rt_tab)  TYPE tt_viewtab,
      control_columns RETURNING VALUE(rt_cols) TYPE tt_fieldname.

    METHODS:
      constructor IMPORTING io_log TYPE REF TO lcl_log,
      load        RAISING lcx_error.

  PRIVATE SECTION.
    DATA mo_log TYPE REF TO lcl_log.
    METHODS:
      get_variant    RAISING lcx_error,
      get_fields     RAISING lcx_error,
      get_cond_rules,
      parse_targets  IMPORTING is_fcat TYPE ty_fcat RETURNING VALUE(rt_target) TYPE tt_target.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_material_bapi DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS:
      constructor         IMPORTING io_log TYPE REF TO lcl_log,
      get_material_number IMPORTING is_row TYPE ty_row RETURNING VALUE(rv_matnr) TYPE matnr,
      get_reference       IMPORTING iv_matnr      TYPE matnr
                                    iv_werks      TYPE werks_d
                                    iv_vkorg      TYPE vkorg
                                    iv_vtweg      TYPE vtweg
                          RETURNING VALUE(rs_ref) TYPE ty_bapi
                          RAISING   lcx_error,
      save_material       IMPORTING is_call      TYPE ty_call
                                    it_rows      TYPE tt_row
                                    iv_matnr     TYPE matnr
                          RETURNING VALUE(rv_ok) TYPE abap_bool,
      classify            IMPORTING is_class     TYPE ty_bapi
                                    is_row       TYPE ty_row
                                    iv_matnr     TYPE matnr
                          RETURNING VALUE(rv_ok) TYPE abap_bool.
  PRIVATE SECTION.
    DATA: mo_log   TYPE REF TO lcl_log,
          mt_cache TYPE tt_refcache.
    METHODS finish_luw IMPORTING iv_ok        TYPE abap_bool
                                 iv_what      TYPE string
                                 iv_msg       TYPE csequence
                                 is_row       TYPE ty_row
                                 iv_matnr     TYPE matnr
                       RETURNING VALUE(rv_ok) TYPE abap_bool.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_output DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS constructor IMPORTING io_log TYPE REF TO lcl_log.
    METHODS publish.
  PRIVATE SECTION.
    DATA: mo_log TYPE REF TO lcl_log,
          mt_out TYPE tt_msg,
          mo_alv TYPE REF TO cl_salv_table.
    METHODS:
      build_alv      RETURNING VALUE(rv_ok) TYPE abap_bool,
      to_xlsx        RETURNING VALUE(rv_xdata) TYPE xstring,
      save_to_server IMPORTING iv_xdata TYPE xstring,
      send_mail      IMPORTING iv_xdata TYPE xstring,
      file_name      RETURNING VALUE(rv_name) TYPE string.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_template DEFINITION FINAL.
  "Upload template as .xlsx (Office Open XML built with CL_ABAP_ZIP)
  PUBLIC SECTION.
    CLASS-METHODS:
      download,
      template_columns RETURNING VALUE(rt_cols) TYPE tt_fieldname,
      get_temp_matnr IMPORTING is_row TYPE ty_row RETURNING VALUE(rv_matnr) TYPE matnr.
  PRIVATE SECTION.
    CONSTANTS:
      BEGIN OF c_style,                 "cellXfs index in styles.xml
        header    TYPE i VALUE 1,       "blue   - optional / other
        mandatory TYPE i VALUE 2,       "red    - mandatory
        cond      TYPE i VALUE 3,       "orange - conditional mandatory
        system    TYPE i VALUE 4,       "grey   - system derived
        control   TYPE i VALUE 5,       "green  - control column
        text      TYPE i VALUE 6,       "data cells formatted as text
        bold      TYPE i VALUE 7,
      END OF c_style.
    TYPES:
      BEGIN OF ty_col,
        field TYPE fieldname,
        style TYPE i,
      END OF ty_col,
      tt_col TYPE STANDARD TABLE OF ty_col WITH EMPTY KEY.
    CLASS-METHODS:
      build_xlsx     IMPORTING it_cols        TYPE tt_col
                               it_fcat        TYPE tt_fcat
                               iv_variant     TYPE csequence
                     RETURNING VALUE(rv_xlsx) TYPE xstring,
      sheet_template IMPORTING it_cols       TYPE tt_col
                     RETURNING VALUE(rv_xml) TYPE string,
      sheet_info     IMPORTING it_fcat       TYPE tt_fcat
                               iv_variant    TYPE csequence
                     RETURNING VALUE(rv_xml) TYPE string,
      styles         RETURNING VALUE(rv_xml) TYPE string,
      cell           IMPORTING iv_col        TYPE i
                               iv_row        TYPE i
                               iv_value      TYPE csequence
                               iv_style      TYPE i
                     RETURNING VALUE(rv_xml) TYPE string,
      col_letter     IMPORTING iv_col        TYPE i
                     RETURNING VALUE(rv_col) TYPE string,
      utf8           IMPORTING iv_xml      TYPE string
                     RETURNING VALUE(rv_x) TYPE xstring.
ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_screen DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      initialization,
      pbo,
      pai,
      f4_local_file  CHANGING cv_file TYPE string,
      get_operation  RETURNING VALUE(rv_opid) TYPE z_de_op_id.
  PRIVATE SECTION.
    CLASS-METHODS:
      set_listboxes,
      check_input,
      download_template,

      download_from_smw0
        IMPORTING iv_objid     TYPE wwwdatatab-objid
                  iv_target    TYPE string OPTIONAL
        RETURNING VALUE(rv_ok) TYPE abap_bool.


ENDCLASS.

*----------------------------------------------------------------------*
CLASS lcl_app DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS constructor.
    METHODS run.
  PRIVATE SECTION.
    DATA: mo_log    TYPE REF TO lcl_log,
          mo_config TYPE REF TO lcl_config,
          mo_bapi   TYPE REF TO lcl_material_bapi,
          mt_header TYPE tt_fieldname,        "template columns (index = column)
          mt_cell   TYPE tt_cell,             "template values
          mt_row    TYPE tt_row,              "template rows
          mt_copied TYPE tt_rowfield,         "values copied from reference
          mt_bapi   TYPE tt_bapi.             "mapped BAPI data per row

    METHODS:
      load_template          RAISING lcx_error,
      derive_values,
      check_columns,
      validate_and_map,
      check_row_control      IMPORTING is_row  TYPE ty_row,
      copy_reference         IMPORTING is_row  TYPE ty_row
                             CHANGING  cs_bapi TYPE ty_bapi,
      validate_row           IMPORTING is_row  TYPE ty_row
                                       is_fcat TYPE ty_fcat
                             CHANGING  cs_bapi TYPE ty_bapi,
      check_cond_mandatory   IMPORTING is_row      TYPE ty_row
                                       is_fcat     TYPE ty_fcat
                                       iv_supplied TYPE abap_bool,
      map_field              IMPORTING is_row   TYPE ty_row
                                       is_fcat  TYPE ty_fcat
                                       iv_value TYPE string
                             CHANGING  cs_bapi  TYPE ty_bapi,
      check_existence        IMPORTING is_row  TYPE ty_row
                                       is_bapi TYPE ty_bapi,
      process_materials,
      build_call             IMPORTING iv_matkey      TYPE string
                                       iv_matnr       TYPE matnr
                                       iv_row         TYPE i OPTIONAL
                             RETURNING VALUE(rs_call) TYPE ty_call,
      get_value              IMPORTING iv_row          TYPE i
                                       iv_field        TYPE fieldname
                             RETURNING VALUE(rv_value) TYPE string,
      is_available           IMPORTING iv_row          TYPE i
                                       iv_field        TYPE fieldname
                             RETURNING VALUE(rv_avail) TYPE abap_bool,
      is_flag_set            IMPORTING iv_row        TYPE i
                                       iv_field      TYPE fieldname
                             RETURNING VALUE(rv_set) TYPE abap_bool.
ENDCLASS.


*INCLUDE zmm_material_maintenance_c02.
*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_C02
*&---------------------------------------------------------------------*
*& Class implementations - part 1
*&   lcx_error, lcl_log, lcl_mapper, lcl_file_reader, lcl_config,
*&   lcl_material_bapi
*& (part 2 in ZMM_MATERIAL_MAINTENANCE_C03)
*&---------------------------------------------------------------------*

CLASS lcx_error IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    mv_text = iv_text.
  ENDMETHOD.
  METHOD get_text.
    result = mv_text.
  ENDMETHOD.
ENDCLASS.

*======================================================================*
* LCL_LOG
*======================================================================*
CLASS lcl_log IMPLEMENTATION.

  METHOD add.
    DATA(ls_msg) = VALUE ty_msg(
      icon  = SWITCH #( iv_type WHEN 'E' OR 'A' THEN icon_red_light
                                WHEN 'W'        THEN icon_yellow_light
                                ELSE                 icon_green_light )
      msgty = COND #( WHEN iv_type = 'A' THEN 'E' ELSE iv_type )
      row   = is_row-row
      werks = is_row-werks
      vkorg = is_row-vkorg
      vtweg = is_row-vtweg
      view  = iv_view
      field = iv_field
      fdesc = iv_fdesc
      text  = iv_text ).

    ls_msg-matnr = COND #( WHEN iv_matnr IS NOT INITIAL THEN iv_matnr
                           WHEN lcl_mapper=>is_dummy_key( is_row-matkey ) = abap_false
                           THEN is_row-matkey ).

    "no duplicates (same field can be maintained in several view tables)
    IF line_exists( mt_msg[ row   = ls_msg-row   msgty = ls_msg-msgty
                            field = ls_msg-field text  = ls_msg-text ] ).
      RETURN.
    ENDIF.
    APPEND ls_msg TO mt_msg.
  ENDMETHOD.

  METHOD count.
    rv_count = REDUCE i( INIT n = 0
                         FOR ls_msg IN mt_msg WHERE ( msgty = iv_type )
                         NEXT n = n + 1 ).
  ENDMETHOD.

  METHOD has_error.
    rv_error = COND #( WHEN line_exists( mt_msg[ row = iv_row msgty = 'E' ] )
                       THEN abap_true ELSE abap_false ).
  ENDMETHOD.

  METHOD has_global_error.
    rv_error = COND #( WHEN line_exists( mt_msg[ row = 0 msgty = 'E' ] )
                       THEN abap_true ELSE abap_false ).
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_MAPPER - generic, field-symbol based mapping
*======================================================================*
CLASS lcl_mapper IMPLEMENTATION.

  METHOD trim.
    rv_value = iv_value.
    rv_value = replace( val = rv_value regex = `^\s+|\s+$` with = `` occ = 0 ).
  ENDMETHOD.

  METHOD is_dummy_key.
    IF iv_key IS INITIAL.
      rv_dummy = abap_true.
      RETURN.
    ENDIF.
    rv_dummy = COND #( WHEN iv_key(1) = '#' THEN abap_true ELSE abap_false ).
  ENDMETHOD.

  METHOD resolve_param.
    "DDIC structure name -> parameter of BAPI_MATERIAL_SAVEREPLICA
    "(BAPIE1* structures; the BAPI_MARA ... names are accepted as well,
    " their field names are identical)
    CONSTANTS lc_single TYPE string VALUE
      ` HEADDATA CLIENTDATA PLANTDATA FORECASTPARAMETERS PLANNINGDATA STORAGELOCATIONDATA VALUATIONDATA WAREHOUSENUMBERDATA SALESDATA STORAGETYPEDATA CLASSKEY `.

    CONSTANTS lc_single2 TYPE string VALUE
    `PRTDATA EXTENSIONIN FORECASTVALUES UNPLNDCONSUMPTIO TOTALCONSUMPTION RETURNMESSAGES CLIENTDATACWM UNITSOFMEASURECWM VALUATIONDATACWM MATPLSTADATA MARC_APS_EXTDATA DEMAND_PENALTYDATA `.

    CONSTANTS lc_tables TYPE string VALUE
      ` MATERIALDESCRIPTION UNITSOFMEASURE INTERNATIONALARTNOS MATERIALLONGTEXT TAXCLASSIFICATIONS ALLOCVALUESCHAR ALLOCVALUESNUM ALLOCVALUESCURR `.

*    DATA lc_single TYPE string.
*
*    lc_single = ` MATERIALDESCRIPTION UNITSOFMEASURE INTERNATIONALARTNOS MATERIALLONGTEXT TAXCLASSIFICATIONS ALLOCVALUESCHAR ALLOCVALUESNUM ALLOCVALUESCURR `
*             && ` PRTDATA EXTENSIONIN FORECASTVALUES UNPLNDCONSUMPTIO TOTALCONSUMPTION RETURNMESSAGES CLIENTDATACWM UNITSOFMEASURECWM VALUATIONDATACWM MATPLSTADATA MARC_APS_EXTDATA DEMAND_PENALTYDATA `.

    CLEAR: ev_param, ev_table.
    DATA(lv_struct) = to_upper( trim( iv_struct ) ).

    ev_param = SWITCH fieldname( lv_struct
                 WHEN 'BAPIE1MATHEAD'              THEN 'HEADDATA'       "SAVEREPLICA
                 WHEN 'BAPIE1MARART'               THEN 'CLIENTDATA'
                 WHEN 'BAPIE1MARCRT'               THEN 'PLANTDATA'
                 WHEN 'BAPIE1MPOPRT'               THEN 'FORECASTPARAMETERS'
                 WHEN 'BAPIE1MPGDRT'               THEN 'PLANNINGDATA'
                 WHEN 'BAPIE1MARDRT'               THEN 'STORAGELOCATIONDATA'
                 WHEN 'BAPIE1MBEWRT'               THEN 'VALUATIONDATA'
                 WHEN 'BAPIE1MLGNRT'               THEN 'WAREHOUSENUMBERDATA'
                 WHEN 'BAPIE1MVKERT'               THEN 'SALESDATA'
                 WHEN 'BAPIE1MLGTRT'               THEN 'STORAGETYPEDATA'
                 WHEN 'BAPIE1MAKTRT'               THEN 'MATERIALDESCRIPTION'
                 WHEN 'BAPIE1MARMRT'               THEN 'UNITSOFMEASURE'
                 WHEN 'BAPIE1MEANRT'               THEN 'INTERNATIONALARTNOS'
                 WHEN 'BAPIE1MLTXRT'               THEN 'MATERIALLONGTEXT'
                 WHEN 'BAPIE1MLANRT'               THEN 'TAXCLASSIFICATIONS'
                 WHEN 'BAPIMATHEAD'                THEN 'HEADDATA'       "SAVEDATA names
                 WHEN 'BAPI_MARA'                  THEN 'CLIENTDATA'
                 WHEN 'BAPI_MARC'                  THEN 'PLANTDATA'
                 WHEN 'BAPI_MPOP'                  THEN 'FORECASTPARAMETERS'
                 WHEN 'BAPI_MPGD'                  THEN 'PLANNINGDATA'
                 WHEN 'BAPI_MARD'                  THEN 'STORAGELOCATIONDATA'
                 WHEN 'BAPI_MBEW'                  THEN 'VALUATIONDATA'
                 WHEN 'BAPI_MLGN'                  THEN 'WAREHOUSENUMBERDATA'
                 WHEN 'BAPI_MVKE'                  THEN 'SALESDATA'
                 WHEN 'BAPI_MLGT'                  THEN 'STORAGETYPEDATA'
                 WHEN 'BAPI_MAKT'                  THEN 'MATERIALDESCRIPTION'
                 WHEN 'BAPI_MARM'                  THEN 'UNITSOFMEASURE'
                 WHEN 'BAPI_MEAN'                  THEN 'INTERNATIONALARTNOS'
                 WHEN 'BAPI_MLTX'                  THEN 'MATERIALLONGTEXT'
                 WHEN 'BAPI_MLAN'                  THEN 'TAXCLASSIFICATIONS'
                 WHEN 'BAPI1003_KEY'               THEN 'CLASSKEY'
                 WHEN 'BAPI1003_ALLOC_VALUES_CHAR' THEN 'ALLOCVALUESCHAR'
                 WHEN 'BAPI1003_ALLOC_VALUES_NUM'  THEN 'ALLOCVALUESNUM'
                 WHEN 'BAPI1003_ALLOC_VALUES_CURR' THEN 'ALLOCVALUESCURR'
                 ELSE lv_struct ).                    "parameter name given directly

    IF lc_tables CS | { ev_param } |.
      ev_table = abap_true.
    ELSEIF lc_single NS | { ev_param } |.
      IF lc_single2 NS | { ev_param } |.
        CLEAR ev_param.
      ENDIF.
      "not supported
    ENDIF.
  ENDMETHOD.

  METHOD target_exists.
    FIELD-SYMBOLS: <lt_tab> TYPE STANDARD TABLE,
                   <ls_str> TYPE any,
                   <lv_cmp> TYPE any.
    DATA ls_probe TYPE ty_bapi.

    IF is_target-table = abap_true.
      ASSIGN COMPONENT is_target-param OF STRUCTURE ls_probe TO <lt_tab>.
      CHECK sy-subrc = 0.
      APPEND INITIAL LINE TO <lt_tab> ASSIGNING <ls_str>.
    ELSE.
      ASSIGN COMPONENT is_target-param OF STRUCTURE ls_probe TO <ls_str>.
      CHECK sy-subrc = 0.
    ENDIF.

    ASSIGN COMPONENT is_target-comp OF STRUCTURE <ls_str> TO <lv_cmp>.
    CHECK sy-subrc = 0.
    LOOP AT is_target-fixed INTO DATA(ls_fixed).
      ASSIGN COMPONENT ls_fixed-comp OF STRUCTURE <ls_str> TO <lv_cmp>.
      CHECK sy-subrc <> 0.
      RETURN.                                         "fixed component unknown
    ENDLOOP.
    rv_exists = abap_true.
  ENDMETHOD.

  METHOD get_line.
    "Line of a TABLES parameter identified by a line key
    FIELD-SYMBOLS: <lt_tab>  TYPE STANDARD TABLE,
                   <ls_line> TYPE any.

    CLEAR er_line.
    ASSIGN COMPONENT iv_param OF STRUCTURE cs_bapi TO <lt_tab>.
    CHECK sy-subrc = 0.

    READ TABLE cs_bapi-line_keys INTO DATA(ls_key)
         WITH KEY param = iv_param key = iv_key.
    IF sy-subrc = 0.
      READ TABLE <lt_tab> ASSIGNING <ls_line> INDEX ls_key-idx.
    ELSE.
      APPEND INITIAL LINE TO <lt_tab> ASSIGNING <ls_line>.
      APPEND VALUE #( param = iv_param key = iv_key idx = lines( <lt_tab> ) )
        TO cs_bapi-line_keys.
    ENDIF.
    er_line = REF #( <ls_line> ).
  ENDMETHOD.

  METHOD map_value.
    FIELD-SYMBOLS: <ls_tgt> TYPE any,
                   <lv_tgt> TYPE any,
                   <lv_fix> TYPE any.
    DATA: lv_suffix TYPE string,
          lv_key    TYPE string,
          lr_line   TYPE REF TO data,
          lv_value  TYPE string,
          lv_rest   TYPE string.

    CLEAR ev_error.
    lv_value = iv_value.

    "--- target structure (single parameter or line of a table parameter)
    IF is_target-table = abap_true.
      lv_key = is_target-linekey.
      IF lv_key IS INITIAL.
        "fields ending with _<n> (CHAR_NAME_1 / CHAR_VALUE_1) share line <n>
        FIND REGEX `_(\d+)$` IN iv_field SUBMATCHES lv_suffix.
        lv_key = |{ REDUCE string( INIT k = `` FOR f IN is_target-fixed
                                   NEXT k = |{ k }{ f-comp }={ f-value };| ) }| &&
                 |#{ COND string( WHEN lv_suffix IS INITIAL THEN `1` ELSE lv_suffix ) }|.
      ENDIF.
      get_line( EXPORTING iv_param = is_target-param
                          iv_key   = lv_key
                IMPORTING er_line  = lr_line
                CHANGING  cs_bapi  = cs_bapi ).
      IF lr_line IS BOUND.
        ASSIGN lr_line->* TO <ls_tgt>.
      ENDIF.
    ELSE.
      ASSIGN COMPONENT is_target-param OF STRUCTURE cs_bapi TO <ls_tgt>.
    ENDIF.

    IF <ls_tgt> IS NOT ASSIGNED.
      ev_error = |BAPI parameter { is_target-param } not available|.
      RETURN.
    ENDIF.

    "--- fixed component values (e.g. TEXT_ID=BEST)
    LOOP AT is_target-fixed INTO DATA(ls_fixed).
      ASSIGN COMPONENT ls_fixed-comp OF STRUCTURE <ls_tgt> TO <lv_fix>.
      IF sy-subrc = 0.
        <lv_fix> = ls_fixed-value.
      ENDIF.
    ENDLOOP.

    "--- target field
    ASSIGN COMPONENT is_target-comp OF STRUCTURE <ls_tgt> TO <lv_tgt>.
    IF sy-subrc <> 0.
      ev_error = |Field { is_target-param }-{ is_target-comp } does not exist|.
      RETURN.
    ENDIF.

    "Long texts longer than one line (132 char) -> continuation lines
    IF is_target-param = 'MATERIALLONGTEXT' AND is_target-comp = 'TEXT_LINE' AND
       strlen( lv_value ) > 132.
      lv_rest  = substring( val = lv_value off = 132 ).
      lv_value = substring( val = lv_value len = 132 ).
    ENDIF.

    move_value( EXPORTING iv_value  = lv_value
                IMPORTING ev_error  = ev_error
                CHANGING  cv_target = <lv_tgt> ).

    IF lv_rest IS NOT INITIAL AND ev_error IS INITIAL.
      DATA(ls_text) = CONV bapie1mltxrt( <ls_tgt> ).
      WHILE lv_rest IS NOT INITIAL.
        ls_text-text_line = lv_rest.
        APPEND ls_text TO cs_bapi-materiallongtext.
        lv_rest = COND #( WHEN strlen( lv_rest ) > 132
                          THEN substring( val = lv_rest off = 132 ) ELSE `` ).
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD move_value.
    "Type-driven conversion of a template value into a BAPI field
    DATA: ls_dfies TYPE dfies,
          lv_date  TYPE d,
          lv_fm    TYPE rs38l_fnam.

    CLEAR ev_error.
    DATA(lo_elem)  = CAST cl_abap_elemdescr( cl_abap_typedescr=>describe_by_data( cv_target ) ).
    DATA(lv_value) = iv_value.

    TRY.
        CASE lo_elem->type_kind.

          WHEN cl_abap_typedescr=>typekind_string.
            cv_target = lv_value.

          WHEN cl_abap_typedescr=>typekind_date.
            IF lv_value CO '0123456789' AND strlen( lv_value ) <= 5.
              lv_date = '18991230'.                       "Excel serial date
              lv_date = lv_date + CONV i( lv_value ).
            ELSEIF lv_value CO '0123456789' AND strlen( lv_value ) = 8.
              lv_date = lv_value.                         "YYYYMMDD
            ELSE.
              CALL FUNCTION 'CONVERT_DATE_TO_INTERNAL'   "user format
                EXPORTING
                  date_external = lv_value
                IMPORTING
                  date_internal = lv_date
                EXCEPTIONS
                  OTHERS        = 1.
              IF sy-subrc <> 0.
                CLEAR lv_date.
              ENDIF.
            ENDIF.
            IF lv_date IS INITIAL OR CONV i( lv_date ) = 0.
              ev_error = |Invalid date '{ lv_value }'|.
              RETURN.
            ENDIF.
            cv_target = lv_date.

          WHEN cl_abap_typedescr=>typekind_packed OR cl_abap_typedescr=>typekind_int
            OR cl_abap_typedescr=>typekind_int1   OR cl_abap_typedescr=>typekind_int2
            OR cl_abap_typedescr=>typekind_float
            OR cl_abap_typedescr=>typekind_decfloat16
            OR cl_abap_typedescr=>typekind_decfloat34.
            CONDENSE lv_value NO-GAPS.
            IF lv_value CS '.'.
              REPLACE ALL OCCURRENCES OF ',' IN lv_value WITH ''.   "1,234.50
            ELSE.
              REPLACE ALL OCCURRENCES OF ',' IN lv_value WITH '.'.  "12,5
            ENDIF.
            cv_target = lv_value.                         "raises on bad format

          WHEN cl_abap_typedescr=>typekind_char OR cl_abap_typedescr=>typekind_num.
            IF lo_elem->is_ddic_type( ) = abap_true.
              lo_elem->get_ddic_field( RECEIVING p_flddescr = ls_dfies EXCEPTIONS OTHERS = 1 ).
            ENDIF.

            IF ls_dfies-convexit IS NOT INITIAL.          "ALPHA, MATN1, CUNIT, ISOLA ...
              lv_fm = |CONVERSION_EXIT_{ ls_dfies-convexit }_INPUT|.
              CALL FUNCTION lv_fm
                EXPORTING
                  input         = lv_value
                IMPORTING
                  output        = cv_target
                EXCEPTIONS
                  error_message = 1
                  OTHERS        = 2.
              IF sy-subrc <> 0.
                CLEAR cv_target.
                ev_error = |Value '{ lv_value }' rejected by conversion exit { ls_dfies-convexit }|.
              ENDIF.
              RETURN.
            ENDIF.

            DATA(lv_maxlen) = lo_elem->length / cl_abap_char_utilities=>charsize.
            IF strlen( lv_value ) > lv_maxlen.
              ev_error = |Value '{ lv_value }' exceeds maximum length { lv_maxlen }|.
              RETURN.
            ENDIF.
            IF lo_elem->type_kind = cl_abap_typedescr=>typekind_num AND lv_value CN '0123456789'.
              ev_error = |Value '{ lv_value }' must be numeric|.
              RETURN.
            ENDIF.
            cv_target = lv_value.

          WHEN OTHERS.
            cv_target = lv_value.
        ENDCASE.

      CATCH cx_sy_conversion_error cx_sy_dyn_call_error INTO DATA(lx_conv).
        CLEAR cv_target.
        ev_error = |Invalid value '{ lv_value }': { lx_conv->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.

  METHOD set_x.
    "Same type as data field -> key field (PLANT, SALES_ORG ...): copy value
    "otherwise BAPIUPDATE flag
    IF cl_abap_typedescr=>describe_by_data( cv_x )->absolute_name =
       cl_abap_typedescr=>describe_by_data( iv_value )->absolute_name.
      cv_x = iv_value.
    ELSE.
      cv_x = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD set_all_x.
    "Build X-structure from all filled components of the data structure
    FIELD-SYMBOLS: <lv_data> TYPE any,
                   <lv_x>    TYPE any.
    DATA(lo_x) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_data( cs_x ) ).
    LOOP AT lo_x->components INTO DATA(ls_comp).
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE is_data TO <lv_data>.
      CHECK sy-subrc = 0.
      CHECK <lv_data> IS NOT INITIAL.
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE cs_x TO <lv_x>.
      CHECK sy-subrc = 0.
      set_x( EXPORTING iv_value = <lv_data> CHANGING cv_x = <lv_x> ).
    ENDLOOP.
  ENDMETHOD.

  METHOD merge_struct.
    "Copy all non-initial components of IS_SRC into CS_TGT
    FIELD-SYMBOLS: <lv_src> TYPE any,
                   <lv_tgt> TYPE any.
    DO.
      ASSIGN COMPONENT sy-index OF STRUCTURE is_src TO <lv_src>.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
      CHECK <lv_src> IS NOT INITIAL.
      ASSIGN COMPONENT sy-index OF STRUCTURE cs_tgt TO <lv_tgt>.
      IF sy-subrc = 0.
        <lv_tgt> = <lv_src>.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD append_unique.
    FIELD-SYMBOLS <ls_line> TYPE any.
    LOOP AT ct_tab ASSIGNING <ls_line>.
      IF <ls_line> = is_line.
        RETURN.
      ENDIF.
    ENDLOOP.
    APPEND is_line TO ct_tab.
  ENDMETHOD.

  METHOD add_line.
    "Add a line to a TABLES parameter of the BAPI call. Lines with the
    "same org. key (e.g. PLANT) are merged, others are appended.
    FIELD-SYMBOLS: <lt_tab>  TYPE STANDARD TABLE,
                   <ls_line> TYPE any,
                   <lv_new>  TYPE any,
                   <lv_old>  TYPE any.
    DATA: lt_keys TYPE string_table,
          lv_same TYPE abap_bool.

    ASSIGN COMPONENT iv_param OF STRUCTURE cs_call TO <lt_tab>.
    CHECK sy-subrc = 0.

    DATA(lv_keys) = SWITCH string( iv_param
      WHEN 'CLIENTDATA'          THEN ``                          "one line per material
      WHEN 'PLANTDATA'           THEN `PLANT`
      WHEN 'FORECASTPARAMETERS'  THEN `PLANT`
      WHEN 'PLANNINGDATA'        THEN `PLANT`
      WHEN 'STORAGELOCATIONDATA' THEN `PLANT STGE_LOC`
      WHEN 'VALUATIONDATA'       THEN `VAL_AREA VAL_TYPE`
      WHEN 'WAREHOUSENUMBERDATA' THEN `WHSE_NO`
      WHEN 'SALESDATA'           THEN `SALES_ORG DISTR_CHAN`
      WHEN 'STORAGETYPEDATA'     THEN `WHSE_NO STGE_TYPE`
      WHEN 'MATERIALDESCRIPTION' THEN `LANGU LANGU_ISO`
      WHEN 'UNITSOFMEASURE'      THEN `ALT_UNIT ALT_UNIT_ISO`
      WHEN 'TAXCLASSIFICATIONS'  THEN `DEPCOUNTRY DEPCOUNTRY_ISO`
      WHEN 'INTERNATIONALARTNOS' THEN `UNIT UNIT_ISO EAN_UPC`
      ELSE `*` ).                                                "append (long texts)

    IF lv_keys = `*`.
      append_unique( EXPORTING is_line = is_line CHANGING ct_tab = <lt_tab> ).
      APPEND VALUE #( param = iv_param idx = lines( <lt_tab> ) row = iv_row ) TO cs_call-origin.
      RETURN.
    ENDIF.

    SPLIT lv_keys AT space INTO TABLE lt_keys.
    LOOP AT <lt_tab> ASSIGNING <ls_line>.
      DATA(lv_idx) = sy-tabix.
      lv_same = abap_true.
      LOOP AT lt_keys INTO DATA(lv_key) WHERE table_line IS NOT INITIAL.
        ASSIGN COMPONENT lv_key OF STRUCTURE is_line TO <lv_new>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT lv_key OF STRUCTURE <ls_line> TO <lv_old>.
        CHECK sy-subrc = 0.
        IF <lv_new> <> <lv_old>.
          lv_same = abap_false.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_same = abap_true.
        merge_struct( EXPORTING is_src = is_line CHANGING cs_tgt = <ls_line> ).
        APPEND VALUE #( param = iv_param idx = lv_idx row = iv_row ) TO cs_call-origin.
        RETURN.
      ENDIF.
    ENDLOOP.

    APPEND is_line TO <lt_tab>.
    APPEND VALUE #( param = iv_param idx = lines( <lt_tab> ) row = iv_row ) TO cs_call-origin.
  ENDMETHOD.

  METHOD set_func.
    "Update BAPI Function
    FIELD-SYMBOLS: <lv_func> TYPE any.

    ASSIGN COMPONENT 'FUNCTION'      OF STRUCTURE cs_line TO <lv_func>.
    IF <lv_func> IS ASSIGNED.
      <lv_func> = iv_function.
    ENDIF.
  ENDMETHOD.


  METHOD set_matnr.
    "MATERIAL (18) and - on S/4HANA - MATERIAL_LONG (40)
    FIELD-SYMBOLS: <lv_short> TYPE any,
                   <lv_long>  TYPE any.
    ASSIGN COMPONENT 'MATERIAL'      OF STRUCTURE cs_line TO <lv_short>.
    ASSIGN COMPONENT 'MATERIAL_LONG' OF STRUCTURE cs_line TO <lv_long>.
    IF <lv_long> IS ASSIGNED.
      <lv_long> = iv_matnr.
      IF <lv_short> IS ASSIGNED.
        IF strlen( iv_matnr ) <= 18.
          <lv_short> = iv_matnr.
        ELSE.
          CLEAR <lv_short>.
        ENDIF.
      ENDIF.
    ELSEIF <lv_short> IS ASSIGNED.
      <lv_short> = iv_matnr.
    ENDIF.
  ENDMETHOD.

  METHOD set_material_all.
    "Material number in every line of every TABLES parameter
    FIELD-SYMBOLS: <lt_tab>  TYPE STANDARD TABLE,
                   <ls_line> TYPE any.

    DATA(lv_func) = COND #( WHEN r_create = abap_true THEN 'INS'
                      WHEN r_update = abap_true THEN 'UPD' ).

    DATA(lo_call) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_data( cs_call ) ).
    LOOP AT lo_call->components INTO DATA(ls_comp) WHERE type_kind = cl_abap_typedescr=>typekind_table.
      CHECK ls_comp-name <> 'ORIGIN'.
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE cs_call TO <lt_tab>.
      CHECK sy-subrc = 0.
      LOOP AT <lt_tab> ASSIGNING <ls_line>.
        set_matnr( EXPORTING iv_matnr = iv_matnr CHANGING cs_line = <ls_line> ).

        set_func( EXPORTING iv_function =  lv_func CHANGING cs_line = <ls_line> ).

      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD build_x_tables.
    "For each parameter with an X counterpart (PLANTDATA -> PLANTDATAX ...)
    "one X line per data line: key fields copied, other filled fields = 'X'
    FIELD-SYMBOLS: <lt_data> TYPE STANDARD TABLE,
                   <lt_x>    TYPE STANDARD TABLE,
                   <ls_data> TYPE any,
                   <ls_x>    TYPE any.
    DATA(lo_call) = CAST cl_abap_structdescr( cl_abap_typedescr=>describe_by_data( cs_call ) ).
    LOOP AT lo_call->components INTO DATA(ls_comp) WHERE type_kind = cl_abap_typedescr=>typekind_table.
      DATA(lv_xname) = |{ ls_comp-name }X|.
      ASSIGN COMPONENT lv_xname OF STRUCTURE cs_call TO <lt_x>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_comp-name OF STRUCTURE cs_call TO <lt_data>.
      CHECK sy-subrc = 0.
      CLEAR <lt_x>.
      LOOP AT <lt_data> ASSIGNING <ls_data>.
        APPEND INITIAL LINE TO <lt_x> ASSIGNING <ls_x>.
        set_all_x( EXPORTING is_data = <ls_data> CHANGING cs_x = <ls_x> ).
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_default.
    "Set component if it exists and is still initial
    FIELD-SYMBOLS <lv_comp> TYPE any.
    ASSIGN COMPONENT iv_comp OF STRUCTURE cs_line TO <lv_comp>.
    IF sy-subrc = 0 AND <lv_comp> IS INITIAL.
      <lv_comp> = iv_value.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_FILE_READER - .xlsx / .csv
*======================================================================*
CLASS lcl_file_reader IMPLEMENTATION.

  METHOD get_extension.
    DATA(lv_file) = to_lower( iv_file ).
    FIND REGEX `\.([a-z0-9]+)$` IN lv_file SUBMATCHES rv_ext.
  ENDMETHOD.

  METHOD read.
    CASE get_extension( iv_file ).
      WHEN 'xlsx'.
        rt_raw = parse_xlsx( iv_xdata = read_binary( iv_file = iv_file iv_server = iv_server )
                             iv_file  = iv_file ).
      WHEN 'csv'.
        rt_raw = parse_csv( read_text_lines( iv_file = iv_file iv_server = iv_server ) ).
      WHEN OTHERS.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = |File { iv_file } not supported - only .xlsx and .csv files are allowed|.
    ENDCASE.

    IF lines( rt_raw ) < gc_data_row.
      RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = 'Template contains no data rows'.
    ENDIF.
  ENDMETHOD.

  METHOD read_binary.
    IF iv_server = abap_false.
      IF sy-batch = abap_true.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = 'Local file cannot be read in background - use application server'.
      ENDIF.
      DATA: lt_bin TYPE solix_tab,
            lv_len TYPE i.
      cl_gui_frontend_services=>gui_upload(
        EXPORTING  filename   = iv_file
                   filetype   = 'BIN'
        IMPORTING  filelength = lv_len
        CHANGING   data_tab   = lt_bin
        EXCEPTIONS OTHERS     = 1 ).
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = |Error uploading file { iv_file }|.
      ENDIF.
      rv_xdata = cl_bcs_convert=>solix_to_xstring( it_solix = lt_bin iv_size = lv_len ).
    ELSE.
      TRY.
          OPEN DATASET iv_file FOR INPUT IN BINARY MODE.
          IF sy-subrc <> 0.
            RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = |Cannot open file { iv_file }|.
          ENDIF.
          READ DATASET iv_file INTO rv_xdata.
          CLOSE DATASET iv_file.
        CATCH cx_sy_file_open cx_sy_file_authority cx_sy_file_io INTO DATA(lx_file).
          RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = lx_file->get_text( ).
      ENDTRY.
    ENDIF.
  ENDMETHOD.

  METHOD read_text_lines.
    DATA lv_line TYPE string.

    IF iv_server = abap_false.
      IF sy-batch = abap_true.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = 'Local file cannot be read in background - use application server'.
      ENDIF.
      cl_gui_frontend_services=>gui_upload(
        EXPORTING  filename = iv_file
                   filetype = 'ASC'
        CHANGING   data_tab = rt_lines
        EXCEPTIONS OTHERS   = 1 ).
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = |Error uploading file { iv_file }|.
      ENDIF.
    ELSE.
      TRY.
          OPEN DATASET iv_file FOR INPUT IN TEXT MODE ENCODING DEFAULT.
*                                   SKIPPING BYTE-ORDER MARK.
          IF sy-subrc <> 0.
            RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = |Cannot open file { iv_file }|.
          ENDIF.
          DO.
            READ DATASET iv_file INTO lv_line.
            IF sy-subrc <> 0.
              EXIT.
            ENDIF.
            APPEND lv_line TO rt_lines.
          ENDDO.
          CLOSE DATASET iv_file.
        CATCH cx_sy_file_open cx_sy_file_authority cx_sy_file_io
              cx_sy_conversion_codepage INTO DATA(lx_file).
          RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = lx_file->get_text( ).
      ENDTRY.
    ENDIF.

    "Remove UTF-8 BOM and CR
    IF rt_lines IS NOT INITIAL.
      ASSIGN rt_lines[ 1 ] TO FIELD-SYMBOL(<lv_first>).
      REPLACE ALL OCCURRENCES OF cl_abap_conv_in_ce=>uccp( 'FEFF' ) IN <lv_first> WITH ``.
    ENDIF.
    LOOP AT rt_lines ASSIGNING FIELD-SYMBOL(<lv_line>).
      REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf(1) IN <lv_line> WITH ``.
    ENDLOOP.
  ENDMETHOD.

  METHOD parse_xlsx.
    FIELD-SYMBOLS: <lt_ws>   TYPE STANDARD TABLE,
                   <ls_line> TYPE any,
                   <lv_cell> TYPE any.
    DATA: lo_xl     TYPE REF TO cl_fdt_xl_spreadsheet,
          lt_values TYPE string_table.

    TRY.
        lo_xl = NEW #( document_name = iv_file xdocument = iv_xdata ).
      CATCH cx_fdt_excel_core INTO DATA(lx_xl).
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = |File is not a valid XLSX file: { lx_xl->get_text( ) }|.
    ENDTRY.

    lo_xl->if_fdt_doc_spreadsheet~get_worksheet_names( IMPORTING worksheet_names = DATA(lt_ws) ).
    IF lt_ws IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = 'XLSX file contains no worksheet'.
    ENDIF.

    "Template = first worksheet
    DATA(lr_data) = lo_xl->if_fdt_doc_spreadsheet~get_itab_from_worksheet( lt_ws[ 1 ] ).
    ASSIGN lr_data->* TO <lt_ws>.
    CHECK sy-subrc = 0.

    LOOP AT <lt_ws> ASSIGNING <ls_line>.
      CLEAR lt_values.
      DO.
        ASSIGN COMPONENT sy-index OF STRUCTURE <ls_line> TO <lv_cell>.
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        APPEND CONV string( <lv_cell> ) TO lt_values.
      ENDDO.
      APPEND lt_values TO rt_raw.
    ENDLOOP.
  ENDMETHOD.

  METHOD parse_csv.
    CHECK it_lines IS NOT INITIAL.

    "Separator = most frequent of ; , TAB in the header line
    DATA(lv_hdr)   = it_lines[ 1 ].
    DATA(lv_tab)   = CONV string( cl_abap_char_utilities=>horizontal_tab ).
    DATA(lv_semi)  = count( val = lv_hdr sub = `;` ).
    DATA(lv_comma) = count( val = lv_hdr sub = `,` ).
    DATA(lv_tabs)  = count( val = lv_hdr sub = lv_tab ).
    DATA(lv_sep)   = COND string( WHEN lv_tabs > lv_semi AND lv_tabs > lv_comma THEN lv_tab
                                  WHEN lv_semi > lv_comma                     THEN `;`
                                  ELSE                                             `,` ).

    LOOP AT it_lines INTO DATA(lv_line).
      APPEND split_csv_line( iv_line = lv_line iv_sep = lv_sep ) TO rt_raw.
    ENDLOOP.
  ENDMETHOD.

  METHOD split_csv_line.
    "CSV with quoted fields ("a;b" and "" as escaped quote)
    DATA: lv_field  TYPE string,
          lv_quoted TYPE abap_bool,
          lv_pos    TYPE i.

    DATA(lv_len) = strlen( iv_line ).
    WHILE lv_pos < lv_len.
      DATA(lv_char) = substring( val = iv_line off = lv_pos len = 1 ).
      IF lv_quoted = abap_true.
        IF lv_char = `"`.
          DATA(lv_next) = lv_pos + 1.
          IF lv_next < lv_len AND substring( val = iv_line off = lv_next len = 1 ) = `"`.
            lv_field = lv_field && `"`.
            lv_pos = lv_pos + 1.
          ELSE.
            lv_quoted = abap_false.
          ENDIF.
        ELSE.
          lv_field = lv_field && lv_char.
        ENDIF.
      ELSEIF lv_char = `"`.
        lv_quoted = abap_true.
      ELSEIF lv_char = iv_sep.
        APPEND lv_field TO rt_fields.
        CLEAR lv_field.
      ELSE.
        lv_field = lv_field && lv_char.
      ENDIF.
      lv_pos = lv_pos + 1.
    ENDWHILE.
    APPEND lv_field TO rt_fields.
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_CONFIG - variant, field catalogue, conditional mandatory rules
*======================================================================*
CLASS lcl_config IMPLEMENTATION.

  METHOD view_tables.
    "View table per selection-screen checkbox
    rt_tab = VALUE #( ( view = gc_view-basic  tabname = 'ZTMM_BASIC_DATA'  active = abap_true   )
                      ( view = gc_view-class  tabname = 'ZTMM_CLASS_DATA'  active = p_class )
                      ( view = gc_view-purch  tabname = 'ZTMM_PURCH_DATA'  active = p_purch  )
                      ( view = gc_view-mrp    tabname = 'ZTMM_MRP_DATA'    active = p_mrp   )
                      ( view = gc_view-plntst tabname = 'ZTMM_PLNTST_DATA' active = p_plntst )
                      ( view = gc_view-sales  tabname = 'ZTMM_SALES_DATA'  active = p_sales )
                      ( view = gc_view-val    tabname = 'ZTMM_VAL_DATA'    active = p_val  ) ).
  ENDMETHOD.

  METHOD control_columns.
    "Template columns that steer processing (not in the view tables)
    rt_cols = VALUE #( ( gc_col-action )     ( gc_col-message )    ( gc_col-profile )
                       ( gc_col-ref_matnr )  ( gc_col-ref_werks )  ( gc_col-ref_vkorg )
                       ( gc_col-ref_vtweg )  ( gc_col-ref_ekorg )  ( gc_col-def_mode )
                       ( gc_col-copy_basic ) ( gc_col-copy_purch ) ( gc_col-copy_mrp )
                       ( gc_col-copy_sales ) ( gc_col-copy_acct ) ).
  ENDMETHOD.

  METHOD constructor.
    mo_log = io_log.
  ENDMETHOD.

  METHOD load.
    get_variant( ).        "5.2
    get_fields( ).         "5.3 / 5.4
    get_cond_rules( ).
  ENDMETHOD.

  METHOD get_variant.
    DATA(lv_opid) = lcl_screen=>get_operation( ).

    SELECT * FROM ztmm_matmas_mast
      INTO TABLE @DATA(lt_mast)
      WHERE mat_type     = @p_mtart
        AND ind_sec      = @p_indsec
        AND bus_prof     = @p_busprf
        AND operation_id = @lv_opid
        AND active_flag  = @abap_true
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = '00000000' ).

    IF lt_mast IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING
          iv_text = |No active variant in ZTMM_MATMAS_MAST for { p_mtart } / { p_indsec } / | &&
                    |{ p_busprf } / operation { lv_opid }|.
    ENDIF.

    SORT lt_mast BY valid_from DESCENDING.
    mv_variant = lt_mast[ 1 ]-variant_view.

*    IF lines( lt_mast ) > 1.
*      mo_log->add( iv_type = 'W'
*                   iv_text = |{ lines( lt_mast ) } active entries found - variant { mv_variant } | &&
*                             |(latest valid-from) used| ).
*    ENDIF.
    mo_log->add( iv_type = 'S' iv_text = |Active variant { mv_variant } determined| ).
  ENDMETHOD.

  METHOD get_fields.
    DATA lt_db TYPE STANDARD TABLE OF ztmm_basic_data WITH EMPTY KEY.

    CLEAR mt_fcat.
    DATA(lt_views) = view_tables( ).

    LOOP AT lt_views INTO DATA(ls_view) WHERE active = abap_true.
      CLEAR lt_db.
      TRY.
          "all view tables have the same structure -> dynamic table name
          SELECT * FROM (ls_view-tabname)
            INTO CORRESPONDING FIELDS OF TABLE @lt_db
            WHERE variant_view = @mv_variant.
        CATCH cx_sy_dynamic_osql_error INTO DATA(lx_sql).
          mo_log->add( iv_type = 'E' iv_text = |{ ls_view-tabname }: { lx_sql->get_text( ) }| ).
          CONTINUE.
      ENDTRY.

      IF lt_db IS INITIAL.
        mo_log->add( iv_type = 'W' iv_view = ls_view-view
                     iv_text = |No fields maintained in { ls_view-tabname } for variant { mv_variant }| ).
        CONTINUE.
      ENDIF.

      LOOP AT lt_db INTO DATA(ls_db).
        DATA(ls_fcat) = CORRESPONDING ty_fcat( ls_db ).
        ls_fcat-temp_field_name = to_upper( lcl_mapper=>trim( ls_fcat-temp_field_name ) ).
        ls_fcat-view            = ls_view-view.
        ls_fcat-targets         = parse_targets( ls_fcat ).
        APPEND ls_fcat TO mt_fcat.
      ENDLOOP.
    ENDLOOP.

    IF mt_fcat IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING
          iv_text = |No field configuration found for variant { mv_variant } and the selected views|.
    ENDIF.
  ENDMETHOD.

  METHOD get_cond_rules.
    SELECT * FROM ztmm_cond_mand
      INTO TABLE @mt_cond
      WHERE mat_type     = @p_mtart
        AND ind_sec      = @p_indsec
        AND bus_prof     = @p_busprf
        AND variant_view = @mv_variant.

    LOOP AT mt_cond ASSIGNING FIELD-SYMBOL(<ls_cond>).
      <ls_cond>-source_field  = to_upper( lcl_mapper=>trim( <ls_cond>-source_field ) ).
      <ls_cond>-condmat_field = to_upper( lcl_mapper=>trim( <ls_cond>-condmat_field ) ).
    ENDLOOP.

    LOOP AT mt_fcat INTO DATA(ls_fcat) WHERE cond_mandatory = abap_true.
      IF NOT line_exists( mt_cond[ source_field = ls_fcat-temp_field_name ] ).
        mo_log->add( iv_type = 'W' iv_view = ls_fcat-view iv_field = ls_fcat-temp_field_name
                     iv_fdesc = ls_fcat-description
                     iv_text = 'Conditional mandatory, but no rule maintained in ZTMM_COND_MAND' ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD parse_targets.
    "BAPI_FIELD_NAME: target{,target}  target = [STRUCT-]FIELD{;QUAL=VALUE}
    DATA: lt_parts  TYPE string_table,
          lt_quals  TYPE string_table,
          lv_struct TYPE string,
          lv_comp   TYPE string.

    DATA(lv_def)     = to_upper( condense( val = CONV string( is_fcat-bapi_field_name )
                                           from = ` ` to = `` ) ).
    DATA(lv_def_str) = to_upper( lcl_mapper=>trim( is_fcat-bapi_struct_name ) ).

    IF ( is_fcat-mandatory = 'X' AND ( lv_def IS INITIAL OR lv_def_str IS INITIAL ) ).

      mo_log->add( iv_type = 'E'
                   iv_view = is_fcat-view
                   iv_field = is_fcat-temp_field_name
                   iv_fdesc = is_fcat-description
                   iv_text = 'No BAPI field/Structure maintained for mandatory field' ).
      RETURN.
    ENDIF.

    IF lv_def IS INITIAL.
      IF is_fcat-system_derived = abap_false.
*        mo_log->add( iv_type = 'W' iv_view = is_fcat-view iv_field = is_fcat-temp_field_name
*                     iv_fdesc = is_fcat-description
*                     iv_text = 'No BAPI field maintained - value is validated but not transferred' ).
      ENDIF.
      RETURN.
    ENDIF.

    SPLIT lv_def AT ',' INTO TABLE lt_parts.
    LOOP AT lt_parts INTO DATA(lv_part).
      SPLIT lv_part AT ';' INTO TABLE lt_quals.
      CHECK lt_quals IS NOT INITIAL.
      DATA(lv_tgt) = lt_quals[ 1 ].
      DELETE lt_quals INDEX 1.

      lv_struct = lv_def_str.
      lv_comp   = lv_tgt.
      IF lv_tgt CS '-'.
        SPLIT lv_tgt AT '-' INTO lv_struct lv_comp.
      ENDIF.

      DATA(ls_target) = VALUE ty_target( comp = lv_comp ).
      lcl_mapper=>resolve_param( EXPORTING iv_struct = lv_struct
                                 IMPORTING ev_param  = ls_target-param
                                           ev_table  = ls_target-table ).
      IF ls_target-param IS INITIAL.
        mo_log->add( iv_type = 'W' iv_view = is_fcat-view iv_field = is_fcat-temp_field_name
                     iv_fdesc = is_fcat-description
                     iv_text = |BAPI structure { lv_struct } not supported - target { lv_tgt } ignored| ).
        CONTINUE.
      ENDIF.

      LOOP AT lt_quals INTO DATA(lv_qual).
        SPLIT lv_qual AT '=' INTO DATA(lv_qkey) DATA(lv_qval).
        IF lv_qkey = 'LINE'.
          ls_target-linekey = lv_qval.
        ELSE.
          APPEND VALUE #( comp = lv_qkey value = lv_qval ) TO ls_target-fixed.
        ENDIF.
      ENDLOOP.

      IF lcl_mapper=>target_exists( ls_target ) = abap_false.
        mo_log->add( iv_type = 'W' iv_view = is_fcat-view iv_field = is_fcat-temp_field_name
                     iv_fdesc = is_fcat-description
                     iv_text = |Field { ls_target-param }-{ ls_target-comp } does not exist - target ignored| ).
        CONTINUE.
      ENDIF.
      APPEND ls_target TO rt_target.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_MATERIAL_BAPI - simulate / post
*======================================================================*
CLASS lcl_material_bapi IMPLEMENTATION.

  METHOD constructor.
    mo_log = io_log.
  ENDMETHOD.

  METHOD get_material_number.
    FIELD-SYMBOLS <lv_num> TYPE any.
    DATA: lt_number TYPE STANDARD TABLE OF bapimatinr,
          ls_return TYPE bapireturn1.

    "External number from template
    IF lcl_mapper=>is_dummy_key( is_row-matkey ) = abap_false.
      CALL FUNCTION 'CONVERSION_EXIT_MATN1_INPUT'
        EXPORTING
          input  = is_row-matkey
        IMPORTING
          output = rv_matnr
        EXCEPTIONS
          OTHERS = 1.
      IF sy-subrc <> 0.
        CLEAR rv_matnr.
        mo_log->add( iv_type = 'E' is_row = is_row iv_text = 'Invalid material number' ).
      ENDIF.
      RETURN.
    ENDIF.

    "Internal numbering (Create only)
    IF lcl_screen=>get_operation( ) <> gc_op-create.
      mo_log->add( iv_type = 'E' is_row = is_row iv_text = 'MATNR is required for Update / Extend' ).
      RETURN.
    ENDIF.
    IF p_test = abap_true AND lcl_mapper=>is_dummy_key( is_row-matkey ) = abap_true.
      rv_matnr = lcl_template=>get_temp_matnr( is_row ).
*      mo_log->add( iv_type = 'W' is_row = is_row
*                   iv_text = 'Simulation skipped - no MATNR (internal number is assigned at posting)' ).
*      RETURN.
*    ENDIF.
    ELSE.
      CALL FUNCTION 'BAPI_MATERIAL_GETINTNUMBER'
        EXPORTING
          material_type    = p_mtart
          industry_sector  = p_indsec
          required_numbers = 1
        IMPORTING
          return           = ls_return
        TABLES
          material_number  = lt_number.
      IF ls_return-type CA 'EA' OR lt_number IS INITIAL.
        mo_log->add( iv_type = 'E' is_row = is_row
                     iv_text = |Internal material number not assigned: { ls_return-message }| ).
        RETURN.
      ENDIF.

      READ TABLE lt_number INTO DATA(ls_number) INDEX 1.
      ASSIGN COMPONENT 'MATERIAL_LONG' OF STRUCTURE ls_number TO <lv_num>.   "S/4HANA
      IF sy-subrc <> 0 OR <lv_num> IS INITIAL.
        ASSIGN COMPONENT 'MATERIAL' OF STRUCTURE ls_number TO <lv_num>.
      ENDIF.
      rv_matnr = <lv_num>.
      mo_log->add( iv_type = 'S' is_row = is_row iv_matnr = rv_matnr
                   iv_text = |Internal material number { rv_matnr ALPHA = OUT } assigned| ).
    ENDIF.
  ENDMETHOD.

  METHOD get_reference.
    "Read reference material via BAPI_MATERIAL_GET_ALL - called dynamically
    "so that the report also activates on releases without this BAPI
    FIELD-SYMBOLS <ls_ga> TYPE any.
    DATA: lt_ptab   TYPE abap_func_parmbind_tab,
          lt_return TYPE STANDARD TABLE OF bapiret2,
          lr_mara   TYPE REF TO data,
          lr_marc   TYPE REF TO data,
          lr_mpop   TYPE REF TO data,
          lr_mpgd   TYPE REF TO data,
          lr_mbew   TYPE REF TO data,
          lr_mvke   TYPE REF TO data,
          lv_mat18  TYPE c LENGTH 18,
          lv_mat40  TYPE c LENGTH 40,
          lv_bwkey  TYPE bwkey.

    DATA(lv_key) = |{ iv_matnr }/{ iv_werks }/{ iv_vkorg }/{ iv_vtweg }|.
    READ TABLE mt_cache INTO DATA(ls_cache) WITH KEY key = lv_key.
    IF sy-subrc = 0.
      rs_ref = ls_cache-data.
      RETURN.
    ENDIF.

    TRY.
        CREATE DATA lr_mara TYPE ('BAPI_MARA_GA').
        CREATE DATA lr_marc TYPE ('BAPI_MARC_GA').
        CREATE DATA lr_mpop TYPE ('BAPI_MPOP_GA').
        CREATE DATA lr_mpgd TYPE ('BAPI_MPGD_GA').
        CREATE DATA lr_mbew TYPE ('BAPI_MBEW_GA').
        CREATE DATA lr_mvke TYPE ('BAPI_MVKE_GA').
      CATCH cx_sy_create_data_error.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = 'Reference copy not supported in this release (BAPI_MATERIAL_GET_ALL)'.
    ENDTRY.

    "S/4HANA: 40-char material number in MATERIAL_LONG
    cl_abap_typedescr=>describe_by_name( EXPORTING  p_name      = 'BAPIMATALL-MATERIAL_LONG'
                                         EXCEPTIONS type_not_found = 1
                                                    OTHERS         = 2 ).
    IF sy-subrc = 0.
      lv_mat40 = iv_matnr.
      INSERT VALUE #( name = 'MATERIAL_LONG' kind = abap_func_exporting value = REF #( lv_mat40 ) ) INTO TABLE lt_ptab.
    ELSE.
      lv_mat18 = iv_matnr.
      INSERT VALUE #( name = 'MATERIAL'      kind = abap_func_exporting value = REF #( lv_mat18 ) ) INTO TABLE lt_ptab.
    ENDIF.

    DATA(lv_werks) = iv_werks.
    DATA(lv_vkorg) = iv_vkorg.
    DATA(lv_vtweg) = iv_vtweg.
    lv_bwkey = iv_werks.
    IF lv_werks IS NOT INITIAL.
      INSERT VALUE #( name = 'PLANT'      kind = abap_func_exporting value = REF #( lv_werks ) ) INTO TABLE lt_ptab.
      INSERT VALUE #( name = 'VAL_AREA'   kind = abap_func_exporting value = REF #( lv_bwkey ) ) INTO TABLE lt_ptab.
    ENDIF.
    IF lv_vkorg IS NOT INITIAL.
      INSERT VALUE #( name = 'SALESORG'   kind = abap_func_exporting value = REF #( lv_vkorg ) ) INTO TABLE lt_ptab.
      INSERT VALUE #( name = 'DISTR_CHAN' kind = abap_func_exporting value = REF #( lv_vtweg ) ) INTO TABLE lt_ptab.
    ENDIF.
    INSERT VALUE #( name = 'CLIENTDATA'         kind = abap_func_importing value = lr_mara ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'PLANTDATA'          kind = abap_func_importing value = lr_marc ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'FORECASTPARAMETERS' kind = abap_func_importing value = lr_mpop ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'PLANNINGDATA'       kind = abap_func_importing value = lr_mpgd ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'VALUATIONDATA'      kind = abap_func_importing value = lr_mbew ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'SALESDATA'          kind = abap_func_importing value = lr_mvke ) INTO TABLE lt_ptab.
    INSERT VALUE #( name = 'RETURN'             kind = abap_func_tables    value = REF #( lt_return ) ) INTO TABLE lt_ptab.

    TRY.
        CALL FUNCTION 'BAPI_MATERIAL_GET_ALL' PARAMETER-TABLE lt_ptab.
      CATCH cx_sy_dyn_call_error INTO DATA(lx_dyn).
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING
            iv_text = |Reference material could not be read: { lx_dyn->get_text( ) }|.
    ENDTRY.

    LOOP AT lt_return INTO DATA(ls_ret) WHERE type CA 'EA'.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING
          iv_text = |Reference material { iv_matnr ALPHA = OUT }: { ls_ret-message }|.
    ENDLOOP.

    ASSIGN lr_mara->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-clientdata.
    ASSIGN lr_marc->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-plantdata.
    ASSIGN lr_mpop->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-forecastparameters.
    ASSIGN lr_mpgd->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-planningdata.
    ASSIGN lr_mbew->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-valuationdata.
    ASSIGN lr_mvke->* TO <ls_ga>. MOVE-CORRESPONDING <ls_ga> TO rs_ref-salesdata.

    APPEND VALUE #( key = lv_key data = rs_ref ) TO mt_cache.
  ENDMETHOD.

  METHOD save_material.
    "BAPI_MATERIAL_SAVEREPLICA - one call per material with all org. levels
    "Test run: TESTRUN = 'X' -> complete check without database update
    FIELD-SYMBOLS: <lv_param> TYPE any,
                   <lv_line>  TYPE any.
    DATA: ls_call   TYPE ty_call,
          ls_return TYPE bapiret2,
          lt_retmsg TYPE STANDARD TABLE OF bapie1ret2.

    ls_call = is_call.                          "TABLES parameters must be changeable
    DATA(ls_first) = VALUE ty_row( it_rows[ 1 ] OPTIONAL ).

    CALL FUNCTION 'BAPI_MATERIAL_SAVEREPLICA'
      EXPORTING
        noappllog            = abap_true
        nochangedoc          = abap_false
        testrun              = p_test
        inpfldcheck          = space
      IMPORTING
        return               = ls_return
      TABLES
*       headdata             = ls_call-headdata
*       clientdata           = ls_call-clientdata
*       clientdatax          = ls_call-clientdatax
*       plantdata            = ls_call-plantdata
*       plantdatax           = ls_call-plantdatax
*       forecastparameters   = ls_call-forecastparameters
*       forecastparametersx  = ls_call-forecastparametersx
*       planningdata         = ls_call-planningdata
*       planningdatax        = ls_call-planningdatax
*       storagelocationdata  = ls_call-storagelocationdata
*       storagelocationdatax = ls_call-storagelocationdatax
*       unitsofmeasure       = ls_call-unitsofmeasure
*       unitsofmeasurex      = ls_call-unitsofmeasurex
*       internationalartnos  = ls_call-internationalartnos
*       materiallongtext     = ls_call-materiallongtext
*       taxclassifications   = ls_call-taxclassifications
*       valuationdata        = ls_call-valuationdata
*       valuationdatax       = ls_call-valuationdatax
*       warehousenumberdata  = ls_call-warehousenumberdata
*       warehousenumberdatax = ls_call-warehousenumberdatax
*       salesdata            = ls_call-salesdata
*       salesdatax           = ls_call-salesdatax
*       storagetypedata      = ls_call-storagetypedata
*       storagetypedatax     = ls_call-storagetypedatax
*       materialdescription  = ls_call-materialdescription
*       returnmessages       = lt_retmsg.
        headdata             = ls_call-headdata
        clientdata           = ls_call-clientdata
        clientdatax          = ls_call-clientdatax
        plantdata            = ls_call-plantdata
        plantdatax           = ls_call-plantdatax
        forecastparameters   = ls_call-forecastparameters
        forecastparametersx  = ls_call-forecastparametersx
        planningdata         = ls_call-planningdata
        planningdatax        = ls_call-planningdatax
        storagelocationdata  = ls_call-storagelocationdata
        storagelocationdatax = ls_call-storagelocationdatax
        valuationdata        = ls_call-valuationdata
        valuationdatax       = ls_call-valuationdatax
        warehousenumberdata  = ls_call-warehousenumberdata
        warehousenumberdatax = ls_call-warehousenumberdatax
        salesdata            = ls_call-salesdata
        salesdatax           = ls_call-salesdatax
        storagetypedata      = ls_call-storagetypedata
        storagetypedatax     = ls_call-storagetypedatax
        materialdescription  = ls_call-materialdescription
        unitsofmeasure       = ls_call-unitsofmeasure
        unitsofmeasurex      = ls_call-unitsofmeasurex
        internationalartnos  = ls_call-internationalartnos
        materiallongtext     = ls_call-materiallongtext
        taxclassifications   = ls_call-taxclassifications
        prtdata              = ls_call-prtdata
        prtdatax             = ls_call-prtdatax
        extensionin          = ls_call-extensionin
        extensioninx         = ls_call-extensioninx
        forecastvalues       = ls_call-forecastvalues
        unplndconsumption    = ls_call-unplndconsumption
        totalconsumption     = ls_call-totalconsumption
        returnmessages       = lt_retmsg
        clientdatacwm        = ls_call-clientdatacwm
        clientdatacwmx       = ls_call-clientdatacwmx
        unitsofmeasurecwm    = ls_call-unitsofmeasurecwm
        unitsofmeasurecwmx   = ls_call-unitsofmeasurecwmx
        valuationdatacwm     = ls_call-valuationdatacwm
        valuationdatacwmx    = ls_call-valuationdatacwmx
        matplstadata         = ls_call-matplstadata
        matplstadatax        = ls_call-matplstadatax
        marc_aps_extdata     = ls_call-marc_aps_extdata
        marc_aps_extdatax    = ls_call-marc_aps_extdatax
        demand_penaltydata   = ls_call-demand_penaltydata
        demand_penaltydatax  = ls_call-demand_penaltydatax.

    rv_ok = COND #( WHEN ls_return-type CA 'EA' THEN abap_false ELSE abap_true ).

    LOOP AT lt_retmsg ASSIGNING FIELD-SYMBOL(<ls_rm>) WHERE type CA 'EAW'.
      "Template row of the BAPI line the message refers to (PARAMETER / ROW)
      DATA(ls_row) = ls_first.
      ASSIGN COMPONENT 'PARAMETER' OF STRUCTURE <ls_rm> TO <lv_param>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'ROW' OF STRUCTURE <ls_rm> TO <lv_line>.
        IF sy-subrc = 0.
          READ TABLE is_call-origin INTO DATA(ls_origin)
               WITH KEY param = to_upper( <lv_param> ) idx = <lv_line>.
          IF sy-subrc = 0.
            ls_row = VALUE #( it_rows[ row = ls_origin-row ] DEFAULT ls_first ).
          ENDIF.
        ENDIF.
      ENDIF.

      mo_log->add( iv_type  = COND #( WHEN <ls_rm>-type = 'W' THEN 'W' ELSE 'E' )
                   iv_text  = |[{ <ls_rm>-id }/{ <ls_rm>-number }] { <ls_rm>-message }|
                   is_row   = ls_row
                   iv_matnr = iv_matnr ).
      IF <ls_rm>-type CA 'EA'.
        rv_ok = abap_false.
      ENDIF.
    ENDLOOP.

    rv_ok = finish_luw(
      iv_ok    = rv_ok
      iv_what  = |Material ({ lines( is_call-plantdata ) } plant(s), | &&
                 |{ lines( is_call-salesdata ) } sales area(s), | &&
                 |{ lines( is_call-valuationdata ) } valuation area(s))|
      iv_msg   = COND string( WHEN ls_return-message IS INITIAL THEN `processed`
                              ELSE ls_return-message )
      is_row   = ls_first
      iv_matnr = iv_matnr ).
  ENDMETHOD.

  METHOD classify.
    DATA: lv_objkey TYPE bapi1003_key-object,
          lt_char   TYPE STANDARD TABLE OF bapi1003_alloc_values_char,
          lt_num    TYPE STANDARD TABLE OF bapi1003_alloc_values_num,
          lt_curr   TYPE STANDARD TABLE OF bapi1003_alloc_values_curr,
          lt_return TYPE STANDARD TABLE OF bapiret2.

    lv_objkey = iv_matnr.
    DATA(lv_class) = is_class-classkey-classnum.
    DATA(lv_ctype) = COND klassenart( WHEN is_class-classkey-classtype IS INITIAL
                                      THEN gc_def_classtype ELSE is_class-classkey-classtype ).

    "Existing assignment (+ current values, BAPI_OBJCL_CHANGE replaces all values)
    CALL FUNCTION 'BAPI_OBJCL_GETDETAIL'
      EXPORTING
        objectkey       = lv_objkey
        objecttable     = gc_objtab_mara
        classnum        = lv_class
        classtype       = lv_ctype
      TABLES
        allocvaluesnum  = lt_num
        allocvalueschar = lt_char
        allocvaluescurr = lt_curr
        return          = lt_return.
    DATA(lv_exists) = COND abap_bool( WHEN line_exists( lt_return[ type = 'E' ] )
                                      THEN abap_false ELSE abap_true ).

    "Template values overwrite existing values of the same characteristic
    LOOP AT is_class-allocvalueschar INTO DATA(ls_char).
      DELETE lt_char WHERE charact = ls_char-charact.
    ENDLOOP.
    APPEND LINES OF is_class-allocvalueschar TO lt_char.
    LOOP AT is_class-allocvaluesnum INTO DATA(ls_num).
      DELETE lt_num WHERE charact = ls_num-charact.
    ENDLOOP.
    APPEND LINES OF is_class-allocvaluesnum TO lt_num.
    LOOP AT is_class-allocvaluescurr INTO DATA(ls_curr).
      DELETE lt_curr WHERE charact = ls_curr-charact.
    ENDLOOP.
    APPEND LINES OF is_class-allocvaluescurr TO lt_curr.

    CLEAR lt_return.
    IF lv_exists = abap_true.
      CALL FUNCTION 'BAPI_OBJCL_CHANGE'
        EXPORTING
          objectkey          = lv_objkey
          objecttable        = gc_objtab_mara
          classnum           = lv_class
          classtype          = lv_ctype
          status             = '1'
        TABLES
          allocvaluesnumnew  = lt_num
          allocvaluescharnew = lt_char
          allocvaluescurrnew = lt_curr
          return             = lt_return.
    ELSE.
      CALL FUNCTION 'BAPI_OBJCL_CREATE'
        EXPORTING
          objectkeynew    = lv_objkey
          objecttablenew  = gc_objtab_mara
          classnumnew     = lv_class
          classtypenew    = lv_ctype
          status          = '1'
        TABLES
          allocvaluesnum  = lt_num
          allocvalueschar = lt_char
          allocvaluescurr = lt_curr
          return          = lt_return.
    ENDIF.

    rv_ok = abap_true.
    LOOP AT lt_return INTO DATA(ls_ret) WHERE type CA 'EAW'.
      mo_log->add( iv_type = COND #( WHEN ls_ret-type = 'W' THEN 'W' ELSE 'E' )
                   iv_text = |[{ ls_ret-id }/{ ls_ret-number }] { ls_ret-message }|
                   is_row = is_row iv_matnr = iv_matnr iv_view = gc_view-class ).
      IF ls_ret-type CA 'EA'.
        rv_ok = abap_false.
      ENDIF.
    ENDLOOP.

    rv_ok = finish_luw( iv_ok = rv_ok
                        iv_what = |Classification { lv_ctype }/{ lv_class }|
                        iv_msg = COND string( WHEN lv_exists = abap_true THEN `assignment changed`
                                              ELSE `assignment created` )
                        is_row = is_row iv_matnr = iv_matnr ).
  ENDMETHOD.

  METHOD finish_luw.
    "Test run: material BAPI ran with TESTRUN = 'X', classification is
    "undone by rollback - otherwise commit / rollback
    DATA ls_commit TYPE bapiret2.
    rv_ok = iv_ok.

    IF p_test = abap_true.
      CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
      CALL FUNCTION 'DEQUEUE_ALL'.
      mo_log->add( iv_type = COND #( WHEN rv_ok = abap_true THEN 'S' ELSE 'E' )
                   iv_text = |Simulation { COND string( WHEN rv_ok = abap_true THEN `OK` ELSE `failed` ) } | &&
                             |- { iv_what }: { iv_msg }|
                   is_row = is_row iv_matnr = iv_matnr ).
    ELSEIF rv_ok = abap_true.
      CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
        EXPORTING
          wait   = abap_true
        IMPORTING
          return = ls_commit.
      IF ls_commit-type CA 'EA'.
        rv_ok = abap_false.
        mo_log->add( iv_type = 'E' is_row = is_row iv_matnr = iv_matnr
                     iv_text = |Commit failed - { iv_what }: { ls_commit-message }| ).
      ELSE.
        mo_log->add( iv_type = 'S' is_row = is_row iv_matnr = iv_matnr
                     iv_text = |Posted - { iv_what }: { iv_msg }| ).
      ENDIF.
    ELSE.
      CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
      mo_log->add( iv_type = 'E' is_row = is_row iv_matnr = iv_matnr
                   iv_text = |Posting failed - { iv_what }: { iv_msg }| ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.


*INCLUDE zmm_material_maintenance_c03.
*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_C03
*&---------------------------------------------------------------------*
*& Class implementations - part 2
*&   lcl_output, lcl_template, lcl_screen, lcl_app
*& (part 1 in ZMM_MATERIAL_MAINTENANCE_C02)
*&---------------------------------------------------------------------*
*======================================================================*
* LCL_OUTPUT - ALV, file on application server, e-mail
*======================================================================*
CLASS lcl_output IMPLEMENTATION.

  METHOD constructor.
    mo_log = io_log.
  ENDMETHOD.

  METHOD publish.
    mt_out = mo_log->mt_msg.
    CHECK build_alv( ) = abap_true.

    DATA(lv_xlsx) = to_xlsx( ).
*    save_to_server( lv_xlsx ).
*    send_mail( lv_xlsx ).

    "messages of save / mail step
    mt_out = mo_log->mt_msg.
    IF sy-batch = abap_false.
      mo_alv->refresh( ).
      mo_alv->display( ).
    ENDIF.
  ENDMETHOD.

  METHOD build_alv.
    TRY.
        cl_salv_table=>factory( IMPORTING r_salv_table = mo_alv
                                CHANGING  t_table      = mt_out ).
        mo_alv->get_functions( )->set_all( abap_true ).
        mo_alv->get_display_settings( )->set_list_header( CONV lvc_title(
          |Material { SWITCH string( lcl_screen=>get_operation( )
                                    WHEN gc_op-create THEN `Create`
                                    WHEN gc_op-update THEN `Update`
                                    ELSE `Extend` ) } - | &&
          |{ COND string( WHEN p_test = abap_true THEN `Test run` ELSE `Update run` ) }| ) ).

        DATA(lo_cols) = mo_alv->get_columns( ).
        lo_cols->set_optimize( ).
        CAST cl_salv_column_table( lo_cols->get_column( 'ICON' ) )->set_icon( if_salv_c_bool_sap=>true ).
        lo_cols->get_column( 'ICON'  )->set_long_text( 'Status' ).
        lo_cols->get_column( 'MSGTY' )->set_long_text( 'Type' ).
        lo_cols->get_column( 'ROW'   )->set_long_text( 'Template Row' ).
        lo_cols->get_column( 'MATNR' )->set_long_text( 'Material' ).
        lo_cols->get_column( 'VIEW'  )->set_long_text( 'View' ).
        lo_cols->get_column( 'FIELD' )->set_long_text( 'Template Field' ).
        lo_cols->get_column( 'FDESC' )->set_long_text( 'Field Description' ).
        lo_cols->get_column( 'TEXT'  )->set_long_text( 'Message' ).
        rv_ok = abap_true.
      CATCH cx_salv_msg cx_salv_not_found.
        MESSAGE 'Error building the output ALV'(e10) TYPE 'I'.
    ENDTRY.
  ENDMETHOD.

  METHOD to_xlsx.
    TRY.
        rv_xdata = mo_alv->to_xml( xml_type = if_salv_bs_xml=>c_type_xlsx ).
      CATCH cx_root.
        CLEAR rv_xdata.
    ENDTRY.
  ENDMETHOD.

  METHOD file_name.
    rv_name = |MATMAINT_{ lcl_screen=>get_operation( ) }_{ sy-datum }_{ sy-uzeit }.xlsx|.
  ENDMETHOD.

  METHOD save_to_server.
    CHECK p_file3 IS NOT INITIAL AND iv_xdata IS NOT INITIAL.

    "P_FILE3 = directory (ending with / or \) or complete file name
    DATA(lv_file) = p_file3.
    DATA(lv_last) = substring( val = lv_file off = strlen( lv_file ) - 1 len = 1 ).
    IF lv_last = `/` OR lv_last = `\`.
      lv_file = lv_file && file_name( ).
    ELSEIF lcl_file_reader=>get_extension( lv_file ) <> 'xlsx'.
      lv_file = lv_file && `.xlsx`.
    ENDIF.

    TRY.
        OPEN DATASET lv_file FOR OUTPUT IN BINARY MODE.
        IF sy-subrc <> 0.
          mo_log->add( iv_type = 'W' iv_text = |Output file { lv_file } could not be opened| ).
          RETURN.
        ENDIF.
        TRANSFER iv_xdata TO lv_file.
        CLOSE DATASET lv_file.
        mo_log->add( iv_type = 'S' iv_text = |Output stored on application server: { lv_file }| ).
      CATCH cx_sy_file_open cx_sy_file_authority cx_sy_file_io INTO DATA(lx_file).
        mo_log->add( iv_type = 'W' iv_text = |Output file not written: { lx_file->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

  METHOD send_mail.
    DATA lt_body TYPE soli_tab.
    CHECK p_email IS NOT INITIAL.

    TRY.
        DATA(lo_send) = cl_bcs=>create_persistent( ).

        lt_body = VALUE #(
          ( line = |Material maintenance - { COND string( WHEN p_test = abap_true THEN `test run` ELSE `update run` ) }| )
          ( line = |Material type { p_mtart } / industry sector { p_indsec } / business profile { p_busprf }| )
          ( line = |Errors: { mo_log->count( 'E' ) }   Warnings: { mo_log->count( 'W' ) }   | &&
                   |Success: { mo_log->count( 'S' ) }| )
          ( line = `The detailed log is attached.` ) ).

        DATA(lo_doc) = cl_document_bcs=>create_document(
          i_type    = 'RAW'
          i_text    = lt_body
          i_subject = CONV so_obj_des( |Material maintenance log { sy-datum DATE = USER } { sy-uzeit TIME = USER }| ) ).

        IF iv_xdata IS NOT INITIAL.
          DATA(lv_name) = file_name( ).
          lo_doc->add_attachment(
            i_attachment_type    = 'BIN'
            i_attachment_subject = CONV so_obj_des( lv_name )
            i_attachment_size    = CONV so_obj_len( xstrlen( iv_xdata ) )
            i_att_content_hex    = cl_bcs_convert=>xstring_to_solix( iv_xdata )
            i_attachment_header  = VALUE soli_tab( ( line = |&SO_FILENAME={ lv_name }| ) ) ).
        ENDIF.

        lo_send->set_document( lo_doc ).
        lo_send->add_recipient( cl_cam_address_bcs=>create_internet_address( p_email ) ).
        lo_send->set_send_immediately( abap_true ).
        lo_send->send( ).
        COMMIT WORK.
        mo_log->add( iv_type = 'S' iv_text = |Output log sent to { p_email }| ).
      CATCH cx_bcs INTO DATA(lx_bcs).
        mo_log->add( iv_type = 'W' iv_text = |E-mail not sent: { lx_bcs->get_text( ) }| ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_TEMPLATE - upload template as .xlsx
*======================================================================*
CLASS lcl_template IMPLEMENTATION.

  METHOD template_columns.
    "Structure of the upload template (column order)
    DATA(lv_cols) =
      `ACTION MESSAGE PROCESS_PROFILE REFERENCE_MATNR REF_WERKS REF_VKORG REF_VTWEG REF_EKORG ` &&
      `DEFAULT_MODE COPY_BASIC COPY_PURCH COPY_MRP COPY_SALES COPY_ACCOUNTING ` &&
      `MATNR MTART MBRSH LGORT SPRAS MAKTX MEINS MATKL PRDHA EXTWG BRGEW NTGEW GEWEI VOLUM VOLEH ` &&
      `EAN11 NUMTP XCHPF IPRKZ MHDRZ MHDLP SERNP MTPOS_MARA SPART KZUMV LABOR LAENG BREIT HOEHE MEABM ` &&
      `CLASS_TYPE CLASS_NAME CHAR_NAME_1 CHAR_VALUE_1 CHAR_NAME_2 CHAR_VALUE_2 CHAR_NAME_3 CHAR_VALUE_3 ` &&
      `CHAR_NAME_4 CHAR_VALUE_4 CHAR_NAME_5 CHAR_VALUE_5 ` &&
      `VKORG VTWEG VMSTD MSTDV MTPOS KTGRM MVGR2 MVGR3 KONDM BONBA VRKME UMREZ UMREN VKGRU PROVG ` &&
      `TRAGR LADGR MTVFP AUTLF ANTLF AUMNG STAWN EXPME HERKL LOGGR CASNR MSTAV VALID_TO DWERK VERSG ` &&
      `MWST ZGST PRCTR ` &&
      `EKORG EKGRP PLIFZ BSTMI_P BSTMA_P BSTME_P INSMK KZKRI EINKZ UMLMC TAXIM AUTRU MFRPN MFRNR ` &&
      `WERKS DISMM DISPO DISLS BSTMA BSTFE MINBE EISBE MABST MTVFP_M FXHOR PERKZ BESKZ LGPRO LGFSB ` &&
      `FHORI DZEIT IPRKZ_M PRGRP PERIV SBDKZ KAUSF RGEKZ XCHAR2 RAUBE TEMPB MHDRZ2 MHDLP2 MAXLP ` &&
      `DISGR ABCIN BSTRF SHFLG SHZET STRGR VRMOD VINT1 VINT2 MTVFP2 CCFIX PRMOD ` &&
      `LGNUM LGTYP LGBKZ LTKZE LHMG1 LVSME LETY1 LTKZA ` &&
      `BWKEY BKLAS VPRSV STPRS VERPR BWTTY MLAST HKMAT ZKPRS ZKDAT ` &&
      `PO_TEXT PRODH_LVL1 PRODH_LVL2 PRODH_LVL3 PRODH_LVL4 PRODH_LVL5`.


    SPLIT lv_cols AT space INTO TABLE rt_cols.
    DELETE rt_cols WHERE table_line IS INITIAL.
  ENDMETHOD.

  METHOD get_temp_matnr.
    rv_matnr = |TEMPMATNR_{ is_row-row }|.
  ENDMETHOD.

  METHOD download.
    DATA: lt_fcat    TYPE tt_fcat,
          lt_cols    TYPE tt_col,
          lv_variant TYPE string,
          lv_file    TYPE string,
          lv_path    TYPE string,
          lv_full    TYPE string,
          lv_action  TYPE i.

    "Field flags of the active variant (only if type / sector / profile selected)
    IF p_mtart IS NOT INITIAL AND p_indsec IS NOT INITIAL AND p_busprf IS NOT INITIAL.
      DATA(lo_cfg) = NEW lcl_config( NEW lcl_log( ) ).
      TRY.
          lo_cfg->load( ).
          lt_fcat    = lo_cfg->mt_fcat.
          lv_variant = lo_cfg->mv_variant.
        CATCH lcx_error.
          CLEAR: lt_fcat, lv_variant.
      ENDTRY.
    ENDIF.

    "Columns = template structure + fields of the variant not yet contained
    DATA(lt_names) = template_columns( ).
    LOOP AT lt_fcat INTO DATA(ls_fcat).
      IF NOT line_exists( lt_names[ table_line = ls_fcat-temp_field_name ] ).
        APPEND ls_fcat-temp_field_name TO lt_names.
      ENDIF.
    ENDLOOP.

    "Header colour per column
    DATA(lt_ctrl) = lcl_config=>control_columns( ).
    LOOP AT lt_names INTO DATA(lv_name).
      APPEND VALUE #(
        field = lv_name
        style = COND #(
          WHEN line_exists( lt_ctrl[ table_line = lv_name ] )
            THEN c_style-control
          WHEN line_exists( lt_fcat[ temp_field_name = lv_name mandatory = abap_true ] )
            THEN c_style-mandatory
          WHEN line_exists( lt_fcat[ temp_field_name = lv_name cond_mandatory = abap_true ] )
            THEN c_style-cond
          WHEN line_exists( lt_fcat[ temp_field_name = lv_name system_derived = abap_true ] ) AND
               NOT line_exists( lt_fcat[ temp_field_name = lv_name optional = abap_true ] )
            THEN c_style-system
          ELSE c_style-header ) ) TO lt_cols.
    ENDLOOP.

    DATA(lv_xlsx) = build_xlsx( it_cols = lt_cols it_fcat = lt_fcat iv_variant = lv_variant ).

    cl_gui_frontend_services=>file_save_dialog(
      EXPORTING  default_file_name = |Material_Template{ COND string( WHEN lv_variant IS NOT INITIAL
                                                                     THEN |_{ lv_variant }| ) }.xlsx|
                 default_extension = 'xlsx'
                 file_filter       = 'Excel (*.xlsx)|*.xlsx'
      CHANGING   filename          = lv_file
                 path              = lv_path
                 fullpath          = lv_full
                 user_action       = lv_action
      EXCEPTIONS OTHERS            = 1 ).
    CHECK sy-subrc = 0 AND lv_action = cl_gui_frontend_services=>action_ok.

    DATA(lt_bin) = cl_bcs_convert=>xstring_to_solix( lv_xlsx ).
    cl_gui_frontend_services=>gui_download(
      EXPORTING  bin_filesize = xstrlen( lv_xlsx )
                 filename     = lv_full
                 filetype     = 'BIN'
      CHANGING   data_tab     = lt_bin
      EXCEPTIONS OTHERS       = 1 ).
    IF sy-subrc = 0.
      MESSAGE |Template downloaded to { lv_full }| TYPE 'S'.
    ELSE.
      MESSAGE 'Template could not be downloaded'(e11) TYPE 'S' DISPLAY LIKE 'E'.
    ENDIF.
  ENDMETHOD.

  METHOD build_xlsx.
    DATA(lo_zip) = NEW cl_abap_zip( ).

    lo_zip->add( name    = '[Content_Types].xml'
                 content = utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` &&
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` &&
      `<Default Extension="xml" ContentType="application/xml"/>` &&
      `<Override PartName="/xl/workbook.xml" ` &&
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` &&
      `<Override PartName="/xl/worksheets/sheet1.xml" ` &&
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` &&
      `<Override PartName="/xl/worksheets/sheet2.xml" ` &&
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` &&
      `<Override PartName="/xl/styles.xml" ` &&
      `ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` &&
      `</Types>` ) ).

    lo_zip->add( name    = '_rels/.rels'
                 content = utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` &&
      `<Relationship Id="rId1" ` &&
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" ` &&
      `Target="xl/workbook.xml"/>` &&
      `</Relationships>` ) ).

    lo_zip->add( name    = 'xl/workbook.xml'
                 content = utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` &&
      `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` &&
      `<sheets><sheet name="TEMPLATE" sheetId="1" r:id="rId1"/>` &&
      `<sheet name="FIELD_INFO" sheetId="2" r:id="rId2"/></sheets>` &&
      `</workbook>` ) ).

    lo_zip->add( name    = 'xl/_rels/workbook.xml.rels'
                 content = utf8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` &&
      `<Relationship Id="rId1" ` &&
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` &&
      `Target="worksheets/sheet1.xml"/>` &&
      `<Relationship Id="rId2" ` &&
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" ` &&
      `Target="worksheets/sheet2.xml"/>` &&
      `<Relationship Id="rId3" ` &&
      `Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" ` &&
      `Target="styles.xml"/>` &&
      `</Relationships>` ) ).

    lo_zip->add( name = 'xl/styles.xml'            content = utf8( styles( ) ) ).
    lo_zip->add( name = 'xl/worksheets/sheet1.xml' content = utf8( sheet_template( it_cols ) ) ).
    lo_zip->add( name = 'xl/worksheets/sheet2.xml' content = utf8( sheet_info( it_fcat    = it_fcat
                                                                               iv_variant = iv_variant ) ) ).
    rv_xlsx = lo_zip->save( ).
  ENDMETHOD.

  METHOD sheet_template.
    "Sheet 1 = upload template: row 1 technical field names, data from row 2
    DATA lv_cells TYPE string.

    LOOP AT it_cols INTO DATA(ls_col).
      DATA(lv_idx) = sy-tabix.
      lv_cells = lv_cells && cell( iv_col = lv_idx iv_row = 1 iv_value = ls_col-field iv_style = ls_col-style ).
    ENDLOOP.

    rv_xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` &&
      `<sheetViews><sheetView workbookViewId="0">` &&
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` &&
      `</sheetView></sheetViews>` &&
      |<cols><col min="1" max="{ lines( it_cols ) }" width="18" style="{ c_style-text }" customWidth="1"/></cols>| &&
      |<sheetData><row r="1">{ lv_cells }</row></sheetData>| &&
      `</worksheet>`.
  ENDMETHOD.

  METHOD sheet_info.
    "Sheet 2 = instructions, colour legend and field list of the variant
    TYPES: BEGIN OF lty_line,
             style  TYPE i,
             values TYPE string_table,
           END OF lty_line.
    DATA: lt_lines TYPE STANDARD TABLE OF lty_line WITH EMPTY KEY,
          lv_rows  TYPE string,
          lv_cells TYPE string.

    APPEND VALUE #( style  = c_style-bold
                    values = VALUE #( ( COND string( WHEN iv_variant IS INITIAL
                                                     THEN `Material upload template`
                                                     ELSE |Material upload template - variant { iv_variant }| ) ) ) )
      TO lt_lines.
    APPEND VALUE #( values = VALUE #(
      ( `Fill sheet TEMPLATE from row 2. Do not change row 1 (technical field names) - only the first worksheet is read.` ) ) )
      TO lt_lines.
    APPEND VALUE #( values = VALUE #(
      ( `One row per material and org. level (plant / sales area / valuation area). Save as .xlsx or .csv.` ) ) )
      TO lt_lines.
    APPEND INITIAL LINE TO lt_lines.
    APPEND VALUE #( style = c_style-bold      values = VALUE #( ( `Header colour` ) ( `Meaning` ) ) ) TO lt_lines.
    APPEND VALUE #( style = c_style-control   values = VALUE #( ( `Green` )  ( `Control column (action, reference copy)` ) ) ) TO lt_lines.
    APPEND VALUE #( style = c_style-mandatory values = VALUE #( ( `Red` )    ( `Mandatory for the variant` ) ) ) TO lt_lines.
    APPEND VALUE #( style = c_style-cond      values = VALUE #( ( `Orange` ) ( `Conditional mandatory (rules in ZTMM_COND_MAND)` ) ) ) TO lt_lines.
    APPEND VALUE #( style = c_style-system    values = VALUE #( ( `Grey` )   ( `System derived - value is not used` ) ) ) TO lt_lines.
    APPEND VALUE #( style = c_style-header    values = VALUE #( ( `Blue` )   ( `Optional / not maintained for the variant` ) ) ) TO lt_lines.
    APPEND INITIAL LINE TO lt_lines.

    IF it_fcat IS INITIAL.
      APPEND VALUE #( values = VALUE #(
        ( `Select material type, industry sector and business profile before downloading ` &&
          `to get the field flags of the active variant.` ) ) ) TO lt_lines.
    ELSE.
      APPEND VALUE #( style  = c_style-bold
                      values = VALUE #( ( `Field` ) ( `Description` ) ( `View` ) ( `Flag` ) ( `BAPI target` ) ) )
        TO lt_lines.
      LOOP AT it_fcat INTO DATA(ls_fcat).
        APPEND VALUE #(
          style  = c_style-text
          values = VALUE #(
            ( CONV string( ls_fcat-temp_field_name ) )
            ( CONV string( ls_fcat-description ) )
            ( CONV string( ls_fcat-view ) )
            ( COND string( WHEN ls_fcat-mandatory      = abap_true THEN `Mandatory`
                           WHEN ls_fcat-cond_mandatory = abap_true THEN `Conditional mandatory`
                           WHEN ls_fcat-optional       = abap_true THEN `Optional`
                           WHEN ls_fcat-system_derived = abap_true THEN `System derived`
                           ELSE `Optional` ) )
            ( condense( |{ ls_fcat-bapi_struct_name } { ls_fcat-bapi_field_name }| ) ) ) )
          TO lt_lines.
      ENDLOOP.
    ENDIF.

    LOOP AT lt_lines INTO DATA(ls_line).
      DATA(lv_row) = sy-tabix.
      CLEAR lv_cells.
      LOOP AT ls_line-values INTO DATA(lv_value).
        DATA(lv_col) = sy-tabix.
        lv_cells = lv_cells && cell( iv_col = lv_col iv_row = lv_row iv_value = lv_value iv_style = ls_line-style ).
      ENDLOOP.
      lv_rows = lv_rows && |<row r="{ lv_row }">{ lv_cells }</row>|.
    ENDLOOP.

    rv_xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` &&
      `<cols><col min="1" max="1" width="22" customWidth="1"/>` &&
      `<col min="2" max="2" width="55" customWidth="1"/>` &&
      `<col min="3" max="5" width="24" customWidth="1"/></cols>` &&
      |<sheetData>{ lv_rows }</sheetData>| &&
      `</worksheet>`.
  ENDMETHOD.

  METHOD styles.
    "Fonts: 0 Arial, 1 Arial bold white, 2 Arial bold
    "Fills: 2 blue, 3 red, 4 orange, 5 grey, 6 green
    "cellXfs: see C_STYLE
    rv_xml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` &&
      `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` &&
      `<fonts count="3">` &&
      `<font><sz val="10"/><name val="Arial"/></font>` &&
      `<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Arial"/></font>` &&
      `<font><b/><sz val="10"/><name val="Arial"/></font>` &&
      `</fonts>` &&
      `<fills count="7">` &&
      `<fill><patternFill patternType="none"/></fill>` &&
      `<fill><patternFill patternType="gray125"/></fill>` &&
      `<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>` &&
      `<fill><patternFill patternType="solid"><fgColor rgb="FFC00000"/><bgColor indexed="64"/></patternFill></fill>` &&
      `<fill><patternFill patternType="solid"><fgColor rgb="FFED7D31"/><bgColor indexed="64"/></patternFill></fill>` &&
      `<fill><patternFill patternType="solid"><fgColor rgb="FF7F7F7F"/><bgColor indexed="64"/></patternFill></fill>` &&
      `<fill><patternFill patternType="solid"><fgColor rgb="FF548235"/><bgColor indexed="64"/></patternFill></fill>` &&
      `</fills>` &&
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` &&
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` &&
      `<cellXfs count="8">` &&
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` &&
      `<xf numFmtId="49" fontId="1" fillId="2" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` &&
      `<xf numFmtId="49" fontId="1" fillId="3" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` &&
      `<xf numFmtId="49" fontId="1" fillId="4" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` &&
      `<xf numFmtId="49" fontId="1" fillId="5" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` &&
      `<xf numFmtId="49" fontId="1" fillId="6" borderId="0" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1"/>` &&
      `<xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>` &&
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` &&
      `</cellXfs>` &&
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` &&
      `</styleSheet>`.
  ENDMETHOD.

  METHOD cell.
    rv_xml = |<c r="{ col_letter( iv_col ) }{ iv_row }" t="inlineStr" s="{ iv_style }">| &&
             |<is><t xml:space="preserve">| &&
             escape( val = CONV string( iv_value ) format = cl_abap_format=>e_xml_text ) &&
             |</t></is></c>|.
  ENDMETHOD.

  METHOD col_letter.
    "1 -> A, 26 -> Z, 27 -> AA ...
    DATA(lv_n) = iv_col.
    WHILE lv_n > 0.
      DATA(lv_m) = ( lv_n - 1 ) MOD 26.
      rv_col = substring( val = sy-abcde off = lv_m len = 1 ) && rv_col.
      lv_n = ( lv_n - 1 ) DIV 26.
    ENDWHILE.
  ENDMETHOD.

  METHOD utf8.
    rv_x = cl_abap_codepage=>convert_to( iv_xml ).
  ENDMETHOD.

ENDCLASS.

*======================================================================*
* LCL_SCREEN - selection screen
*======================================================================*
CLASS lcl_screen IMPLEMENTATION.

  METHOD initialization.
    p_btn = 'Download Template'(b01).
  ENDMETHOD.

  METHOD get_operation.
    rv_opid = COND #( WHEN r_create = abap_true THEN gc_op-create
                      WHEN r_update = abap_true THEN gc_op-update
                      ELSE                           gc_op-extend ).
  ENDMETHOD.

  METHOD pbo.
    LOOP AT SCREEN.
      CASE screen-group1.
        WHEN 'MD1'.
          screen-input = COND #( WHEN r_local = abap_true THEN '1' ELSE '0' ).
        WHEN 'MD2'.
          screen-input = COND #( WHEN r_unix  = abap_true THEN '1' ELSE '0' ).
      ENDCASE.
      MODIFY SCREEN.
    ENDLOOP.
    set_listboxes( ).
  ENDMETHOD.

  METHOD set_listboxes.
    "Only values allowed in ZTMM_MATMAS_MAST for the selected action
    DATA: lt_vrm    TYPE vrm_values,
          lt_mtart  TYPE STANDARD TABLE OF mtart         WITH EMPTY KEY,
          lt_indsec TYPE STANDARD TABLE OF z_de_ind_sec  WITH EMPTY KEY,
          lt_busprf TYPE STANDARD TABLE OF z_de_bus_prof WITH EMPTY KEY,
          lr_mtart  TYPE RANGE OF mtart,
          lr_indsec TYPE RANGE OF z_de_ind_sec.

    DATA(lv_opid) = get_operation( ).

    "--- Material type
    SELECT DISTINCT mat_type FROM ztmm_matmas_mast
      INTO TABLE @lt_mtart
      WHERE operation_id = @lv_opid
        AND active_flag  = @abap_true
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = '00000000' ).
    IF lt_mtart IS NOT INITIAL.
      SELECT mtart, mtbez FROM t134t
        INTO TABLE @DATA(lt_t134t)
        FOR ALL ENTRIES IN @lt_mtart
        WHERE spras = @sy-langu AND mtart = @lt_mtart-table_line.
    ENDIF.
    lt_vrm = VALUE #( FOR lv_mtart IN lt_mtart
                      ( key  = lv_mtart
                        text = VALUE #( lt_t134t[ mtart = lv_mtart ]-mtbez OPTIONAL ) ) ).
    CALL FUNCTION 'VRM_SET_VALUES' EXPORTING id = 'P_MTART' values = lt_vrm EXCEPTIONS OTHERS = 0.
    IF p_mtart IS NOT INITIAL AND NOT line_exists( lt_mtart[ table_line = p_mtart ] ).
      CLEAR p_mtart.
    ENDIF.

    "--- Industry sector (for material type)
    IF p_mtart IS NOT INITIAL.
      lr_mtart = VALUE #( ( sign = 'I' option = 'EQ' low = p_mtart ) ).
    ENDIF.
    SELECT DISTINCT ind_sec FROM ztmm_matmas_mast
      INTO TABLE @lt_indsec
      WHERE operation_id = @lv_opid
        AND active_flag  = @abap_true
        AND mat_type    IN @lr_mtart
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = '00000000' ).
    IF lt_indsec IS NOT INITIAL.
      SELECT mbrsh, mbbez FROM t137t
        INTO TABLE @DATA(lt_t137t)
        FOR ALL ENTRIES IN @lt_indsec
        WHERE spras = @sy-langu AND mbrsh = @lt_indsec-table_line.
    ENDIF.
    lt_vrm = VALUE #( FOR lv_ind IN lt_indsec
                      ( key  = lv_ind
                        text = VALUE #( lt_t137t[ mbrsh = lv_ind ]-mbbez OPTIONAL ) ) ).
    CALL FUNCTION 'VRM_SET_VALUES' EXPORTING id = 'P_INDSEC' values = lt_vrm EXCEPTIONS OTHERS = 0.
    IF p_indsec IS NOT INITIAL AND NOT line_exists( lt_indsec[ table_line = p_indsec ] ).
      CLEAR p_indsec.
    ENDIF.

    "--- Business profile (for material type + industry sector)
    IF p_indsec IS NOT INITIAL.
      lr_indsec = VALUE #( ( sign = 'I' option = 'EQ' low = p_indsec ) ).
    ENDIF.
    SELECT DISTINCT bus_prof FROM ztmm_matmas_mast
      INTO TABLE @lt_busprf
      WHERE operation_id = @lv_opid
        AND active_flag  = @abap_true
        AND mat_type    IN @lr_mtart
        AND ind_sec     IN @lr_indsec
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = '00000000' ).
    lt_vrm = VALUE #( FOR lv_bp IN lt_busprf ( key = lv_bp text = lv_bp ) ).
    CALL FUNCTION 'VRM_SET_VALUES' EXPORTING id = 'P_BUSPRF' values = lt_vrm EXCEPTIONS OTHERS = 0.
    IF p_busprf IS NOT INITIAL AND NOT line_exists( lt_busprf[ table_line = p_busprf ] ).
      CLEAR p_busprf.
    ENDIF.
  ENDMETHOD.

  METHOD pai.
    CASE sscrfields-ucomm.
      WHEN 'BTN_CLK'.
        download_template( ).
      WHEN 'ONLI' OR 'SJOB' OR 'PRIN'.
        check_input( ).
    ENDCASE.
  ENDMETHOD.

  METHOD check_input.
    IF p_mtart IS INITIAL OR p_indsec IS INITIAL OR p_busprf IS INITIAL.
      MESSAGE 'Select material type, industry sector and business profile'(e01) TYPE 'E'.
    ENDIF.
    IF p_class IS INITIAL AND p_sales IS INITIAL AND p_purch  IS INITIAL AND
       p_mrp IS INITIAL AND p_plntst IS INITIAL AND p_val IS INITIAL AND p_class IS INITIAL.
      MESSAGE 'Select at least one view'(e02) TYPE 'E'.
    ENDIF.
    DATA(lv_file) = COND string( WHEN r_local = abap_true THEN p_file1 ELSE p_file2 ).
    IF lv_file IS INITIAL.
      MESSAGE 'Enter the template file path'(e03) TYPE 'E'.
    ENDIF.
    DATA(lv_ext) = lcl_file_reader=>get_extension( lv_file ).
    IF lv_ext <> 'xlsx' AND lv_ext <> 'csv'.
      MESSAGE 'Only .xlsx and .csv files are allowed'(e04) TYPE 'E'.
    ENDIF.
  ENDMETHOD.

  METHOD f4_local_file.
    DATA: lt_files TYPE filetable,
          lv_rc    TYPE i.
    cl_gui_frontend_services=>file_open_dialog(
      EXPORTING  file_filter = 'Excel (*.xlsx)|*.xlsx|CSV (*.csv)|*.csv'
      CHANGING   file_table  = lt_files
                 rc          = lv_rc
      EXCEPTIONS OTHERS      = 1 ).
    IF sy-subrc = 0 AND lv_rc > 0.
      cv_file = lt_files[ 1 ]-filename.
    ENDIF.
  ENDMETHOD.

  METHOD download_template.



    "Upload template (.xlsx) as reference for the user

*    lcl_template=>download( ).


    TYPES:
      BEGIN OF ty_template_result,
        operation_code TYPE char1,
        object_id      TYPE wwwdatatab-objid,
        file_name      TYPE string,
        mime_type      TYPE string,
        content        TYPE xstring,
      END OF ty_template_result.

    DATA: ls_result TYPE ty_template_result.

    DATA lv_object_id TYPE wwwdatatab-objid.
    DATA(lv_operation) = lcl_screen=>get_operation( ).

    CASE lv_operation.
      WHEN 'C'.
        lv_object_id = 'ZMMCREATE_CRT_XLSX'.
        ls_result-file_name = 'ZMMCREATE_Create_Template.xlsx'.
      WHEN 'U'.
        lv_object_id = 'ZMMCREATE_UPD_XLSX'.
        ls_result-file_name = 'ZMMCREATE_Update_Template.xlsx'.
      WHEN 'E'.
        lv_object_id = 'ZMMCREATE_EXT_XLSX'.
        ls_result-file_name = 'ZMMCREATE_Extend_Template.xlsx'.
    ENDCASE.

    ls_result-operation_code = lv_operation.
    ls_result-object_id      = lv_object_id.
    ls_result-mime_type      =
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'.
*    ls_result-content = read_smw0_binary( lv_object_id ).


    DATA(lv_result) = download_from_smw0(
     iv_objid  = lv_object_id
     iv_target = '' ).


  ENDMETHOD.

  METHOD download_from_smw0.
    DATA: ls_key      TYPE wwwdatatab,
          lt_mime     TYPE STANDARD TABLE OF w3mime,
          lt_params   TYPE STANDARD TABLE OF wwwparams,
          lv_filesize TYPE i,
          lv_ext      TYPE string,
          lv_name     TYPE string,
          lv_path     TYPE string,
          lv_fullpath TYPE string,
          lv_target   TYPE string.
    rv_ok = abap_false.
    " 1. Read the object header (must exist as binary object, relid = 'MI')
    SELECT SINGLE * FROM wwwdata INTO CORRESPONDING FIELDS OF ls_key
      WHERE srtf2 = 0
        AND relid = 'MI'
        AND objid = iv_objid.
    IF sy-subrc <> 0.
      MESSAGE |SMW0 object { iv_objid } not found| TYPE 'S' DISPLAY LIKE 'E'.
      RETURN.
    ENDIF.

    " 2. Get file size and extension from the object's parameters
    CALL FUNCTION 'WWWPARAMS_READ_ALL'
      EXPORTING
        TYPE  = ls_key-relid
        objid  = ls_key-objid
      TABLES
        params = lt_params
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc = 0.
      LOOP AT lt_params ASSIGNING FIELD-SYMBOL(<ls_p>).
        CASE <ls_p>-name.
          WHEN 'filesize'.      lv_filesize = <ls_p>-value.
          WHEN 'fileextension'. lv_ext      = <ls_p>-value.
        ENDCASE.
      ENDLOOP.
    ENDIF.
    " 3. Import binary content
    CALL FUNCTION 'WWWDATA_IMPORT'
      EXPORTING
        key               = ls_key
      TABLES
        mime              = lt_mime
      EXCEPTIONS
        wrong_object_type = 1
        import_error      = 2
        OTHERS            = 3.
    IF sy-subrc <> 0.
      MESSAGE |Import of { iv_objid } failed| TYPE 'S' DISPLAY LIKE 'E'.
      RETURN.
    ENDIF.
    " 4. Determine target path
    lv_target = iv_target.
    IF lv_target IS INITIAL.
      cl_gui_frontend_services=>file_save_dialog(
        EXPORTING
          default_file_name = |{ iv_objid }{ lv_ext }|
          default_extension = lv_ext
        CHANGING
          filename          = lv_name
          path              = lv_path
          fullpath          = lv_fullpath
        EXCEPTIONS
          OTHERS            = 1 ).
      IF sy-subrc <> 0 OR lv_fullpath IS INITIAL.
        RETURN.
      ENDIF.
      lv_target = lv_fullpath.
    ENDIF.
    " 5. Download to frontend
    cl_gui_frontend_services=>gui_download(
      EXPORTING
        bin_filesize = lv_filesize
        filename     = lv_target
        filetype     = 'BIN'
      CHANGING
        data_tab     = lt_mime
      EXCEPTIONS
        OTHERS       = 1 ).
    IF sy-subrc <> 0.
      MESSAGE |Download to { lv_target } failed| TYPE 'S' DISPLAY LIKE 'E'.
      RETURN.
    ENDIF.
    rv_ok = abap_true.
    MESSAGE |File downloaded to { lv_target }| TYPE 'S'.
  ENDMETHOD.

*  METHOD read_smw0_binary.
*    DATA ls_key  TYPE wwwdatatab.
*    DATA lt_mime TYPE STANDARD TABLE OF w3mime.
*
*    ls_key-relid = 'MI'.
*    ls_key-objid = iv_object_id.
*
*    CALL FUNCTION 'WWWDATA_IMPORT'
*      EXPORTING
*        key               = ls_key
*      TABLES
*        mime              = lt_mime
*      EXCEPTIONS
*        wrong_object_type = 1
*        import_error      = 2
*        OTHERS            = 3.
*
*    IF sy-subrc <> 0 OR lt_mime IS INITIAL.
*      RAISE EXCEPTION TYPE zcx_mm_template_error
*        EXPORTING
*          textid    = zcx_mm_template_error=>object_not_found
*          object_id = iv_object_id.
*    ENDIF.
*
*    rv_content = zcl_mm_binary_helper=>w3mime_to_xstring( lt_mime ).
*  ENDMETHOD.


ENDCLASS.

*======================================================================*
* LCL_APP - controller
*======================================================================*
CLASS lcl_app IMPLEMENTATION.

  METHOD constructor.
    mo_log    = NEW #( ).
    mo_config = NEW #( mo_log ).
    mo_bapi   = NEW #( mo_log ).
  ENDMETHOD.

  METHOD run.
    TRY.
        mo_config->load( ).          "5.2 variant, 5.3/5.4 view tables
        load_template( ).            "5.1 read template
        derive_values( ).
        check_columns( ).
        validate_and_map( ).         "5.5 validation + mapping to BAPI
      CATCH lcx_error INTO DATA(lx_error).
        mo_log->add( iv_type = 'E' iv_text = lx_error->get_text( ) ).
    ENDTRY.

    DATA(lv_err) = mo_log->count( 'E' ).
*    mo_log->add( iv_type = COND #( WHEN lv_err > 0 THEN 'W' ELSE 'S' )
*                 iv_text = |Validation finished: { lines( mt_row ) } row(s), { lv_err } error(s), | &&
*                           |{ mo_log->count( 'W' ) } warning(s)| ).

    IF mo_log->has_global_error( ) = abap_true.
      mo_log->add( iv_type = 'E'
                   iv_text = |{ COND string( WHEN p_test = abap_true THEN `Simulation` ELSE `Posting` ) } | &&
                             |not executed - correct the errors first| ).
    ELSE.
      process_materials( ).        "simulate / post
    ENDIF.

    NEW lcl_output( mo_log )->publish( ).
  ENDMETHOD.

*----------------------------------------------------------------------*
* 5.1 - template
*----------------------------------------------------------------------*
  METHOD load_template.
    DATA lv_has_data TYPE abap_bool.

    DATA(lv_file) = COND string( WHEN r_local = abap_true THEN p_file1 ELSE p_file2 ).
    DATA(lt_raw)  = lcl_file_reader=>read( iv_file = lv_file iv_server = r_unix ).

    "Header row: column index -> technical field name
    DATA(lt_hdr) = lt_raw[ gc_hdr_row ].
    LOOP AT lt_hdr INTO DATA(lv_hdr).
      DATA(lv_field) = CONV fieldname( to_upper( lcl_mapper=>trim( lv_hdr ) ) ).
      IF lv_field IS NOT INITIAL AND line_exists( mt_header[ table_line = lv_field ] ).
        mo_log->add( iv_type = 'W' iv_field = lv_field iv_text = 'Duplicate column - first occurrence used' ).
        CLEAR lv_field.
      ENDIF.
      APPEND lv_field TO mt_header.
    ENDLOOP.

    CLEAR: lv_field.
    IF line_exists( mt_header[ table_line = 'MEINS' ] ).
      IF NOT line_exists( mt_header[ table_line = 'MEINH' ] )  .
        lv_field = CONV fieldname( 'MEINH' ).
        APPEND lv_field TO mt_header.
      ENDIF.
      IF NOT line_exists( mt_header[ table_line = 'UMREZ' ] )  .
        lv_field = CONV fieldname( 'UMREZ' ).
        APPEND lv_field TO mt_header.
      ENDIF.
      IF NOT line_exists( mt_header[ table_line = 'UMREN' ] )  .
        lv_field = CONV fieldname( 'UMREN' ).
        APPEND lv_field TO mt_header.
      ENDIF.
    ENDIF.

    "Data rows: keep non-empty cells only
    LOOP AT lt_raw INTO DATA(lt_values) FROM gc_data_row.
      DATA(lv_row) = sy-tabix.                            "= row number in the file
      lv_has_data = abap_false.

      LOOP AT lt_values INTO DATA(lv_raw).
        DATA(lv_col) = sy-tabix.
        DATA(lv_colname) = VALUE fieldname( mt_header[ lv_col ] OPTIONAL ).
        CHECK lv_colname IS NOT INITIAL AND lv_colname <> gc_col-message.
        DATA(lv_value) = lcl_mapper=>trim( lv_raw ).
        CHECK lv_value IS NOT INITIAL.
        INSERT VALUE #( row = lv_row field = lv_colname value = lv_value ) INTO TABLE mt_cell.
        IF lv_colname = 'MEINS' AND lv_value IS NOT INITIAL.
          INSERT VALUE #( row = lv_row field = 'MEINH' value = lv_value ) INTO TABLE mt_cell.
          INSERT VALUE #( row = lv_row field = 'UMREN' value = '1' ) INTO TABLE mt_cell.
          INSERT VALUE #( row = lv_row field = 'UMREZ' value = '1' ) INTO TABLE mt_cell.
        ENDIF.
        lv_has_data = abap_true.
      ENDLOOP.


      CHECK lv_has_data = abap_true.                      "skip empty lines
      DATA(lv_matnr) = to_upper( get_value( iv_row = lv_row iv_field = gc_col-matnr ) ).
      APPEND VALUE #( row    = lv_row
                      matkey = COND #( WHEN lv_matnr IS INITIAL THEN |#{ lv_row }| ELSE lv_matnr )
                      werks  = to_upper( get_value( iv_row = lv_row iv_field = gc_col-werks ) )
                      vkorg  = to_upper( get_value( iv_row = lv_row iv_field = gc_col-vkorg ) )
                      vtweg  = to_upper( get_value( iv_row = lv_row iv_field = gc_col-vtweg ) ) )
        TO mt_row.
    ENDLOOP.

    IF mt_row IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = 'Template contains no data rows'.
    ENDIF.
    mo_log->add( iv_type = 'S' iv_text = |Template { lv_file }: { lines( mt_row ) } data row(s) read| ).
  ENDMETHOD.

  METHOD derive_values.
    "PRDHA derived from PRODH_LVL1..n if not given directly
    DATA lv_prdha TYPE string.
    LOOP AT mt_row INTO DATA(ls_row).
      CHECK NOT line_exists( mt_cell[ row = ls_row-row field = gc_col-prdha ] ).
      CLEAR lv_prdha.
      DO gc_prodh_levels TIMES.
        lv_prdha = lv_prdha && get_value( iv_row   = ls_row-row
                                          iv_field = CONV #( |PRODH_LVL{ sy-index }| ) ).
      ENDDO.
      CHECK lv_prdha IS NOT INITIAL.
      INSERT VALUE #( row = ls_row-row field = gc_col-prdha value = lv_prdha ) INTO TABLE mt_cell.
      mo_log->add( iv_type = 'S' is_row = ls_row iv_field = gc_col-prdha
                   iv_text = |Product hierarchy { lv_prdha } derived from PRODH_LVL1-{ gc_prodh_levels }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD check_columns.
    DATA(lt_ctrl) = lcl_config=>control_columns( ).

    "Columns not maintained in any selected view table
*    LOOP AT mt_header INTO DATA(lv_col) WHERE table_line IS NOT INITIAL.
*      CHECK NOT line_exists( lt_ctrl[ table_line = lv_col ] ).
*      CHECK NOT line_exists( mo_config->mt_fcat[ KEY k_field COMPONENTS temp_field_name = lv_col ] ).
*      CHECK lv_col NP 'PRODH_LVL*'.
*      mo_log->add( iv_type = 'W' iv_field = lv_col
*                   iv_text = 'Column not maintained in the view tables of the selected views - ignored' ).
*    ENDLOOP.

    "Mandatory fields that are no column of the template
    LOOP AT mo_config->mt_fcat INTO DATA(ls_fcat) WHERE mandatory = abap_true.
      CHECK NOT line_exists( mt_header[ table_line = ls_fcat-temp_field_name ] ).
      mo_log->add( iv_type = 'E' iv_view = ls_fcat-view iv_field = ls_fcat-temp_field_name
                   iv_fdesc = ls_fcat-description
                   iv_text = 'Mandatory field is not a column of the template' ).
    ENDLOOP.
  ENDMETHOD.

*----------------------------------------------------------------------*
* 5.5 - validation and mapping, row by row
*----------------------------------------------------------------------*
  METHOD validate_and_map.
    DATA(lv_fixed_comp) = 'ROW_NO  ACTION  STATUS  MESSAGE PROCESS_PROFILE REFERENCE_MATNR REF_WERKS ' &&
          ' REF_VKORG  REF_VTWEG REF_EKORG DEFAULT_MODE  COPY_BASIC  COPY_PURCH  COPY_MRP  COPY_SALES  COPY_ACCOUNTING DEFAULT_SUMMARY MATNR '.
*    LOOP AT mt_row INTO DATA(ls_row).
*      DATA(ls_bapi) = VALUE ty_bapi( row = ls_row-row matkey = ls_row-matkey ).
*
*      check_row_control( ls_row ).
*      copy_reference( EXPORTING is_row = ls_row CHANGING cs_bapi = ls_bapi ).
*      validate_row(   EXPORTING is_row = ls_row CHANGING cs_bapi = ls_bapi ).
*      check_existence( is_row = ls_row is_bapi = ls_bapi ).
*
*      APPEND ls_bapi TO mt_bapi.
*    ENDLOOP.
    DATA: lt_comp TYPE string_table.
    SPLIT lv_fixed_comp AT space INTO TABLE lt_comp.

    LOOP AT mt_row INTO DATA(ls_row).
      DATA(ls_bapi) = VALUE ty_bapi( row = ls_row-row matkey = ls_row-matkey ).
      check_row_control( ls_row ).  "check Screen Fields with Template Fields
      LOOP AT mt_cell INTO DATA(ls_cell) WHERE row = ls_row-row.
*        CHECK not ( ls_cell-field <> 'ACTION' AND ls_cell-field <> 'ROW_NO' ).
        DATA(lv_comp) = VALUE #( lt_comp[ table_line = ls_cell-field  ] OPTIONAL ).
        CHECK lv_comp <> ls_cell-field.

        copy_reference( EXPORTING is_row = ls_row CHANGING cs_bapi = ls_bapi ).

*        DATA(ls_fcat) = VALUE #( mo_config->mt_fcat[ temp_field_name = ls_cell-field ] OPTIONAL ).

        DATA(lt_fcat) = FILTER #( mo_config->mt_fcat USING KEY k_field WHERE temp_field_name = ls_cell-field ).

        LOOP AT lt_fcat INTO DATA(ls_fcat).
          IF ls_fcat IS NOT INITIAL.
            validate_row( EXPORTING is_row = ls_row is_fcat = ls_fcat CHANGING cs_bapi = ls_bapi ).
          ELSE.
            mo_log->add( iv_type = 'E'
                         is_row = ls_row
                         iv_field = ls_cell-field
                         iv_text = |The { ls_cell-field } is available in template but not maintained into config tables.| ).
          ENDIF.
        ENDLOOP.

      ENDLOOP.

      check_existence( is_row = ls_row is_bapi = ls_bapi ).

      APPEND ls_bapi TO mt_bapi.
    ENDLOOP.
  ENDMETHOD.

  METHOD check_row_control.
    DATA(lv_opid) = lcl_screen=>get_operation( ).

    "ACTION column must match the action selected on the screen
    DATA(lv_action) = to_upper( get_value( iv_row = is_row-row iv_field = gc_col-action ) ).
    IF lv_action IS NOT INITIAL.
      DATA(lv_row_op) = COND z_de_op_id(
        WHEN lv_action = 'C' OR lv_action = 'CREATE'                        THEN gc_op-create
        WHEN lv_action = 'U' OR lv_action = 'UPDATE' OR lv_action = 'CHANGE' THEN gc_op-update
        WHEN lv_action = 'E' OR lv_action = 'EXTEND'                        THEN gc_op-extend
        ELSE '?' ).
      IF lv_row_op <> lv_opid.
        mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-action
                     iv_text = |Row action '{ lv_action }' does not match the action selected on the screen| ).
      ENDIF.
    ENDIF.

    "MTART / MBRSH in the template must match the selection screen
    DATA(lv_mtart) = to_upper( get_value( iv_row = is_row-row iv_field = gc_col-mtart ) ).
    IF lv_mtart IS NOT INITIAL AND lv_mtart <> p_mtart.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-mtart
                   iv_text = |Material type { lv_mtart } differs from selection { p_mtart }| ).
    ENDIF.
    DATA(lv_mbrsh) = to_upper( get_value( iv_row = is_row-row iv_field = gc_col-mbrsh ) ).
    IF lv_mbrsh IS NOT INITIAL AND lv_mbrsh <> p_indsec.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-mbrsh
                   iv_text = |Industry sector { lv_mbrsh } differs from selection { p_indsec }| ).
    ENDIF.

    "Update / Extend need a material number
    IF lv_opid <> gc_op-create AND lcl_mapper=>is_dummy_key( is_row-matkey ) = abap_true.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-matnr
                   iv_text = 'MATNR is required for Update / Extend' ).
    ENDIF.

    "Reference / copy columns
    IF get_value( iv_row = is_row-row iv_field = gc_col-ref_matnr ) = `` AND
       ( is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_basic ) = abap_true OR
         is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_purch ) = abap_true OR
         is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_mrp   ) = abap_true OR
         is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_sales ) = abap_true OR
         is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_acct  ) = abap_true ).
      mo_log->add( iv_type = 'W' is_row = is_row iv_field = gc_col-ref_matnr
                   iv_text = 'COPY_* flags ignored - no REFERENCE_MATNR given' ).
    ENDIF.
    IF get_value( iv_row = is_row-row iv_field = gc_col-ref_ekorg ) <> ``.
      mo_log->add( iv_type = 'W' is_row = is_row iv_field = gc_col-ref_ekorg
                   iv_text = 'REF_EKORG ignored - purchasing org. data is not part of BAPI_MATERIAL_SAVEREPLICA' ).
    ENDIF.
  ENDMETHOD.

  METHOD copy_reference.
    "Copy the configured fields of the flagged views from the reference
    "material - values given in the template always win
    FIELD-SYMBOLS: <ls_src> TYPE any,
                   <lv_src> TYPE any,
                   <ls_tgt> TYPE any,
                   <lv_tgt> TYPE any.
    CONSTANTS lc_org_keys TYPE string VALUE
      ` MATERIAL MATERIAL_LONG PLANT SALES_ORG DISTR_CHAN VAL_AREA VAL_TYPE STGE_LOC WHSE_NO STGE_TYPE `.
    DATA: lt_views  TYPE tt_views,
          lv_refmat TYPE matnr.

    DATA(lv_ref) = to_upper( get_value( iv_row = is_row-row iv_field = gc_col-ref_matnr ) ).
    CHECK lv_ref IS NOT INITIAL.

    IF is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_basic ) = abap_true.
      INSERT gc_view-basic INTO TABLE lt_views.
    ENDIF.
    IF is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_purch ) = abap_true.
      INSERT gc_view-purch INTO TABLE lt_views.
    ENDIF.
    IF is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_mrp ) = abap_true.
      INSERT gc_view-mrp INTO TABLE lt_views.
    ENDIF.
    IF is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_sales ) = abap_true.
      INSERT gc_view-sales INTO TABLE lt_views.
    ENDIF.
    IF is_flag_set( iv_row = is_row-row iv_field = gc_col-copy_acct ) = abap_true.
      INSERT gc_view-val INTO TABLE lt_views.
    ENDIF.
    CHECK lt_views IS NOT INITIAL.

    CALL FUNCTION 'CONVERSION_EXIT_MATN1_INPUT'
      EXPORTING
        input  = lv_ref
      IMPORTING
        output = lv_refmat
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-ref_matnr
                   iv_text = |Invalid reference material { lv_ref }| ).
      RETURN.
    ENDIF.

    TRY.
        DATA(ls_ref) = mo_bapi->get_reference(
          iv_matnr = lv_refmat
          iv_werks = CONV #( to_upper( get_value( iv_row = is_row-row iv_field = gc_col-ref_werks ) ) )
          iv_vkorg = CONV #( to_upper( get_value( iv_row = is_row-row iv_field = gc_col-ref_vkorg ) ) )
          iv_vtweg = CONV #( to_upper( get_value( iv_row = is_row-row iv_field = gc_col-ref_vtweg ) ) ) ).
      CATCH lcx_error INTO DATA(lx_error).
        mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-ref_matnr
                     iv_text = lx_error->get_text( ) ).
        RETURN.
    ENDTRY.

    LOOP AT mo_config->mt_fcat INTO DATA(ls_fcat) WHERE system_derived = abap_false.
      CHECK line_exists( lt_views[ table_line = ls_fcat-view ] ).
      CHECK NOT line_exists( mt_cell[ row = is_row-row field = ls_fcat-temp_field_name ] ).

      LOOP AT ls_fcat-targets INTO DATA(ls_target) WHERE table = abap_false.
        CHECK lc_org_keys NS | { ls_target-comp } |.        "never copy org. keys
        ASSIGN COMPONENT ls_target-param OF STRUCTURE ls_ref TO <ls_src>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT ls_target-comp OF STRUCTURE <ls_src> TO <lv_src>.
        CHECK sy-subrc = 0.
        CHECK <lv_src> IS NOT INITIAL.
        ASSIGN COMPONENT ls_target-param OF STRUCTURE cs_bapi TO <ls_tgt>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT ls_target-comp OF STRUCTURE <ls_tgt> TO <lv_tgt>.
        CHECK sy-subrc = 0.
        <lv_tgt> = <lv_src>.
        INSERT VALUE #( row = is_row-row field = ls_fcat-temp_field_name ) INTO TABLE mt_copied.
        INSERT ls_fcat-view INTO TABLE cs_bapi-views.
      ENDLOOP.
    ENDLOOP.

    mo_log->add( iv_type = 'S' is_row = is_row iv_field = gc_col-ref_matnr
                 iv_text = |Reference { lv_ref } copied for view(s) { concat_lines_of( table = lt_views sep = `, ` ) }| ).
  ENDMETHOD.

  METHOD validate_row.
    "Step 5.5.1 - one pass over the field catalogue of all selected views
*    LOOP AT mo_config->mt_fcat INTO DATA(ls_fcat).

    DATA(ls_fcat)     = is_fcat.
    DATA(lv_value)    = get_value( iv_row = is_row-row iv_field = ls_fcat-temp_field_name ).
    DATA(lv_supplied) = COND abap_bool( WHEN lv_value IS NOT INITIAL THEN abap_true ELSE abap_false ).

    IF ls_fcat-mandatory = abap_true.
      IF lv_supplied = abap_true.
        map_field( EXPORTING is_row = is_row is_fcat = ls_fcat iv_value = lv_value
                   CHANGING  cs_bapi = cs_bapi ).
      ELSEIF is_available( iv_row = is_row-row iv_field = ls_fcat-temp_field_name ) = abap_false.
        mo_log->add( iv_type = 'E' is_row = is_row iv_view = ls_fcat-view
                     iv_field = ls_fcat-temp_field_name iv_fdesc = ls_fcat-description
                     iv_text = |{ ls_fcat-temp_field_name } ({ ls_fcat-description }) is mandatory| ).
      ENDIF.

    ELSEIF ls_fcat-optional = abap_true.
      IF lv_supplied = abap_true.
        map_field( EXPORTING is_row = is_row is_fcat = ls_fcat iv_value = lv_value
                   CHANGING  cs_bapi = cs_bapi ).
      ENDIF.

    ELSEIF ls_fcat-system_derived = abap_true.
      "derived by the system - nothing to do
      IF lv_supplied = abap_true.
        map_field( EXPORTING is_row = is_row is_fcat = ls_fcat iv_value = lv_value
                   CHANGING  cs_bapi = cs_bapi ).
      ENDIF.

    ELSEIF ls_fcat-cond_mandatory = abap_true.
      IF lv_supplied = abap_true.
        map_field( EXPORTING is_row = is_row is_fcat = ls_fcat iv_value = lv_value
                   CHANGING  cs_bapi = cs_bapi ).
      ENDIF.
      check_cond_mandatory( is_row      = is_row
                            is_fcat     = ls_fcat
                            iv_supplied = is_available( iv_row   = is_row-row
                                                        iv_field = ls_fcat-temp_field_name ) ).

    ELSE.
      "no flag maintained -> handled like optional
      IF lv_supplied = abap_true.
        map_field( EXPORTING is_row = is_row is_fcat = ls_fcat iv_value = lv_value
                   CHANGING  cs_bapi = cs_bapi ).
      ENDIF.
    ENDIF.
*    ENDLOOP.

    "Classification consistency
    LOOP AT cs_bapi-allocvalueschar INTO DATA(ls_char) WHERE charact IS INITIAL.
      mo_log->add( iv_type = 'E' is_row = is_row iv_view = gc_view-class
                   iv_text = |Characteristic value '{ ls_char-value_char }' without characteristic name| ).
    ENDLOOP.
    IF ( cs_bapi-allocvalueschar IS NOT INITIAL OR cs_bapi-allocvaluesnum IS NOT INITIAL OR
         cs_bapi-allocvaluescurr IS NOT INITIAL ) AND cs_bapi-classkey-classnum IS INITIAL.
      mo_log->add( iv_type = 'E' is_row = is_row iv_view = gc_view-class
                   iv_text = 'Characteristic values given, but no class' ).
    ENDIF.
  ENDMETHOD.

  METHOD check_cond_mandatory.
    "ZTMM_COND_MAND: SOURCE_FIELD = this field -> CONDMAT_FIELD required
    LOOP AT mo_config->mt_cond INTO DATA(ls_cond) WHERE source_field = is_fcat-temp_field_name.
      IF gc_cond_if_source = abap_true AND iv_supplied = abap_false.
        CONTINUE.                               "source not maintained -> no check
      ENDIF.
      CHECK is_available( iv_row = is_row-row iv_field = ls_cond-condmat_field ) = abap_false.

      mo_log->add( iv_type  = 'E'
                   is_row   = is_row
                   iv_view  = is_fcat-view
                   iv_field = ls_cond-condmat_field
                   iv_fdesc = ls_cond-condmat_dec
                   iv_text  = |{ ls_cond-condmat_field } ({ ls_cond-condmat_dec }) is mandatory | &&
                              |when { ls_cond-source_field } ({ ls_cond-source_dec }) is maintained| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD map_field.
    "Pass the template value to every BAPI target maintained for the field
    LOOP AT is_fcat-targets INTO DATA(ls_target).
      lcl_mapper=>map_value( EXPORTING is_target = ls_target
                                       iv_field  = is_fcat-temp_field_name
                                       iv_value  = iv_value
                             IMPORTING ev_error  = DATA(lv_error)
                             CHANGING  cs_bapi   = cs_bapi ).
      IF lv_error IS NOT INITIAL.
        mo_log->add( iv_type = 'E' is_row = is_row iv_view = is_fcat-view
                     iv_field = is_fcat-temp_field_name iv_fdesc = is_fcat-description
                     iv_text = lv_error ).
      ENDIF.
    ENDLOOP.
    IF is_fcat-targets IS NOT INITIAL.
      INSERT is_fcat-view INTO TABLE cs_bapi-views.
    ENDIF.
  ENDMETHOD.

  METHOD check_existence.
    TYPES: BEGIN OF lty_org,
             text   TYPE string,
             exists TYPE abap_bool,
           END OF lty_org.
    DATA: lt_org   TYPE STANDARD TABLE OF lty_org WITH EMPTY KEY,
          lv_matnr TYPE matnr,
          lv_dummy TYPE matnr.

    CHECK lcl_mapper=>is_dummy_key( is_row-matkey ) = abap_false.

    CALL FUNCTION 'CONVERSION_EXIT_MATN1_INPUT'
      EXPORTING
        input  = is_row-matkey
      IMPORTING
        output = lv_matnr
      EXCEPTIONS
        OTHERS = 1.
    IF sy-subrc <> 0.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-matnr iv_text = 'Invalid material number' ).
      RETURN.
    ENDIF.

    SELECT SINGLE matnr FROM mara INTO @lv_dummy WHERE matnr = @lv_matnr.
    DATA(lv_exists) = COND abap_bool( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ).
    DATA(lv_opid)   = lcl_screen=>get_operation( ).

    IF lv_opid = gc_op-create.
      IF lv_exists = abap_true.
        mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-matnr
                     iv_text = 'Material already exists - use Update or Extend' ).
      ENDIF.
      RETURN.
    ENDIF.
    IF lv_exists = abap_false.
      mo_log->add( iv_type = 'E' is_row = is_row iv_field = gc_col-matnr
                   iv_text = 'Material does not exist - use Create' ).
      RETURN.
    ENDIF.

    "Org. levels of this row - already maintained for the material?
    IF is_bapi-plantdata IS NOT INITIAL.
      SELECT SINGLE matnr FROM marc INTO @lv_dummy
        WHERE matnr = @lv_matnr AND werks = @is_bapi-plantdata-plant.
      APPEND VALUE #( text   = |Plant { is_bapi-plantdata-plant }|
                      exists = COND #( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ) ) TO lt_org.
    ENDIF.
    IF is_bapi-salesdata-sales_org IS NOT INITIAL.
      SELECT SINGLE matnr FROM mvke INTO @lv_dummy
        WHERE matnr = @lv_matnr AND vkorg = @is_bapi-salesdata-sales_org
                                AND vtweg = @is_bapi-salesdata-distr_chan.
      APPEND VALUE #( text   = |Sales area { is_bapi-salesdata-sales_org }/{ is_bapi-salesdata-distr_chan }|
                      exists = COND #( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ) ) TO lt_org.
    ENDIF.
    IF is_bapi-storagelocationdata-stge_loc IS NOT INITIAL.
      DATA(lv_sloc_plant) = COND werks_d( WHEN is_bapi-storagelocationdata-plant IS NOT INITIAL
                                          THEN is_bapi-storagelocationdata-plant
                                          ELSE is_bapi-plantdata-plant ).
      SELECT SINGLE matnr FROM mard INTO @lv_dummy
        WHERE matnr = @lv_matnr AND werks = @lv_sloc_plant
                                AND lgort = @is_bapi-storagelocationdata-stge_loc.
      APPEND VALUE #( text   = |Storage location { lv_sloc_plant }/{ is_bapi-storagelocationdata-stge_loc }|
                      exists = COND #( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ) ) TO lt_org.
    ENDIF.
    IF is_bapi-valuationdata-val_area IS NOT INITIAL.
      SELECT SINGLE matnr FROM mbew INTO @lv_dummy
        WHERE matnr = @lv_matnr AND bwkey = @is_bapi-valuationdata-val_area
                                AND bwtar = @is_bapi-valuationdata-val_type.
      APPEND VALUE #( text   = |Valuation area { is_bapi-valuationdata-val_area }|
                      exists = COND #( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ) ) TO lt_org.
    ENDIF.
    IF is_bapi-warehousenumberdata-whse_no IS NOT INITIAL.
      SELECT SINGLE matnr FROM mlgn INTO @lv_dummy
        WHERE matnr = @lv_matnr AND lgnum = @is_bapi-warehousenumberdata-whse_no.
      APPEND VALUE #( text   = |Warehouse { is_bapi-warehousenumberdata-whse_no }|
                      exists = COND #( WHEN sy-subrc = 0 THEN abap_true ELSE abap_false ) ) TO lt_org.
    ENDIF.

    CASE lv_opid.
      WHEN gc_op-update.
        LOOP AT lt_org INTO DATA(ls_org) WHERE exists = abap_false.
          mo_log->add( iv_type = 'E' is_row = is_row
                       iv_text = |{ ls_org-text } does not exist for the material - use Extend| ).
        ENDLOOP.
      WHEN gc_op-extend.
        LOOP AT lt_org INTO ls_org WHERE exists = abap_true.
          mo_log->add( iv_type = 'W' is_row = is_row
                       iv_text = |{ ls_org-text } already exists - its values will be changed| ).
        ENDLOOP.
        IF lt_org IS NOT INITIAL AND NOT line_exists( lt_org[ exists = abap_false ] ).
          mo_log->add( iv_type = 'E' is_row = is_row
                       iv_text = 'Nothing to extend - all org. levels of the row already exist (use Update)' ).
        ENDIF.
    ENDCASE.
  ENDMETHOD.

*----------------------------------------------------------------------*
* Simulation / posting
*----------------------------------------------------------------------*
  METHOD process_materials.
    FIELD-SYMBOLS <ls_class> TYPE ty_bapi.
    DATA: lt_err_mat  TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line,
          lt_seen     TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line,
          lt_mat      TYPE string_table,
          lt_class    TYPE tt_bapi,
          lv_ok_cnt   TYPE i,
          lv_fail_cnt TYPE i,
          lv_skip_cnt TYPE i.

    DATA(lv_mode) = COND string( WHEN p_test = abap_true THEN `Simulation` ELSE `Posting` ).

    "Materials in template order, materials with validation errors
    LOOP AT mt_row INTO DATA(ls_row).
      INSERT ls_row-matkey INTO TABLE lt_seen.
      IF sy-subrc = 0.
        APPEND ls_row-matkey TO lt_mat.
      ENDIF.
      IF mo_log->has_error( ls_row-row ) = abap_true.
        INSERT ls_row-matkey INTO TABLE lt_err_mat.
      ENDIF.
    ENDLOOP.

    LOOP AT lt_mat INTO DATA(lv_matkey).
      DATA(ls_first) = mt_row[ matkey = lv_matkey ].

      IF line_exists( lt_err_mat[ table_line = lv_matkey ] ).
        mo_log->add( iv_type = 'W' is_row = ls_first
                     iv_text = |{ lv_mode } skipped - material has validation errors| ).
        lv_skip_cnt = lv_skip_cnt + 1.
        CONTINUE.
      ENDIF.

      DATA(lv_matnr) = mo_bapi->get_material_number( ls_first ).
      IF lv_matnr IS INITIAL.
        lv_skip_cnt = lv_skip_cnt + 1.
        CONTINUE.
      ENDIF.

      "--- One BAPI_MATERIAL_SAVEREPLICA call per template row:
      "    basic data of the material + org. levels of this row only
      DATA(lv_mat_ok) = abap_true.
      LOOP AT mt_row INTO DATA(ls_mrow) WHERE matkey = lv_matkey.
        IF mo_bapi->save_material( is_call  = build_call( iv_matkey = lv_matkey
                                                          iv_matnr  = lv_matnr
                                                          iv_row    = ls_mrow-row )
                                   it_rows  = VALUE #( ( ls_mrow ) )
                                   iv_matnr = lv_matnr ) = abap_false.
          lv_mat_ok = abap_false.
          IF p_test = abap_false.
            mo_log->add( iv_type = 'W' is_row = ls_mrow
                         iv_text = 'Remaining rows of this material not posted after the error' ).
            EXIT.                                   "posting: stop this material
          ENDIF.
        ENDIF.
      ENDLOOP.

      "--- Classification: merged per class over all rows of the material
      CLEAR lt_class.
      LOOP AT mt_bapi INTO DATA(ls_rb) WHERE matkey = lv_matkey.
        CHECK ls_rb-classkey-classnum IS NOT INITIAL.
        READ TABLE lt_class ASSIGNING <ls_class>
             WITH KEY classkey-classnum  = ls_rb-classkey-classnum
                      classkey-classtype = ls_rb-classkey-classtype.
        IF sy-subrc <> 0.
          APPEND VALUE #( classkey = ls_rb-classkey row = ls_rb-row matkey = lv_matkey )
            TO lt_class ASSIGNING <ls_class>.
        ENDIF.
        LOOP AT ls_rb-allocvalueschar INTO DATA(ls_vchar).
          lcl_mapper=>append_unique( EXPORTING is_line = ls_vchar CHANGING ct_tab = <ls_class>-allocvalueschar ).
        ENDLOOP.
        LOOP AT ls_rb-allocvaluesnum INTO DATA(ls_vnum).
          lcl_mapper=>append_unique( EXPORTING is_line = ls_vnum CHANGING ct_tab = <ls_class>-allocvaluesnum ).
        ENDLOOP.
        LOOP AT ls_rb-allocvaluescurr INTO DATA(ls_vcurr).
          lcl_mapper=>append_unique( EXPORTING is_line = ls_vcurr CHANGING ct_tab = <ls_class>-allocvaluescurr ).
        ENDLOOP.
      ENDLOOP.

      "only once the material exists (after posting / for update + extend)
      IF lv_mat_ok = abap_true OR p_test = abap_true.
        LOOP AT lt_class ASSIGNING <ls_class>.
          DATA(ls_crow) = mt_row[ row = <ls_class>-row ].
          IF p_test = abap_true AND lcl_screen=>get_operation( ) = gc_op-create.
            mo_log->add( iv_type = 'W' is_row = ls_crow iv_view = gc_view-class
                         iv_text = |Classification { <ls_class>-classkey-classnum } not simulated - | &&
                                   |material does not exist before posting| ).
            CONTINUE.
          ENDIF.
          IF mo_bapi->classify( is_class = <ls_class> is_row = ls_crow iv_matnr = lv_matnr ) = abap_false.
            lv_mat_ok = abap_false.
          ENDIF.
        ENDLOOP.
      ENDIF.

      IF lv_mat_ok = abap_true.
        lv_ok_cnt = lv_ok_cnt + 1.
      ELSE.
        lv_fail_cnt = lv_fail_cnt + 1.
      ENDIF.
    ENDLOOP.

    mo_log->add( iv_type = COND #( WHEN lv_fail_cnt > 0 THEN 'W' ELSE 'S' )
                 iv_text = |{ lv_mode } finished: { lv_ok_cnt } material(s) successful, | &&
                           |{ lv_fail_cnt } failed, { lv_skip_cnt } skipped| ).
  ENDMETHOD.

  METHOD build_call.
    "One call of BAPI_MATERIAL_SAVEREPLICA for template row IV_ROW:
    " - basic data (header, client data, descriptions, units, texts, tax)
    "   from all rows of the material - every call is complete on its own
    " - org. level data (plant, storage location, sales area, valuation
    "   area, warehouse ...) only from row IV_ROW
    FIELD-SYMBOLS: <ls_src>  TYPE any,
                   <lt_src>  TYPE STANDARD TABLE,
                   <ls_line> TYPE any.
    CONSTANTS:
      lc_single  TYPE string VALUE `CLIENTDATA PLANTDATA FORECASTPARAMETERS PLANNINGDATA STORAGELOCATIONDATA VALUATIONDATA WAREHOUSENUMBERDATA SALESDATA STORAGETYPEDATA`,
      lc_single2 TYPE string VALUE `PRTDATA EXTENSIONIN FORECASTVALUES UNPLNDCONSUMPTIO TOTALCONSUMPTION RETURNMESSAGES CLIENTDATACWM UNITSOFMEASURECWM VALUATIONDATACWM MATPLSTADATA MARC_APS_EXTDATA DEMAND_PENALTYDATA `,
      lc_tables  TYPE string VALUE `MATERIALDESCRIPTION UNITSOFMEASURE INTERNATIONALARTNOS MATERIALLONGTEXT TAXCLASSIFICATIONS`.
    DATA: lt_single TYPE string_table,
          lt_tables TYPE string_table,
          lt_views  TYPE tt_views,
          ls_head   TYPE bapie1matheader.

    SPLIT lc_single AT space INTO TABLE lt_single.
    SPLIT lc_single2 AT space INTO TABLE DATA(lt_single2).
    APPEND LINES OF lt_single2 TO lt_single.
    SPLIT lc_tables AT space INTO TABLE lt_tables.

    LOOP AT mt_bapi INTO DATA(ls_rb) WHERE matkey = iv_matkey.

      "Org. key defaults from the plant of the row
      IF ls_rb-plantdata-plant IS NOT INITIAL.
        IF ls_rb-storagelocationdata IS NOT INITIAL AND ls_rb-storagelocationdata-plant IS INITIAL.
          ls_rb-storagelocationdata-plant = ls_rb-plantdata-plant.
        ENDIF.
        IF ls_rb-forecastparameters IS NOT INITIAL AND ls_rb-forecastparameters-plant IS INITIAL.
          ls_rb-forecastparameters-plant = ls_rb-plantdata-plant.
        ENDIF.
        IF ls_rb-planningdata IS NOT INITIAL AND ls_rb-planningdata-plant IS INITIAL.
          ls_rb-planningdata-plant = ls_rb-plantdata-plant.
        ENDIF.
        IF ls_rb-valuationdata IS NOT INITIAL AND ls_rb-valuationdata-val_area IS INITIAL.
          ls_rb-valuationdata-val_area = ls_rb-plantdata-plant.       "valuation at plant level
        ENDIF.
      ENDIF.

      DATA(lv_this_row) = COND abap_bool( WHEN iv_row IS INITIAL OR ls_rb-row = iv_row
                                          THEN abap_true ELSE abap_false ).

      "Header fields + views with data (org. level views only from this row)
      lcl_mapper=>merge_struct( EXPORTING is_src = ls_rb-headdata CHANGING cs_tgt = ls_head ).
      LOOP AT ls_rb-views INTO DATA(lv_view).
        IF lv_this_row = abap_true OR lv_view = gc_view-basic.
          INSERT lv_view INTO TABLE lt_views.
        ENDIF.
      ENDLOOP.

      "Structures -> table lines: CLIENTDATA from every row, org. levels
      "only from this row
      LOOP AT lt_single INTO DATA(lv_param).
        CHECK lv_this_row = abap_true OR lv_param = `CLIENTDATA`.
        ASSIGN COMPONENT lv_param OF STRUCTURE ls_rb TO <ls_src>.
        CHECK sy-subrc = 0.
        CHECK <ls_src> IS NOT INITIAL.
        lcl_mapper=>add_line( EXPORTING iv_param = CONV #( lv_param )
                                        is_line  = <ls_src>
                                        iv_row   = ls_rb-row
                              CHANGING  cs_call  = rs_call ).
      ENDLOOP.

      "Table parameters of the row
      LOOP AT lt_tables INTO lv_param.
        ASSIGN COMPONENT lv_param OF STRUCTURE ls_rb TO <lt_src>.
        CHECK sy-subrc = 0.
        LOOP AT <lt_src> ASSIGNING <ls_line>.
          lcl_mapper=>add_line( EXPORTING iv_param = CONV #( lv_param )
                                          is_line  = <ls_line>
                                          iv_row   = ls_rb-row
                                CHANGING  cs_call  = rs_call ).
        ENDLOOP.
      ENDLOOP.
    ENDLOOP.

    "Defaults for descriptions and long texts
    LOOP AT rs_call-materialdescription ASSIGNING FIELD-SYMBOL(<ls_makt>)
         WHERE langu IS INITIAL AND langu_iso IS INITIAL.
      <ls_makt>-langu = sy-langu.
    ENDLOOP.
    LOOP AT rs_call-materiallongtext ASSIGNING FIELD-SYMBOL(<ls_text>).
      lcl_mapper=>set_default( EXPORTING iv_comp = 'APPLOBJECT' iv_value = 'MATERIAL' CHANGING cs_line = <ls_text> ).
      lcl_mapper=>set_default( EXPORTING iv_comp = 'TEXT_NAME'  iv_value = iv_matnr   CHANGING cs_line = <ls_text> ).
      lcl_mapper=>set_default( EXPORTING iv_comp = 'TEXT_ID'    iv_value = 'GRUN'     CHANGING cs_line = <ls_text> ).
      lcl_mapper=>set_default( EXPORTING iv_comp = 'LANGU'      iv_value = sy-langu   CHANGING cs_line = <ls_text> ).
    ENDLOOP.

    "Header: type, industry sector, view indicators (screen AND data supplied)
    ls_head-matl_type  = p_mtart.
    ls_head-ind_sector = p_indsec.
*    ls_head-basic_view    = COND #( WHEN abap   = abap_true AND line_exists( lt_views[ table_line = gc_view-basic  ] ) THEN abap_true ).
    ls_head-basic_view    = abap_true.
    ls_head-purchase_view = COND #( WHEN p_purch  = abap_true AND line_exists( lt_views[ table_line = gc_view-purch  ] ) THEN abap_true ).
    ls_head-mrp_view      = COND #( WHEN p_mrp   = abap_true AND line_exists( lt_views[ table_line = gc_view-mrp    ] ) THEN abap_true ).
    ls_head-storage_view  = COND #( WHEN p_plntst = abap_true AND line_exists( lt_views[ table_line = gc_view-plntst ] ) THEN abap_true ).
    ls_head-sales_view    = COND #( WHEN p_sales = abap_true AND line_exists( lt_views[ table_line = gc_view-sales  ] ) THEN abap_true ).
    ls_head-account_view  = COND #( WHEN p_val  = abap_true AND line_exists( lt_views[ table_line = gc_view-val    ] ) THEN abap_true ).
*    ls_head-forecast_view  = COND #( WHEN ls_head-mrp_view = abap_true AND rs_call-forecastparameters IS NOT INITIAL
*                                     THEN abap_true ).
*    ls_head-warehouse_view = COND #( WHEN ls_head-storage_view = abap_true AND rs_call-warehousenumberdata IS NOT INITIAL
*                                     THEN abap_true ).
    APPEND ls_head TO rs_call-headdata.

    "Material number in all lines, then the X tables
    lcl_mapper=>set_material_all( EXPORTING iv_matnr = iv_matnr CHANGING cs_call = rs_call ).
    lcl_mapper=>build_x_tables( CHANGING cs_call = rs_call ).
  ENDMETHOD.

*----------------------------------------------------------------------*
* Helpers
*----------------------------------------------------------------------*
  METHOD get_value.
    rv_value = VALUE #( mt_cell[ row = iv_row field = iv_field ]-value OPTIONAL ).
  ENDMETHOD.

  METHOD is_available.
    "value in template or copied from the reference material
    rv_avail = COND #( WHEN line_exists( mt_cell[   row = iv_row field = iv_field ] ) OR
                            line_exists( mt_copied[ row = iv_row field = iv_field ] )
                       THEN abap_true ELSE abap_false ).
  ENDMETHOD.

  METHOD is_flag_set.
    DATA(lv_flag) = to_upper( get_value( iv_row = iv_row iv_field = iv_field ) ).
    rv_set = COND #( WHEN lv_flag = 'X' OR lv_flag = 'Y' OR lv_flag = 'YES' OR
                          lv_flag = '1' OR lv_flag = 'TRUE'
                     THEN abap_true ELSE abap_false ).
  ENDMETHOD.

ENDCLASS.


*----------------------------------------------------------------------*
INITIALIZATION.
  lcl_screen=>initialization( ).

AT SELECTION-SCREEN OUTPUT.
  lcl_screen=>pbo( ).

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file1.
  lcl_screen=>f4_local_file( CHANGING cv_file = p_file1 ).

AT SELECTION-SCREEN.
  lcl_screen=>pai( ).

START-OF-SELECTION.
  NEW lcl_app( )->run( ).