#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');

const repoRoot = __dirname;
const backendRoot = path.join(repoRoot, 'code', 'backend');
const backendDataDir = path.join(backendRoot, 'data');
const backendUploadsDir = path.join(backendRoot, 'uploads');
const sandboxRoot = path.join(os.tmpdir(), 'autoqa-sandbox');

function safeDeleteFile(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Failed to delete file: ${filePath}`);
    console.error(error.message);
    return false;
  }
}

function safeDeleteDirectory(dirPath) {
  try {
    if (fs.existsSync(dirPath)) {
      fs.rmSync(dirPath, { recursive: true, force: true });
      return true;
    }
    return false;
  } catch (error) {
    console.error(`Failed to delete directory: ${dirPath}`);
    console.error(error.message);
    return false;
  }
}

function ensureDirectory(dirPath) {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
  } catch (error) {
    console.error(`Failed to create directory: ${dirPath}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

function clearBackendData() {
  const deletedItems = [];

  // Remove the main SQLite database and sidecar files.
  const dbFiles = [
    path.join(backendDataDir, 'autoqa.db'),
    path.join(backendDataDir, 'autoqa.db-shm'),
    path.join(backendDataDir, 'autoqa.db-wal'),
  ];

  dbFiles.forEach((filePath) => {
    if (safeDeleteFile(filePath)) deletedItems.push(filePath);
  });

  // Remove JSON stores used for local state and run history.
  const jsonStores = [
    path.join(backendDataDir, 'projects.json'),
    path.join(backendDataDir, 'requirementsMap.json'),
    path.join(backendDataDir, 'rtm_baselines.json'),
    path.join(backendDataDir, 'runHistory.json'),
    path.join(backendDataDir, 'jiraDocuments.json'),
  ];

  jsonStores.forEach((filePath) => {
    if (safeDeleteFile(filePath)) deletedItems.push(filePath);
  });

  return deletedItems;
}

function clearUploads() {
  const deletedItems = [];
  if (safeDeleteDirectory(backendUploadsDir)) {
    deletedItems.push(backendUploadsDir);
  }
  return deletedItems;
}

function clearSandboxArtifacts() {
  const deletedItems = [];
  if (safeDeleteDirectory(sandboxRoot)) {
    deletedItems.push(sandboxRoot);
  }
  return deletedItems;
}

function main() {
  console.log('Clearing local AutoQA run/database data...\n');

  const removed = [
    ...clearBackendData(),
    ...clearUploads(),
    ...clearSandboxArtifacts(),
  ];

  // Recreate expected directories so next run starts cleanly.
  ensureDirectory(backendDataDir);
  ensureDirectory(path.join(backendUploadsDir, 'requirements'));
  ensureDirectory(path.join(backendUploadsDir, 'jira-docs'));

  if (removed.length === 0) {
    console.log('No local run/db artifacts were found to remove.');
  } else {
    console.log('Removed items:');
    removed.forEach((item) => console.log(`- ${item}`));
  }

  console.log('\nDone. You can now run a fresh local test cycle.');
}

main();
