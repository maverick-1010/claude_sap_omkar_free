'use strict';

/** Key (ID) of the last path segment of an OData request, e.g. UploadJobs(<ID>)/requests(<ID>). */
function keyOf(req) {
  const k = req.params?.at(-1);
  return typeof k === 'object' && k !== null ? k.ID : k;
}

module.exports = { keyOf };
