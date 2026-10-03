*&---------------------------------------------------------------------*
*& Report  ZMM_MATERIAL_MAINTENANCE_SINGLE
*&---------------------------------------------------------------------*
*& Material master mass maintenance (Create / Update / Extend)
*& Single-file version: all logic consolidated into one report.
*& Original include-based project remains untouched.
*&---------------------------------------------------------------------*
REPORT zmm_material_maintenance_single.

TYPE-POOLS: abap, icon, vrm.

TYPES: ty_t_cells TYPE STANDARD TABLE OF string WITH EMPTY KEY,
       ty_t_grid  TYPE STANDARD TABLE OF ty_t_cells WITH EMPTY KEY,
       ty_t_tabname TYPE STANDARD TABLE OF tabname WITH EMPTY KEY.

"One template row = hashed list of (upper-case column name, value)
TYPES: BEGIN OF ty_fv,
         name  TYPE string,
         value TYPE string,
       END OF ty_fv,
       ty_t_fv TYPE HASHED TABLE OF ty_fv WITH UNIQUE KEY name.

TYPES: BEGIN OF ty_row,
         row_no TYPE i,
         fields TYPE ty_t_fv,
       END OF ty_row,
       ty_t_row TYPE STANDARD TABLE OF ty_row WITH EMPTY KEY.

"Field configuration line (all ZTMM_*_DATA view tables share one structure)
TYPES: BEGIN OF ty_cfg.
         INCLUDE TYPE ztmm_basic_data.
TYPES:   view_tab TYPE tabname,
       END OF ty_cfg,
       ty_t_cfg TYPE STANDARD TABLE OF ty_cfg WITH DEFAULT KEY.

"Validated value ready to be passed to a BAPI
TYPES: BEGIN OF ty_map,
         view_tab   TYPE tabname,
         temp_field TYPE string,
         struct     TYPE string,
         field      TYPE string,
         value      TYPE string,
         line_key   TYPE i,
       END OF ty_map,
       ty_t_map TYPE STANDARD TABLE OF ty_map WITH EMPTY KEY.

"Output / ALV line
TYPES: BEGIN OF ty_log,
         row_no  TYPE i,
         matnr   TYPE c LENGTH 40,
         icon    TYPE icon_d,
         type    TYPE bapi_mtype,
         stage   TYPE c LENGTH 10,
         field   TYPE c LENGTH 30,
         message TYPE c LENGTH 255,
       END OF ty_log,
       ty_t_log TYPE STANDARD TABLE OF ty_log WITH DEFAULT KEY.

"Selection Screen
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
  PARAMETERS : p_mtart  TYPE mtart AS LISTBOX VISIBLE LENGTH 10 USER-COMMAND ucmd,
               p_indsec TYPE char1 AS LISTBOX VISIBLE LENGTH 4 USER-COMMAND ucmd,
               p_busprf TYPE char20 AS LISTBOX VISIBLE LENGTH 20 USER-COMMAND ucmd,
               p_sales  AS CHECKBOX DEFAULT 'X',
               p_class    AS CHECKBOX DEFAULT 'X',
               p_purch   AS CHECKBOX DEFAULT 'X',
               p_mrp    AS CHECKBOX DEFAULT 'X',
               p_plnst  AS CHECKBOX DEFAULT 'X',
               p_val   AS CHECKBOX DEFAULT 'X'.
SELECTION-SCREEN END OF BLOCK b3.
SELECTION-SCREEN BEGIN OF BLOCK b4 WITH FRAME TITLE TEXT-005.
  PARAMETERS : p_file3 TYPE string LOWER CASE DEFAULT TEXT-006 MODIF ID md3,
               p_email TYPE ad_smtpadr DEFAULT TEXT-008 MODIF ID md3,
               p_test  AS CHECKBOX DEFAULT abap_true USER-COMMAND ucmd.
SELECTION-SCREEN END OF BLOCK b4.

*----------------------------------------------------------------------*
* Exception
*----------------------------------------------------------------------*
CLASS lcx_error DEFINITION FINAL INHERITING FROM cx_static_check.
  PUBLIC SECTION.
    DATA text TYPE string READ-ONLY.
    METHODS constructor IMPORTING iv_text TYPE string.
ENDCLASS.

CLASS lcx_error IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    text = iv_text.
  ENDMETHOD.
ENDCLASS.

*----------------------------------------------------------------------*
* File IO (frontend + application server)
*----------------------------------------------------------------------*
CLASS lcl_file_io DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      get_extension IMPORTING iv_file       TYPE string
                    RETURNING VALUE(rv_ext) TYPE string,
      read_local    IMPORTING iv_file        TYPE string
                    RETURNING VALUE(rv_xstr) TYPE xstring
                    RAISING   lcx_error,
      read_server   IMPORTING iv_file        TYPE string
                    RETURNING VALUE(rv_xstr) TYPE xstring
                    RAISING   lcx_error,
      write_server  IMPORTING iv_file TYPE string
                              iv_text TYPE string
                    RAISING   lcx_error,
      f4_local      CHANGING cv_file TYPE string,
      f4_server     CHANGING cv_file TYPE string.
ENDCLASS.

CLASS lcl_file_io IMPLEMENTATION.

  METHOD get_extension.
    rv_ext = to_lower( match( val = iv_file regex = '\.[A-Za-z0-9]+$' ) ).
  ENDMETHOD.

  METHOD read_local.
    DATA: lt_bin TYPE solix_tab,
          lv_len TYPE i.

    IF sy-batch = abap_true.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Local files cannot be read in background. Use the application server option.|.
    ENDIF.

    cl_gui_frontend_services=>gui_upload(
      EXPORTING  filename   = iv_file
                 filetype   = 'BIN'
      IMPORTING  filelength = lv_len
      CHANGING   data_tab   = lt_bin
      EXCEPTIONS OTHERS     = 1 ).
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Cannot read local file { iv_file }|.
    ENDIF.
    rv_xstr = cl_bcs_convert=>solix_to_xstring( it_solix = lt_bin iv_size = lv_len ).
  ENDMETHOD.

  METHOD read_server.
    DATA: lv_buf TYPE x LENGTH 4096,
          lv_len TYPE i.

    AUTHORITY-CHECK OBJECT 'S_DATASET'
      ID 'PROGRAM'  FIELD sy-repid
      ID 'ACTVT'    FIELD '33'
      ID 'FILENAME' FIELD iv_file.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |No authorization to read file { iv_file }|.
    ENDIF.

    OPEN DATASET iv_file FOR INPUT IN BINARY MODE.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Cannot open application server file { iv_file }|.
    ENDIF.
    DO.
      CLEAR lv_len.
      READ DATASET iv_file INTO lv_buf ACTUAL LENGTH lv_len.
      IF lv_len > 0.
        CONCATENATE rv_xstr lv_buf(lv_len) INTO rv_xstr IN BYTE MODE.
      ENDIF.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
    ENDDO.
    CLOSE DATASET iv_file.
  ENDMETHOD.

  METHOD write_server.
    AUTHORITY-CHECK OBJECT 'S_DATASET'
      ID 'PROGRAM'  FIELD sy-repid
      ID 'ACTVT'    FIELD '34'
      ID 'FILENAME' FIELD iv_file.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |No authorization to write file { iv_file }|.
    ENDIF.

    OPEN DATASET iv_file FOR OUTPUT IN TEXT MODE ENCODING UTF-8.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Cannot write application server file { iv_file }|.
    ENDIF.
    TRANSFER iv_text TO iv_file.
    CLOSE DATASET iv_file.
  ENDMETHOD.

  METHOD f4_local.
    DATA: lt_files TYPE filetable,
          lv_rc    TYPE i.

    cl_gui_frontend_services=>file_open_dialog(
      EXPORTING  window_title = 'Select template file'
                 file_filter  = 'Template files (*.xlsx;*.csv)|*.xlsx;*.csv'
      CHANGING   file_table   = lt_files
                 rc           = lv_rc
      EXCEPTIONS OTHERS       = 1 ).
    IF sy-subrc = 0 AND lv_rc > 0.
      READ TABLE lt_files INDEX 1 INTO DATA(ls_file).
      IF sy-subrc = 0.
        cv_file = ls_file-filename.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD f4_server.
    DATA lv_file TYPE dxfields-longpath.

    CALL FUNCTION '/SAPDMC/LSM_F4_SERVER_FILE'
      IMPORTING
        serverfile       = lv_file
      EXCEPTIONS
        canceled_by_user = 1
        OTHERS           = 2.
    IF sy-subrc = 0.
      cv_file = lv_file.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Template reader: .xlsx / .csv  ->  rows of (column name, value)
*----------------------------------------------------------------------*
CLASS lcl_template DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS read
      IMPORTING iv_xstr        TYPE xstring
                iv_ext         TYPE string
                iv_name        TYPE string
      RETURNING VALUE(rt_rows) TYPE ty_t_row
      RAISING   lcx_error.
  PRIVATE SECTION.
    CLASS-METHODS:
      xlsx_to_grid IMPORTING iv_xstr        TYPE xstring
                             iv_name        TYPE string
                   RETURNING VALUE(rt_grid) TYPE ty_t_grid
                   RAISING   lcx_error,
      csv_to_grid  IMPORTING iv_xstr        TYPE xstring
                   RETURNING VALUE(rt_grid) TYPE ty_t_grid
                   RAISING   lcx_error,
      grid_to_rows IMPORTING it_grid        TYPE ty_t_grid
                   RETURNING VALUE(rt_rows) TYPE ty_t_row
                   RAISING   lcx_error,
      is_blank     IMPORTING it_cells       TYPE ty_t_cells
                   RETURNING VALUE(rv_blank) TYPE abap_bool,
      trim         IMPORTING iv_val         TYPE string
                   RETURNING VALUE(rv_val)  TYPE string.
ENDCLASS.

