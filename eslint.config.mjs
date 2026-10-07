
import cds from '@sap/cds/eslint.config.mjs'
import cdsPlugin from '@sap/eslint-plugin-cds'

export default [{ ignores: ['gen/**'] }, ...cds.recommended, cdsPlugin.configs.recommended]
