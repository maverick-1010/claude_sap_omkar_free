*&---------------------------------------------------------------------*
*& Include          ZMM_MATERIAL_MAINTENANCE_TOP
*&---------------------------------------------------------------------*
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
