# Custom auth framework – progress

Source: `docs/spec/Specification Custom Auth Framework for SAP CAP (Node.js).docx`. Docs: `docs/auth.md`.

## Phases
| # | Phase | Status | Gate |
|---|---|---|---|
| 1 | Foundation | done | `cds deploy` creates 8 `auth_*` tables; `cds env` right in both modes; existing 179 tests green |
| 2 | Crypto core | done | `test/unit/tokens`, `password`, `config` (AC-14) |
| 3 | Authentication | done | `test/auth.test.js` (AC-1…AC-7, AC-16) |
| 4 | Authorization | done | `test/unit/permissions`, `test/auth-admin.test.js` (AC-8/9/15 adapted to MassMaterialService) |
| 5 | Administration | done | `test/auth-admin.test.js` (AC-10…AC-13 + admin rules) |
| 6 | Hardening | done | `mta.yaml`, docs, SEC review below |

## Decisions
- Custom auth kind `mmc-auth` (not a bare `impl`) in `[development]` and `[production]`; the existing suites keep `kind: mocked` via `CDS_CONFIG` and are untouched. `[test]` profile = in-memory DB.
- Roles `MaterialRequester/Approver/Admin` are seeded `auth.Roles`; role IDs and permission IDs both become `cds.User` roles, so `srv/authorization.cds` and the handlers are unchanged. `Administrator` (permission `User.Admin`) administers users.
- `@sap/cds` 10 / express 5 instead of 9 / 4. `@sap/xssec` and `xs-security.json` removed. No sample `DocumentService` (not part of MMC).
- Signing key: env var or the Cloud Foundry user-provided service `mmc-auth-keys` (read in `config.js`, env wins).
- Extra guard rails: `Administrator` cannot lose `User.Admin`; foreign keys of UserRoles/RolePermissions are checked in the handler (SQLite does not enforce them); deleting an assigned role or `Administrator` is 409.
- Open-question defaults taken: in-memory limiter/cache (Redis documented), no MFA (extension point `afterPasswordVerified`), username ≠ email, audit kept forever (purge documented), API only.

## Open issues
- `mbt build` not run (mbt not installed here); `cds build --production` is checked instead.
- Rate limiter and user-state cache are per instance.
- No purge job for `auth.AuditLog` / expired `auth.RefreshTokens`.
- `/odata/v2/...` works with the Bearer token (manual smoke test) but is not covered by a test.

## Security checklist
| ID | Status | Where |
|---|---|---|
| SEC-1 no plaintext passwords / raw tokens stored or logged | ok | hashes only (`password.js`, `tokens.hashToken`); test checks the audit log |
| SEC-2 EdDSA only | ok | `tokens.verifyAccessToken`; unit tests (alg none, HS256) |
| SEC-3 no user enumeration | ok | same message, dummy scrypt (AC-1) |
| SEC-4 rate limit + lockout | ok | `rate-limit.js`, AC-4 |
| SEC-5 refresh theft detection | ok | family revocation, AC-5 |
| SEC-6 CSRF for cookie refresh | ok | SameSite=Strict + header, AC-6 |
| SEC-7 revocation ≤ `AUTH_STATE_CACHE_MS` | ok | `user-store` cache, invalidated locally and after commit |
| SEC-8 security headers | ok | `server.js`, tested |
| SEC-9 trust proxy | ok | `config.trustProxy` (1 in production) |
| SEC-10 keys only from env / secret store | ok | `keys.js`, `config.js`, AC-14 |
| SEC-11 audit events, failure never breaks request | ok | `audit.js` |
| SEC-12 input limits | ok | 10 kB body, 16 kB token, 128-char password |
| SEC-13 generic 500s | ok | `routes.js`, `custom-auth.js` |
