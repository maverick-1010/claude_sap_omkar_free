*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_C02
*& Log, validator, output (ALV / server file / e-mail), application
*&---------------------------------------------------------------------*

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
* Validator - implements step 5.5 (mandatory / optional / system derived
* / conditional mandatory) and produces the BAPI mapping
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
        "nothing to do - derived by the system

      ELSEIF <ls_c>-cond_mandatory = abap_true.
        "the field itself is passed on when provided ...
        IF lv_given = abap_true.
          add_map( EXPORTING is_cfg = <ls_c> iv_name = lv_name iv_val = lv_val CHANGING ct_map = et_map ).
        ENDIF.
        "... and, if provided, it makes the dependent field(s) mandatory
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

      "a provided field without BAPI mapping can never reach the BAPI
      IF lv_given = abap_true AND <ls_c>-system_derived = abap_false
         AND <ls_c>-bapi_struct_name IS INITIAL.
        mo_log->add( iv_row = is_row-row_no iv_matnr = lv_matnr iv_type = 'W'
                     iv_stage = 'VALIDATE' iv_field = lv_name
                     iv_text = |No BAPI structure maintained for { lv_name } - value ignored| ).
      ENDIF.
    ENDLOOP.

    "remove mapping lines without BAPI structure (already warned)
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
      rv_path = lv_p.                                 "explicit file name
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

  "---------------------------------------------------------------
  " Selection screen
  "---------------------------------------------------------------
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
      CLEAR cv_val.            "selected value is not valid for the new operation / parent value
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

    "template is a .xlsx / .csv file kept on the application server (AL11);
    "path is maintained in text symbol 007
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

  "---------------------------------------------------------------
  " Main flow
  "---------------------------------------------------------------
  METHOD run.
    TRY.
        check_inputs( ).
        DATA(lt_rows) = read_template( ).         "5.1

        mo_log = NEW #( ).
        mo_cfg = NEW #( ).
        mo_cfg->load( ).                          "5.2 - 5.4
        mo_val = NEW #( io_config = mo_cfg io_log = mo_log ).

        LOOP AT lt_rows ASSIGNING FIELD-SYMBOL(<ls_row>).
          process_row( <ls_row> ).                "5.5 + BAPI per row
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

  "---------------------------------------------------------------
  " Row processing
  "---------------------------------------------------------------
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
    "program level checks on the control columns of the template
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

    "---- checks + 5.5 validation -------------------------------------
    precheck( EXPORTING is_row = is_row IMPORTING ev_matnr = lv_matnr ).
    mo_val->validate( EXPORTING is_row = is_row
                      IMPORTING et_map = DATA(lt_map)
                                ev_ok  = DATA(lv_ok) ).
    IF mv_failed = abap_true OR lv_ok = abap_false.
      mv_failed = abap_true.
      RETURN.
    ENDIF.

    "---- dynamic mapping template field -> BAPI structure / field ---
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

    "---- header defaults driven by selection screen ------------------
    DATA(lt_head) = VALUE ty_t_map(
      ( struct = 'HEADDATA' field = 'MATL_TYPE'     value = CONV #( p_mtart ) )
      ( struct = 'HEADDATA' field = 'IND_SECTOR'    value = CONV #( p_indsec ) )
      ( struct = 'HEADDATA' field = 'BASIC_VIEW'    value = 'X' ) ).
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

    "---- BAPI_MATERIAL_SAVEREPLICA - one call per material (row) ----
    DATA(lt_ret) = lo_save->execute( ).
    mo_log->add_return( iv_row = mv_row iv_matnr = mv_matnr iv_stage = 'SAVE' it_return = lt_ret ).

    IF mo_log->has_error( lt_ret ) = abap_true.
      commit_or_rollback( abap_false ).
      mv_failed = abap_true.
      RETURN.
    ENDIF.

    "material number created / changed (internal numbering)
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

    "---- classification (separate BAPI, material must exist) --------
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
    "BAPI_OBJCL_CREATE uses ...NEW parameter names for the key fields, BAPI_OBJCL_CHANGE does not
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
      "already classified -> change values
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
