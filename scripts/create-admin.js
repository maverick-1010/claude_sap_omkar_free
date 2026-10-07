#!/usr/bin/env node
'use strict';
// Creates the first administrator (auth spec "Seed data"): never seeded with a known password.
// Usage: node scripts/create-admin.js [--username admin] [--email a@b.c]
// The password is read from ADMIN_PASSWORD or prompted (hidden). The user must change it at first login.
const readline = require('readline');
const crypto = require('crypto');
const cds = require('@sap/cds');
const password = require('../srv/lib/auth/password');

const ROLES = ['Administrator', 'MaterialAdmin'];
const USERNAME = /^[a-z0-9._-]{3,60}$/;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

function ask(question, hidden = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a); }));
}

async function main() {
  const username = (arg('username') || (await ask('Admin username [admin]: ')) || 'admin').trim().toLowerCase();
  if (!USERNAME.test(username)) throw new Error('Username must match ^[a-z0-9._-]{3,60}$');
  const email = arg('email', null);

  let pw = process.env.ADMIN_PASSWORD;
  if (!pw) {
    pw = await ask('Initial password: ', true);
    if (pw !== (await ask('Repeat password: ', true))) throw new Error('Passwords do not match');
  }
  const policy = password.policyError(pw, username);
  if (policy) throw new Error(policy);

  cds.model = cds.compile.for.nodejs(await cds.load('*'));
  const db = await cds.connect.to('db');
  const { Users, UserRoles, Roles } = cds.entities('auth');

  await db.tx({ user: new cds.User({ id: 'create-admin' }) }, async (tx) => {
    if (await tx.run(SELECT.one.from(Users).where({ username }))) throw new Error(`User ${username} already exists`);
    const known = (await tx.run(SELECT.from(Roles).columns('ID').where({ ID: { in: ROLES } }))).map((r) => r.ID);
    const missing = ROLES.filter((r) => !known.includes(r));
    if (missing.length) throw new Error(`Roles not found: ${missing.join(', ')} (deploy the database first)`);
    const ID = crypto.randomUUID();
    await tx.run(INSERT.into(Users).entries({ ID, username, email, passwordHash: await password.hash(pw), mustChangePassword: true }));
    await tx.run(INSERT.into(UserRoles).entries(ROLES.map((role_ID) => ({ user_ID: ID, role_ID }))));
  });
  console.log(`Administrator ${username} created with roles ${ROLES.join(', ')}; the password must be changed at first login.`);   // eslint-disable-line no-console
}

main().then(() => process.exit(0), (e) => {
  console.error(`create-admin: ${e.message}`);   // eslint-disable-line no-console
  process.exit(1);
});
