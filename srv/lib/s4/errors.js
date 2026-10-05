'use strict';

// Every adapter classifies failures into one of three kinds so the worker does not need to know the protocol:
//   transient - timeout, 5xx, lock: retried with backoff
//   business  - S/4 rejected this material: the row FAILED, no retry, the job continues
//   job       - destination missing, authentication failed: nothing can be posted, the job FAILED
class S4Error extends Error {
  constructor(message, { kind = 'business', code = null, cause } = {}) {
    super(message, { cause });
    this.name = 'S4Error';
    this.kind = kind;
    this.code = code;
  }
}

module.exports = { S4Error };
