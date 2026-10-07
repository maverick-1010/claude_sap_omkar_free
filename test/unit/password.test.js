'use strict';
/** Auth spec "Unit tests – Password", FR-P1, FR-P2, SEC-12. */
const crypto = require('crypto');
const password = require('../../srv/lib/auth/password');

const GOOD = 'Correct-Horse-42';

describe('password hashing', () => {
  let stored;
  beforeAll(async () => { stored = await password.hash(GOOD); });

  test('hash has the format scrypt$N$r$p$salt$hash with current parameters', () => {
    const [alg, N, r, p, salt, key] = stored.split('$');
    expect([alg, N, r, p]).toEqual(['scrypt', '32768', '8', '1']);
    expect(Buffer.from(salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(key, 'base64')).toHaveLength(64);
    expect(stored).not.toContain(GOOD);
  });

  test('verify accepts the right and rejects a wrong password', async () => {
    expect(await password.verify(GOOD, stored)).toBe(true);
    expect(await password.verify('Correct-Horse-43', stored)).toBe(false);
    expect(await password.verify('', stored)).toBe(false);
  });

  test('the same password gets a different salt every time', async () => {
    expect(await password.hash(GOOD)).not.toBe(stored);
  });

  test('needsRehash is false for current parameters and true for outdated ones', async () => {
    expect(password.needsRehash(stored)).toBe(false);
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(GOOD, salt, 64, { N: 2 ** 14, r: 8, p: 1 });
    const old = `scrypt$16384$8$1$${salt.toString('base64')}$${key.toString('base64')}`;
    expect(password.needsRehash(old)).toBe(true);
    expect(await password.verify(GOOD, old)).toBe(true);
    expect(password.needsRehash('garbage')).toBe(true);
  });

  test('out-of-range or malformed parameters from the DB are rejected', async () => {
    const [, , , , salt, key] = stored.split('$');
    for (const bad of [
      `scrypt$${2 ** 22}$8$1$${salt}$${key}`,   // N too large (hashing DoS)
      `scrypt$1000$8$1$${salt}$${key}`,         // N not a power of 2
      `scrypt$1024$8$1$${salt}$${key}`,         // N too small
      `scrypt$32768$99$1$${salt}$${key}`,       // r out of range
      `scrypt$32768$8$50$${salt}$${key}`,       // p out of range
      `scrypt$32768$8$1$AAAA$${key}`,           // salt too short
      `bcrypt$32768$8$1$${salt}$${key}`,
      'scrypt$32768$8$1', null, undefined, '',
    ]) {
      expect(password.parse(bad)).toBeNull();
      expect(await password.verify(GOOD, bad)).toBe(false);
    }
  });

  test('passwords over 128 characters are never hashed', async () => {
    const long = 'Aa1!'.repeat(33);
    expect(await password.verify(long, stored)).toBe(false);
    await expect(password.hash(long)).rejects.toThrow();
  });

  test('dummyVerify always fails and takes a real scrypt run', async () => {
    expect(await password.dummyVerify(GOOD)).toBe(false);
    expect(await password.dummyVerify(undefined)).toBe(false);
  });
});

describe('password policy', () => {
  test.each([
    ['Short-1a', /12 to 128/],
    ['A'.repeat(64) + 'a1!'.repeat(22), /12 to 128/],
    ['alllowercaseletters', /three of/],
    ['lowercase-and-symbols', /three of/],
    ['UPPER123456789', /three of/],
    ['Xalice-Secret-9', /user name/],
    ['xALICE-secret-9', /user name/],
  ])('%s is rejected', (pw, msg) => {
    expect(password.policyError(pw, 'alice')).toMatch(msg);
  });

  test.each(['Correct-Horse-42', 'lowercase123UPPER', 'abcdefgh123!', 'ABCDEFGH123!'])('%s is accepted', (pw) => {
    expect(password.policyError(pw, 'alice')).toBeNull();
  });

  test('a missing password is rejected', () => {
    expect(password.policyError(undefined, 'alice')).toMatch(/required/);
  });
});
