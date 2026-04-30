/**
 * Wipe all test cases, pipeline run history, DLQ rows, and scenario run metadata.
 * Scenarios (Jira-linked rows) and story_sync_log are kept.
 *
 * Usage:
 *   node code/devscripts/clearPipelineTestData.js   (from repo root)
 */

const path = require('path');
const { backendRoot, loadBackendEnv } = require('./_paths');
loadBackendEnv();
const { initDb, clearAllPipelineExecutionData } = require(path.join(backendRoot, 'db'));

initDb();
clearAllPipelineExecutionData();
console.log('[clearPipelineTestData] Removed test_cases, run_history, dead_letter_queue; reset rtm_scenarios run fields.');
