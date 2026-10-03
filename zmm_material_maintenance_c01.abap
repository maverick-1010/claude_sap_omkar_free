*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_C01
*& Infrastructure classes: exception, file IO, template reader,
*& configuration, generic dynamic BAPI wrapper
*&---------------------------------------------------------------------*

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

    "Delimiter detection on the header line
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
        "duplicate column check
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
    APPEND 'ZTMM_BASIC_DATA' TO rt_tab.                         "always
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

    "5.2 - active variant view for the selected combination
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

    "5.3 / 5.4 - field configuration of every selected view
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

    "conditional mandatory rules
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
*  - reads the BAPI interface from FUPARAREF
*  - structure / table / scalar parameters are created dynamically
*  - values are converted to the target field type
*  - "<param>X" flag structures are maintained automatically
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
      "returns an error text (initial = ok)
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
      "scalar BAPI parameter (no field name maintained)
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

    "maintain the corresponding X (change flag) structure / table
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
          <lv_fx> = <lv_f>.         "key fields of the X structure
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
          REPLACE ALL OCCURRENCES OF ',' IN lv_num WITH ``.     "1,234.50
        ELSEIF lv_num CS ','.
          REPLACE ',' IN lv_num WITH '.'.                       "1234,50
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
        "no such conversion exit function - keep the value as is
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

    FIND REGEX '^(\d{4})-?(\d{2})-?(\d{2})' IN iv_value SUBMATCHES lv_y lv_m lv_d.         "YYYYMMDD / YYYY-MM-DD
    IF sy-subrc <> 0.
      FIND REGEX '^(\d{1,2})[./](\d{1,2})[./](\d{4})$' IN iv_value SUBMATCHES lv_d lv_m lv_y. "DD.MM.YYYY / DD/MM/YYYY
      IF sy-subrc = 0.
        lv_d = |{ lv_d ALPHA = IN WIDTH = 2 }|.
        lv_m = |{ lv_m ALPHA = IN WIDTH = 2 }|.
      ELSE.
        FIND REGEX '^(\d{5})(\.\d+)?$' IN iv_value SUBMATCHES lv_d.                         "Excel serial number
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

    "collect BAPIRET2 messages: tables first, single structures as fallback
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
