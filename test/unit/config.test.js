'use strict';
/** Auth spec "Configuration", SEC-10, AC-14: settings come from env or the mmc-auth-keys service; production needs a key. */
const crypto = require('crypto');

const withEnv = (vars, fn) => {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  try { let out; jest.isolateModules(() => { out = fn(); }); return out; } finally {
    for (const k of Object.keys(vars)) if (k in saved) process.env[k] = saved[k]; else delete process.env[k];
  }
};
const pem = () => crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });

describe('auth configuration', () => {
  test('defaults match the spec', () => {
    const c = withEnv({}, () => require('../../srv/lib/auth/config'));
    expect(c).toMatchObject({ issuer: 'cap-custom-auth', audience: 'cap-app', accessTtlSec: 900, refreshTtlSec: 604800, sessionMaxSec: 2592000,
      refreshGraceMs: 10000, maxFailed: 5, lockoutSec: 900, loginRateMax: 20, stateCacheMs: 30000, refreshCookie: 'cap_rt' });
  });

  test('invalid numbers abort startup', () => {
    expect(() => withEnv({ AUTH_ACCESS_TTL_SEC: 'abc' }, () => require('../../srv/lib/auth/config'))).toThrow('AUTH_ACCESS_TTL_SEC');
  });

  test('the signing key is read from the user-provided service mmc-auth-keys; a real env var wins', () => {
    const key = pem();
    const vcap = JSON.stringify({ 'user-provided': [{ name: 'mmc-auth-keys', credentials: { AUTH_SIGNING_KEY: key, AUTH_SIGNING_KID: 'from-service' } }] });
    expect(withEnv({ VCAP_SERVICES: vcap }, () => require('../../srv/lib/auth/config')).signingKey).toBe(key);
    expect(withEnv({ VCAP_SERVICES: vcap, AUTH_SIGNING_KID: 'from-env' }, () => require('../../srv/lib/auth/config')).signingKid).toBe('from-env');
    expect(withEnv({ VCAP_SERVICES: 'not json' }, () => require('../../srv/lib/auth/config')).signingKey).toBeNull();
  });

  test('AC-14: production without AUTH_SIGNING_KEY fails to start with a clear error', () => {
    const start = (vars) => withEnv({ NODE_ENV: 'production', ...vars }, () => require('../../srv/lib/auth/keys').keys());
    delete process.env.AUTH_SIGNING_KEY;
    expect(() => start({})).toThrow(/AUTH_SIGNING_KEY is required in production/);
    expect(start({ AUTH_SIGNING_KEY: pem() }).kid).toEqual(expect.any(String));
  });

  test('trust proxy defaults: 1 in production, off in development', () => {
    expect(withEnv({ NODE_ENV: 'production' }, () => require('../../srv/lib/auth/config')).trustProxy).toBe(1);
    expect(withEnv({ NODE_ENV: 'development' }, () => require('../../srv/lib/auth/config')).trustProxy).toBe(false);
    expect(withEnv({ NODE_ENV: 'production', AUTH_TRUST_PROXY: '2' }, () => require('../../srv/lib/auth/config')).trustProxy).toBe(2);
  });
});