CLASS lcl_template IMPLEMENTATION.

  METHOD read.
    DATA lt_grid TYPE ty_t_grid.

    CASE iv_ext.
      WHEN '.xlsx'.
        lt_grid = xlsx_to_grid( iv_xstr = iv_xstr iv_name = iv_name ).
      WHEN '.csv'.
        lt_grid = csv_to_grid( iv_xstr ).
      WHEN OTHERS.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |Invalid file format { iv_ext }. Only .xlsx and .csv are allowed.|.
    ENDCASE.

    rt_rows = grid_to_rows( lt_grid ).
    IF rt_rows IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Template file contains no data rows|.
    ENDIF.
  ENDMETHOD.

  METHOD xlsx_to_grid.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.
    DATA lt_cells TYPE ty_t_cells.

    TRY.
        DATA(lo_xl) = NEW cl_fdt_xl_spreadsheet( document_name = iv_name
                                                 xdocument     = iv_xstr ).
        lo_xl->if_fdt_doc_spreadsheet~get_worksheet_names( IMPORTING worksheet_names = DATA(lt_ws) ).
        IF lt_ws IS INITIAL.
          RAISE EXCEPTION TYPE lcx_error
            EXPORTING iv_text = |Excel file has no worksheet|.
        ENDIF.
        DATA(lr_data) = lo_xl->if_fdt_doc_spreadsheet~get_itab_from_worksheet( lt_ws[ 1 ] ).
      CATCH cx_fdt_excel_core INTO DATA(lx_xl).
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |Cannot read Excel file: { lx_xl->get_text( ) }|.
    ENDTRY.

    ASSIGN lr_data->* TO <lt_data>.
    LOOP AT <lt_data> ASSIGNING FIELD-SYMBOL(<ls_line>).
      CLEAR lt_cells.
      DO.
        ASSIGN COMPONENT sy-index OF STRUCTURE <ls_line> TO FIELD-SYMBOL(<lv_cell>).
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        APPEND CONV string( <lv_cell> ) TO lt_cells.
      ENDDO.
      APPEND lt_cells TO rt_grid.
    ENDLOOP.
  ENDMETHOD.

  METHOD csv_to_grid.
    DATA: lv_text  TYPE string,
          lv_cell  TYPE string,
          lt_cells TYPE ty_t_cells,
          lv_inq   TYPE abap_bool,
          lv_i     TYPE i,
          lv_n     TYPE i,
          lv_nx    TYPE i,
          lv_c     TYPE c LENGTH 1.

    TRY.
        cl_abap_conv_in_ce=>create( encoding    = 'UTF-8'
                                    ignore_cerr = abap_true
                                    replacement = '?'
                                    input       = iv_xstr )->read( IMPORTING data = lv_text ).
      CATCH cx_root INTO DATA(lx).
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |Cannot decode CSV file (save it as UTF-8): { lx->get_text( ) }|.
    ENDTRY.

    IF lv_text IS NOT INITIAL AND lv_text(1) = cl_abap_conv_in_ce=>uccp( 'FEFF' ).
      lv_text = lv_text+1.
    ENDIF.

    DATA(lv_nl_pos) = find( val = lv_text sub = cl_abap_char_utilities=>newline ).
    DATA(lv_head) = COND string( WHEN lv_nl_pos >= 0 THEN substring( val = lv_text len = lv_nl_pos )
                                 ELSE lv_text ).
    DATA(lv_delim) = `,`.
    IF count( val = lv_head sub = `;` ) > count( val = lv_head sub = lv_delim ).
      lv_delim = `;`.
    ENDIF.
    IF count( val = lv_head sub = cl_abap_char_utilities=>horizontal_tab ) > count( val = lv_head sub = lv_delim ).
      lv_delim = cl_abap_char_utilities=>horizontal_tab.
    ENDIF.

    DATA(lv_cr) = cl_abap_conv_in_ce=>uccp( '000D' ).

    lv_n = strlen( lv_text ).
    WHILE lv_i < lv_n.
      lv_c = lv_text+lv_i(1).
      IF lv_inq = abap_true.
        IF lv_c = '"'.
          lv_nx = lv_i + 1.
          IF lv_nx < lv_n AND lv_text+lv_nx(1) = '"'.
            lv_cell = lv_cell && '"'.
            lv_i = lv_i + 1.
          ELSE.
            lv_inq = abap_false.
          ENDIF.
        ELSE.
          lv_cell = lv_cell && lv_c.
        ENDIF.
      ELSE.
        IF lv_c = '"'.
          lv_inq = abap_true.
        ELSEIF lv_c = lv_delim.
          APPEND lv_cell TO lt_cells.
          CLEAR lv_cell.
        ELSEIF lv_c = lv_cr.
          "ignore
        ELSEIF lv_c = cl_abap_char_utilities=>newline.
          APPEND lv_cell TO lt_cells.
          APPEND lt_cells TO rt_grid.
          CLEAR: lv_cell, lt_cells.
        ELSE.
          lv_cell = lv_cell && lv_c.
        ENDIF.
      ENDIF.
      lv_i = lv_i + 1.
    ENDWHILE.

    IF lv_cell IS NOT INITIAL OR lt_cells IS NOT INITIAL.
      APPEND lv_cell TO lt_cells.
      APPEND lt_cells TO rt_grid.
    ENDIF.
  ENDMETHOD.

  METHOD grid_to_rows.
    DATA: lt_head TYPE ty_t_cells,
          lv_hdr  TYPE abap_bool,
          ls_row  TYPE ty_row.

    LOOP AT it_grid INTO DATA(lt_cells).
      DATA(lv_no) = sy-tabix.
      IF is_blank( lt_cells ) = abap_true.
        CONTINUE.
      ENDIF.

      IF lv_hdr = abap_false.
        lv_hdr = abap_true.
        LOOP AT lt_cells INTO DATA(lv_cell).
          APPEND to_upper( trim( lv_cell ) ) TO lt_head.
        ENDLOOP.
        LOOP AT lt_head INTO DATA(lv_h).
          IF lv_h IS INITIAL.
            CONTINUE.
          ENDIF.
          DATA(lv_from) = sy-tabix + 1.
          LOOP AT lt_head TRANSPORTING NO FIELDS FROM lv_from WHERE table_line = lv_h.
            RAISE EXCEPTION TYPE lcx_error
              EXPORTING iv_text = |Duplicate column { lv_h } in template header|.
          ENDLOOP.
        ENDLOOP.
        CONTINUE.
      ENDIF.

      CLEAR ls_row.
      ls_row-row_no = lv_no.
      LOOP AT lt_head INTO lv_h.
        DATA(lv_pos) = sy-tabix.
        IF lv_h IS INITIAL.
          CONTINUE.
        ENDIF.
        READ TABLE lt_cells INTO lv_cell INDEX lv_pos.
        IF sy-subrc = 0.
          INSERT VALUE #( name = lv_h value = trim( lv_cell ) ) INTO TABLE ls_row-fields.
        ENDIF.
      ENDLOOP.
      APPEND ls_row TO rt_rows.
    ENDLOOP.
  ENDMETHOD.

  METHOD is_blank.
    rv_blank = abap_true.
    LOOP AT it_cells INTO DATA(lv_cell).
      IF trim( lv_cell ) IS NOT INITIAL.
        rv_blank = abap_false.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD trim.
    rv_val = shift_left( val = shift_right( val = iv_val ) ).
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Configuration (ZTMM_MATMAS_MAST, view tables, ZTMM_COND_MAND)
*----------------------------------------------------------------------*
CLASS lcl_config DEFINITION FINAL.
  PUBLIC SECTION.
    DATA: mv_variant TYPE ztmm_matmas_mast-variant_view READ-ONLY,
          ms_master  TYPE ztmm_matmas_mast READ-ONLY,
          mt_cfg     TYPE ty_t_cfg READ-ONLY,
          mt_cond    TYPE STANDARD TABLE OF ztmm_cond_mand WITH DEFAULT KEY READ-ONLY.

    CLASS-METHODS:
      get_operation RETURNING VALUE(rv_op) TYPE ztmm_matmas_mast-operation_id,
      list_values   IMPORTING iv_field      TYPE string
                    RETURNING VALUE(rt_vrm) TYPE vrm_values.

    METHODS load RAISING lcx_error.

  PRIVATE SECTION.
    CLASS-METHODS selected_views RETURNING VALUE(rt_tab) TYPE ty_t_tabname.
ENDCLASS.

CLASS lcl_config IMPLEMENTATION.

  METHOD get_operation.
    rv_op = COND #( WHEN r_create = abap_true THEN 'C'
                    WHEN r_update = abap_true THEN 'U'
                    ELSE 'E' ).
  ENDMETHOD.

  METHOD list_values.
    TYPES: BEGIN OF ty_m,
             mat_type TYPE ztmm_matmas_mast-mat_type,
             ind_sec  TYPE ztmm_matmas_mast-ind_sec,
             bus_prof TYPE ztmm_matmas_mast-bus_prof,
           END OF ty_m.
    DATA: lt_m    TYPE STANDARD TABLE OF ty_m WITH DEFAULT KEY,
          lv_none TYPE dats,
          lv_op   TYPE ztmm_matmas_mast-operation_id,
          lv_key  TYPE vrm_value-key.

    lv_op = get_operation( ).
    SELECT DISTINCT mat_type, ind_sec, bus_prof
      FROM ztmm_matmas_mast
      WHERE operation_id = @lv_op
        AND active_flag  = @abap_true
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = @lv_none )
      INTO TABLE @lt_m.

    SORT lt_m BY mat_type ind_sec bus_prof.
    LOOP AT lt_m INTO DATA(ls_m).
      CASE iv_field.
        WHEN 'MTART'.
          lv_key = ls_m-mat_type.
        WHEN 'INDSEC'.
          IF p_mtart IS NOT INITIAL AND ls_m-mat_type <> p_mtart.
            CONTINUE.
          ENDIF.
          lv_key = ls_m-ind_sec.
        WHEN 'BUSPRF'.
          IF p_mtart IS NOT INITIAL AND ls_m-mat_type <> p_mtart.
            CONTINUE.
          ENDIF.
          IF p_indsec IS NOT INITIAL AND ls_m-ind_sec <> p_indsec.
            CONTINUE.
          ENDIF.
          lv_key = ls_m-bus_prof(20).
        WHEN OTHERS.
          CONTINUE.
      ENDCASE.
      IF lv_key IS INITIAL OR line_exists( rt_vrm[ key = lv_key ] ).
        CONTINUE.
      ENDIF.
      APPEND VALUE #( key = lv_key text = lv_key ) TO rt_vrm.
    ENDLOOP.
  ENDMETHOD.

  METHOD selected_views.
    APPEND 'ZTMM_BASIC_DATA' TO rt_tab.
    IF p_class = abap_true.
      APPEND 'ZTMM_CLASS_DATA' TO rt_tab.
    ENDIF.
    IF p_mrp = abap_true.
      APPEND 'ZTMM_MRP_DATA' TO rt_tab.
    ENDIF.
    IF p_plnst = abap_true.
      APPEND 'ZTMM_PLNTST_DATA' TO rt_tab.
    ENDIF.
    IF p_purch = abap_true.
      APPEND 'ZTMM_PURCH_DATA' TO rt_tab.
    ENDIF.
    IF p_sales = abap_true.
      APPEND 'ZTMM_SALES_DATA' TO rt_tab.
    ENDIF.
    IF p_val = abap_true.
      APPEND 'ZTMM_VAL_DATA' TO rt_tab.
    ENDIF.
  ENDMETHOD.

  METHOD load.
    DATA: lt_m    TYPE STANDARD TABLE OF ztmm_matmas_mast WITH DEFAULT KEY,
          lt_hit  TYPE STANDARD TABLE OF ztmm_matmas_mast WITH DEFAULT KEY,
          lt_tmp  TYPE STANDARD TABLE OF ztmm_basic_data WITH DEFAULT KEY,
          ls_cfg  TYPE ty_cfg,
          lv_none TYPE dats,
          lv_op   TYPE ztmm_matmas_mast-operation_id.

    lv_op = get_operation( ).
    SELECT * FROM ztmm_matmas_mast
      WHERE mat_type     = @p_mtart
        AND ind_sec      = @p_indsec
        AND operation_id = @lv_op
        AND active_flag  = @abap_true
        AND valid_from  <= @sy-datum
        AND ( valid_to  >= @sy-datum OR valid_to = @lv_none )
      INTO TABLE @lt_m.

    LOOP AT lt_m INTO DATA(ls_m).
      IF ls_m-bus_prof(20) = p_busprf.
        APPEND ls_m TO lt_hit.
      ENDIF.
    ENDLOOP.

    IF lt_hit IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |No active variant view in ZTMM_MATMAS_MAST for material type { p_mtart }, industry sector { p_indsec }, business profile { p_busprf }, operation { lv_op }|.
    ENDIF.

    ms_master  = lt_hit[ 1 ].
    mv_variant = ms_master-variant_view.
    LOOP AT lt_hit INTO ls_m WHERE variant_view <> mv_variant.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |More than one active variant view found in ZTMM_MATMAS_MAST ({ mv_variant }, { ls_m-variant_view }). Please correct the configuration.|.
    ENDLOOP.

    LOOP AT selected_views( ) INTO DATA(lv_tab).
      CLEAR lt_tmp.
      SELECT * FROM (lv_tab)
        INTO CORRESPONDING FIELDS OF TABLE @lt_tmp
        WHERE variant_view = @mv_variant.
      LOOP AT lt_tmp INTO DATA(ls_tmp).
        CLEAR ls_cfg.
        MOVE-CORRESPONDING ls_tmp TO ls_cfg.
        ls_cfg-view_tab = lv_tab.
        APPEND ls_cfg TO mt_cfg.
      ENDLOOP.
    ENDLOOP.

    IF mt_cfg IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |No field configuration found for variant view { mv_variant } in the selected view tables|.
    ENDIF.

    SELECT * FROM ztmm_cond_mand
      INTO TABLE @mt_cond
      WHERE mat_type     = @ms_master-mat_type
        AND ind_sec      = @ms_master-ind_sec
        AND bus_prof     = @ms_master-bus_prof
        AND variant_view = @mv_variant.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Generic dynamic BAPI wrapper
