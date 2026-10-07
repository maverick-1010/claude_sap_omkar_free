'use strict';
const cds = require('@sap/cds');

module.exports = class AuthAdminService extends cds.ApplicationService {
  init() {
    require('./handlers/auth-admin.handler')(this);
    return super.init();
  }
};
