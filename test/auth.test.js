'use strict';
/** Auth spec AC-1..AC-7, AC-16: login, lockout, refresh rotation, CSRF, logout-all, revocation. */
process.env.CDS_CONFIG = JSON.stringify({ requires: { auth: { kind: 'mmc-auth' } } });
process.env.AUTH_LOGIN_RATE_MAX = '1000';       // the limiter itself is covered in test/unit/rate-limit.test.js

const path = require('path');
const crypto = require('crypto');
const cds = require('@sap/cds');
const cdsTest = require('@cap-js/cds-test');
const password = require('../srv/lib/auth/password');
const store = require('../srv/lib/auth/user-store');
const { signJwt } = require('../srv/lib/auth/tokens');
const { keys } = require('../srv/lib/auth/keys');

const JOBS = '/odata/v4/mass-material/UploadJobs';
const PW = 'Correct-Horse-42';
const XHR = { 'X-Requested-With': 'XMLHttpRequest' };

describe('custom authentication', () => {
  const { GET, POST, axios } = cdsTest(path.join(__dirname, '..'));
  axios.defaults.validateStatus = () => true;
  let hash;

  const addUser = async (username, roles = ['MaterialRequester'], extra = {}) => {
    const ID = crypto.randomUUID();
    await cds.db.run(INSERT.into('auth.Users').entries({ ID, username, passwordHash: hash, ...extra }));
    if (roles.length) await cds.db.run(INSERT.into('auth.UserRoles').entries(roles.map((role_ID) => ({ user_ID: ID, role_ID }))));
    return ID;
  };
  const login = (username, pw = PW, extra = {}) => POST('/auth/login', { username, password: pw, ...extra });
  const bearer = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
  const setCookies = (res) => [].concat(res.headers['set-cookie'] || []);
  const cookieOf = (res) => setCookies(res).map((c) => c.split(';')[0]).find((c) => c.startsWith('cap_rt='));
  const audits = (event) => cds.db.run(SELECT.from('auth.AuditLog').where({ event }));

  beforeAll(async () => {
    hash = await password.hash(PW);
    await addUser('alice');
    await addUser('bob');
  });

  test('AC-1: wrong password and unknown user get an identical 401', async () => {
    const wrong = await login('alice', 'Wrong-Password-1');
    const unknown = await login('nobody', 'Wrong-Password-1');
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.data).toEqual(unknown.data);
    expect(wrong.data).toEqual({ error: { code: '401', message: 'Invalid username or password' } });
    expect(wrong.headers['cache-control']).toBe('no-store');
  });

  test('login returns an access token and a refresh cookie; username is trimmed and lower-cased', async () => {
    const res = await login('  ALICE ');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ token_type: 'Bearer', expires_in: 900, must_change_password: false });
    expect(res.data.refresh_token).toBeUndefined();
    const set = setCookies(res).find((c) => c.startsWith('cap_rt='));
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Strict/i);
    expect(set).toMatch(/Path=\/auth/i);
    const me = await GET('/auth/me', bearer(res.data.access_token));
    expect(me.data).toMatchObject({ username: 'alice', roles: ['MaterialRequester'], mustChangePassword: false });
    expect(me.data.attributes.userId).toBeUndefined();
  });

  test('native clients receive the refresh token in the body, not as a cookie', async () => {
    const res = await login('alice', PW, { client: 'native' });
    expect(res.data.refresh_token).toEqual(expect.any(String));
    expect(res.headers['set-cookie']).toBeUndefined();
    const stored = await cds.db.run(SELECT.one.from('auth.RefreshTokens').where({ tokenHash: require('../srv/lib/auth/tokens').hashToken(res.data.refresh_token) }));
    expect(stored).toBeTruthy();
    expect(JSON.stringify(await cds.db.run(SELECT.from('auth.RefreshTokens')))).not.toContain(res.data.refresh_token);
  });

  test('bad requests: missing fields 400, oversized body 413, overlong password 400', async () => {
    expect((await POST('/auth/login', {})).status).toBe(400);
    expect((await POST('/auth/login', { username: 'alice', password: 'x'.repeat(129) })).status).toBe(400);
    expect((await POST('/auth/login', { username: 'alice', password: 'x', pad: 'y'.repeat(11 * 1024) })).status).toBe(413);
  });

  test('AC-2: anonymous request to a restricted service is 401', async () => {
    const res = await GET(JOBS);
    expect(res.status).toBe(401);
  });

  test('a valid token reaches the service with the mapped roles and user id', async () => {
    const { data } = await login('alice');
    const res = await GET(JOBS, bearer(data.access_token));
    expect(res.status).toBe(200);
    const created = await POST(JOBS, { description: 'via token' }, bearer(data.access_token));
    expect(created.status).toBe(201);
    expect(created.data.createdBy).toBe('alice');           // cds.User.id = username (FR-Z1)
    const other = await login('bob');
    expect((await GET(JOBS, bearer(other.data.access_token))).data.value).toEqual([]);   // existing @restrict rules apply unchanged
  });

  test('malformed or foreign tokens are 401 with WWW-Authenticate, never anonymous', async () => {
    for (const h of ['Bearer garbage', 'Basic YWxpY2U6eA==', 'Bearer']) {
      const res = await GET(JOBS, { headers: { Authorization: h } });
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/^Bearer/);
    }
  });

  test('AC-3: a token with a modified perms claim is 401', async () => {
    const { data } = await login('alice');
    const [h, p, s] = data.access_token.split('.');
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    claims.roles = ['MaterialAdmin'];
    const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${s}`;
    expect((await GET('/odata/v4/material-admin/ValidationRules', bearer(forged))).status).toBe(401);
  });

  test('a token whose tokenVersion is stale is 401, inactive user too', async () => {
    const id = await addUser('carol');
    const { data } = await login('carol');
    expect((await GET(JOBS, bearer(data.access_token))).status).toBe(200);
    await cds.db.run(UPDATE('auth.Users', id).set({ isActive: false }));
    store.invalidate(id);
    expect((await GET(JOBS, bearer(data.access_token))).status).toBe(401);
    expect((await login('carol')).status).toBe(401);
  });

  test('AC-4: 5 failed logins lock the account, the correct password is then 401, ACCOUNT_LOCKED is audited', async () => {
    await addUser('dave');
    for (let i = 0; i < 5; i++) expect((await login('dave', 'Wrong-Password-1')).status).toBe(401);
    const res = await login('dave');
    expect(res.status).toBe(401);
    expect(res.data.error.message).toBe('Invalid username or password');
    const locked = (await audits('ACCOUNT_LOCKED')).filter((a) => a.username === 'dave');
    expect(locked).toHaveLength(1);
    const row = await cds.db.run(SELECT.one.from('auth.Users').where({ username: 'dave' }));
    expect(row.failedLogins).toBe(0);
    expect(new Date(row.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await audits('LOGIN_FAILED')).some((a) => a.username === 'dave')).toBe(true);
    expect(JSON.stringify(await cds.db.run(SELECT.from('auth.AuditLog')))).not.toContain(PW);
  });

  test('AC-5: refresh rt1 -> rt2, replay rt1, then rt2 is dead too (family revoked)', async () => {
    const first = await login('alice', PW, { client: 'native' });
    const rt1 = first.data.refresh_token;
    const second = await POST('/auth/refresh', { refresh_token: rt1 });
    expect(second.status).toBe(200);
    const rt2 = second.data.refresh_token;
    expect(rt2).not.toBe(rt1);
    await cds.db.run(UPDATE('auth.RefreshTokens').set({ revokedAt: new Date(Date.now() - 60000).toISOString() }).where({ tokenHash: require('../srv/lib/auth/tokens').hashToken(rt1) }));
    expect((await POST('/auth/refresh', { refresh_token: rt1 })).status).toBe(401);
    expect((await POST('/auth/refresh', { refresh_token: rt2 })).status).toBe(401);
    expect((await audits('REFRESH_TOKEN_REUSE')).length).toBeGreaterThan(0);
  });

  test('replay inside the grace window is 409 and the family stays alive', async () => {
    const rt1 = (await login('alice', PW, { client: 'native' })).data.refresh_token;
    const rt2 = (await POST('/auth/refresh', { refresh_token: rt1 })).data.refresh_token;
    expect((await POST('/auth/refresh', { refresh_token: rt1 })).status).toBe(409);   // parallel tab, not theft
    expect((await POST('/auth/refresh', { refresh_token: rt2 })).status).toBe(200);
  });

  test('AC-6: cookie refresh needs X-Requested-With', async () => {
    const res = await login('alice');
    const cookie = cookieOf(res);
    const without = await POST('/auth/refresh', {}, { headers: { Cookie: cookie } });
    expect(without.status).toBe(403);
    const withHeader = await POST('/auth/refresh', {}, { headers: { Cookie: cookie, ...XHR } });
    expect(withHeader.status).toBe(200);
    expect(withHeader.data.access_token).toEqual(expect.any(String));
    expect(cookieOf(withHeader)).toBeTruthy();
    expect(cookieOf(withHeader)).not.toBe(cookie);
  });

  test('refresh without any token is 401', async () => {
    expect((await POST('/auth/refresh', {})).status).toBe(401);
  });

  test('AC-7: logout-all, then the old access token is 401', async () => {
    const a = await login('bob');
    const b = await login('bob', PW, { client: 'native' });
    expect((await GET(JOBS, bearer(a.data.access_token))).status).toBe(200);
    const out = await POST('/auth/logout-all', {}, bearer(a.data.access_token));
    expect(out.status).toBe(204);
    expect((await GET(JOBS, bearer(a.data.access_token))).status).toBe(401);
    expect((await GET(JOBS, bearer(b.data.access_token))).status).toBe(401);
    expect((await POST('/auth/refresh', { refresh_token: b.data.refresh_token })).status).toBe(401);
    expect((await audits('LOGOUT_ALL')).length).toBeGreaterThan(0);
  });

  test('logout revokes the current family and is idempotent', async () => {
    const res = await login('alice', PW, { client: 'native' });
    expect((await POST('/auth/logout', { refresh_token: res.data.refresh_token })).status).toBe(204);
    expect((await POST('/auth/refresh', { refresh_token: res.data.refresh_token })).status).toBe(401);
    expect((await POST('/auth/logout', {})).status).toBe(204);
  });

  test('AC-16: expired refresh token and inactive user are 401 and the cookie is cleared', async () => {
    const res = await login('alice');
    const cookie = cookieOf(res);
    const raw = decodeURIComponent(cookie.split('=')[1]);
    await cds.db.run(UPDATE('auth.RefreshTokens').set({ expiresAt: new Date(Date.now() - 1000).toISOString() })
      .where({ tokenHash: require('../srv/lib/auth/tokens').hashToken(raw) }));
    const expired = await POST('/auth/refresh', {}, { headers: { Cookie: cookie, ...XHR } });
    expect(expired.status).toBe(401);
    expect(setCookies(expired).join(';')).toMatch(/cap_rt=;/);

    const id = await addUser('erin');
    const r = await login('erin');
    await cds.db.run(UPDATE('auth.Users', id).set({ isActive: false }));
    const inactive = await POST('/auth/refresh', {}, { headers: { Cookie: cookieOf(r), ...XHR } });
    expect(inactive.status).toBe(401);
    expect(setCookies(inactive).join(';')).toMatch(/cap_rt=;/);
  });

  test('JWKS is public, cacheable and has no private part', async () => {
    const res = await GET('/auth/.well-known/jwks.json');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=300/);
    expect(res.data.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA' });
    expect(res.data.keys[0].d).toBeUndefined();
    expect(res.data.keys[0].kid).toBe(keys().kid);
  });

  test('security headers are on every response and errors are generic', async () => {
    const res = await GET('/auth/me');
    expect(res.status).toBe(401);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect((await GET('/auth/nope')).status).toBe(404);
  });

  test('a validly signed token of a deleted user is 401', async () => {
    const token = signJwt({ alg: 'EdDSA', typ: 'JWT', kid: keys().kid },
      { iss: 'cap-custom-auth', aud: 'cap-app', sub: crypto.randomUUID(), name: 'ghost', token_use: 'access',
        iat: Math.floor(Date.now() / 1000), nbf: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600, jti: 'x', tv: 0, roles: ['MaterialAdmin'], perms: [], attr: {} },
      keys().privateKey);
    expect((await GET(JOBS, bearer(token))).status).toBe(401);
  });
});
