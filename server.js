'use strict';
// Bootstrap of the custom auth framework: security headers (SEC-8), trust proxy (SEC-9) and the /auth router.
// The OData services, their middlewares and the V2 adapter are untouched.
const cds = require('@sap/cds');

cds.on('bootstrap', (app) => {
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'no-referrer');
    if (process.env.NODE_ENV === 'production') res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Only with the custom auth kind; tests that use mocked users keep CAP's own strategy
  if (cds.env.requires.auth?.kind !== 'mmc-auth') return;
  const config = require('./srv/lib/auth/config');
  require('./srv/lib/auth/keys').keys();                 // no signing key in production -> startup fails here (SEC-10)
  if (config.trustProxy !== false) app.set('trust proxy', config.trustProxy);
  app.use('/auth', require('./srv/lib/auth/routes').createAuthRouter());
});

module.exports = cds.server;
