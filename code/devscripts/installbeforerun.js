#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { repoRoot } = require('./_paths');

const installTargets = [
  path.join('code', 'backend'),
  path.join('code', 'frontend'),
];

function hasPackageJson(dirPath) {
  return fs.existsSync(path.join(dirPath, 'package.json'));
}

function runNpmInstall(dirPath) {
  console.log(`\nInstalling dependencies in: ${dirPath}`);
  const result = spawnSync('npm', ['install'], {
    cwd: dirPath,
    stdio: 'inherit',
    shell: true,
  });

  if (result.error) {
    console.error(`Failed to start npm in ${dirPath}:`, result.error.message);
    return false;
  }

  if (result.status !== 0) {
    console.error(`npm install failed in ${dirPath} with exit code ${result.status}`);
    return false;
  }

  console.log(`Completed install in: ${dirPath}`);
  return true;
}

function main() {
  console.log('Starting dependency installation...\n');

  for (const relTarget of installTargets) {
    const absTarget = path.join(repoRoot, relTarget);

    if (!hasPackageJson(absTarget)) {
      console.log(`Skipping ${absTarget} (no package.json found)`);
      continue;
    }

    const ok = runNpmInstall(absTarget);
    if (!ok) {
      console.error('\nInstall process stopped due to an error.');
      process.exit(1);
    }
  }

  console.log('\nAll dependency installs completed successfully.');
}

main();
