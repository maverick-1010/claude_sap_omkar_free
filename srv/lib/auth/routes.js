'use strict';
// /auth/* endpoints (auth spec "API specification"): plain Express routes, outside any CDS service.
// Every response: Cache-Control no-store (except JWKS) and errors as {"error": {"code": "<status>", "message": "..."}}.
const crypto = require('crypto');
const express = require('express');
const cds = require('@sap/cds');
const config = require('./config');
const { keys } = require('./keys');
const tokens = require('./tokens');
const password = require('./password');
const store = require('./user-store');
const { audit } = require('./audit');
const { createLimiter } = require('./rate-limit');
const { authenticate, AuthError } = require('./custom-auth');

const LOG = cds.log('auth');
const A = () => cds.entities('auth');
const INVALID_LOGIN = 'Invalid username or password';

class HttpError extends Error {
  constructor(status, message, { clearCookie = false } = {}) { super(message); this.status = status; this.clearCookie = clearCookie; }
}

const loginLimiter = createLimiter({ max: config.loginRateMax, windowMs: config.loginRateWindowMs });

// MFA extension point (open question, default: no MFA in v1): runs after a successful password check.
// Throw an HttpError here to require a second factor before tokens are issued.
const afterPasswordVerified = async (/* user, req */) => {};

// ---------- helpers ----------

const ipOf = (req) => req.ip || null;
const nowMs = () => Date.now();

function readCookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}

const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict', path: '/auth', secure: config.production });
const clearRefreshCookie = (res) => res.clearCookie(config.refreshCookie, cookieOptions());

const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
const str = (v) => (typeof v === 'string' ? v : undefined);

/** Runs fn in its own DB transaction; `actor` ends up in modifiedBy. */
const inTx = (actor, fn) => cds.tx({ user: new cds.User({ id: actor || 'auth' }) }, fn);

/** Creates a refresh-token row and returns the raw token (only its hash is stored, FR-S1). */
async function newRefreshRow(user, req, { ID = crypto.randomUUID(), family = crypto.randomUUID(), sessionExpiresAt } = {}) {
  const now = nowMs();
  const sessionEnd = sessionExpiresAt ? Date.parse(sessionExpiresAt) : now + config.sessionMaxSec * 1000;
  const raw = tokens.newRefreshToken();
  await INSERT.into(A().RefreshTokens).entries({
    ID, user_ID: user.ID, tokenHash: tokens.hashToken(raw), family,
    expiresAt: store.nowIso(Math.min(now + config.refreshTtlSec * 1000, sessionEnd)),
    sessionExpiresAt: store.nowIso(sessionEnd),
    createdIp: ipOf(req), userAgent: str(req.headers['user-agent'])?.slice(0, 255) ?? null,
  });
  return { ID, raw, expiresMs: Math.min(now + config.refreshTtlSec * 1000, sessionEnd) };
}

/** Token response; the refresh token goes in the body for native clients, otherwise in the HttpOnly cookie. */
async function tokenResponse(res, user, refresh, { inBody }) {
  const tu = await store.tokenUser(user);
  const out = {
    access_token: tokens.signAccessToken(tu),
    token_type: 'Bearer',
    expires_in: config.accessTtlSec,
    must_change_password: tu.mustChangePassword,
  };
  if (inBody) out.refresh_token = refresh.raw;
  else res.cookie(config.refreshCookie, refresh.raw, { ...cookieOptions(), maxAge: Math.max(0, refresh.expiresMs - nowMs()) });
  return out;
}

const wrap = (fn) => async (req, res) => {
  try {
    const result = await fn(req, res);
    if (res.headersSent) return;
    if (result === undefined) res.status(204).end();
    else res.status(200).json(result);
  } catch (e) {
    if (e instanceof HttpError || e instanceof AuthError) {
      if (e.clearCookie) clearRefreshCookie(res);
      if (e.status === 401) res.set('WWW-Authenticate', 'Bearer');
      return res.status(e.status).json({ error: { code: String(e.status), message: e.message } });
    }
    LOG.error('unexpected error in /auth', e);   // stack only in the server log (SEC-13)
    res.status(500).json({ error: { code: '500', message: 'Internal server error' } });
  }
};

/** Bearer authentication for /auth endpoints; a pending password change is allowed here (FR-P4). */
async function bearer(req) {
  const result = await authenticate(req, { allowMcp: true });
  if (!result) throw new HttpError(401, 'Authentication required');
  return result.claims;
}

// ---------- handlers ----------

