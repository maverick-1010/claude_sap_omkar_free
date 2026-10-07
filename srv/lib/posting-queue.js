'use strict';
const cds = require('@sap/cds');

// Hand-off between the lifecycle actions and the posting worker (spec §3.5).
// submit / approve / retryFailed call enqueue() after the job is PROCESSING and return immediately;
// the message is written to the persistent outbox in the same transaction as the status change.
async function enqueue(jobID) {
  const posting = cds.services.PostingService ?? await cds.connect.to('PostingService');
  await cds.queued(posting).send('postChunk', { jobID });
}

module.exports = { enqueue };
