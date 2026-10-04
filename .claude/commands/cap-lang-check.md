---slash command : cap-lang-check
description: Check the health and completeness of all i18n files in a SAP CAP project
---

# SAP CAP i18n Health Check

Analyze the i18n translation files in this SAP CAP project and 
provide a comprehensive status report.

═══════════════════════════════════════════════════════════════════
ANALYSIS STEPS
═══════════════════════════════════════════════════════════════════

1. Find all i18n folders in the project:
   - db/i18n/
   - srv/i18n/
   - app/*/i18n/

2. For each i18n folder, list all properties files found

3. Identify the baseline file (i18n.properties or i18n_en.properties)

4. For each language file, check:
   - Total number of keys
   - Keys present in baseline but missing in translation
   - Keys present in translation but not in baseline (orphans)
   - Empty values (key=)
   - Duplicate keys
   - Lines that don't follow key=value format

═══════════════════════════════════════════════════════════════════
REPORT FORMAT
═══════════════════════════════════════════════════════════════════

Provide a table-style report:

| Language | Keys | Missing | Orphan | Empty | Status |
|----------|------|---------|--------|-------|--------|
| en       | 45   | 0       | 0      | 0     | ✅ OK  |
| de       | 43   | 2       | 0      | 1     | ⚠️ Warn |
| fr       | 45   | 0       | 0      | 0     | ✅ OK  |

Then for each language with issues, list:
- Specific missing keys with their English values (for translation)
- Orphan keys that should be removed
- Empty keys that need values

═══════════════════════════════════════════════════════════════════
RECOMMENDATIONS
═══════════════════════════════════════════════════════════════════

After the analysis, provide:
1. Suggested fixes for each issue found
2. Commands to run for validation:
   - cds compile srv --to edmx
   - cds watch
3. Any best practice recommendations based on what you observed
4. Suggest creating missing language files if the project targets 
   specific markets (mention common languages for SAP enterprise apps)