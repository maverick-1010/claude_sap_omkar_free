using { mmc } from '../db/schema';

// Configuration and cache administration (spec §2.2, §3.7) - MaterialAdmin only
service MaterialAdminService @(path: '/odata/v4/material-admin') {

  // Full CRUD: changes apply to the next validate call
  entity ValidationRules        as projection on mmc.ValidationRules;
  entity MaterialTypeViewConfig as projection on mmc.MaterialTypeViewConfig;

  // Filled only by the refresh actions and the nightly job
  @readonly entity ValueHelpCache        as projection on mmc.ValueHelpCache;
  @readonly entity ExistingMaterialCache as projection on mmc.ExistingMaterialCache;

  // Empty category = all categories; returns the number of codes loaded
  action   refreshValueHelps(category : String(30)) returns Integer;
  // Returns the number of material numbers loaded
  action   refreshExistingMaterials()               returns Integer;
  function testS4Connection()                       returns { status : String; latencyMs : Integer };
}
