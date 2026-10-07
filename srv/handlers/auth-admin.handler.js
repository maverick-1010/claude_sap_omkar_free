'use strict';
// AuthAdminService rules (auth spec "Admin service"). Every change that affects a user's access bumps that user's
// tokenVersion and writes an audit entry naming the acting admin; both happen after the transaction commits
// (cache invalidation too, so a concurrent reader cannot refill the cache with the old state).
const cds = require('@sap/cds');
const { keyOf } = require('../lib/util');
const password = require('../lib/auth/password');
const store = require('../lib/auth/user-store');
const { audit } = require('../lib/auth/audit');

const USERNAME = /^[a-z0-9._-]{3,60}$/;
const ADMIN_ROLE = 'Administrator';
const ADMIN_PERMISSION = 'User.Admin';

module.exports = (srv) => {
  const { Users, UserRoles, UserAttributes, Roles, RolePermissions, Sessions } = srv.entities;
  const A = cds.entities('auth');

  const actorOf = (req) => req.user.id;
  const selfId = (req) => req.user.attr?.userId;
  const key = (req) => req.params.at(-1);
  const olds = new WeakMap();

  /** Revokes the user's access tokens (tokenVersion + 1) and drops the cached state, now and after commit. */
  async function revokeAccess(req, userIds) {
    const ids = [...new Set([].concat(userIds).filter(Boolean))];
    await store.bumpTokenVersion(ids);
    req.on('succeeded', () => store.invalidate(ids));
  }

  /** Audit entry written after commit, so a rolled-back change leaves no trace. */
  const record = (req, event, target, details = {}) =>
    req.on('succeeded', () => audit(event, {
      userId: target?.ID ?? null, username: target?.username ?? null,
      ip: req.http?.req?.ip ?? null, details: { actor: actorOf(req), ...details },
    }));

  const userById = (ID) => SELECT.one.from(A.Users).columns('ID', 'username', 'isActive').where({ ID });

  async function mustExist(req, ID) {
    const user = ID && (await userById(ID));
    if (!user) req.reject(404, 'User not found');
    return user;
  }

  // The database does not enforce foreign keys everywhere (SQLite), so references are checked here
  async function mustExistIn(req, entity, ID, label) {
    if (!ID || !(await SELECT.one.from(entity).columns('ID').where({ ID }))) req.reject(400, `${label} ${ID ?? ''} does not exist`.replace('  ', ' '));
  }

  // ---------- Users ----------

  srv.before('CREATE', Users, (req) => req.reject(405, 'Use the createUser action to create users'));
  srv.before('DELETE', Users, (req) => req.reject(405, 'Users cannot be deleted, deactivate them instead'));

  srv.before('UPDATE', Users, async (req) => {
    const ID = keyOf(req);
    olds.set(req, await SELECT.one.from(A.Users).where({ ID }));
    if (req.data.isActive === false && ID === selfId(req)) req.reject(400, 'You cannot deactivate yourself');
  });
  srv.after('UPDATE', Users, async (_, req) => {
    const before = olds.get(req);
    if (!before) return;
    const changes = {};
    for (const f of ['email', 'isActive']) if (f in req.data && req.data[f] !== before[f]) changes[f] = [before[f], req.data[f]];
    if (!Object.keys(changes).length) return;
    if ('isActive' in changes) {
      await store.revokeAllRefreshTokens(before.ID);         // deactivating ends every session
      await revokeAccess(req, before.ID);
    }
    record(req, 'USER_UPDATED', before, { changes });
  });

  // ---------- Roles of a user ----------

  srv.before(['UPDATE', 'DELETE'], UserRoles, async (req) => {
    const k = key(req);
    const old = await SELECT.one.from(A.UserRoles).where({ user_ID: k.user_ID, role_ID: k.role_ID });
    olds.set(req, old);
    if (old && old.user_ID === selfId(req) && old.role_ID === ADMIN_ROLE)
      req.reject(400, 'You cannot change or remove your own Administrator role');
  });
  srv.before('CREATE', UserRoles, async (req) => {
    await mustExist(req, req.data.user_ID);
    await mustExistIn(req, A.Roles, req.data.role_ID, 'Role');
  });
  srv.after(['CREATE', 'UPDATE', 'DELETE'], UserRoles, async (_, req) => {
    const old = olds.get(req);
    const userId = old?.user_ID ?? req.data.user_ID;
    const roleId = old?.role_ID ?? req.data.role_ID;
    await revokeAccess(req, userId);
    record(req, 'ROLE_CHANGED', await userById(userId), { change: req.event, role: roleId, validFrom: req.data.validFrom, validTo: req.data.validTo });
  });

  // ---------- Attributes of a user ----------

  srv.before(['UPDATE', 'DELETE'], UserAttributes, async (req) => {
    olds.set(req, await SELECT.one.from(A.UserAttributes).where({ ID: keyOf(req) }));
  });
  srv.before('CREATE', UserAttributes, async (req) => {
    await mustExist(req, req.data.user_ID);
  });
  srv.after(['CREATE', 'UPDATE', 'DELETE'], UserAttributes, async (result, req) => {
    const old = olds.get(req);
    const userIds = [old?.user_ID, req.data.user_ID ?? result?.user_ID].filter(Boolean);
    await revokeAccess(req, userIds);
    record(req, 'AUTHZ_CHANGED', await userById(userIds[0]), {
      change: req.event, attribute: old?.name ?? req.data.name, from: old?.value, to: req.event === 'DELETE' ? undefined : req.data.value,
    });
  });

  // ---------- Roles and their permissions ----------

  srv.before('DELETE', Roles, async (req) => {
    const ID = keyOf(req);
    if (ID === ADMIN_ROLE) req.reject(409, 'The Administrator role cannot be deleted');
    const { n } = await SELECT.one.from(A.UserRoles).columns('count(*) as n').where({ role_ID: ID });
    if (n) req.reject(409, `Role ${ID} is still assigned to ${n} user(s)`);
  });
  srv.after(['CREATE', 'UPDATE', 'DELETE'], Roles, (result, req) => {
    record(req, 'ROLE_CHANGED', null, { change: req.event, role: keyOf(req) ?? req.data.ID });
  });

  srv.before('CREATE', RolePermissions, async (req) => {
    await mustExistIn(req, A.Roles, req.data.role_ID, 'Role');
    await mustExistIn(req, A.Permissions, req.data.permission_ID, 'Permission');
  });
  srv.before(['UPDATE', 'DELETE'], RolePermissions, async (req) => {
    const k = key(req);
    olds.set(req, k);
    if (req.event === 'DELETE' && k.role_ID === ADMIN_ROLE && k.permission_ID === ADMIN_PERMISSION)
      req.reject(400, `${ADMIN_PERMISSION} cannot be removed from the ${ADMIN_ROLE} role`);
  });
  srv.after(['CREATE', 'UPDATE', 'DELETE'], RolePermissions, async (_, req) => {
    const k = olds.get(req) ?? req.data;
    const holders = await store.usersWithRole(k.role_ID);
    await revokeAccess(req, holders);                         // permissions travel in the token: every holder needs a new one
    record(req, 'ROLE_CHANGED', null, { change: req.event, role: k.role_ID, permission: k.permission_ID, affectedUsers: holders.length });
  });

  // ---------- Sessions: only those that can still be refreshed ----------

  srv.before('READ', Sessions, (req) => {
    req.query.where('expiresAt >', new Date().toISOString(), 'and sessionExpiresAt >', new Date().toISOString());
  });

  // ---------- Actions ----------

  srv.on('createUser', async (req) => {
    const { email, password: pw, roles = [] } = req.data;
    const username = store.normalizeUsername(req.data.username);
    if (!USERNAME.test(username)) req.reject(400, 'Username must match ^[a-z0-9._-]{3,60}$');
    const policy = password.policyError(pw, username);
    if (policy) req.reject(400, policy);
    if (await SELECT.one.from(A.Users).columns('ID').where({ username })) req.reject(409, `User ${username} already exists`);
    const wanted = [...new Set(roles)];
    if (wanted.length) {
      const known = (await SELECT.from(A.Roles).columns('ID').where({ ID: { in: wanted } })).map((r) => r.ID);
      const unknown = wanted.filter((r) => !known.includes(r));
      if (unknown.length) req.reject(400, `Unknown role(s): ${unknown.join(', ')}`);
    }
    const ID = cds.utils.uuid();
    await INSERT.into(A.Users).entries({ ID, username, email: email || null, passwordHash: await password.hash(pw), mustChangePassword: true });
    if (wanted.length) await INSERT.into(A.UserRoles).entries(wanted.map((role_ID) => ({ user_ID: ID, role_ID })));
    record(req, 'USER_CREATED', { ID, username }, { roles: wanted });
    return { ID, username };
  });

  srv.on('resetPassword', async (req) => {
    const user = await mustExist(req, req.data.userId);
    const policy = password.policyError(req.data.newPassword, user.username);
    if (policy) req.reject(400, policy);
    await UPDATE(A.Users, user.ID).set({
      passwordHash: await password.hash(req.data.newPassword), mustChangePassword: true,
      passwordChangedAt: store.nowIso(), failedLogins: 0, lockedUntil: null,
    });
    await store.revokeAllRefreshTokens(user.ID);
    await revokeAccess(req, user.ID);
    record(req, 'PASSWORD_RESET', user);
  });

  srv.on('unlockUser', async (req) => {
    const user = await mustExist(req, req.data.userId);
    await UPDATE(A.Users, user.ID).set({ failedLogins: 0, lockedUntil: null });
    record(req, 'USER_UNLOCKED', user);
  });

  srv.on('revokeSessions', async (req) => {
    const user = await mustExist(req, req.data.userId);
    await store.revokeAllRefreshTokens(user.ID);
    await revokeAccess(req, user.ID);
    record(req, 'SESSIONS_REVOKED', user);
  });
};