async function login(req, res) {
  const { username, password: pw, client } = body(req);
  if (typeof username !== 'string' || typeof pw !== 'string' || !username.trim() || username.length > 255)
    throw new HttpError(400, 'username and password are required');
  if (pw.length > password.MAX_LEN) throw new HttpError(400, `Password must not exceed ${password.MAX_LEN} characters`);

  const name = store.normalizeUsername(username);
  const ip = ipOf(req);
  const user = await store.findByUsername(name);
  const now = nowMs();

  const fail = async (reason, extra = {}) => {
    await audit('LOGIN_FAILED', { userId: user?.ID ?? null, username: name, ip, success: false, details: { reason } });
    throw new HttpError(401, INVALID_LOGIN, extra);
  };

  // unknown and locked users: same message and one scrypt run, so neither is revealed (FR-A2, SEC-3)
  if (!user) { await password.dummyVerify(pw); return fail('unknown user'); }
  if (user.lockedUntil && Date.parse(user.lockedUntil) > now) { await password.dummyVerify(pw); return fail('locked'); }

  const ok = await password.verify(pw, user.passwordHash);
  if (!user.isActive) return fail('inactive');
  if (!ok) {
    const failed = (user.failedLogins ?? 0) + 1;
    const locks = failed >= config.maxFailed;
    await inTx(name, () => UPDATE(A().Users, user.ID).set(locks
      ? { failedLogins: 0, lockedUntil: store.nowIso(now + config.lockoutSec * 1000) }
      : { failedLogins: failed }));
    if (locks) await audit('ACCOUNT_LOCKED', { userId: user.ID, username: name, ip, success: false, details: { failedLogins: failed } });
    return fail('wrong password');
  }

  await afterPasswordVerified(user, req);

  const native = client === 'native';
  const result = await inTx(name, async () => {
    const changes = { failedLogins: 0, lockedUntil: null, lastLoginAt: store.nowIso(now) };
    if (password.needsRehash(user.passwordHash)) changes.passwordHash = await password.hash(pw);   // FR-A4
    await UPDATE(A().Users, user.ID).set(changes);
    const refresh = await newRefreshRow(user, req);                                              // new family (FR-A6)
    return tokenResponse(res, { ...user, ...changes }, refresh, { inBody: native });
  });
  await audit('LOGIN_SUCCESS', { userId: user.ID, username: name, ip, details: { client: native ? 'native' : 'browser' } });
  return result;
}

async function refresh(req, res) {
  const fromBody = str(body(req).refresh_token);
  let raw = fromBody;
  if (!raw) {
    raw = readCookie(req, config.refreshCookie);
    if (!raw) throw new HttpError(401, 'Refresh token required');
    if (req.get('X-Requested-With') !== 'XMLHttpRequest') throw new HttpError(403, 'Missing X-Requested-With header');   // CSRF (SEC-6)
  }
  if (raw.length > 512) throw new HttpError(401, 'Invalid refresh token', { clearCookie: true });

  const { RefreshTokens } = A();
  const ip = ipOf(req);
  const row = await SELECT.one.from(RefreshTokens).where({ tokenHash: tokens.hashToken(raw) });
  if (!row) throw new HttpError(401, 'Invalid refresh token', { clearCookie: !fromBody });
  const now = nowMs();

  if (row.revokedAt) {
    // a rotated token presented again: parallel tab within the grace window, otherwise theft (FR-S3, SEC-5)
    if (row.replacedBy && now - Date.parse(row.revokedAt) <= config.refreshGraceMs)
      throw new HttpError(409, 'Refresh token was already rotated');
    if (row.replacedBy) {
      await inTx('auth', () => store.revokeFamily(row.family));
      const user = await store.findById(row.user_ID);
      await audit('REFRESH_TOKEN_REUSE', { userId: row.user_ID, username: user?.username, ip, success: false, details: { family: row.family } });
    }
    throw new HttpError(401, 'Invalid refresh token', { clearCookie: !fromBody });
  }
  if (Date.parse(row.expiresAt) <= now || Date.parse(row.sessionExpiresAt) <= now)
    throw new HttpError(401, 'Refresh token expired', { clearCookie: !fromBody });

  const user = await store.findById(row.user_ID);
  if (!user || !user.isActive) {
    await inTx('auth', () => store.revokeFamily(row.family));
    throw new HttpError(401, 'Invalid refresh token', { clearCookie: !fromBody });
  }

  return inTx(user.username, async () => {
    const nextId = crypto.randomUUID();
    // conditional rotation: of two concurrent calls only one can win (FR-S2)
    const n = await UPDATE(RefreshTokens).set({ revokedAt: store.nowIso(now), replacedBy: nextId }).where({ ID: row.ID, revokedAt: null });
    if (!n) throw new HttpError(409, 'Refresh token was already rotated');
    const fresh = await newRefreshRow(user, req, { ID: nextId, family: row.family, sessionExpiresAt: row.sessionExpiresAt });
    return tokenResponse(res, user, fresh, { inBody: !!fromBody });
  });
}