*----------------------------------------------------------------------*
CLASS lcl_bapi DEFINITION FINAL.
  PUBLIC SECTION.
    CONSTANTS: gc_longtext_param TYPE string VALUE 'MATERIALLONGTEXT',
               gc_longtext_field TYPE string VALUE 'TEXT_LINE',
               gc_longtext_width TYPE i      VALUE 132,
               gc_longtext_id    TYPE c LENGTH 4 VALUE 'BEST'.

    METHODS:
      constructor IMPORTING iv_func TYPE rs38l_fnam
                  RAISING   lcx_error,
      has_param   IMPORTING iv_name       TYPE string
                  RETURNING VALUE(rv_has) TYPE abap_bool,
      set_value   IMPORTING iv_param         TYPE string
                            iv_field         TYPE string
                            iv_value         TYPE string
                            iv_line_key      TYPE i DEFAULT 0
                            iv_if_initial    TYPE abap_bool DEFAULT abap_false
                  RETURNING VALUE(rv_error)  TYPE string,
      get_value   IMPORTING iv_param         TYPE string
                            iv_field         TYPE string
                  RETURNING VALUE(rv_value)  TYPE string,
      execute     RETURNING VALUE(rt_return) TYPE bapiret2_t.

  PRIVATE SECTION.
    TYPES: BEGIN OF ty_if,
             name   TYPE string,
             kind   TYPE c LENGTH 1,
             struct TYPE string,
           END OF ty_if,
           ty_t_if TYPE STANDARD TABLE OF ty_if WITH EMPTY KEY,
           BEGIN OF ty_cache,
             func   TYPE rs38l_fnam,
             params TYPE ty_t_if,
           END OF ty_cache,
           BEGIN OF ty_par,
             name   TYPE string,
             kind   TYPE c LENGTH 1,
             struct TYPE string,
             ref    TYPE REF TO data,
             tab    TYPE abap_bool,
             used   TYPE abap_bool,
           END OF ty_par,
           BEGIN OF ty_lk,
             param TYPE string,
             key   TYPE i,
             idx   TYPE i,
           END OF ty_lk.

    CLASS-DATA gt_cache TYPE HASHED TABLE OF ty_cache WITH UNIQUE KEY func.

    DATA: mv_func TYPE rs38l_fnam,
          mt_par  TYPE HASHED TABLE OF ty_par WITH UNIQUE KEY name,
          mt_lk   TYPE HASHED TABLE OF ty_lk WITH UNIQUE KEY param key.

    METHODS:
      line_of        IMPORTING iv_param       TYPE string
                               iv_key         TYPE i
                     RETURNING VALUE(rr_line) TYPE REF TO data,
      convert        IMPORTING iv_value TYPE string
                     CHANGING  cv_field TYPE any
                     RAISING   lcx_error,
      apply_exit     IMPORTING iv_exit  TYPE string
                               iv_value TYPE string
                     CHANGING  cv_field TYPE any
                     RAISING   lcx_error,
      to_date        IMPORTING iv_value       TYPE string
                     RETURNING VALUE(rv_date) TYPE d
                     RAISING   lcx_error,
      to_time        IMPORTING iv_value       TYPE string
                     RETURNING VALUE(rv_time) TYPE t
                     RAISING   lcx_error,
      add_long_text  IMPORTING iv_value        TYPE string
                     RETURNING VALUE(rv_error) TYPE string,
      finalize_long_text,
      default_comp   IMPORTING iv_comp TYPE string
                               iv_val  TYPE string
                     CHANGING  cs_line TYPE any.
ENDCLASS.

