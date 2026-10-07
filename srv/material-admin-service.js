'use strict';
const cds = require('@sap/cds');

module.exports = class MaterialAdminService extends cds.ApplicationService {
  init() {
    require('./handlers/admin.handler')(this);
    cds.once('served', () => require('./lib/nightly').schedule());
    return super.init();
  }
};
