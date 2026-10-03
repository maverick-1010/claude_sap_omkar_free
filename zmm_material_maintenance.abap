*&---------------------------------------------------------------------*
*& Report  ZMM_MATERIAL_MAINTENANCE
*&---------------------------------------------------------------------*
*& Material master mass maintenance (Create / Update / Extend)
*& - Template upload from frontend or AL11 (.xlsx / .csv)
*& - Config driven validation (ZTMM_* tables)
*& - Dynamic template-field -> BAPI structure/field mapping
*& - BAPI_MATERIAL_SAVEREPLICA is called once per material (template row)
*& Requires ABAP 7.40 SP08 or higher
*&---------------------------------------------------------------------*
REPORT zmm_material_maintenance.

INCLUDE zmm_material_maintenance_top.
INCLUDE zmm_material_maintenance_s01.
INCLUDE zmm_material_maintenance_c01.
INCLUDE zmm_material_maintenance_c02.
INCLUDE zmm_material_maintenance_e01.
