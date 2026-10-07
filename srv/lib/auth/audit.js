'use strict';
// Security audit trail (SEC-11): append-only rows in auth.AuditLog.
// Written in an own transaction so a failed login (no commit) is still recorded; a failing write never breaks the request.
const cds = require('@sap/cds');
const LOG = cds.log('auth');

const EVENTS = new Set([
  'LOGIN_SUCCESS', 'LOGIN_FAILED', 'ACCOUNT_LOCKED', 'REFRESH_TOKEN_REUSE', 'LOGOUT', 'LOGOUT_ALL',
  'PASSWORD_CHANGED', 'PASSWORD_CHANGE_FAILED', 'PASSWORD_RESET', 'USER_CREATED', 'USER_UPDATED',
  'USER_UNLOCKED', 'SESSIONS_REVOKED', 'AUTHZ_CHANGED', 'ROLE_CHANGED',
]);

/**
 * audit('LOGIN_FAILED', { userId, username, ip, success: false, details: { reason } })
 * Never throws. details must not contain passwords or tokens (SEC-1).
 */
async function audit(event, { userId = null, username = null, ip = null, success = true, details } = {}) {
  try {
    if (!EVENTS.has(event)) throw new Error(`unknown audit event ${event}`);
    await cds.tx({ user: new cds.User.Privileged() }, (tx) => tx.run(INSERT.into(cds.entities('auth').AuditLog).entries({
      event, userId, username, ip, success,
      details: details === undefined ? null : JSON.stringify(details),
    })));
  } catch (e) {
    LOG.error('audit write failed', event, e.message);
  }
}

module.exports = { audit, EVENTS };
