---
description: Export the Mass Material Creation CAP schema (schema.cds + common.cds) as a database design image
argument-hint: [optional: output filename without extension]
---

# Export CAP Database Design as Image

Generate a high-quality, professional database design diagram from this
project's CAP model (db/schema.cds and db/common.cds) and export it as a
PNG image.

User specified filename: $ARGUMENTS
(If empty, use default name: mmc-database-design)

═══════════════════════════════════════════════════════════════════
CONFIGURATION (edit here, not in the steps below)
═══════════════════════════════════════════════════════════════════

TITLE            = "MASS MATERIAL CREATION"
SUBTITLE         = "SAP CAP Database Design · S/4HANA Material Master"
OUTPUT_DIR       = docs/db-design
MERMAID_VERSION  = 11