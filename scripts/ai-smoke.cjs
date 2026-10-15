'use strict';
const { runSmoke } = require('../tests/helpers/ai-battles.cjs');
const boards = Number(process.argv[2] || 20);
process.stdout.write(JSON.stringify(runSmoke({ boardCount: boards }), null, 2) + '\n');
