'use strict';
/** Auth spec FR-Z6: permission and attribute helpers reject with 403. */
const cds = require('@sap/cds');
const { requirePermission, requireAnyPermission, requireAttribute } = require('../../srv/lib/auth/permissions');

const reqFor = (roles, attr = {}) => ({
  user: new cds.User({ id: 'u', roles, attr }),
  reject: (status, message) => { throw Object.assign(new Error(message), { status }); },
});

describe('permission helpers', () => {
  test('requirePermission needs all permissions', () => {
    const req = reqFor(['Doc.Read', 'Doc.Write']);
    expect(() => requirePermission(req, 'Doc.Read', 'Doc.Write')).not.toThrow();
    expect(() => requirePermission(req, 'Doc.Read', 'Doc.Delete')).toThrow(expect.objectContaining({ status: 403, message: 'Missing permission: Doc.Delete' }));
  });

  test('requireAnyPermission needs one of them', () => {
    const req = reqFor(['Doc.Read']);
    expect(() => requireAnyPermission(req, 'Doc.Write', 'Doc.Read')).not.toThrow();
    expect(() => requireAnyPermission(req, 'Doc.Write', 'Doc.Delete')).toThrow(expect.objectContaining({ status: 403 }));
  });

  test('requireAttribute handles scalar and multi-valued attributes', () => {
    expect(() => requireAttribute(reqFor([], { department: 'FIN' }), 'department', 'FIN')).not.toThrow();
    expect(() => requireAttribute(reqFor([], { department: ['FIN', 'HR'] }), 'department', 'HR')).not.toThrow();
    expect(() => requireAttribute(reqFor([], { department: 'FIN' }), 'department', 'HR')).toThrow(expect.objectContaining({ status: 403 }));
    expect(() => requireAttribute(reqFor([]), 'department', 'FIN')).toThrow(expect.objectContaining({ status: 403 }));
  });

  test('anonymous users are denied', () => {
    const req = { user: cds.User.anonymous, reject: reqFor([]).reject };
    expect(() => requirePermission(req, 'Doc.Read')).toThrow(expect.objectContaining({ status: 403 }));
  });

  test('without req.reject a 403 error is thrown', () => {
    expect(() => requirePermission({ user: new cds.User({ id: 'u', roles: [] }) }, 'X')).toThrow(expect.objectContaining({ status: 403 }));
  });
});
