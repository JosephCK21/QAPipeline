'use strict';

/**
 * Placeholder for Phase 16 (worker_threads): run `runPipeline` off the UI thread with a
 * parent↔worker message bridge for Socket.IO / DB-safe updates. Not wired behind env yet —
 * enables future `worker_threads` integration without refactoring consumers today.
 */

module.exports = {
    PIPELINE_WORKER_ENABLED: process.env.PIPELINE_WORKER_ENABLED === 'true'
};
