'use strict';
// CAP auth implementation (cds.requires.auth.impl, kind "mmc-auth"): verifies the Bearer token and builds req.user.
// FR-Z1: id = username, roles = role IDs + permission IDs, attr = token attributes + userId.
// FR-Z2: no Authorization header -> anonymous; a bad or revoked token -> 401, never anonymous.
// FR-P4: tokens with a pending password change are rejected (403) on CAP services.
const cds = require('@sap/cds');
const { keys } = require('./keys');
const { verifyAccessToken, TokenError } = require('./tokens');
const store = require('./user-store');

const LOG = cds.log('auth');

class AuthError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Authenticates an Express request from its Bearer token.
 * Returns null when there is no Authorization header, otherwise { claims, state };
 * throws AuthError(401) for anything invalid and AuthError(403) for a pending password change unless allowMcp.
 */
async function authenticate(req, { allowMcp = false } = {}) {
  const header = req.headers.authorization;
  if (header === undefined || header === '') return null;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (!match) throw new AuthError(401, 'Invalid authorization header');

  let claims;
  try {
    claims = verifyAccessToken(match[1]);
  } catch (e) {
    if (e instanceof TokenError) throw new AuthError(401, 'Invalid or expired token');
    throw e;
  }
  const state = await store.getState(claims.sub);
  if (!state || !state.isActive || state.tokenVersion !== claims.tv) throw new AuthError(401, 'Token has been revoked');
  if (!allowMcp && (claims.mcp || state.mustChangePassword)) throw new AuthError(403, 'Password change required');
  return { claims, state };
}

/** cds.User built from verified claims. */
function toCdsUser(claims) {
  const roles = [...new Set([...(claims.roles || []), ...(claims.perms || [])])];
  return new cds.User({ id: claims.name, roles, attr: { ...(claims.attr || {}), userId: claims.sub } });
}

function send(res, status, message) {
  if (status === 401) res.set('WWW-Authenticate', 'Bearer error="invalid_token"');
  res.status(status).json({ error: { code: String(status), message } });
}

/** Factory called by CAP (function with fewer than 3 parameters). */
function customAuth() {
  keys();   // fail fast when no signing key in production
  return async function custom_auth(req, res, next) {
    // CAP calls req._login() when an anonymous user hits a restricted service
    req._login = () => { send(res, 401, 'Authentication required'); return true; };   // truthy: CAP must not answer again
    try {
      const result = await authenticate(req);
      if (result) {
        const user = toCdsUser(result.claims);
        cds.context.user = req.user = user;
      }
      next();
    } catch (e) {
      if (e instanceof AuthError) return send(res, e.status, e.message);
      LOG.error('authentication failed unexpectedly', e);
      send(res, 500, 'Internal server error');
    }
  };
}

module.exports = customAuth;
module.exports.authenticate = authenticate;
module.exports.toCdsUser = toCdsUser;
module.exports.AuthError = AuthError;
