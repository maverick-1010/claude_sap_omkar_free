'use strict';
// All settings of the auth framework, read once from the environment (auth spec "Configuration").
// No other module reads process.env for auth settings.

// Secrets may come from the Cloud Foundry user-provided service "mmc-auth-keys" (credentials use the same names
// as the variables below); a real environment variable always wins.
const SECRET_SERVICE = 'mmc-auth-keys';
function serviceCredentials() {
  try {
    const entry = (JSON.parse(process.env.VCAP_SERVICES || '{}')['user-provided'] || []).find((s) => s.name === SECRET_SERVICE);
    return entry?.credentials || {};
  } catch { return {}; }
}
const env = { ...serviceCredentials(), ...process.env };
const production = process.env.NODE_ENV === 'production';

const int = (name, def) => {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer`);
  return n;
};

const json = (name) => {
  const raw = env[name];
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error(`${name} must be a JSON object {kid: publicPem}`); }
};

// AUTH_TRUST_PROXY: number of hops, "true"/"false"; default 1 in production, off in dev
const trustProxy = () => {
  const raw = env.AUTH_TRUST_PROXY;
  if (raw === undefined || raw === '') return production ? 1 : false;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
};

module.exports = Object.freeze({
  production,
  signingKey: env.AUTH_SIGNING_KEY || null,          // Ed25519 PKCS#8 PEM; required in production
  signingKid: env.AUTH_SIGNING_KID || null,          // default: JWK thumbprint of the key
  verifyKeys: json('AUTH_VERIFY_KEYS'),              // previous public keys, for rotation
  issuer: env.AUTH_ISSUER || 'cap-custom-auth',
  audience: env.AUTH_AUDIENCE || 'cap-app',
  accessTtlSec: int('AUTH_ACCESS_TTL_SEC', 900),
  refreshTtlSec: int('AUTH_REFRESH_TTL_SEC', 604800),
  sessionMaxSec: int('AUTH_SESSION_MAX_SEC', 2592000),
  refreshGraceMs: int('AUTH_REFRESH_GRACE_MS', 10000),
  maxFailed: int('AUTH_MAX_FAILED', 5),
  lockoutSec: int('AUTH_LOCKOUT_SEC', 900),
  loginRateMax: int('AUTH_LOGIN_RATE_MAX', 20),
  loginRateWindowMs: 15 * 60 * 1000,
  stateCacheMs: int('AUTH_STATE_CACHE_MS', 30000),
  refreshCookie: env.AUTH_REFRESH_COOKIE || 'cap_rt',
  trustProxy: trustProxy(),
  clockSkewSec: 30,
  maxBodyBytes: 10 * 1024,
  maxTokenBytes: 16 * 1024,
});
