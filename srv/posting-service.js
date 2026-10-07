'use strict';
const cds = require('@sap/cds');
const { postChunk } = require('./lib/posting');
const queue = require('./lib/posting-queue');

module.exports = class PostingService extends cds.ApplicationService {
  init() {
    this.on('postChunk', async (req) => {
      const { remaining } = await postChunk(req.data.jobID);
      if (remaining) await queue.enqueue(req.data.jobID);            // next chunk: committed together with this one
    });
    return super.init();
  }
};