async function logout(req, res) {
  const raw = str(body(req).refresh_token) || readCookie(req, config.refreshCookie);
  clearRefreshCookie(res);
  if (!raw || raw.length > 512) return;
  const row = await SELECT.one.from(A().RefreshTokens).where({ tokenHash: tokens.hashToken(raw) });
  if (!row) return;
  await inTx('auth', () => store.revokeFamily(row.family));
  const user = await store.findById(row.user_ID);
  await audit('LOGOUT', { userId: row.user_ID, username: user?.username, ip: ipOf(req), details: { family: row.family } });
}

async function logoutAll(req, res) {
  const claims = await bearer(req);
  await inTx(claims.name, async () => {
    await store.bumpTokenVersion(claims.sub);
    await store.revokeAllRefreshTokens(claims.sub);
  });
  store.invalidate(claims.sub);
  clearRefreshCookie(res);
  await audit('LOGOUT_ALL', { userId: claims.sub, username: claims.name, ip: ipOf(req) });
}

async function changePassword(req, res) {
  const claims = await bearer(req);
  const { currentPassword, newPassword, client } = body(req);
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string')
    throw new HttpError(400, 'currentPassword and newPassword are required');
  const user = await store.findById(claims.sub);
  const ip = ipOf(req);
  const failed = async (reason, message) => {
    await audit('PASSWORD_CHANGE_FAILED', { userId: claims.sub, username: claims.name, ip, success: false, details: { reason } });
    throw new HttpError(400, message);
  };
  if (currentPassword.length > password.MAX_LEN || !(await password.verify(currentPassword, user.passwordHash)))
    return failed('wrong current password', 'Current password is incorrect');
  const policy = password.policyError(newPassword, user.username);
  if (policy) return failed('policy', policy);
  if (await password.verify(newPassword, user.passwordHash)) return failed('reuse', 'The new password must differ from the current one');

  const passwordHash = await password.hash(newPassword);
  const result = await inTx(user.username, async () => {
    const changes = { passwordHash, mustChangePassword: false, passwordChangedAt: store.nowIso(), tokenVersion: (user.tokenVersion ?? 0) + 1, failedLogins: 0, lockedUntil: null };
    await UPDATE(A().Users, user.ID).set(changes);
    await store.revokeAllRefreshTokens(user.ID);   // every other session ends (FR-P3)
    store.invalidate(user.ID);
    const fresh = await newRefreshRow(user, req);
    return tokenResponse(res, { ...user, ...changes }, fresh, { inBody: client === 'native' });
  });
  store.invalidate(user.ID);
  await audit('PASSWORD_CHANGED', { userId: user.ID, username: user.username, ip });
  return result;
}

async function me(req) {
  const claims = await bearer(req);
  const state = await store.getState(claims.sub);
  return {
    id: claims.sub, username: claims.name, roles: claims.roles || [], permissions: claims.perms || [],
    attributes: claims.attr || {}, mustChangePassword: !!(claims.mcp || state?.mustChangePassword),
  };
}

// ---------- router ----------

function createAuthRouter() {
  const router = express.Router();
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/.well-known/jwks.json', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(keys().jwks);
  });

  router.use(express.json({ limit: config.maxBodyBytes }));
  router.post('/login', loginLimiter.middleware, wrap(login));
  router.post('/refresh', wrap(refresh));
  router.post('/logout', wrap(logout));
  router.post('/logout-all', wrap(logoutAll));
  router.post('/change-password', wrap(changePassword));
  router.get('/me', wrap(me));

  router.use((req, res) => res.status(404).json({ error: { code: '404', message: 'Not found' } }));
  // body parser errors (too large, bad JSON) and anything else unexpected
  router.use((err, req, res, next) => {   // eslint-disable-line no-unused-vars
    const status = err.status === 413 || err.type === 'entity.too.large' ? 413 : err.status === 400 ? 400 : 500;
    if (status === 500) LOG.error('unexpected error in /auth', err);
    res.status(status).json({ error: { code: String(status), message: status === 500 ? 'Internal server error' : status === 413 ? 'Request body too large' : 'Malformed request body' } });
  });
  return router;
}

module.exports = { createAuthRouter, loginLimiter, HttpError };
