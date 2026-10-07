'use strict';
/** Auth spec AC-8..AC-13, AC-15 (adapted to MassMaterialService) and the AuthAdminService business rules. */
process.env.CDS_CONFIG = JSON.stringify({ requires: { auth: { kind: 'mmc-auth' } } });
process.env.AUTH_LOGIN_RATE_MAX = '1000';

const path = require('path');
const crypto = require('crypto');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const password = require('../srv/lib/auth/password');

const ADMIN = '/admin';
const JOBS = '/odata/v4/mass-material/UploadJobs';
const PW = 'Correct-Horse-42';
const NEW_PW = 'Another-Secret-77';

describe('authorization and administration', () => {
  const { GET, POST, PATCH, DELETE, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  let hash, adminToken;
  const ids = {};

  const addUser = async (username, roles = []) => {
    const ID = crypto.randomUUID();
    await cds.db.run(INSERT.into('auth.Users').entries({ ID, username, passwordHash: hash }));
    if (roles.length) await cds.db.run(INSERT.into('auth.UserRoles').entries(roles.map((role_ID) => ({ user_ID: ID, role_ID }))));
    ids[username] = ID;
    return ID;
  };
  const login = (username, pw = PW) => POST('/auth/login', { username, password: pw });
  const tokenOf = async (username) => (await login(username)).data.access_token;
  const as = (token, extra = {}) => ({ headers: { Authorization: `Bearer ${token}`, ...(extra.headers || {}) } });
  const audits = (event) => cds.db.run(SELECT.from('auth.AuditLog').where({ event }));
  const userRow = (username) => cds.db.run(SELECT.one.from('auth.Users').where({ username }));
  const roleUrl = (user, role) => `${ADMIN}/UserRoles(user_ID=${ids[user]},role_ID='${role}')`;

  beforeAll(async () => {
    hash = await password.hash(PW);
    await addUser('root', ['Administrator', 'MaterialAdmin']);
    await addUser('req1', ['MaterialRequester']);
    await addUser('req2', ['MaterialRequester']);
    await addUser('appr', ['MaterialApprover']);
    adminToken = await tokenOf('root');
  });

  describe('MassMaterialService with token users (AC-8, AC-9, AC-15)', () => {
    test('AC-8: a requester sees only own jobs', async () => {
      const t1 = await tokenOf('req1'), t2 = await tokenOf('req2');
      await POST(JOBS, { description: 'job of req1' }, as(t1));
      await POST(JOBS, { description: 'job of req2' }, as(t2));
      const seen = (await GET(JOBS, as(t1))).data.value;
      expect(seen.map((j) => j.description)).toEqual(['job of req1']);
      expect((await GET(JOBS, as(adminToken))).data.value.length).toBeGreaterThanOrEqual(2);
    });

    test('AC-9: an approver cannot create a job (403) and does not see DRAFT jobs', async () => {
      const t = await tokenOf('appr');
      expect((await POST(JOBS, { description: 'x' }, as(t))).status).toBe(403);
      expect((await GET(JOBS, as(t))).data.value).toEqual([]);
    });

    test('AC-15: a requester cannot touch another requester\'s job', async () => {
      const t1 = await tokenOf('req1'), t2 = await tokenOf('req2');
      const { data: job } = await POST(JOBS, { description: 'private' }, as(t1));
      const res = await PATCH(`${JOBS}(${job.ID})`, { description: 'hijack' }, as(t2, { headers: { 'If-Match': '*' } }));
      expect([403, 404]).toContain(res.status);
      expect((await GET(`${JOBS}(${job.ID})`, as(t2))).status).toBe(404);
    });

    test('a non-admin token cannot call MaterialAdminService', async () => {
      expect((await GET('/odata/v4/material-admin/ValidationRules', as(await tokenOf('req1')))).status).toBe(403);
      expect((await GET('/odata/v4/material-admin/ValidationRules', as(adminToken))).status).toBe(200);
    });
  });

  describe('access to /admin', () => {
    test('AC-10: a non-admin gets 403, anonymous 401', async () => {
      expect((await GET(`${ADMIN}/Users`, as(await tokenOf('req1')))).status).toBe(403);
      expect((await GET(`${ADMIN}/Users`)).status).toBe(401);
    });

    test('Users never expose passwordHash, tokenVersion or failedLogins; read-only tables reject writes', async () => {
      const res = await GET(`${ADMIN}/Users?$filter=username eq 'req1'`, as(adminToken));
      expect(res.status).toBe(200);
      expect(Object.keys(res.data.value[0])).not.toEqual(expect.arrayContaining(['passwordHash']));
      for (const k of ['passwordHash', 'tokenVersion', 'failedLogins']) expect(res.data.value[0]).not.toHaveProperty(k);
      expect((await POST(`${ADMIN}/Permissions`, { ID: 'X.Y' }, as(adminToken))).status).toBe(405);
      expect((await PATCH(`${ADMIN}/AuditLog(${crypto.randomUUID()})`, { event: 'X' }, as(adminToken))).status).toBe(405);
      expect((await GET(`${ADMIN}/Permissions`, as(adminToken))).data.value.map((p) => p.ID)).toContain('User.Admin');
    });
  });

  describe('users', () => {
    test('AC-11: createUser -> first login must change password -> CAP is 403 -> change -> 200, old token 401', async () => {
      const created = await POST(`${ADMIN}/createUser`, { username: ' New.User ', email: 'n@x.io', password: PW, roles: ['MaterialRequester'] }, as(adminToken));
      expect(created.status).toBe(200);
      expect(created.data.username).toBe('new.user');
      expect((await userRow('new.user')).mustChangePassword).toBe(true);

      const first = await login('new.user');
      expect(first.data.must_change_password).toBe(true);
      const old = first.data.access_token;
      expect((await GET(JOBS, as(old))).status).toBe(403);
      expect((await GET('/auth/me', as(old))).data.mustChangePassword).toBe(true);

      const changed = await POST('/auth/change-password', { currentPassword: PW, newPassword: NEW_PW }, as(old));
      expect(changed.status).toBe(200);
      expect(changed.data.must_change_password).toBe(false);
      expect((await GET(JOBS, as(changed.data.access_token))).status).toBe(200);
      expect((await GET(JOBS, as(old))).status).toBe(401);
      expect((await login('new.user', PW)).status).toBe(401);
      expect((await login('new.user', NEW_PW)).status).toBe(200);
      expect((await audits('PASSWORD_CHANGED')).some((a) => a.username === 'new.user')).toBe(true);
    });

    test('change-password rejects a wrong current password, the same password and policy violations', async () => {
      await addUser('chg', ['MaterialRequester']);
      const t = await tokenOf('chg');
      expect((await POST('/auth/change-password', { currentPassword: 'Wrong-Password-1', newPassword: NEW_PW }, as(t))).status).toBe(400);
      expect((await POST('/auth/change-password', { currentPassword: PW, newPassword: PW }, as(t))).status).toBe(400);
      expect((await POST('/auth/change-password', { currentPassword: PW, newPassword: 'short' }, as(t))).status).toBe(400);
      expect((await POST('/auth/change-password', { currentPassword: PW, newPassword: 'Chg-Secret-123' }, as(t))).status).toBe(400);   // contains the user name
      expect((await audits('PASSWORD_CHANGE_FAILED')).length).toBeGreaterThanOrEqual(4);
    });

    test('createUser validation: username, policy, duplicates (409), unknown roles (400)', async () => {
      const call = (data) => POST(`${ADMIN}/createUser`, { password: PW, roles: [], ...data }, as(adminToken));
      expect((await call({ username: 'x' })).status).toBe(400);
      expect((await call({ username: 'bad name!' })).status).toBe(400);
      expect((await call({ username: 'okname', password: 'weak' })).status).toBe(400);
      expect((await call({ username: 'REQ1' })).status).toBe(409);
      const unknown = await call({ username: 'okname2', roles: ['NoSuchRole'] });
      expect(unknown.status).toBe(400);
      expect(await userRow('okname2')).toBeUndefined();
    });

    test('Users cannot be created or deleted directly (405); username is immutable', async () => {
      expect((await POST(`${ADMIN}/Users`, { username: 'direct' }, as(adminToken))).status).toBe(405);
      expect((await DELETE(`${ADMIN}/Users(${ids.req2})`, as(adminToken))).status).toBe(405);
      await PATCH(`${ADMIN}/Users(${ids.req2})`, { username: 'renamed', mustChangePassword: true }, as(adminToken));
      const row = await userRow('req2');
      expect(row).toBeTruthy();
      expect(row.mustChangePassword).toBe(false);
    });

    test('deactivating a user revokes tokens and sessions; an admin cannot deactivate themselves (400)', async () => {
      await addUser('victim', ['MaterialRequester']);
      const login1 = await POST('/auth/login', { username: 'victim', password: PW, client: 'native' });
      const t = login1.data.access_token;
      expect((await GET(JOBS, as(t))).status).toBe(200);
      expect((await PATCH(`${ADMIN}/Users(${ids.root})`, { isActive: false }, as(adminToken))).status).toBe(400);
      expect((await PATCH(`${ADMIN}/Users(${ids.victim})`, { isActive: false }, as(adminToken))).status).toBe(200);
      expect((await GET(JOBS, as(t))).status).toBe(401);
      expect((await POST('/auth/refresh', { refresh_token: login1.data.refresh_token })).status).toBe(401);
      expect((await login('victim')).status).toBe(401);
      const entry = (await audits('USER_UPDATED')).find((a) => a.username === 'victim');
      expect(JSON.parse(entry.details).actor).toBe('root');
    });

    test('resetPassword forces a change, clears the lockout and ends all sessions', async () => {
      await addUser('forgetful', ['MaterialRequester']);
      const old = await tokenOf('forgetful');
      await cds.db.run(UPDATE('auth.Users', ids.forgetful).set({ lockedUntil: new Date(Date.now() + 600000).toISOString(), failedLogins: 3 }));
      expect((await POST(`${ADMIN}/resetPassword`, { userId: ids.forgetful, newPassword: 'weak' }, as(adminToken))).status).toBe(400);
      expect((await POST(`${ADMIN}/resetPassword`, { userId: crypto.randomUUID(), newPassword: NEW_PW }, as(adminToken))).status).toBe(404);
      expect((await POST(`${ADMIN}/resetPassword`, { userId: ids.forgetful, newPassword: NEW_PW }, as(adminToken))).status).toBe(204);
      expect((await GET(JOBS, as(old))).status).toBe(401);
      const row = await userRow('forgetful');
      expect([row.mustChangePassword, row.failedLogins, row.lockedUntil]).toEqual([true, 0, null]);
      expect((await login('forgetful', NEW_PW)).data.must_change_password).toBe(true);
      expect((await audits('PASSWORD_RESET')).length).toBeGreaterThan(0);
    });

    test('unlockUser and revokeSessions', async () => {
      await addUser('locked', ['MaterialRequester']);
      await cds.db.run(UPDATE('auth.Users', ids.locked).set({ lockedUntil: new Date(Date.now() + 600000).toISOString(), failedLogins: 2 }));
      expect((await login('locked')).status).toBe(401);
      expect((await POST(`${ADMIN}/unlockUser`, { userId: ids.locked }, as(adminToken))).status).toBe(204);
      const t = await tokenOf('locked');
      expect((await GET(JOBS, as(t))).status).toBe(200);
      expect((await GET(`${ADMIN}/Sessions?$filter=user_ID eq ${ids.locked}`, as(adminToken))).data.value).toHaveLength(1);
      expect((await POST(`${ADMIN}/revokeSessions`, { userId: ids.locked }, as(adminToken))).status).toBe(204);
      expect((await GET(JOBS, as(t))).status).toBe(401);
      const sessions = (await GET(`${ADMIN}/Sessions?$filter=user_ID eq ${ids.locked}`, as(adminToken))).data.value;
      expect(sessions).toEqual([]);
      expect((await audits('USER_UNLOCKED')).length).toBeGreaterThan(0);
      expect((await audits('SESSIONS_REVOKED')).length).toBeGreaterThan(0);
    });

    test('Sessions expose no token hash', async () => {
      const res = await GET(`${ADMIN}/Sessions`, as(adminToken));
      expect(res.status).toBe(200);
      expect(res.data.value.length).toBeGreaterThan(0);
      for (const s of res.data.value) expect(s).not.toHaveProperty('tokenHash');
    });
  });

  describe('roles, assignments and attributes', () => {
    test('AC-12: removing a role from a user with a valid token makes that token 401', async () => {
      await addUser('holder', ['MaterialRequester', 'MaterialApprover']);
      const t = await tokenOf('holder');
      expect((await GET(JOBS, as(t))).status).toBe(200);
      expect((await DELETE(roleUrl('holder', 'MaterialApprover'), as(adminToken))).status).toBe(204);
      expect((await GET(JOBS, as(t))).status).toBe(401);
      const fresh = await tokenOf('holder');
      expect((await GET('/auth/me', as(fresh))).data.roles).toEqual(['MaterialRequester']);
      expect((await audits('ROLE_CHANGED')).some((a) => a.username === 'holder')).toBe(true);
    });

    test('AC-13: an admin cannot remove or change their own Administrator role (400)', async () => {
      expect((await DELETE(roleUrl('root', 'Administrator'), as(adminToken))).status).toBe(400);
      expect((await PATCH(roleUrl('root', 'Administrator'), { validTo: '2020-01-01T00:00:00Z' }, as(adminToken))).status).toBe(400);
      expect((await DELETE(roleUrl('root', 'MaterialAdmin'), as(adminToken))).status).toBe(204);   // other roles are fine
      adminToken = await tokenOf('root');
    });

    test('assigning a role gives the token its permissions on next login; time-bound roles only count inside their window', async () => {
      await addUser('timed', []);
      const post = (role, extra) => POST(`${ADMIN}/UserRoles`, { user_ID: ids.timed, role_ID: role, ...extra }, as(adminToken));
      expect((await post('MaterialRequester')).status).toBe(201);
      expect((await post('MaterialApprover', { validFrom: new Date(Date.now() + 3600000).toISOString() })).status).toBe(201);
      expect((await post('MaterialAdmin', { validTo: new Date(Date.now() - 3600000).toISOString() })).status).toBe(201);
      expect((await post('NoSuchRole')).status).toBe(400);
      const me = (await GET('/auth/me', as(await tokenOf('timed')))).data;
      expect(me.roles).toEqual(['MaterialRequester']);
    });

    test('attributes: several rows form an array, one stays scalar; changes revoke the user\'s tokens', async () => {
      await addUser('abac', ['MaterialRequester']);
      const old = await tokenOf('abac');
      const add = (name, value) => POST(`${ADMIN}/UserAttributes`, { user_ID: ids.abac, name, value }, as(adminToken));
      expect((await add('department', 'FIN')).status).toBe(201);
      expect((await add('department', 'HR')).status).toBe(201);
      expect((await add('region', 'EU')).status).toBe(201);
      expect((await GET(JOBS, as(old))).status).toBe(401);
      const me = (await GET('/auth/me', as(await tokenOf('abac')))).data;
      expect(me.attributes).toMatchObject({ department: ['FIN', 'HR'], region: 'EU' });
      expect((await audits('AUTHZ_CHANGED')).length).toBeGreaterThan(0);
    });

    test('a role cannot be deleted while assigned (409); the Administrator role never; an unused role can', async () => {
      expect((await DELETE(`${ADMIN}/Roles('MaterialRequester')`, as(adminToken))).status).toBe(409);
      expect((await DELETE(`${ADMIN}/Roles('Administrator')`, as(adminToken))).status).toBe(409);
      expect((await POST(`${ADMIN}/Roles`, { ID: 'Temp', description: 'temporary' }, as(adminToken))).status).toBe(201);
      expect((await DELETE(`${ADMIN}/Roles('Temp')`, as(adminToken))).status).toBe(204);
    });

    test('changing a role\'s permissions revokes the tokens of every holder', async () => {
      await POST(`${ADMIN}/Roles`, { ID: 'Reviewer', description: 'r' }, as(adminToken));
            await cds.db.run(INSERT.into('auth.Permissions').entries({ ID: 'Report.Read', description: 'read reports' }));
      await addUser('rev1', ['Reviewer']);
      await addUser('rev2', ['Reviewer']);
      const [t1, t2] = [await tokenOf('rev1'), await tokenOf('rev2')];
      expect((await GET('/auth/me', as(t1))).status).toBe(200);
      const add = await POST(`${ADMIN}/RolePermissions`, { role_ID: 'Reviewer', permission_ID: 'Report.Read' }, as(adminToken));
      expect(add.status).toBe(201);
    expect((await POST(`${ADMIN}/RolePermissions`, { role_ID: 'Reviewer', permission_ID: 'Nope.Nope' }, as(adminToken))).status).toBe(400);
      expect((await GET('/auth/me', as(t1))).status).toBe(401);
      expect((await GET('/auth/me', as(t2))).status).toBe(401);
      expect((await GET('/auth/me', as(await tokenOf('rev1')))).data.permissions).toEqual(['Report.Read']);
      expect((await DELETE(`${ADMIN}/RolePermissions(role_ID='Administrator',permission_ID='User.Admin')`, as(adminToken))).status).toBe(400);
    });
  });
});
