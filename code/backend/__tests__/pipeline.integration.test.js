'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('AUTOQA_DB_PATH is read by db module export contract', async (t) => {
    const ORIG = process.env.AUTOQA_DB_PATH;
    let dbPathTarget;
    try {
        dbPathTarget = `${__dirname}/fixture-autoqa-smoke-db-${Date.now()}.db`;
        process.env.AUTOQA_DB_PATH = dbPathTarget;
        delete require.cache[require.resolve('../db.js')];
        const dbFresh = require('../db.js');
        dbFresh.initDb();
        dbFresh.insertLlmTraceRow({
            runId: 'run-smoke',
            traceLabel: 'smoke',
            phase: 'response',
            requestPayload: '{}',
            responsePayload: '{"ok":true}',
            tokenUsage: JSON.stringify({ inputTokens: 1, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0 })
        });
        const rows = dbFresh.listLlmTracesByRun('run-smoke');
        assert.equal(rows.length, 1);
        assert.ok(rows[0].responsePayload.includes('"ok"'));
        const fs = require('fs');
        fs.unlinkSync(dbPathTarget);
    } catch (err) {
        if (String(err?.message || '').includes('NODE_MODULE_VERSION') || String(err?.code) === 'ERR_DLOPEN_FAILED') {
            t.skip(`better-sqlite3 native module unavailable: ${err.message}`);
            return;
        }
        throw err;
    } finally {
        process.env.AUTOQA_DB_PATH = ORIG;
        delete require.cache[require.resolve('../db.js')];
        if (dbPathTarget) {
            try {
                require('fs').unlinkSync(dbPathTarget);
            } catch { /* noop */ }
        }
    }
});
