'use strict';
// In-memory fixed-window rate limiter (FR-A5, SEC-4). Per instance; with several instances
// the effective limit is max x instances (a shared store such as Redis would make it global, see PROGRESS.md).

function createLimiter({ max, windowMs }) {
  const hits = new Map();   // key -> { start, count }

  /** Counts one request; returns { allowed, retryAfterSec }. */
  function hit(key, now = Date.now()) {
    let w = hits.get(key);
    if (!w || now - w.start >= windowMs) {
      if (hits.size > 50000) sweep(now);
      w = { start: now, count: 0 };
      hits.set(key, w);
    }
    w.count++;
    if (w.count <= max) return { allowed: true, retryAfterSec: 0 };
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
  }

  function sweep(now) {
    for (const [k, w] of hits) if (now - w.start >= windowMs) hits.delete(k);
  }

  /** Express middleware keyed by client IP; answers 429 with Retry-After. */
  function middleware(req, res, next) {
    const { allowed, retryAfterSec } = hit(req.ip || 'unknown');
    if (allowed) return next();
    res.set('Retry-After', String(retryAfterSec));
    res.status(429).json({ error: { code: '429', message: 'Too many requests, try again later' } });
  }

  return { hit, middleware, reset: () => hits.clear() };
}

module.exports = { createLimiter };
