'use strict';
// Job status lifecycle (spec §3.1). Single source of truth: every action checks its
// transition here, anything not listed is rejected with 409.

const EDITABLE = ['DRAFT', 'VALIDATED', 'REJECTED'];
const DELETABLE = [...EDITABLE, 'CANCELLED'];

const TRANSITIONS = {
  parse:       { from: ['DRAFT'], to: ['DRAFT'] },
  validate:    { from: EDITABLE, to: ['DRAFT', 'VALIDATED'] },
  submit:      { from: ['VALIDATED'], to: ['PENDING_APPROVAL', 'PROCESSING'] },
  approve:     { from: ['PENDING_APPROVAL'], to: ['APPROVED'] },
  startPosting: { from: ['APPROVED'], to: ['PROCESSING'] },
  reject:      { from: ['PENDING_APPROVAL'], to: ['REJECTED'] },
  cancel:      { from: ['DRAFT', 'VALIDATED', 'PENDING_APPROVAL', 'REJECTED'], to: ['CANCELLED'] },
  retryFailed: { from: ['COMPLETED_WITH_ERRORS', 'FAILED'], to: ['PROCESSING'] },
  finish:      { from: ['PROCESSING'], to: ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] },
};

// Messages required by spec §7.3; everything else gets the generic text
const MESSAGES = {
  submit: () => 'Job must be validated before submit',
  cancel: (status) => status === 'PROCESSING' ? 'Posting already started' : null,
};

const isEditable = (status) => EDITABLE.includes(status);
const isDeletable = (status) => DELETABLE.includes(status);

const canTransition = (status, event) => !!TRANSITIONS[event]?.from.includes(status);

/** Rejects the request with 409 unless `event` is allowed from `status`. */
function assertTransition(req, status, event) {
  if (canTransition(status, event)) return;
  const text = MESSAGES[event]?.(status) ?? `Action ${event} is not allowed in status ${status}`;
  req.reject(409, text);
}

module.exports = { EDITABLE, DELETABLE, TRANSITIONS, isEditable, isDeletable, canTransition, assertTransition };
