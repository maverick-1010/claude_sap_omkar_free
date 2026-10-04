// ============================================================================
// Mass Material Creation - common reusable types
// Single source of truth for enums and scalar domain types used by schema.cds
// ============================================================================
using from '@sap/cds/common';

namespace mmc;

// ---------- Enums ----------

@title: '{i18n>JobStatus}'
type JobStatus : String(25) enum {
  DRAFT; VALIDATED; PENDING_APPROVAL; APPROVED; REJECTED;
  PROCESSING; COMPLETED; COMPLETED_WITH_ERRORS; FAILED; CANCELLED;
}

@title: '{i18n>RowStatus}'
type RowStatus : String(10) enum {
  NEW; VALID; WARNING; ERROR; QUEUED; POSTING; SUCCESS; FAILED;
}

@title: '{i18n>Severity}'
type Severity : String(8) enum { ERROR; WARNING; INFO; }

@title: '{i18n>ViewType}'
type ViewType : String(12) enum {
  BASIC; PLANT; STORAGE; SALES; VALUATION; PURCHASING;
}

@title: '{i18n>RuleType}'
type RuleType : String(10) enum { REQUIRED; REGEX; RANGE; LOOKUP; LENGTH; }

// ---------- Domain types ----------

@title: '{i18n>MaterialNumber}'
type MaterialNumber : String(40);
@title: '{i18n>Plant}'
type Plant : String(4);
@title: '{i18n>UoM}'
type UoM : String(3);
@title: '{i18n>Currency}'
type Currency : String(5);
@title: '{i18n>Quantity}'
type Quantity : Decimal(13,3);
@title: '{i18n>Amount}'
type Amount : Decimal(11,2);
