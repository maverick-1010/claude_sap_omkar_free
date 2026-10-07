'use strict';
// Access tokens (FR-T1..T3, SEC-2): own minimal JWT implementation, EdDSA only.
// Refresh tokens (FR-S1): 32 random bytes, only their SHA-256 hash is ever stored.
const crypto = require('crypto');
const config = require('./config');
const { keys } = require('./keys');

class TokenError extends Error {}

const b64json = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const nowSec = () => Math.floor(Date.now() / 1000);

/** Low-level: signs header + payload with an Ed25519 private key. */
function signJwt(header, payload, privateKey) {
  const input = `${b64json(header)}.${b64json(payload)}`;
  const signature = crypto.sign(null, Buffer.from(input), privateKey).toString('base64url');
  return `${input}.${signature}`;
}

/**
 * Issues an access token for a resolved user.
 * user = { id, username, tokenVersion, roles, permissions, attributes, mustChangePassword }
 */
function signAccessToken(user, { now = nowSec(), ttl = config.accessTtlSec, keyStore = keys() } = {}) {
  const payload = {
    iss: config.issuer,
    aud: config.audience,
    sub: user.id,
    name: user.username,
    token_use: 'access',
    iat: now,
    nbf: now,
    exp: now + ttl,
    jti: crypto.randomUUID(),
    tv: user.tokenVersion,
    roles: user.roles,
    perms: user.permissions,
    attr: user.attributes,
  };
  if (user.mustChangePassword) payload.mcp = true;
  return signJwt({ alg: 'EdDSA', typ: 'JWT', kid: keyStore.kid }, payload, keyStore.privateKey);
}

const B64URL = /^[A-Za-z0-9_-]+$/;
const parsePart = (part) => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch { /* falls through */ }
  throw new TokenError('malformed token');
};

/** Verifies an access token and returns its claims; throws TokenError for anything not acceptable. */
function verifyAccessToken(token, { now = nowSec(), keyStore = keys() } = {}) {
  if (typeof token !== 'string' || !token || Buffer.byteLength(token) > config.maxTokenBytes) throw new TokenError('malformed token');
  const parts = token.split('.');
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) throw new TokenError('malformed token');

  const header = parsePart(parts[0]);
  if (header.alg !== 'EdDSA') throw new TokenError('unsupported algorithm');       // blocks alg:none and algorithm confusion
  if (header.typ !== undefined && header.typ !== 'JWT') throw new TokenError('unsupported token type');
  const publicKey = typeof header.kid === 'string' && keyStore.publicKeys.get(header.kid);
  if (!publicKey) throw new TokenError('unknown key');

  const signature = Buffer.from(parts[2], 'base64url');
  if (signature.length !== 64 || !crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, signature))
    throw new TokenError('invalid signature');

  const claims = parsePart(parts[1]);
  if (claims.iss !== config.issuer) throw new TokenError('wrong issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.audience)) throw new TokenError('wrong audience');
  if (claims.token_use !== 'access') throw new TokenError('wrong token use');
  if (!Number.isInteger(claims.exp) || now - config.clockSkewSec >= claims.exp) throw new TokenError('token expired');
  if (claims.nbf !== undefined && (!Number.isInteger(claims.nbf) || now + config.clockSkewSec < claims.nbf)) throw new TokenError('token not yet valid');
  if (typeof claims.sub !== 'string' || typeof claims.name !== 'string' || !Number.isInteger(claims.tv)) throw new TokenError('malformed claims');
  return claims;
}

const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

module.exports = { signAccessToken, verifyAccessToken, signJwt, newRefreshToken, hashToken, TokenError };
