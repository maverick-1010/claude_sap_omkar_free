*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_E01
*& Selection screen / program events
*&---------------------------------------------------------------------*
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
