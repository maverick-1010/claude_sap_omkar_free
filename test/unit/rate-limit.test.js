'use strict';
/** Auth spec "Unit tests – Rate limiter", FR-A5. */
const { createLimiter } = require('../../srv/lib/auth/rate-limit');

describe('rate limiter', () => {
  test('request N+1 within the window is refused with a Retry-After', () => {
    const limiter = createLimiter({ max: 3, windowMs: 60000 });
    for (let i = 0; i < 3; i++) expect(limiter.hit('1.1.1.1', 1000).allowed).toBe(true);
    const r = limiter.hit('1.1.1.1', 1000 + 10000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBe(50);
  });

  test('keys are independent and the window resets', () => {
    const limiter = createLimiter({ max: 1, windowMs: 1000 });
    expect(limiter.hit('a', 0).allowed).toBe(true);
    expect(limiter.hit('a', 10).allowed).toBe(false);
    expect(limiter.hit('b', 10).allowed).toBe(true);
    expect(limiter.hit('a', 1000).allowed).toBe(true);
  });

  test('middleware answers 429 with Retry-After and the error shape', () => {
    const limiter = createLimiter({ max: 1, windowMs: 60000 });
    const res = { headers: {}, set(k, v) { this.headers[k] = v; return this; }, status(c) { this.code = c; return this; }, json(b) { this.body = b; } };
    const next = jest.fn();
    limiter.middleware({ ip: '2.2.2.2' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    limiter.middleware({ ip: '2.2.2.2' }, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.code).toBe(429);
    expect(Number(res.headers['Retry-After'])).toBeGreaterThan(0);
    expect(res.body.error.code).toBe('429');
  });
});
