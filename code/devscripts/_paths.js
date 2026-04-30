/**
 * Shared repo layout for scripts under code/devscripts/.
 * Repo root is the parent directory of code/.
 */
const path = require('path');
const { createRequire } = require('module');

const backendRoot = path.join(__dirname, '..', 'backend');
const frontendRoot = path.join(__dirname, '..', 'frontend');
const repoRoot = path.join(__dirname, '..', '..');
const requireBackend = createRequire(path.join(backendRoot, 'package.json'));

function loadBackendEnv() {
    requireBackend('dotenv').config({ path: path.join(backendRoot, '.env') });
}

module.exports = {
    backendRoot,
    frontendRoot,
    repoRoot,
    loadBackendEnv
};