CLASS lcl_bapi IMPLEMENTATION.

  METHOD constructor.
    DATA: lt_db  TYPE STANDARD TABLE OF fupararef WITH DEFAULT KEY,
          ls_c   TYPE ty_cache,
          ls_par TYPE ty_par,
          lo_t   TYPE REF TO cl_abap_typedescr,
          lo_tab TYPE REF TO cl_abap_tabledescr.

    mv_func = iv_func.

    READ TABLE gt_cache ASSIGNING FIELD-SYMBOL(<ls_cache>) WITH TABLE KEY func = iv_func.
    IF sy-subrc <> 0.
      SELECT * FROM fupararef
        INTO TABLE @lt_db
        WHERE funcname = @iv_func
          AND r3state  = 'A'.
      IF lt_db IS INITIAL.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |Function module { iv_func } not found|.
      ENDIF.
      ls_c-func = iv_func.
      LOOP AT lt_db INTO DATA(ls_db) WHERE paramtype = 'I' OR paramtype = 'E' OR paramtype = 'T'.
        APPEND VALUE #( name   = ls_db-parameter
                        kind   = ls_db-paramtype
                        struct = ls_db-structure ) TO ls_c-params.
      ENDLOOP.
      INSERT ls_c INTO TABLE gt_cache ASSIGNING <ls_cache>.
    ENDIF.

    LOOP AT <ls_cache>-params INTO DATA(ls_if).
      CLEAR ls_par.
      ls_par-name   = ls_if-name.
      ls_par-kind   = ls_if-kind.
      ls_par-struct = ls_if-struct.
      IF ls_if-struct IS NOT INITIAL.
        cl_abap_typedescr=>describe_by_name(
          EXPORTING  p_name         = ls_if-struct
          RECEIVING  p_descr_ref    = lo_t
          EXCEPTIONS type_not_found = 1
                     OTHERS         = 2 ).
        IF sy-subrc = 0.
          IF ls_if-kind = 'T' AND lo_t->kind <> cl_abap_typedescr=>kind_table.
            lo_tab = cl_abap_tabledescr=>create( p_line_type = CAST cl_abap_datadescr( lo_t ) ).
            CREATE DATA ls_par-ref TYPE HANDLE lo_tab.
            ls_par-tab = abap_true.
          ELSE.
            CREATE DATA ls_par-ref TYPE HANDLE CAST cl_abap_datadescr( lo_t ).
            IF lo_t->kind = cl_abap_typedescr=>kind_table.
              ls_par-tab = abap_true.
            ENDIF.
          ENDIF.
        ENDIF.
      ENDIF.
      INSERT ls_par INTO TABLE mt_par.
    ENDLOOP.
  ENDMETHOD.

  METHOD has_param.
    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = to_upper( iv_name ).
    IF sy-subrc = 0 AND <ls_p>-kind <> 'E' AND <ls_p>-ref IS NOT INITIAL.
      rv_has = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD line_of.
    FIELD-SYMBOLS: <lt_tab> TYPE STANDARD TABLE,
                   <ls_ln>  TYPE any,
                   <ls_k>   TYPE ty_lk.

    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = iv_param.
    IF sy-subrc <> 0 OR <ls_p>-ref IS INITIAL.
      RETURN.
    ENDIF.
    <ls_p>-used = abap_true.

    IF <ls_p>-tab = abap_false.
      rr_line = <ls_p>-ref.
      RETURN.
    ENDIF.

    ASSIGN <ls_p>-ref->* TO <lt_tab>.
    READ TABLE mt_lk ASSIGNING <ls_k> WITH TABLE KEY param = iv_param key = iv_key.
    IF sy-subrc <> 0.
      APPEND INITIAL LINE TO <lt_tab> ASSIGNING <ls_ln>.
      INSERT VALUE #( param = iv_param key = iv_key idx = lines( <lt_tab> ) )
        INTO TABLE mt_lk ASSIGNING <ls_k>.
    ENDIF.
    READ TABLE <lt_tab> INDEX <ls_k>-idx ASSIGNING <ls_ln>.
    GET REFERENCE OF <ls_ln> INTO rr_line.
  ENDMETHOD.

  METHOD set_value.
    FIELD-SYMBOLS: <ls_line> TYPE any,
                   <lv_f>    TYPE any,
                   <ls_xl>   TYPE any,
                   <lv_fx>   TYPE any.
    DATA: lv_t   TYPE c LENGTH 1,
          lv_len TYPE i.

    DATA(lv_param) = to_upper( iv_param ).
    DATA(lv_field) = to_upper( iv_field ).

    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = lv_param.
    IF sy-subrc <> 0 OR <ls_p>-kind = 'E' OR <ls_p>-ref IS INITIAL.
      rv_error = |BAPI parameter { lv_param } does not exist in { mv_func } (or is not an input parameter)|.
      RETURN.
    ENDIF.

    IF lv_param = gc_longtext_param AND lv_field = gc_longtext_field.
      rv_error = add_long_text( iv_value ).
      RETURN.
    ENDIF.

    DATA(lr_line) = line_of( iv_param = lv_param iv_key = iv_line_key ).
    IF lr_line IS INITIAL.
      rv_error = |BAPI parameter { lv_param } cannot be filled (no DDIC type found in interface of { mv_func })|.
      RETURN.
    ENDIF.
    ASSIGN lr_line->* TO <ls_line>.

    IF cl_abap_typedescr=>describe_by_data( <ls_line> )->kind = cl_abap_typedescr=>kind_elem.
      ASSIGN <ls_line> TO <lv_f>.
    ELSE.
      IF lv_field IS INITIAL.
        rv_error = |No BAPI field name maintained for structure { lv_param }|.
        RETURN.
      ENDIF.
      ASSIGN COMPONENT lv_field OF STRUCTURE <ls_line> TO <lv_f>.
      IF sy-subrc <> 0.
        rv_error = |Field { lv_field } does not exist in BAPI structure { lv_param } ({ <ls_p>-struct })|.
        RETURN.
      ENDIF.
    ENDIF.

    IF iv_if_initial = abap_true AND <lv_f> IS NOT INITIAL.
      RETURN.
    ENDIF.

    TRY.
        convert( EXPORTING iv_value = iv_value CHANGING cv_field = <lv_f> ).
      CATCH lcx_error INTO DATA(lx).
        rv_error = |{ lv_param }-{ lv_field }: { lx->text }|.
        RETURN.
    ENDTRY.

    DATA(lv_xp) = lv_param && 'X'.
    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_px>) WITH TABLE KEY name = lv_xp.
    IF sy-subrc = 0 AND <ls_px>-kind <> 'E' AND <ls_px>-ref IS NOT INITIAL.
      DATA(lr_xl) = line_of( iv_param = lv_xp iv_key = iv_line_key ).
      ASSIGN lr_xl->* TO <ls_xl>.
      ASSIGN COMPONENT lv_field OF STRUCTURE <ls_xl> TO <lv_fx>.
      IF sy-subrc = 0.
        DESCRIBE FIELD <lv_fx> TYPE lv_t.
        IF lv_t = 'C'.
          DESCRIBE FIELD <lv_fx> LENGTH lv_len IN CHARACTER MODE.
        ENDIF.
        IF lv_t = 'C' AND lv_len = 1.
          <lv_fx> = abap_true.
        ELSE.
          <lv_fx> = <lv_f>.
        ENDIF.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD get_value.
    FIELD-SYMBOLS: <ls_v> TYPE any,
                   <lv_w> TYPE any.

    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = to_upper( iv_param ).
    IF sy-subrc <> 0 OR <ls_p>-ref IS INITIAL OR <ls_p>-tab = abap_true.
      RETURN.
    ENDIF.
    ASSIGN <ls_p>-ref->* TO <ls_v>.
    IF iv_field IS INITIAL.
      rv_value = |{ <ls_v> }|.
    ELSE.
      DATA(lv_comp) = to_upper( iv_field ).
      ASSIGN COMPONENT lv_comp OF STRUCTURE <ls_v> TO <lv_w>.
      IF sy-subrc = 0.
        rv_value = |{ <lv_w> }|.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD convert.
    DATA: lv_t     TYPE c LENGTH 1,
          lv_len   TYPE i,
          ls_dfies TYPE dfies,
          lv_num   TYPE string.

    DESCRIBE FIELD cv_field TYPE lv_t.

    CASE lv_t.
      WHEN 'C' OR 'g'.
        IF lv_t = 'C'.
          DESCRIBE FIELD cv_field LENGTH lv_len IN CHARACTER MODE.
          IF strlen( iv_value ) > lv_len.
            RAISE EXCEPTION TYPE lcx_error
              EXPORTING iv_text = |Value '{ iv_value }' is too long (max { lv_len } characters)|.
          ENDIF.
          DATA(lo_el) = CAST cl_abap_elemdescr( cl_abap_typedescr=>describe_by_data( cv_field ) ).
          lo_el->get_ddic_field(
            EXPORTING  p_langu      = sy-langu
            RECEIVING  p_flddescr   = ls_dfies
            EXCEPTIONS not_found    = 1
                       no_ddic_type = 2
                       OTHERS       = 3 ).
          IF sy-subrc = 0 AND ls_dfies-convexit IS NOT INITIAL.
            apply_exit( EXPORTING iv_exit = CONV #( ls_dfies-convexit )
                                  iv_value = iv_value
                        CHANGING  cv_field = cv_field ).
            RETURN.
          ENDIF.
        ENDIF.
        cv_field = iv_value.

      WHEN 'N'.
        DESCRIBE FIELD cv_field LENGTH lv_len IN CHARACTER MODE.
        IF iv_value CN '0123456789'.
          RAISE EXCEPTION TYPE lcx_error
            EXPORTING iv_text = |Value '{ iv_value }' must be numeric|.
        ENDIF.
        IF strlen( iv_value ) > lv_len.
          RAISE EXCEPTION TYPE lcx_error
            EXPORTING iv_text = |Value '{ iv_value }' is too long (max { lv_len } digits)|.
        ENDIF.
        cv_field = iv_value.

      WHEN 'D'.
        cv_field = to_date( iv_value ).

      WHEN 'T'.
        cv_field = to_time( iv_value ).

      WHEN 'P' OR 'F' OR 'I' OR 'b' OR 's' OR '8' OR 'a' OR 'e'.
        lv_num = iv_value.
        REPLACE ALL OCCURRENCES OF ` ` IN lv_num WITH ``.
        IF lv_num CS ',' AND lv_num CS '.'.
          REPLACE ALL OCCURRENCES OF ',' IN lv_num WITH ``.
        ELSEIF lv_num CS ','.
          REPLACE ',' IN lv_num WITH '.'.
        ENDIF.
        TRY.
            cv_field = CONV decfloat34( lv_num ).
          CATCH cx_sy_conversion_error cx_sy_arithmetic_error.
            RAISE EXCEPTION TYPE lcx_error
              EXPORTING iv_text = |'{ iv_value }' is not a valid number for this field|.
        ENDTRY.

      WHEN OTHERS.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |Unsupported BAPI field type '{ lv_t }'|.
    ENDCASE.
  ENDMETHOD.

  METHOD apply_exit.
    DATA: lv_in   TYPE c LENGTH 255,
          lr_in   TYPE REF TO data,
          lr_out  TYPE REF TO data,
          lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab.

    lv_in = iv_value.
    GET REFERENCE OF lv_in    INTO lr_in.
    GET REFERENCE OF cv_field INTO lr_out.
    DATA(lv_fm) = |CONVERSION_EXIT_{ iv_exit }_INPUT|.
    lt_ptab = VALUE #( ( name = 'INPUT'  kind = abap_func_exporting value = lr_in )
                       ( name = 'OUTPUT' kind = abap_func_importing value = lr_out ) ).
    lt_etab = VALUE #( ( name = 'OTHERS' value = 1 ) ).
    TRY.
        CALL FUNCTION lv_fm PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
      CATCH cx_sy_dyn_call_error.
        cv_field = iv_value.
        RETURN.
    ENDTRY.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Value '{ iv_value }' is not valid (conversion exit { iv_exit })|.
    ENDIF.
  ENDMETHOD.

  METHOD to_date.
    DATA: lv_y    TYPE string,
          lv_m    TYPE string,
          lv_d    TYPE string,
          lv_base TYPE d VALUE '18991230',
          lv_n    TYPE i.

    IF iv_value IS INITIAL.
      RETURN.
    ENDIF.

    FIND REGEX '^(\d{4})-?(\d{2})-?(\d{2})' IN iv_value SUBMATCHES lv_y lv_m lv_d.
    IF sy-subrc <> 0.
      FIND REGEX '^(\d{1,2})[./](\d{1,2})[./](\d{4})$' IN iv_value SUBMATCHES lv_d lv_m lv_y.
      IF sy-subrc = 0.
        lv_d = |{ lv_d ALPHA = IN WIDTH = 2 }|.
        lv_m = |{ lv_m ALPHA = IN WIDTH = 2 }|.
      ELSE.
        FIND REGEX '^(\d{5})(\.\d+)?$' IN iv_value SUBMATCHES lv_d.
        IF sy-subrc = 0.
          lv_n = lv_d.
          rv_date = lv_base + lv_n.
          RETURN.
        ENDIF.
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |'{ iv_value }' is not a valid date (use DD.MM.YYYY or YYYYMMDD)|.
      ENDIF.
    ENDIF.

    rv_date = |{ lv_y }{ lv_m }{ lv_d }|.
    CALL FUNCTION 'DATE_CHECK_PLAUSIBILITY'
      EXPORTING
        date                      = rv_date
      EXCEPTIONS
        plausibility_check_failed = 1
        OTHERS                    = 2.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |'{ iv_value }' is not a valid date|.
    ENDIF.
  ENDMETHOD.

  METHOD to_time.
    DATA: lv_h TYPE string,
          lv_m TYPE string,
          lv_s TYPE string.

    IF iv_value IS INITIAL.
      RETURN.
    ENDIF.
    FIND REGEX '^(\d{1,2}):(\d{2})(?::(\d{2}))?' IN iv_value SUBMATCHES lv_h lv_m lv_s.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |'{ iv_value }' is not a valid time (use HH:MM:SS)|.
    ENDIF.
    IF lv_s IS INITIAL.
      lv_s = '00'.
    ENDIF.
    lv_h = |{ lv_h ALPHA = IN WIDTH = 2 }|.
    rv_time = |{ lv_h }{ lv_m }{ lv_s }|.
  ENDMETHOD.

  METHOD add_long_text.
    FIELD-SYMBOLS: <lt_tab> TYPE STANDARD TABLE,
                   <ls_ln>  TYPE any,
                   <lv_tl>  TYPE any.
    DATA: lt_lines TYPE string_table,
          lv_chunk TYPE string.

    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = gc_longtext_param.
    IF sy-subrc <> 0 OR <ls_p>-ref IS INITIAL.
      rv_error = |BAPI parameter { gc_longtext_param } does not exist in { mv_func }|.
      RETURN.
    ENDIF.
    <ls_p>-used = abap_true.
    ASSIGN <ls_p>-ref->* TO <lt_tab>.

    SPLIT iv_value AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
    LOOP AT lt_lines INTO DATA(lv_l).
      DO.
        lv_chunk = COND #( WHEN strlen( lv_l ) > gc_longtext_width
                           THEN substring( val = lv_l len = gc_longtext_width )
                           ELSE lv_l ).
        APPEND INITIAL LINE TO <lt_tab> ASSIGNING <ls_ln>.
        ASSIGN COMPONENT gc_longtext_field OF STRUCTURE <ls_ln> TO <lv_tl>.
        IF sy-subrc <> 0.
          rv_error = |Field { gc_longtext_field } not found in { gc_longtext_param }|.
          RETURN.
        ENDIF.
        <lv_tl> = lv_chunk.
        IF strlen( lv_l ) <= gc_longtext_width.
          EXIT.
        ENDIF.
        lv_l = substring( val = lv_l off = gc_longtext_width ).
      ENDDO.
    ENDLOOP.
  ENDMETHOD.

  METHOD finalize_long_text.
    FIELD-SYMBOLS <lt_tab> TYPE STANDARD TABLE.

    READ TABLE mt_par ASSIGNING FIELD-SYMBOL(<ls_p>) WITH TABLE KEY name = gc_longtext_param.
    IF sy-subrc <> 0 OR <ls_p>-used = abap_false OR <ls_p>-ref IS INITIAL.
      RETURN.
    ENDIF.
    ASSIGN <ls_p>-ref->* TO <lt_tab>.
    DATA(lv_matnr) = get_value( iv_param = 'HEADDATA' iv_field = 'MATERIAL' ).
    LOOP AT <lt_tab> ASSIGNING FIELD-SYMBOL(<ls_ln>).
      default_comp( EXPORTING iv_comp = 'MATERIAL'   iv_val = lv_matnr CHANGING cs_line = <ls_ln> ).
      default_comp( EXPORTING iv_comp = 'TEXT_NAME'  iv_val = lv_matnr CHANGING cs_line = <ls_ln> ).
      default_comp( EXPORTING iv_comp = 'APPLOBJECT' iv_val = `MATERIAL` CHANGING cs_line = <ls_ln> ).
      default_comp( EXPORTING iv_comp = 'TEXT_ID'    iv_val = CONV #( gc_longtext_id ) CHANGING cs_line = <ls_ln> ).
      default_comp( EXPORTING iv_comp = 'LANGU'      iv_val = CONV #( sy-langu ) CHANGING cs_line = <ls_ln> ).
      default_comp( EXPORTING iv_comp = 'FORMAT_COL' iv_val = `*` CHANGING cs_line = <ls_ln> ).
    ENDLOOP.
  ENDMETHOD.

  METHOD default_comp.
    ASSIGN COMPONENT iv_comp OF STRUCTURE cs_line TO FIELD-SYMBOL(<lv_c>).
    IF sy-subrc = 0 AND <lv_c> IS INITIAL AND iv_val IS NOT INITIAL.
      <lv_c> = iv_val.
    ENDIF.
  ENDMETHOD.

  METHOD execute.
    DATA: lt_ptab TYPE abap_func_parmbind_tab,
          lt_etab TYPE abap_func_excpbind_tab,
          ls_ret  TYPE bapiret2.
    FIELD-SYMBOLS: <lt_tab> TYPE STANDARD TABLE,
                   <ls_ret> TYPE any.

    finalize_long_text( ).

    LOOP AT mt_par ASSIGNING FIELD-SYMBOL(<ls_p>).
      IF <ls_p>-ref IS INITIAL.
        CONTINUE.
      ENDIF.
      CASE <ls_p>-kind.
        WHEN 'I'.
          IF <ls_p>-used = abap_true.
            APPEND VALUE #( name = <ls_p>-name kind = abap_func_exporting value = <ls_p>-ref ) TO lt_ptab.
          ENDIF.
        WHEN 'E'.
          APPEND VALUE #( name = <ls_p>-name kind = abap_func_importing value = <ls_p>-ref ) TO lt_ptab.
        WHEN 'T'.
          APPEND VALUE #( name = <ls_p>-name kind = abap_func_tables value = <ls_p>-ref ) TO lt_ptab.
      ENDCASE.
    ENDLOOP.

    lt_etab = VALUE #( ( name = 'ERROR_MESSAGE' value = 1 )
                       ( name = 'OTHERS'        value = 2 ) ).

    TRY.
        CALL FUNCTION mv_func PARAMETER-TABLE lt_ptab EXCEPTION-TABLE lt_etab.
      CATCH cx_sy_dyn_call_error INTO DATA(lx_dyn).
        APPEND VALUE #( type = 'E' message = |Dynamic call of { mv_func } failed: { lx_dyn->get_text( ) }| ) TO rt_return.
        RETURN.
    ENDTRY.

    IF sy-subrc <> 0.
      IF sy-msgid IS NOT INITIAL.
        MESSAGE ID sy-msgid TYPE 'E' NUMBER sy-msgno
                WITH sy-msgv1 sy-msgv2 sy-msgv3 sy-msgv4 INTO DATA(lv_text).
      ELSE.
        lv_text = |{ mv_func } raised exception (sy-subrc { sy-subrc })|.
      ENDIF.
      APPEND VALUE #( type = 'E' id = sy-msgid number = sy-msgno message = lv_text ) TO rt_return.
      RETURN.
    ENDIF.

    LOOP AT mt_par ASSIGNING <ls_p> WHERE kind = 'T' AND struct = 'BAPIRET2'.
      ASSIGN <ls_p>-ref->* TO <lt_tab>.
      LOOP AT <lt_tab> ASSIGNING <ls_ret>.
        CLEAR ls_ret.
        MOVE-CORRESPONDING <ls_ret> TO ls_ret.
        APPEND ls_ret TO rt_return.
      ENDLOOP.
    ENDLOOP.
    IF rt_return IS INITIAL.
      LOOP AT mt_par ASSIGNING <ls_p> WHERE kind = 'E' AND struct = 'BAPIRET2'.
        ASSIGN <ls_p>-ref->* TO <ls_ret>.
        CLEAR ls_ret.
        MOVE-CORRESPONDING <ls_ret> TO ls_ret.
        IF ls_ret IS NOT INITIAL.
          APPEND ls_ret TO rt_return.
        ENDIF.
      ENDLOOP.
    ENDIF.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Log
*----------------------------------------------------------------------*
CLASS lcl_log DEFINITION FINAL.
  PUBLIC SECTION.
    DATA mt_log TYPE ty_t_log READ-ONLY.
    METHODS:
      add        IMPORTING iv_row   TYPE i
                           iv_matnr TYPE string
                           iv_type  TYPE bapi_mtype
                           iv_stage TYPE string
                           iv_field TYPE string OPTIONAL
                           iv_text  TYPE string,
      add_return IMPORTING iv_row    TYPE i
                           iv_matnr  TYPE string
                           iv_stage  TYPE string
                           it_return TYPE bapiret2_t,
      has_error  IMPORTING it_return      TYPE bapiret2_t
                 RETURNING VALUE(rv_err)  TYPE abap_bool.
ENDCLASS.

CLASS lcl_log IMPLEMENTATION.

  METHOD add.
    DATA(ls_log) = VALUE ty_log(
      row_no  = iv_row
      matnr   = iv_matnr
      icon    = SWITCH icon_d( iv_type WHEN 'S' THEN icon_led_green
                                       WHEN 'W' THEN icon_led_yellow
                                       WHEN 'E' THEN icon_led_red
                                       WHEN 'A' THEN icon_led_red
                                       ELSE icon_led_inactive )
      type    = iv_type
      stage   = iv_stage
      field   = iv_field
      message = iv_text ).
    IF line_exists( mt_log[ row_no = ls_log-row_no type = ls_log-type
                            stage = ls_log-stage field = ls_log-field
                            message = ls_log-message ] ).
      RETURN.
    ENDIF.
    APPEND ls_log TO mt_log.
  ENDMETHOD.

  METHOD add_return.
    LOOP AT it_return ASSIGNING FIELD-SYMBOL(<ls_r>).
      DATA(lv_text) = COND string( WHEN <ls_r>-message IS NOT INITIAL
                                   THEN CONV string( <ls_r>-message )
                                   ELSE |{ <ls_r>-id } { <ls_r>-number }| ).
      add( iv_row = iv_row iv_matnr = iv_matnr iv_type = <ls_r>-type
           iv_stage = iv_stage iv_text = lv_text ).
    ENDLOOP.
  ENDMETHOD.

  METHOD has_error.
    LOOP AT it_return TRANSPORTING NO FIELDS WHERE type = 'E' OR type = 'A'.
      rv_err = abap_true.
      RETURN.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Validator
*----------------------------------------------------------------------*
CLASS lcl_validator DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS value_of
      IMPORTING is_row        TYPE ty_row
                iv_name       TYPE string
      RETURNING VALUE(rv_val) TYPE string.

    METHODS:
      constructor IMPORTING io_config TYPE REF TO lcl_config
                            io_log    TYPE REF TO lcl_log,
      validate    IMPORTING is_row TYPE ty_row
                  EXPORTING et_map TYPE ty_t_map
                            ev_ok  TYPE abap_bool.

  PRIVATE SECTION.
    DATA: mo_cfg TYPE REF TO lcl_config,
          mo_log TYPE REF TO lcl_log.

    METHODS:
      line_key_of IMPORTING iv_name       TYPE string
                  RETURNING VALUE(rv_key) TYPE i,
      norm        IMPORTING iv_val        TYPE clike
                  RETURNING VALUE(rv_val) TYPE string,
      add_map     IMPORTING is_cfg  TYPE ty_cfg
                            iv_name TYPE string
                            iv_val  TYPE string
                  CHANGING  ct_map  TYPE ty_t_map.
ENDCLASS.

CLASS lcl_validator IMPLEMENTATION.

  METHOD constructor.
    mo_cfg = io_config.
    mo_log = io_log.
  ENDMETHOD.

  METHOD value_of.
    READ TABLE is_row-fields ASSIGNING FIELD-SYMBOL(<ls_f>) WITH TABLE KEY name = iv_name.
    IF sy-subrc = 0.
      rv_val = <ls_f>-value.
    ENDIF.
  ENDMETHOD.

  METHOD norm.
    rv_val = to_upper( condense( CONV string( iv_val ) ) ).
  ENDMETHOD.

  METHOD line_key_of.
    DATA lv_n TYPE string.
    FIND REGEX '_(\d+)$' IN iv_name SUBMATCHES lv_n.
    IF sy-subrc = 0.
      rv_key = lv_n.
    ENDIF.
  ENDMETHOD.

  METHOD add_map.
    APPEND VALUE #( view_tab   = is_cfg-view_tab
                    temp_field = iv_name
                    struct     = norm( is_cfg-bapi_struct_name )
                    field      = norm( is_cfg-bapi_field_name )
                    value      = iv_val
                    line_key   = line_key_of( iv_name ) ) TO ct_map.
  ENDMETHOD.

  METHOD validate.
    CLEAR et_map.
    ev_ok = abap_true.

    DATA(lv_matnr) = value_of( is_row = is_row iv_name = 'MATNR' ).

    LOOP AT mo_cfg->mt_cfg ASSIGNING FIELD-SYMBOL(<ls_c>).
      DATA(lv_name)  = norm( <ls_c>-temp_field_name ).
      DATA(lv_val)   = value_of( is_row = is_row iv_name = lv_name ).
      DATA(lv_given) = COND abap_bool( WHEN lv_val IS NOT INITIAL THEN abap_true ELSE abap_false ).

      IF <ls_c>-mandatory = abap_true.
        IF lv_given = abap_false.
          mo_log->add( iv_row = is_row-row_no iv_matnr = lv_matnr iv_type = 'E'
                       iv_stage = 'VALIDATE' iv_field = lv_name
                       iv_text = |Mandatory field { lv_name } ({ <ls_c>-description }) is missing| ).
          ev_ok = abap_false.
        ELSE.
          add_map( EXPORTING is_cfg = <ls_c> iv_name = lv_name iv_val = lv_val CHANGING ct_map = et_map ).
        ENDIF.

      ELSEIF <ls_c>-optional = abap_true.
        IF lv_given = abap_true.
          add_map( EXPORTING is_cfg = <ls_c> iv_name = lv_name iv_val = lv_val CHANGING ct_map = et_map ).
        ENDIF.

      ELSEIF <ls_c>-system_derived = abap_true.
      ELSEIF <ls_c>-cond_mandatory = abap_true.
        IF lv_given = abap_true.
          add_map( EXPORTING is_cfg = <ls_c> iv_name = lv_name iv_val = lv_val CHANGING ct_map = et_map ).
        ENDIF.
        LOOP AT mo_cfg->mt_cond ASSIGNING FIELD-SYMBOL(<ls_k>).
          IF norm( <ls_k>-source_field ) <> lv_name OR lv_given = abap_false.
            CONTINUE.
          ENDIF.
          DATA(lv_dep) = norm( <ls_k>-condmat_field ).
          IF value_of( is_row = is_row iv_name = lv_dep ) IS INITIAL.
            mo_log->add( iv_row = is_row-row_no iv_matnr = lv_matnr iv_type = 'E'
                         iv_stage = 'VALIDATE' iv_field = lv_dep
                         iv_text = |Conditional mandatory: { lv_dep } ({ <ls_k>-condmat_dec }) is required when { lv_name } ({ <ls_k>-source_dec }) is provided| ).
            ev_ok = abap_false.
          ENDIF.
        ENDLOOP.
      ENDIF.

      IF lv_given = abap_true AND <ls_c>-system_derived = abap_false
         AND <ls_c>-bapi_struct_name IS INITIAL.
        mo_log->add( iv_row = is_row-row_no iv_matnr = lv_matnr iv_type = 'W'
                     iv_stage = 'VALIDATE' iv_field = lv_name
                     iv_text = |No BAPI structure maintained for { lv_name } - value ignored| ).
      ENDIF.
    ENDLOOP.

    DELETE et_map WHERE struct = ''.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Output: ALV, server file, e-mail
