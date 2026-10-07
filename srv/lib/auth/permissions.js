'use strict';
// Handler-side checks (FR-Z6, FR-Z7) for rules that @restrict cannot express, e.g. attribute checks on CREATE.
// Each helper rejects with 403 through req.reject, which also works for any object with a user and a reject function.

const has = (req, name) => !!req.user?.is?.(name);

function deny(req, message) {
  if (typeof req.reject === 'function') return req.reject(403, message);
  throw Object.assign(new Error(message), { status: 403, code: 403 });
}

/** The user needs ALL given permissions (or roles). */
function requirePermission(req, ...perms) {
  const missing = perms.filter((p) => !has(req, p));
  if (missing.length) deny(req, `Missing permission: ${missing.join(', ')}`);
}

/** The user needs AT LEAST ONE of the given permissions. */
function requireAnyPermission(req, ...perms) {
  if (!perms.some((p) => has(req, p))) deny(req, `Requires one of: ${perms.join(', ')}`);
}

/** The user's attribute `name` (scalar or multi-valued) must contain `value`. */
function requireAttribute(req, name, value) {
  const have = [].concat(req.user?.attr?.[name] ?? []);
  if (!have.map(String).includes(String(value))) deny(req, `Attribute ${name} does not allow ${value}`);
}

module.exports = { requirePermission, requireAnyPermission, requireAttribute };
