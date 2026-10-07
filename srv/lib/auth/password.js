'use strict';
// Password hashing and policy (FR-P1, FR-P2, SEC-1, SEC-3, SEC-12). Node crypto.scrypt only, no native modules.
// Stored format: scrypt$N$r$p$<salt base64>$<hash base64>
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const CURRENT = { N: 2 ** 15, r: 8, p: 1 };
const KEY_LEN = 64, SALT_LEN = 16;
const MAX_LEN = 128, MIN_LEN = 12;

const maxmem = ({ N, r, p }) => 128 * N * r * (p + 1) + 1024 * 1024;
const derive = (password, salt, params) => scrypt(password, salt, KEY_LEN, { ...params, maxmem: maxmem(params) });

async function hash(password) {
  if (typeof password !== 'string' || password.length > MAX_LEN) throw new Error('invalid password');
  const salt = crypto.randomBytes(SALT_LEN);
  const key = await derive(password, salt, CURRENT);
  return ['scrypt', CURRENT.N, CURRENT.r, CURRENT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Parses a stored hash; parameters from the DB are range-checked so a tampered row cannot trigger a hashing DoS. */
function parse(stored) {
  if (typeof stored !== 'string') return null;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const powerOf2 = Number.isInteger(N) && N > 1 && (N & (N - 1)) === 0;
  if (!powerOf2 || N < 2 ** 14 || N > 2 ** 20) return null;
  if (!Number.isInteger(r) || r < 1 || r > 32) return null;
  if (!Number.isInteger(p) || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4], 'base64'), key = Buffer.from(parts[5], 'base64');
  if (salt.length !== SALT_LEN || key.length !== KEY_LEN) return null;
  return { params: { N, r, p }, salt, key };
}

async function verify(password, stored) {
  if (typeof password !== 'string' || password.length > MAX_LEN) return false;
  const parsed = parse(stored);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.params);
  return crypto.timingSafeEqual(actual, parsed.key);
}

/** True if the hash was made with other parameters than the current ones (re-hash on next login, FR-A4). */
function needsRehash(stored) {
  const parsed = parse(stored);
  return !parsed || parsed.params.N !== CURRENT.N || parsed.params.r !== CURRENT.r || parsed.params.p !== CURRENT.p;
}

// Unknown and locked users still pay for one scrypt run, so timing does not reveal them (FR-A2)
let dummy;
async function dummyVerify(password) {
  dummy ??= hash(crypto.randomBytes(16).toString('hex'));
  await verify(typeof password === 'string' ? password.slice(0, MAX_LEN) : '', await dummy);
  return false;
}

/** Password policy (FR-P2). Returns an error message, or null when the password is acceptable. */
function policyError(password, username = '') {
  if (typeof password !== 'string') return 'Password is required';
  if (password.length < MIN_LEN || password.length > MAX_LEN) return `Password must be ${MIN_LEN} to ${MAX_LEN} characters long`;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'Password must contain at least three of: lowercase letters, uppercase letters, digits, symbols';
  if (username && password.toLowerCase().includes(String(username).toLowerCase())) return 'Password must not contain the user name';
  return null;
}

module.exports = { hash, verify, needsRehash, dummyVerify, policyError, parse, MAX_LEN, CURRENT };