*----------------------------------------------------------------------*
CLASS lcl_output DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      show_alv    IMPORTING it_log TYPE ty_t_log
                            iv_title TYPE string,
      save_server IMPORTING it_log TYPE ty_t_log
                  RAISING   lcx_error,
      send_mail   IMPORTING it_log TYPE ty_t_log
                            iv_title TYPE string
                  RAISING   lcx_error.
  PRIVATE SECTION.
    CLASS-METHODS:
      to_csv      IMPORTING it_log        TYPE ty_t_log
                  RETURNING VALUE(rv_csv) TYPE string,
      quote       IMPORTING iv_val        TYPE string
                  RETURNING VALUE(rv_val) TYPE string,
      server_path RETURNING VALUE(rv_path) TYPE string,
      set_col     IMPORTING io_cols TYPE REF TO cl_salv_columns_table
                            iv_name TYPE lvc_fname
                            iv_text TYPE scrtext_l
                            iv_len  TYPE lvc_outlen.
ENDCLASS.

CLASS lcl_output IMPLEMENTATION.

  METHOD show_alv.
    DATA lt_log TYPE ty_t_log.
    lt_log = it_log.
    TRY.
        cl_salv_table=>factory( IMPORTING r_salv_table = DATA(lo_alv)
                                CHANGING  t_table      = lt_log ).
        lo_alv->get_functions( )->set_all( abap_true ).
        lo_alv->get_display_settings( )->set_list_header( CONV #( iv_title ) ).
        lo_alv->get_display_settings( )->set_striped_pattern( abap_true ).
        DATA(lo_cols) = lo_alv->get_columns( ).
        lo_cols->set_optimize( abap_true ).
        set_col( io_cols = lo_cols iv_name = 'ROW_NO'  iv_text = 'Row'      iv_len = 6 ).
        set_col( io_cols = lo_cols iv_name = 'MATNR'   iv_text = 'Material' iv_len = 18 ).
        set_col( io_cols = lo_cols iv_name = 'ICON'    iv_text = 'Status'   iv_len = 6 ).
        set_col( io_cols = lo_cols iv_name = 'TYPE'    iv_text = 'Type'     iv_len = 4 ).
        set_col( io_cols = lo_cols iv_name = 'STAGE'   iv_text = 'Stage'    iv_len = 10 ).
        set_col( io_cols = lo_cols iv_name = 'FIELD'   iv_text = 'Template field' iv_len = 20 ).
        set_col( io_cols = lo_cols iv_name = 'MESSAGE' iv_text = 'Message'  iv_len = 120 ).
        CAST cl_salv_column_table( lo_cols->get_column( 'ICON' ) )->set_icon( if_salv_c_bool_sap=>true ).
        lo_alv->get_sorts( )->add_sort( columnname = 'ROW_NO' ).
        lo_alv->display( ).
      CATCH cx_salv_error INTO DATA(lx).
        DATA(lv_text) = lx->get_text( ).
        MESSAGE lv_text TYPE 'S' DISPLAY LIKE 'E'.
    ENDTRY.
  ENDMETHOD.

  METHOD set_col.
    TRY.
        DATA(lo_col) = io_cols->get_column( iv_name ).
        lo_col->set_short_text( CONV #( iv_text ) ).
        lo_col->set_medium_text( CONV #( iv_text ) ).
        lo_col->set_long_text( iv_text ).
        lo_col->set_output_length( iv_len ).
      CATCH cx_salv_not_found.
        RETURN.
    ENDTRY.
  ENDMETHOD.

  METHOD quote.
    rv_val = |"{ replace( val = iv_val sub = `"` with = `""` occ = 0 ) }"|.
  ENDMETHOD.

  METHOD to_csv.
    DATA(lv_nl) = cl_abap_char_utilities=>cr_lf.
    rv_csv = |ROW;MATERIAL;TYPE;STAGE;FIELD;MESSAGE{ lv_nl }|.
    LOOP AT it_log ASSIGNING FIELD-SYMBOL(<ls_l>).
      rv_csv = rv_csv && |{ <ls_l>-row_no };{ quote( CONV #( <ls_l>-matnr ) ) };{ <ls_l>-type };|
                      && |{ quote( CONV #( <ls_l>-stage ) ) };{ quote( CONV #( <ls_l>-field ) ) };|
                      && |{ quote( CONV #( <ls_l>-message ) ) }{ lv_nl }|.
    ENDLOOP.
  ENDMETHOD.

  METHOD server_path.
    DATA(lv_p) = CONV string( p_file3 ).
    IF lv_p IS INITIAL.
      RETURN.
    ENDIF.
    IF lcl_file_io=>get_extension( lv_p ) IS NOT INITIAL.
      rv_path = lv_p.
      RETURN.
    ENDIF.
    IF lv_p NP '*/' AND lv_p NP '*\'.
      lv_p = lv_p && '/'.
    ENDIF.
    rv_path = |{ lv_p }MATERIAL_LOAD_{ sy-datum }_{ sy-uzeit }.csv|.
  ENDMETHOD.

  METHOD save_server.
    DATA(lv_path) = server_path( ).
    IF lv_path IS INITIAL.
      RETURN.
    ENDIF.
    lcl_file_io=>write_server( iv_file = lv_path iv_text = to_csv( it_log ) ).
    DATA(lv_msg) = |Output stored on server: { lv_path }|.
    MESSAGE lv_msg TYPE 'S'.
  ENDMETHOD.

  METHOD send_mail.
    DATA: lt_solix TYPE solix_tab,
          lv_size  TYPE so_obj_len.

    IF p_email IS INITIAL.
      RETURN.
    ENDIF.

    TRY.
        cl_bcs_convert=>string_to_solix( EXPORTING iv_string   = to_csv( it_log )
                                                   iv_codepage = '4110'
                                                   iv_add_bom  = abap_true
                                         IMPORTING et_solix    = lt_solix
                                                   ev_size     = lv_size ).
        DATA(lo_doc) = cl_document_bcs=>create_document(
          i_type    = 'RAW'
          i_subject = CONV #( iv_title )
          i_text    = cl_bcs_convert=>string_to_soli( |{ iv_title }. Please see the attached result file.| ) ).
        lo_doc->add_attachment( i_attachment_type    = 'CSV'
                                i_attachment_subject = 'MaterialLoadResult'
                                i_attachment_size    = lv_size
                                i_att_content_hex    = lt_solix ).
        DATA(lo_bcs) = cl_bcs=>create_persistent( ).
        lo_bcs->set_document( lo_doc ).
        lo_bcs->add_recipient( cl_cam_address_bcs=>create_internet_address( p_email ) ).
        lo_bcs->set_send_immediately( abap_true ).
        lo_bcs->send( ).
        COMMIT WORK.
        DATA(lv_msg) = |Result sent to { p_email }|.
        MESSAGE lv_msg TYPE 'S'.
      CATCH cx_bcs INTO DATA(lx_bcs).
        RAISE EXCEPTION TYPE lcx_error
          EXPORTING iv_text = |E-mail could not be sent: { lx_bcs->get_text( ) }|.
    ENDTRY.
  ENDMETHOD.

ENDCLASS.

*----------------------------------------------------------------------*
* Application
*----------------------------------------------------------------------*
CLASS lcl_app DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS:
      on_output,
      on_input.
    METHODS run.

  PRIVATE SECTION.
    CONSTANTS: gc_save       TYPE rs38l_fnam VALUE 'BAPI_MATERIAL_SAVEREPLICA',
               gc_cls_create TYPE rs38l_fnam VALUE 'BAPI_OBJCL_CREATE',
               gc_cls_change TYPE rs38l_fnam VALUE 'BAPI_OBJCL_CHANGE'.

    DATA: mo_cfg    TYPE REF TO lcl_config,
          mo_log    TYPE REF TO lcl_log,
          mo_val    TYPE REF TO lcl_validator,
          mv_ok     TYPE i,
          mv_err    TYPE i,
          mv_row    TYPE i,
          mv_matnr  TYPE string,
          mv_failed TYPE abap_bool.

    CLASS-METHODS:
      set_listbox     IMPORTING iv_id   TYPE vrm_id
                                it_vrm  TYPE vrm_values
                      CHANGING  cv_val  TYPE any,
      download_template RAISING lcx_error,
      to_matnr        IMPORTING iv_matnr       TYPE string
                      RETURNING VALUE(rv_matnr) TYPE matnr,
      rename_class_param IMPORTING iv_name        TYPE string
                         RETURNING VALUE(rv_name) TYPE string.

    METHODS:
      check_inputs     RAISING lcx_error,
      read_template    RETURNING VALUE(rt_rows) TYPE ty_t_row
                       RAISING   lcx_error,
      process_row      IMPORTING is_row TYPE ty_row,
      process_row_main IMPORTING is_row TYPE ty_row
                       RAISING   lcx_error,
      precheck         IMPORTING is_row   TYPE ty_row
                       EXPORTING ev_matnr TYPE matnr,
      class_stage      IMPORTING io_class TYPE REF TO lcl_bapi
                                 it_map   TYPE ty_t_map
                                 iv_matnr TYPE matnr
                       RAISING   lcx_error,
      class_assigned   IMPORTING iv_matnr       TYPE matnr
                                 iv_klart       TYPE string
                                 iv_class       TYPE string
                       RETURNING VALUE(rv_found) TYPE abap_bool,
      commit_or_rollback IMPORTING iv_commit TYPE abap_bool,
      msg              IMPORTING iv_type  TYPE bapi_mtype
                                 iv_stage TYPE string
                                 iv_text  TYPE string
                                 iv_field TYPE string OPTIONAL.
ENDCLASS.

CLASS lcl_app IMPLEMENTATION.

  METHOD on_output.
    LOOP AT SCREEN.
      CASE screen-group1.
        WHEN 'MD1'.
          screen-active = COND #( WHEN r_local = abap_true THEN 1 ELSE 0 ).
          MODIFY SCREEN.
        WHEN 'MD2'.
          screen-active = COND #( WHEN r_unix = abap_true THEN 1 ELSE 0 ).
          MODIFY SCREEN.
      ENDCASE.
    ENDLOOP.

    set_listbox( EXPORTING iv_id = 'P_MTART'  it_vrm = lcl_config=>list_values( 'MTART' )
                 CHANGING  cv_val = p_mtart ).
    set_listbox( EXPORTING iv_id = 'P_INDSEC' it_vrm = lcl_config=>list_values( 'INDSEC' )
                 CHANGING  cv_val = p_indsec ).
    set_listbox( EXPORTING iv_id = 'P_BUSPRF' it_vrm = lcl_config=>list_values( 'BUSPRF' )
                 CHANGING  cv_val = p_busprf ).
  ENDMETHOD.

  METHOD set_listbox.
    DATA(lv_key) = CONV vrm_value-key( cv_val ).
    CALL FUNCTION 'VRM_SET_VALUES'
      EXPORTING
        id     = iv_id
        values = it_vrm.
    IF lv_key IS NOT INITIAL AND NOT line_exists( it_vrm[ key = lv_key ] ).
      CLEAR cv_val.
    ENDIF.
  ENDMETHOD.

  METHOD on_input.
    IF sy-ucomm = 'BTN_CLK'.
      TRY.
          download_template( ).
        CATCH lcx_error INTO DATA(lx).
          MESSAGE lx->text TYPE 'S' DISPLAY LIKE 'E'.
      ENDTRY.
    ENDIF.
  ENDMETHOD.

  METHOD download_template.
    DATA: lv_file TYPE string,
          lv_path TYPE string,
          lv_full TYPE string,
          lv_act  TYPE i.

    DATA(lv_srv) = CONV string( text-007 ).
    IF lv_srv IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Template path on application server is not maintained (text symbol 007)|.
    ENDIF.
    DATA(lv_ext) = lcl_file_io=>get_extension( lv_srv ).
    IF lv_ext <> '.xlsx' AND lv_ext <> '.csv'.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Template on server must be a .xlsx or .csv file|.
    ENDIF.

    DATA(lv_xstr) = lcl_file_io=>read_server( lv_srv ).
    DATA(lv_name) = match( val = lv_srv regex = '[^/\\]+$' ).

    cl_gui_frontend_services=>file_save_dialog(
      EXPORTING  window_title      = 'Save template'
                 default_extension = substring( val = lv_ext off = 1 )
                 default_file_name = lv_name
      CHANGING   filename          = lv_file
                 path              = lv_path
                 fullpath          = lv_full
                 user_action       = lv_act
      EXCEPTIONS OTHERS            = 1 ).
    IF sy-subrc <> 0 OR lv_act <> cl_gui_frontend_services=>action_ok.
      RETURN.
    ENDIF.

    DATA(lt_bin) = cl_bcs_convert=>xstring_to_solix( lv_xstr ).
    cl_gui_frontend_services=>gui_download(
      EXPORTING  bin_filesize = xstrlen( lv_xstr )
                 filename     = lv_full
                 filetype     = 'BIN'
      CHANGING   data_tab     = lt_bin
      EXCEPTIONS OTHERS       = 1 ).
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Template could not be saved to { lv_full }|.
    ENDIF.
    DATA(lv_msg) = |Template downloaded to { lv_full }|.
    MESSAGE lv_msg TYPE 'S'.
  ENDMETHOD.

  METHOD run.
    TRY.
        check_inputs( ).
        DATA(lt_rows) = read_template( ).

        mo_log = NEW #( ).
        mo_cfg = NEW #( ).
        mo_cfg->load( ).
        mo_val = NEW #( io_config = mo_cfg io_log = mo_log ).

        LOOP AT lt_rows ASSIGNING FIELD-SYMBOL(<ls_row>).
          process_row( <ls_row> ).
        ENDLOOP.

      CATCH lcx_error INTO DATA(lx).
        MESSAGE lx->text TYPE 'S' DISPLAY LIKE 'E'.
        RETURN.
    ENDTRY.

    DATA(lv_title) = |Material { SWITCH string( lcl_config=>get_operation( ) WHEN 'C' THEN `create` WHEN 'U' THEN `update` ELSE `extend` ) }|
                  && |{ COND string( WHEN p_test = abap_true THEN ` (TEST RUN)` ELSE `` ) }|
                  && | - { mv_ok } row(s) OK, { mv_err } row(s) with errors|.

    TRY.
        lcl_output=>save_server( mo_log->mt_log ).
      CATCH lcx_error INTO lx.
        MESSAGE lx->text TYPE 'S' DISPLAY LIKE 'E'.
    ENDTRY.
    TRY.
        lcl_output=>send_mail( it_log = mo_log->mt_log iv_title = lv_title ).
      CATCH lcx_error INTO lx.
        MESSAGE lx->text TYPE 'S' DISPLAY LIKE 'E'.
    ENDTRY.

    lcl_output=>show_alv( it_log = mo_log->mt_log iv_title = lv_title ).
  ENDMETHOD.

  METHOD check_inputs.
    IF p_mtart IS INITIAL OR p_indsec IS INITIAL OR p_busprf IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Select material type, industry sector and business profile|.
    ENDIF.

    DATA(lv_file) = COND string( WHEN r_local = abap_true THEN p_file1 ELSE p_file2 ).
    IF lv_file IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Provide the template file|.
    ENDIF.

    DATA(lv_ext) = lcl_file_io=>get_extension( lv_file ).
    IF lv_ext <> '.xlsx' AND lv_ext <> '.csv'.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Invalid file format. Only .xlsx and .csv files are allowed.|.
    ENDIF.

    IF p_email IS NOT INITIAL AND p_email NS '@'.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Invalid e-mail address { p_email }|.
    ENDIF.
  ENDMETHOD.

  METHOD read_template.
    DATA(lv_file) = COND string( WHEN r_local = abap_true THEN p_file1 ELSE p_file2 ).
    DATA(lv_xstr) = COND xstring( WHEN r_local = abap_true THEN lcl_file_io=>read_local( lv_file )
                                  ELSE lcl_file_io=>read_server( lv_file ) ).
    rt_rows = lcl_template=>read( iv_xstr = lv_xstr
                                  iv_ext  = lcl_file_io=>get_extension( lv_file )
                                  iv_name = lv_file ).
  ENDMETHOD.

  METHOD msg.
    mo_log->add( iv_row = mv_row iv_matnr = mv_matnr iv_type = iv_type
                 iv_stage = iv_stage iv_field = iv_field iv_text = iv_text ).
    IF iv_type = 'E' OR iv_type = 'A'.
      mv_failed = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD process_row.
    mv_row    = is_row-row_no.
    mv_matnr  = lcl_validator=>value_of( is_row = is_row iv_name = 'MATNR' ).
    mv_failed = abap_false.

    TRY.
        process_row_main( is_row ).
      CATCH lcx_error INTO DATA(lx).
        msg( iv_type = 'E' iv_stage = 'ERROR' iv_text = lx->text ).
      CATCH cx_root INTO DATA(lx_root).
        msg( iv_type = 'E' iv_stage = 'ERROR' iv_text = |Unexpected error: { lx_root->get_text( ) }| ).
    ENDTRY.

    IF mv_failed = abap_true.
      mv_err = mv_err + 1.
      msg( iv_type = 'E' iv_stage = 'RESULT' iv_text = |Row { mv_row } failed - nothing was saved for this row| ).
    ELSE.
      mv_ok = mv_ok + 1.
    ENDIF.
  ENDMETHOD.

  METHOD to_matnr.
    DATA lv_in TYPE c LENGTH 255.
    lv_in = iv_matnr.
    CALL FUNCTION 'CONVERSION_EXIT_MATN1_INPUT'
      EXPORTING
        input        = lv_in
      IMPORTING
        output       = rv_matnr
      EXCEPTIONS
        length_error = 1
        OTHERS       = 2.
    IF sy-subrc <> 0.
      CLEAR rv_matnr.
    ENDIF.
  ENDMETHOD.

  METHOD precheck.
    DATA(lv_op)  = lcl_config=>get_operation( ).
    DATA(lv_act) = to_upper( lcl_validator=>value_of( is_row = is_row iv_name = 'ACTION' ) ).

    IF lv_act IS NOT INITIAL.
      DATA(lv_a) = SWITCH string( lv_act WHEN 'C' OR 'CREATE' THEN `C`
                                         WHEN 'U' OR 'UPDATE' THEN `U`
                                         WHEN 'E' OR 'EXTEND' THEN `E`
                                         ELSE `` ).
      IF lv_a <> lv_op.
        msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'ACTION'
             iv_text = |ACTION '{ lv_act }' does not match the selected operation| ).
      ENDIF.
    ENDIF.

    DATA(lv_mtart) = to_upper( lcl_validator=>value_of( is_row = is_row iv_name = 'MTART' ) ).
    IF lv_mtart IS NOT INITIAL AND lv_mtart <> p_mtart.
      msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'MTART'
           iv_text = |Material type { lv_mtart } in template differs from selection { p_mtart }| ).
    ENDIF.

    IF mv_matnr IS NOT INITIAL.
      ev_matnr = to_matnr( mv_matnr ).
      IF ev_matnr IS INITIAL.
        msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'MATNR'
             iv_text = |Material number { mv_matnr } is not valid| ).
        RETURN.
      ENDIF.
      SELECT SINGLE matnr FROM mara WHERE matnr = @ev_matnr INTO @DATA(lv_exists).
      IF sy-subrc = 0 AND lv_op = 'C'.
        msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'MATNR'
             iv_text = |Material { mv_matnr } already exists - use Update or Extend| ).
      ELSEIF sy-subrc <> 0 AND lv_op <> 'C'.
        msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'MATNR'
             iv_text = |Material { mv_matnr } does not exist| ).
      ENDIF.
    ELSEIF lv_op <> 'C'.
      msg( iv_type = 'E' iv_stage = 'CHECK' iv_field = 'MATNR'
           iv_text = |Material number is required for update / extend| ).
    ENDIF.
  ENDMETHOD.

  METHOD process_row_main.
    DATA: lv_matnr     TYPE matnr,
          lo_class     TYPE REF TO lcl_bapi,
          lt_class_map TYPE ty_t_map,
          lv_err       TYPE string.

    precheck( EXPORTING is_row = is_row IMPORTING ev_matnr = lv_matnr ).
    mo_val->validate( EXPORTING is_row = is_row
                      IMPORTING et_map = DATA(lt_map)
                                ev_ok  = DATA(lv_ok) ).
    IF mv_failed = abap_true OR lv_ok = abap_false.
      mv_failed = abap_true.
      RETURN.
    ENDIF.

    DATA(lo_save) = NEW lcl_bapi( gc_save ).
    LOOP AT lt_map ASSIGNING FIELD-SYMBOL(<ls_m>).
      CLEAR lv_err.
      IF lo_save->has_param( <ls_m>-struct ) = abap_true.
        lv_err = lo_save->set_value( iv_param = <ls_m>-struct iv_field = <ls_m>-field
                                     iv_value = <ls_m>-value  iv_line_key = <ls_m>-line_key ).
      ELSE.
        IF lo_class IS NOT BOUND.
          lo_class = NEW #( gc_cls_create ).
        ENDIF.
        IF lo_class->has_param( <ls_m>-struct ) = abap_true.
          lv_err = lo_class->set_value( iv_param = <ls_m>-struct iv_field = <ls_m>-field
                                        iv_value = <ls_m>-value  iv_line_key = <ls_m>-line_key ).
          APPEND <ls_m> TO lt_class_map.
        ELSE.
          lv_err = |BAPI structure { <ls_m>-struct } exists neither in { gc_save } nor in { gc_cls_create }|.
        ENDIF.
      ENDIF.
      IF lv_err IS NOT INITIAL.
        msg( iv_type = 'E' iv_stage = 'MAPPING' iv_field = <ls_m>-temp_field iv_text = lv_err ).
      ENDIF.
    ENDLOOP.

    DATA(lt_head) = VALUE ty_t_map(
      ( struct = 'HEADDATA' field = 'MATL_TYPE'  value = CONV #( p_mtart ) )
      ( struct = 'HEADDATA' field = 'IND_SECTOR' value = CONV #( p_indsec ) )
      ( struct = 'HEADDATA' field = 'BASIC_VIEW' value = 'X' ) ).
    IF lv_matnr IS NOT INITIAL.
      APPEND VALUE #( struct = 'HEADDATA' field = 'MATERIAL' value = CONV #( lv_matnr ) ) TO lt_head.
    ENDIF.
    IF p_sales = abap_true.
      APPEND VALUE #( struct = 'HEADDATA' field = 'SALES_VIEW' value = 'X' ) TO lt_head.
    ENDIF.
    IF p_purch = abap_true.
      APPEND VALUE #( struct = 'HEADDATA' field = 'PURCHASE_VIEW' value = 'X' ) TO lt_head.
    ENDIF.
    IF p_mrp = abap_true.
      APPEND VALUE #( struct = 'HEADDATA' field = 'MRP_VIEW' value = 'X' ) TO lt_head.
    ENDIF.
    IF p_plnst = abap_true.
      APPEND VALUE #( struct = 'HEADDATA' field = 'STORAGE_VIEW' value = 'X' ) TO lt_head.
    ENDIF.
    IF p_val = abap_true.
      APPEND VALUE #( struct = 'HEADDATA' field = 'ACCOUNT_VIEW' value = 'X' ) TO lt_head.
    ENDIF.
    LOOP AT lt_head ASSIGNING FIELD-SYMBOL(<ls_h>).
      lv_err = lo_save->set_value( iv_param = <ls_h>-struct iv_field = <ls_h>-field
                                   iv_value = <ls_h>-value iv_if_initial = abap_true ).
      IF lv_err IS NOT INITIAL.
        msg( iv_type = 'E' iv_stage = 'MAPPING' iv_field = <ls_h>-field iv_text = lv_err ).
      ENDIF.
    ENDLOOP.

    IF mv_failed = abap_true.
      RETURN.
    ENDIF.

    DATA(lt_ret) = lo_save->execute( ).
    mo_log->add_return( iv_row = mv_row iv_matnr = mv_matnr iv_stage = 'SAVE' it_return = lt_ret ).

    IF mo_log->has_error( lt_ret ) = abap_true.
      commit_or_rollback( abap_false ).
      mv_failed = abap_true.
      RETURN.
    ENDIF.

    DATA(lv_new) = lv_matnr.
    LOOP AT lt_ret ASSIGNING FIELD-SYMBOL(<ls_r>)
         WHERE type = 'S' AND id = 'M3' AND ( number = '800' OR number = '801' ).
      lv_new = to_matnr( CONV #( <ls_r>-message_v1 ) ).
      EXIT.
    ENDLOOP.
    IF lv_new IS NOT INITIAL AND mv_matnr IS INITIAL.
      mv_matnr = lv_new.
    ENDIF.

    IF p_test = abap_true.
      commit_or_rollback( abap_false ).
      msg( iv_type = 'S' iv_stage = 'RESULT'
           iv_text = |Test run OK - BAPI reported no errors, nothing was saved| ).
      IF lo_class IS BOUND.
        msg( iv_type = 'W' iv_stage = 'CLASS'
             iv_text = |Classification is not simulated in test run (material does not exist yet)| ).
      ENDIF.
      RETURN.
    ENDIF.

    commit_or_rollback( abap_true ).

    IF lo_class IS BOUND.
      TRY.
          class_stage( io_class = lo_class it_map = lt_class_map iv_matnr = lv_new ).
        CATCH lcx_error INTO DATA(lx).
          commit_or_rollback( abap_false ).
          msg( iv_type = 'E' iv_stage = 'CLASS' iv_text = |Material { mv_matnr } saved, but classification failed: { lx->text }| ).
          RETURN.
      ENDTRY.
    ENDIF.

    msg( iv_type = 'S' iv_stage = 'RESULT'
         iv_text = |Material { mv_matnr } { SWITCH string( lcl_config=>get_operation( ) WHEN 'C' THEN `created` WHEN 'U' THEN `updated` ELSE `extended` ) } successfully| ).
  ENDMETHOD.

  METHOD commit_or_rollback.
    IF iv_commit = abap_true.
      CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
        EXPORTING
          wait = abap_true.
    ELSE.
      CALL FUNCTION 'BAPI_TRANSACTION_ROLLBACK'.
    ENDIF.
  ENDMETHOD.

  METHOD rename_class_param.
    IF iv_name = 'OBJECTKEYNEW' OR iv_name = 'OBJECTTABLENEW'
       OR iv_name = 'CLASSNUMNEW' OR iv_name = 'CLASSTYPENEW'.
      rv_name = substring( val = iv_name len = strlen( iv_name ) - 3 ).
    ELSE.
      rv_name = iv_name.
    ENDIF.
  ENDMETHOD.

  METHOD class_assigned.
    DATA: lv_objek TYPE inob-objek,
          lv_ob    TYPE kssk-objek.

    DATA(lv_klart) = CONV klah-klart( iv_klart ).
    DATA(lv_class) = CONV klah-class( to_upper( iv_class ) ).
    lv_objek = iv_matnr.
    SELECT SINGLE cuobj FROM inob
      WHERE objek = @lv_objek AND obtab = 'MARA' AND klart = @lv_klart
      INTO @DATA(lv_cuobj).
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lv_ob = lv_cuobj.
    SELECT SINGLE kssk~clint FROM kssk
      INNER JOIN klah ON klah~clint = kssk~clint
      WHERE kssk~objek = @lv_ob AND kssk~mafid = 'O'
        AND kssk~klart = @lv_klart AND klah~class = @lv_class
      INTO @DATA(lv_clint).
    IF sy-subrc = 0.
      rv_found = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD class_stage.
    DATA: lo_call TYPE REF TO lcl_bapi,
          lv_sfx  TYPE string,
          lv_err  TYPE string.

    DATA(lv_klart) = io_class->get_value( iv_param = 'CLASSTYPENEW' iv_field = `` ).
    DATA(lv_class) = io_class->get_value( iv_param = 'CLASSNUMNEW'  iv_field = `` ).
    IF lv_klart IS INITIAL OR lv_class IS INITIAL.
      RAISE EXCEPTION TYPE lcx_error
        EXPORTING iv_text = |Class type and class name are required for classification|.
    ENDIF.

    IF class_assigned( iv_matnr = iv_matnr iv_klart = lv_klart iv_class = lv_class ) = abap_true.
      lo_call = NEW #( gc_cls_change ).
      LOOP AT it_map ASSIGNING FIELD-SYMBOL(<ls_m>).
        lv_err = lo_call->set_value( iv_param = rename_class_param( <ls_m>-struct )
                                     iv_field = <ls_m>-field iv_value = <ls_m>-value
                                     iv_line_key = <ls_m>-line_key ).
        IF lv_err IS NOT INITIAL.
          RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = lv_err.
        ENDIF.
      ENDLOOP.
      lv_sfx = ``.
    ELSE.
      lo_call = io_class.
      lv_sfx  = `NEW`.
    ENDIF.

    lv_err = lo_call->set_value( iv_param = |OBJECTKEY{ lv_sfx }|   iv_field = `` iv_value = CONV #( iv_matnr ) ).
    IF lv_err IS INITIAL.
      lv_err = lo_call->set_value( iv_param = |OBJECTTABLE{ lv_sfx }| iv_field = `` iv_value = `MARA` ).
    ENDIF.
    IF lv_err IS NOT INITIAL.
      RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = lv_err.
    ENDIF.

    DATA(lt_ret) = lo_call->execute( ).
    mo_log->add_return( iv_row = mv_row iv_matnr = mv_matnr iv_stage = 'CLASS' it_return = lt_ret ).
    IF mo_log->has_error( lt_ret ) = abap_true.
      RAISE EXCEPTION TYPE lcx_error EXPORTING iv_text = |BAPI returned errors - see messages|.
    ENDIF.
    commit_or_rollback( abap_true ).
  ENDMETHOD.

ENDCLASS.

INITIALIZATION.
  p_btn = 'Download Template'.

AT SELECTION-SCREEN OUTPUT.
  lcl_app=>on_output( ).

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file1.
  lcl_file_io=>f4_local( CHANGING cv_file = p_file1 ).

AT SELECTION-SCREEN ON VALUE-REQUEST FOR p_file2.
  lcl_file_io=>f4_server( CHANGING cv_file = p_file2 ).

AT SELECTION-SCREEN.
  lcl_app=>on_input( ).

START-OF-SELECTION.
  DATA(go_app) = NEW lcl_app( ).
  go_app->run( ).
