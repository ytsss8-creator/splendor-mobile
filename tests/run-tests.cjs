'use strict';

// Register all native node:test cases in one process. Each game still gets its
// own VM. This produces case-level TAP totals without subprocess IPC or flags.
const fs = require('node:fs');
const path = require('node:path');

for (const name of fs.readdirSync(__dirname).filter(name => name.endsWith('.test.cjs')).sort()) {
  require(path.join(__dirname, name));
}
