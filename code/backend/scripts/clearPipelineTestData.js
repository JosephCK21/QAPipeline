/**
 * Wipe all test cases, pipeline run history, DLQ rows, and scenario run metadata.
 * Scenarios (Jira-linked rows) and story_sync_log are kept.
 *
 * Usage (from code/backend):
 *   node scripts/clearPipelineTestData.js
 */

require('dotenv').config();
const path = require('path');
const { initDb, clearAllPipelineExecutionData } = require(path.join(__dirname, '..', 'db'));

initDb();
clearAllPipelineExecutionData();
console.log('[clearPipelineTestData] Removed test_cases, run_history, dead_letter_queue; reset rtm_scenarios run fields.');
