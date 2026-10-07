'use strict';
/** Auth spec "Unit tests – Tokens", FR-T1..T5, SEC-2, AC-14. */
const crypto = require('crypto');
const { createKeyStore, thumbprint } = require('../../srv/lib/auth/keys');
const { signAccessToken, verifyAccessToken, signJwt, newRefreshToken, hashToken } = require('../../srv/lib/auth/tokens');
const config = require('../../srv/lib/auth/config');

const quiet = { warn: () => {} };
const keyStore = createKeyStore({ ...config, signingKey: null, production: false }, quiet);
const user = { id: 'u-1', username: 'alice', tokenVersion: 3, roles: ['MaterialRequester'], permissions: [], attributes: { userId: 'u-1' } };
const now = 1_800_000_000;

const payloadOf = (token) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
const claims = (extra = {}) => ({
  iss: config.issuer, aud: config.audience, sub: 'u-1', name: 'alice', token_use: 'access',
  iat: now, nbf: now, exp: now + 900, jti: 'j', tv: 3, roles: [], perms: [], attr: {}, ...extra,
});
const sign = (header, payload, key = keyStore.privateKey) => signJwt({ alg: 'EdDSA', typ: 'JWT', kid: keyStore.kid, ...header }, payload, key);
const verify = (token, at = now) => verifyAccessToken(token, { now: at, keyStore });

describe('access tokens', () => {
  test('round trip sign / verify returns all claims', () => {
    const token = signAccessToken({ ...user, mustChangePassword: true }, { now, keyStore });
    const c = verify(token);
    expect(c).toMatchObject({ sub: 'u-1', name: 'alice', tv: 3, token_use: 'access', roles: ['MaterialRequester'], mcp: true, exp: now + 900 });
    expect(JSON.parse(Buffer.from(token.split('.')[0], 'base64url').toString())).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: keyStore.kid });
    expect(payloadOf(signAccessToken(user, { now, keyStore })).mcp).toBeUndefined();
  });

  test('a tampered payload is rejected', () => {
    const [h, , s] = signAccessToken(user, { now, keyStore }).split('.');
    const forged = Buffer.from(JSON.stringify(claims({ perms: ['User.Admin'] }))).toString('base64url');
    expect(() => verify(`${h}.${forged}.${s}`)).toThrow('invalid signature');
  });

  test('alg none and other algorithms are rejected', () => {
    const body = Buffer.from(JSON.stringify(claims())).toString('base64url');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT', kid: keyStore.kid })).toString('base64url');
    expect(() => verify(`${none}.${body}.AA`)).toThrow('unsupported algorithm');
    expect(() => verify(`${none}.${body}.`)).toThrow();
    const hs = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: keyStore.kid })).toString('base64url');
    expect(() => verify(`${hs}.${body}.${crypto.createHmac('sha256', 'x').update('y').digest('base64url')}`)).toThrow('unsupported algorithm');
  });

  test('an unknown kid is rejected', () => {
    expect(() => verify(sign({ kid: 'other' }, claims()))).toThrow('unknown key');
    const stranger = crypto.generateKeyPairSync('ed25519').privateKey;
    expect(() => verify(sign({}, claims(), stranger))).toThrow('invalid signature');
  });

  test('wrong issuer, audience or token use is rejected', () => {
    expect(() => verify(sign({}, claims({ iss: 'evil' })))).toThrow('wrong issuer');
    expect(() => verify(sign({}, claims({ aud: 'other-app' })))).toThrow('wrong audience');
    expect(() => verify(sign({}, claims({ token_use: 'refresh' })))).toThrow('wrong token use');
  });

  test('expired and not-yet-valid tokens are rejected, 30 s clock skew allowed', () => {
    const token = sign({}, claims());
    expect(verify(token, now + 900 + 29)).toBeTruthy();
    expect(() => verify(token, now + 900 + 30)).toThrow('token expired');
    expect(verify(token, now - 29)).toBeTruthy();
    expect(() => verify(token, now - 31)).toThrow('token not yet valid');
  });

  test('malformed and oversized tokens are rejected', () => {
    for (const t of ['', 'abc', 'a.b', 'a.b.c.d', 'a!.b.c', null, 42]) expect(() => verify(t)).toThrow();
    expect(() => verify(sign({}, claims({ pad: 'x'.repeat(17 * 1024) })))).toThrow('malformed token');
    expect(() => verify(sign({}, claims({ tv: '3' })))).toThrow('malformed claims');
  });
});

describe('keys', () => {
  test('AC-14: production without AUTH_SIGNING_KEY fails with a clear error', () => {
    expect(() => createKeyStore({ ...config, signingKey: null, production: true }, quiet)).toThrow(/AUTH_SIGNING_KEY is required in production/);
  });

  test('a configured key is used, kid defaults to its thumbprint, old keys still verify', () => {
    const current = crypto.generateKeyPairSync('ed25519');
    const old = crypto.generateKeyPairSync('ed25519');
    const pem = current.privateKey.export({ type: 'pkcs8', format: 'pem' });
    const store = createKeyStore({ ...config, signingKey: pem, production: true, verifyKeys: { old: old.publicKey.export({ type: 'spki', format: 'pem' }) } }, quiet);
    expect(store.kid).toBe(thumbprint(current.publicKey));
    expect(store.jwks.keys.map((k) => k.kid)).toEqual([store.kid, 'old']);
    expect(store.jwks.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', alg: 'EdDSA', use: 'sig' });
    expect(store.jwks.keys[0].d).toBeUndefined();   // never publish the private part
    const oldToken = signJwt({ alg: 'EdDSA', typ: 'JWT', kid: 'old' }, claims(), old.privateKey);
    expect(verifyAccessToken(oldToken, { now, keyStore: store }).sub).toBe('u-1');
  });

  test('non-Ed25519 keys are refused', () => {
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    expect(() => createKeyStore({ ...config, signingKey: rsa }, quiet)).toThrow('Ed25519');
    expect(() => createKeyStore({ ...config, signingKey: 'garbage' }, quiet)).toThrow('PKCS#8');
  });
});

describe('refresh tokens', () => {
  test('32 random bytes in base64url, hashed with SHA-256', () => {
    const t = newRefreshToken();
    expect(Buffer.from(t, 'base64url')).toHaveLength(32);
    expect(t).not.toBe(newRefreshToken());
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(crypto.createHash('sha256').update(t).digest('hex'));
  });
});
