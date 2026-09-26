"use strict";

const fs = require("node:fs");

// Async rm retries initial rmdir EBUSY and lets process shutdown callbacks run.
function rmTree(dir) {
  return fs.promises.rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 7,
    retryDelay: 50,
  });
}

module.exports = { rmTree };
