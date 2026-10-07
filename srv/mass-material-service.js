'use strict';
const cds = require('@sap/cds');

// Business logic lives in small handler modules (spec §4.2)
module.exports = class MassMaterialService extends cds.ApplicationService {
  init() {
    require('./handlers/jobs.handler')(this);
    require('./handlers/requests.handler')(this);
    require('./handlers/upload.handler')(this);
    require('./handlers/parse.handler')(this);
    require('./handlers/validate.handler')(this);
    require('./handlers/actions.handler')(this);
    require('./handlers/files.handler')(this);
    return super.init();
  }

  // CAP asks for If-Match on every bound operation of an ETag entity, also on the read-only downloadResult.
  // A download link cannot send that header, so "any version" is assumed; this runs before CAP's ETag check.
  async handle(req) {
    if (req.event === 'downloadResult' && req.headers && !req.headers['if-match']) req.headers['if-match'] = '*';
    return super.handle(req);
  }
};
