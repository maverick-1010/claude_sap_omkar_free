'use strict';
// Users, authorization resolution and revocation (FR-Z3, FR-Z4, FR-S7, SEC-7).
// Every API call checks isActive and tokenVersion through a short-lived per-instance cache;
// changes made on this instance invalidate it at once, other instances see them after AUTH_STATE_CACHE_MS.
const cds = require('@sap/cds');
const config = require('./config');

const A = () => cds.entities('auth');
const nowIso = (ms = Date.now()) => new Date(ms).toISOString();

const normalizeUsername = (u) => (typeof u === 'string' ? u.trim().toLowerCase() : '');

const findByUsername = (username) => SELECT.one.from(A().Users).where({ username: normalizeUsername(username) });
const findById = (ID) => SELECT.one.from(A().Users).where({ ID });

/** Roles active now (validFrom/validTo window), their permissions and the user's attributes. */
async function resolveAuthz(userId, at = nowIso()) {
  const { UserRoles, RolePermissions, UserAttributes } = A();
  const t = Date.parse(at);
  const inWindow = (r) => (!r.validFrom || Date.parse(r.validFrom) <= t) && (!r.validTo || Date.parse(r.validTo) > t);
  const assignments = await SELECT.from(UserRoles).columns('role_ID', 'validFrom', 'validTo').where({ user_ID: userId });
  const roles = [...new Set(assignments.filter(inWindow).map((r) => r.role_ID))].sort();
  const perms = roles.length ? await SELECT.from(RolePermissions).columns('permission_ID').where({ role_ID: { in: roles } }) : [];
  const permissions = [...new Set(perms.map((p) => p.permission_ID))].sort();

  const attributes = {};
  for (const { name, value } of await SELECT.from(UserAttributes).columns('name', 'value').where({ user_ID: userId }).orderBy('name', 'value')) {
    if (!(name in attributes)) attributes[name] = value;
    else attributes[name] = [].concat(attributes[name], value);    // several rows -> array, one row stays scalar
  }
  return { roles, permissions, attributes };
}

/** Everything the token needs about a user row. */
async function tokenUser(user) {
  const authz = await resolveAuthz(user.ID);
  return {
    id: user.ID, username: user.username, tokenVersion: user.tokenVersion ?? 0,
    mustChangePassword: !!user.mustChangePassword, ...authz,
  };
}

// ---------- state cache ----------

const cache = new Map();   // userId -> { at, state }

/** { isActive, tokenVersion, mustChangePassword } of a user, or null if unknown. */
async function getState(userId) {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < config.stateCacheMs) return hit.state;
  const row = await SELECT.one.from(A().Users).columns('isActive', 'tokenVersion', 'mustChangePassword').where({ ID: userId });
  const state = row ? { isActive: !!row.isActive, tokenVersion: row.tokenVersion ?? 0, mustChangePassword: !!row.mustChangePassword } : null;
  cache.set(userId, { at: Date.now(), state });
  if (cache.size > 10000) cache.delete(cache.keys().next().value);
  return state;
}

/** Drops cached state now and again after the current transaction commits (a reader may have refilled it meanwhile). */
function invalidate(userIds) {
  const ids = [].concat(userIds).filter(Boolean);
  for (const id of ids) cache.delete(id);
  const tx = cds.context?.tx;
  if (tx && typeof tx.on === 'function') tx.on('succeeded', () => { for (const id of ids) cache.delete(id); });
}

/** Invalidates every access token of the given users: tokenVersion + 1. */
async function bumpTokenVersion(userIds) {
  const ids = [...new Set([].concat(userIds).filter(Boolean))];
  if (!ids.length) return;
  await UPDATE(A().Users).set('tokenVersion = tokenVersion + 1').where({ ID: { in: ids } });
  invalidate(ids);
}

/** Revokes all open refresh tokens of a user (all sessions). */
const revokeAllRefreshTokens = (userId) =>
  UPDATE(A().RefreshTokens).set({ revokedAt: nowIso() }).where({ user_ID: userId, revokedAt: null });

/** Revokes one session family. */
const revokeFamily = (family) =>
  UPDATE(A().RefreshTokens).set({ revokedAt: nowIso() }).where({ family, revokedAt: null });

/** Users currently holding a role (for token-version propagation when the role changes). */
async function usersWithRole(roleId) {
  return (await SELECT.from(A().UserRoles).columns('user_ID').where({ role_ID: roleId })).map((r) => r.user_ID);
}

module.exports = {
  normalizeUsername, findByUsername, findById, resolveAuthz, tokenUser,
  getState, invalidate, bumpTokenVersion, revokeAllRefreshTokens, revokeFamily, usersWithRole, nowIso,
};
