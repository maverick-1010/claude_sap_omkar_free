'use strict';
const cds = require('@sap/cds');

// Picks the S/4 adapter (spec §3.5). Config: cds.env.mmc.s4.adapter = 'odata' | 'mock'.
// Default: the mock outside production, API_PRODUCT_SRV in production.
function getAdapter() {
  const configured = cds.env.mmc?.s4?.adapter;
  const kind = configured ?? (process.env.NODE_ENV === 'production' ? 'odata' : 'mock');
  return kind === 'odata' ? require('./product-srv.adapter') : require('./mock.adapter');
}

module.exports = { getAdapter };
