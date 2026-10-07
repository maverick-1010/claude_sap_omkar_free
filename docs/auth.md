# Custom authentication and authorization

Replaces XSUAA. Source spec: `docs/spec/Specification Custom Auth Framework for SAP CAP (Node.js).docx`. Progress and decisions: `PROGRESS.md`.

## Architecture
- Login/refresh are plain Express routes under `/auth` (`server.js` → `srv/lib/auth/routes.js`). Everything else goes through CAP, where `srv/lib/auth/custom-auth.js` (`cds.requires.auth.kind = mmc-auth`) verifies the Bearer token and builds `req.user`.
- Identity data lives in `db/auth-schema.cds` (namespace `auth`). Passwords: scrypt. Access tokens: 15 min EdDSA JWT. Refresh tokens: rotating, only SHA-256 hashes stored.
- `cds.User.id` = username; `roles` = role IDs + permission IDs; `attr` = user attributes + `userId`. The existing `@restrict` rules (`MaterialRequester`, `MaterialApprover`, `MaterialAdmin`) are unchanged.
- Every request re-checks `isActive` and `tokenVersion` (cached per instance for `AUTH_STATE_CACHE_MS`). Deactivation, password change, role change and logout-all take effect at once on the instance that handled the change and within the cache TTL on other instances.

## Endpoints
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/login` | `{username, password, client?}`; 20 per 15 min per IP; `client: "native"` returns `refresh_token` in the body, browsers get an HttpOnly cookie |
| POST | `/auth/refresh` | cookie + `X-Requested-With: XMLHttpRequest`, or body `refresh_token`; 409 inside the grace window, reuse of a rotated token revokes the family |
| POST | `/auth/logout`, `/auth/logout-all`, `/auth/change-password` | logout-all and change-password need a Bearer token |
| GET | `/auth/me`, `/auth/.well-known/jwks.json` | |
| OData | `/admin/*` | `AuthAdminService`, permission `User.Admin`: Users, UserRoles, UserAttributes, Roles, RolePermissions, Permissions, AuditLog, Sessions; actions `createUser`, `resetPassword`, `unlockUser`, `revokeSessions` |

While `mustChangePassword` is set, the token only works on `/auth/*`; CAP services answer 403.

## Configuration (`srv/lib/auth/config.js`)
`AUTH_SIGNING_KEY` (Ed25519 PKCS#8 PEM, required in production), `AUTH_SIGNING_KID`, `AUTH_VERIFY_KEYS` (JSON `{kid: publicPem}`), `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ACCESS_TTL_SEC` (900), `AUTH_REFRESH_TTL_SEC` (604800), `AUTH_SESSION_MAX_SEC` (2592000), `AUTH_REFRESH_GRACE_MS` (10000), `AUTH_MAX_FAILED` (5), `AUTH_LOCKOUT_SEC` (900), `AUTH_LOGIN_RATE_MAX` (20), `AUTH_STATE_CACHE_MS` (30000), `AUTH_REFRESH_COOKIE` (cap_rt), `AUTH_TRUST_PROXY` (1 in production). On Cloud Foundry the same names are read from the user-provided service `mmc-auth-keys`; real environment variables win.

## Local setup
`npm run setup` deploys `db.sqlite` and creates the administrator (password from `ADMIN_PASSWORD` or a prompt, `mustChangePassword` set), then `npm run watch`. Without `AUTH_SIGNING_KEY` development uses an ephemeral key (tokens die on restart).

## Key rotation
1. Generate a key: `node -e "const c=require('crypto');console.log(c.generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}))"`.
2. Put the old **public** key into `AUTH_VERIFY_KEYS` as `{"<old kid>": "<pem>"}` and the new private key into `AUTH_SIGNING_KEY`; restart. Old tokens stay valid until they expire (15 min).
3. After 15 minutes remove the old entry.

## Production checklist
- Create the secret service once: `cf cups mmc-auth-keys -p '{"AUTH_SIGNING_KEY":"<pem>"}'`. The app refuses to start without a key.
- Run behind the CF router (`trust proxy` = 1) over HTTPS only; HSTS is sent in production.
- Create the first admin with `scripts/create-admin.js`; never seed a password.
- Several instances: the rate limiter and the state cache are per instance (effective limit = max × instances, revocation visible within `AUTH_STATE_CACHE_MS`). A shared store such as Redis would make both global.
- `auth.AuditLog` and expired `auth.RefreshTokens` grow forever: schedule a purge job according to your retention policy.
- MFA: extension point `afterPasswordVerified` in `routes.js`.
