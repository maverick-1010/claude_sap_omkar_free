'use strict';
// Signing keys (FR-T4, FR-T5, SEC-10): the Ed25519 key comes from the environment only.
// Older public keys stay accepted for verification so keys can be rotated without logging everyone out.
const crypto = require('crypto');
const config = require('./config');

/** RFC 7638 JWK thumbprint of an Ed25519 public key, used as default kid. */
function thumbprint(publicKey) {
  const { crv, kty, x } = publicKey.export({ format: 'jwk' });
  return crypto.createHash('sha256').update(JSON.stringify({ crv, kty, x })).digest('base64url');
}

function publicKeyFrom(pem, name) {
  let key;
  try { key = crypto.createPublicKey(pem); } catch { throw new Error(`${name} is not a valid public key PEM`); }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`${name} must be an Ed25519 key`);
  return key;
}

/**
 * Builds the key store from settings: { kid, privateKey, publicKeys: Map<kid, KeyObject>, jwks }.
 * Throws in production when no signing key is configured.
 */
function createKeyStore(cfg = config, log = console) {
  let privateKey;
  if (cfg.signingKey) {
    try { privateKey = crypto.createPrivateKey(cfg.signingKey); } catch { throw new Error('AUTH_SIGNING_KEY is not a valid PKCS#8 PEM private key'); }
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('AUTH_SIGNING_KEY must be an Ed25519 key');
  } else if (cfg.production) {
    throw new Error('AUTH_SIGNING_KEY is required in production: refusing to start without a signing key');
  } else {
    privateKey = crypto.generateKeyPairSync('ed25519').privateKey;
    log.warn('[auth] AUTH_SIGNING_KEY not set: using an ephemeral signing key (development only, tokens die on restart)');
  }
  const publicKey = crypto.createPublicKey(privateKey);
  const kid = cfg.signingKid || thumbprint(publicKey);

  const publicKeys = new Map([[kid, publicKey]]);
  for (const [oldKid, pem] of Object.entries(cfg.verifyKeys || {}))
    if (!publicKeys.has(oldKid)) publicKeys.set(oldKid, publicKeyFrom(pem, `AUTH_VERIFY_KEYS.${oldKid}`));

  const jwks = {
    keys: [...publicKeys].map(([k, key]) => ({ ...key.export({ format: 'jwk' }), kid: k, alg: 'EdDSA', use: 'sig' })),
  };
  return Object.freeze({ kid, privateKey, publicKeys, jwks });
}

let store;
/** The process-wide key store, created on first use (server.js calls it at bootstrap so startup fails early). */
const keys = () => (store ??= createKeyStore());

module.exports = { keys, createKeyStore, thumbprint };
