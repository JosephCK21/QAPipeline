#!/usr/bin/env node
/**
 * Thin forwarder — implementations live in code/devscripts/clear.js
 */
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = __dirname;
const r = spawnSync(process.execPath, [path.join(repoRoot, 'code', 'devscripts', 'clear.js')], {
  cwd: repoRoot,
  stdio: 'inherit'
});
process.exit(r.status ?? 0);
