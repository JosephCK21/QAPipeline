const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

function safeJsonParse(text, fallback) {
    if (!text) return fallback;
    try { return JSON.parse(text); } catch { return fallback; }
}

const dbPath = process.env.AUTOQA_DB_PATH
    ? path.resolve(process.env.AUTOQA_DB_PATH)
    : path.join(__dirname, 'data', 'autoqa.db');

let db;

function initDb() {
    // Ensure data directory exists
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'));
    }
    if (!fs.existsSync(path.join(__dirname, 'data', 'artifacts'))) {
        fs.mkdirSync(path.join(__dirname, 'data', 'artifacts'));
    }

    db = new Database(dbPath);
    
    // Emulate write-ahead logging for better concurrency
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS rtm_scenarios (
            scenarioId TEXT PRIMARY KEY,
            projectKey TEXT,
            epicId TEXT,
            storyId TEXT,
            title TEXT,
            description TEXT,
            acceptanceCriteriaRef TEXT,
            type TEXT,
            priority TEXT,
            status TEXT,
            lastPRTested TEXT,
            testScriptRef TEXT,
            healAttempts INTEGER DEFAULT 0,
            lastRunDate TEXT,
            createdAt TEXT
        );
        
        CREATE TABLE IF NOT EXISTS run_history (
            runId TEXT PRIMARY KEY,
            repoFullName TEXT,
            prUrl TEXT,
            status TEXT,
            createdAt TEXT,
            completedAt TEXT,
            events TEXT,
            logs TEXT,
            llm_traces TEXT,
            scenario_statuses TEXT,
            localProjectId TEXT
        );

        CREATE TABLE IF NOT EXISTS dead_letter_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,
            payload TEXT,
            error TEXT,
            createdAt TEXT,
            retryCount INTEGER DEFAULT 0,
            status TEXT DEFAULT 'pending'
        );

        CREATE TABLE IF NOT EXISTS test_cases (
            testCaseId       TEXT PRIMARY KEY,
            scenarioId       TEXT NOT NULL,
            projectKey       TEXT,
            runId            TEXT,
            prUrl            TEXT,
            title            TEXT,
            steps            TEXT,
            testData         TEXT,
            testScript       TEXT,
            language         TEXT,
            status           TEXT DEFAULT 'pending',
            version          INTEGER DEFAULT 1,
            previousVersionId TEXT,
            codeFiles        TEXT,
            healAttempts     INTEGER DEFAULT 0,
            conversationId   TEXT,
            latestResponseId TEXT,
            createdAt        TEXT,
            lastRunAt        TEXT
        );

        CREATE TABLE IF NOT EXISTS story_sync_log (
            storyKey TEXT NOT NULL,
            localProjectId TEXT NOT NULL,
            projectKey TEXT,
            epicKey TEXT,
            summary TEXT,
            description TEXT,
            acceptanceCriteria TEXT,
            contentHash TEXT,
            lastSyncedAt TEXT,
            PRIMARY KEY (storyKey, localProjectId)
        );
    `);

    // Safe migration: add localProjectId to run_history if missing
    try {
        const columns = db.pragma('table_info(run_history)');
        if (!columns.find(c => c.name === 'localProjectId')) {
            db.exec('ALTER TABLE run_history ADD COLUMN localProjectId TEXT');
        }
    } catch (e) {
        // Column already exists or table doesn't exist yet — both are fine
    }

    // Safe migration: add conversationId / latestResponseId to test_cases for
    // resumable stateful LLM chains across server restarts.
    try {
        const columns = db.pragma('table_info(test_cases)');
        if (!columns.find(c => c.name === 'conversationId')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN conversationId TEXT');
        }
        if (!columns.find(c => c.name === 'latestResponseId')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN latestResponseId TEXT');
        }
    } catch (e) {
        // Columns already exist or table doesn't exist yet — both fine.
    }

    // Safe migration: add regression bookkeeping to test_cases so bug-fix
    // regression runs can record a clean pass vs adapted (healed) vs regression_fail,
    // and keep the original failing script + output as a potential regression signal.
    try {
        const columns = db.pragma('table_info(test_cases)');
        if (!columns.find(c => c.name === 'regression')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN regression TEXT');
        }
        if (!columns.find(c => c.name === 'originalScript')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN originalScript TEXT');
        }
        if (!columns.find(c => c.name === 'originalFailureOutput')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN originalFailureOutput TEXT');
        }
    } catch (e) {
        // Columns already exist or table doesn't exist yet — both fine.
    }

    // Migrate story_sync_log from single-column PK to composite (storyKey, localProjectId)
    try {
        const tableInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='story_sync_log'").get();
        const isOldSchema = tableInfo && !tableInfo.sql.includes('localProjectId');
        if (isOldSchema) {
            db.exec(`
                DROP TABLE story_sync_log;
                CREATE TABLE story_sync_log (
                    storyKey TEXT NOT NULL,
                    localProjectId TEXT NOT NULL,
                    projectKey TEXT,
                    epicKey TEXT,
                    summary TEXT,
                    description TEXT,
                    acceptanceCriteria TEXT,
                    contentHash TEXT,
                    lastSyncedAt TEXT,
                    PRIMARY KEY (storyKey, localProjectId)
                );
            `);
            console.log('[DB] Migrated story_sync_log to composite primary key (storyKey, localProjectId). Previous sync history cleared — run Sync Jira to repopulate.');
        }
    } catch (e) {
        console.warn('[DB Migration] story_sync_log migration failed:', e.message);
    }

    // Indexes for common query patterns — prevents full table scans at scale.
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_rtm_projectKey ON rtm_scenarios(projectKey);
        CREATE INDEX IF NOT EXISTS idx_tc_scenarioId  ON test_cases(scenarioId);
        CREATE INDEX IF NOT EXISTS idx_tc_projectKey  ON test_cases(projectKey);
        CREATE INDEX IF NOT EXISTS idx_runs_repo      ON run_history(repoFullName);
        CREATE INDEX IF NOT EXISTS idx_runs_project   ON run_history(localProjectId);
    `);

    migrateDbV2();
}

/** User-facing schema batch id (increment when adding migrations below). */
const DB_MIGRATION_VERSION = 2;

function migrateDbV2() {
    try {
        const v = Number(db.pragma('user_version', { simple: true }));
        if (v >= DB_MIGRATION_VERSION) return;

        db.exec(`
            CREATE TABLE IF NOT EXISTS llm_trace_rows (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                runId TEXT NOT NULL,
                traceLabel TEXT,
                phase TEXT,
                requestPayload TEXT,
                responsePayload TEXT,
                tokenUsage TEXT,
                createdAt TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_llm_trace_run_created ON llm_trace_rows(runId, createdAt);

            CREATE TABLE IF NOT EXISTS webhook_deliveries (
                deliveryId TEXT PRIMARY KEY,
                source TEXT NOT NULL,
                receivedAt TEXT NOT NULL,
                payloadHash TEXT
            );

            CREATE TABLE IF NOT EXISTS heal_patterns (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scenarioId TEXT NOT NULL,
                failureSignature TEXT NOT NULL,
                workingFixSummary TEXT,
                createdAt TEXT NOT NULL,
                expiresAt TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_heal_patterns_scenario ON heal_patterns(scenarioId, expiresAt);

            CREATE TABLE IF NOT EXISTS reference_examples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                framework TEXT NOT NULL,
                scriptBody TEXT NOT NULL,
                scenarioType TEXT,
                useCount INTEGER DEFAULT 1,
                lastUsedAt TEXT,
                qualityScore REAL DEFAULT 1.0,
                UNIQUE(framework, scenarioType)
            );
        `);

        try {
            db.exec(`
                CREATE UNIQUE INDEX IF NOT EXISTS idx_run_history_active_pr
                ON run_history(prUrl) WHERE status = 'running' AND prUrl IS NOT NULL AND length(trim(prUrl)) > 0;
            `);
        } catch (e) {
            console.warn('[DB] idx_run_history_active_pr skipped or failed:', e.message);
        }

        const addRunCol = (name, sqlType) => {
            const cols = db.pragma('table_info(run_history)');
            if (!cols.find(c => c.name === name)) {
                db.exec(`ALTER TABLE run_history ADD COLUMN ${name} ${sqlType}`);
            }
        };
        addRunCol('input_tokens_total', 'INTEGER DEFAULT 0');
        addRunCol('output_tokens_total', 'INTEGER DEFAULT 0');
        addRunCol('cached_tokens_total', 'INTEGER DEFAULT 0');
        addRunCol('overall_success', 'INTEGER');

        const tcCols = db.pragma('table_info(test_cases)');
        if (!tcCols.find(c => c.name === 'heal_exhausted')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN heal_exhausted INTEGER DEFAULT 0');
        }
        if (!tcCols.find(c => c.name === 'schema_version')) {
            db.exec('ALTER TABLE test_cases ADD COLUMN schema_version INTEGER DEFAULT 1');
        }
        if (!tcCols.find(c => c.name === 'source')) {
            db.exec("ALTER TABLE test_cases ADD COLUMN source TEXT DEFAULT 'scenario'");
        }

        const rtmCols = db.pragma('table_info(rtm_scenarios)');
        if (!rtmCols.find(c => c.name === 'schema_version')) {
            db.exec('ALTER TABLE rtm_scenarios ADD COLUMN schema_version INTEGER DEFAULT 1');
        }
        if (!rtmCols.find(c => c.name === 'map_attempts')) {
            db.exec('ALTER TABLE rtm_scenarios ADD COLUMN map_attempts INTEGER DEFAULT 0');
        }
        if (!rtmCols.find(c => c.name === 'map_hits')) {
            db.exec('ALTER TABLE rtm_scenarios ADD COLUMN map_hits INTEGER DEFAULT 0');
        }
        if (!rtmCols.find(c => c.name === 'test_pass_count')) {
            db.exec('ALTER TABLE rtm_scenarios ADD COLUMN test_pass_count INTEGER DEFAULT 0');
        }
        if (!rtmCols.find(c => c.name === 'test_fail_count')) {
            db.exec('ALTER TABLE rtm_scenarios ADD COLUMN test_fail_count INTEGER DEFAULT 0');
        }

        db.pragma(`user_version = ${DB_MIGRATION_VERSION}`);
    } catch (e) {
        console.error('[DB] migrateDbV2 failed:', e.message);
        throw e;
    }
}

function insertWebhookDelivery(deliveryId, source, payloadHash = null) {
    if (!deliveryId) return { inserted: true };
    try {
        db.prepare(`
            INSERT INTO webhook_deliveries (deliveryId, source, receivedAt, payloadHash)
            VALUES (@deliveryId, @source, @receivedAt, @payloadHash)
        `).run({
            deliveryId,
            source,
            receivedAt: new Date().toISOString(),
            payloadHash
        });
        return { inserted: true };
    } catch (e) {
        if (String(e.message).includes('UNIQUE')) return { inserted: false };
        throw e;
    }
}

function pruneOldWebhookDeliveries(retentionDays) {
    const d = Number(retentionDays);
    if (!Number.isFinite(d) || d <= 0) return 0;
    const cutoff = new Date(Date.now() - d * 864e5).toISOString();
    const r = db.prepare('DELETE FROM webhook_deliveries WHERE receivedAt < ?').run(cutoff);
    return r.changes;
}

function getActiveRunByPrUrl(prUrl) {
    if (!prUrl) return null;
    const row = db.prepare(
        `SELECT runId FROM run_history WHERE prUrl = ? AND status = 'running' ORDER BY createdAt DESC LIMIT 1`
    ).get(prUrl);
    return row || null;
}

function insertLlmTraceRow(row) {
    db.prepare(`
        INSERT INTO llm_trace_rows (runId, traceLabel, phase, requestPayload, responsePayload, tokenUsage, createdAt)
        VALUES (@runId, @traceLabel, @phase, @requestPayload, @responsePayload, @tokenUsage, @createdAt)
    `).run({
        runId: row.runId || '__none__',
        traceLabel: row.traceLabel || null,
        phase: row.phase || null,
        requestPayload: row.requestPayload != null ? String(row.requestPayload) : null,
        responsePayload: row.responsePayload != null ? String(row.responsePayload) : null,
        tokenUsage: row.tokenUsage != null ? (typeof row.tokenUsage === 'string' ? row.tokenUsage : JSON.stringify(row.tokenUsage)) : null,
        createdAt: row.createdAt || new Date().toISOString()
    });
}

function listLlmTracesByRun(runId, { limit = 500, offset = 0 } = {}) {
    return db.prepare(
        `SELECT * FROM llm_trace_rows WHERE runId = ? ORDER BY id ASC LIMIT ? OFFSET ?`
    ).all(runId, Math.min(limit, 2000), offset);
}

function addRunTokenUsage(runId, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = {}) {
    if (!runId || runId === '__jira_sync__') return;
    db.prepare(`
        UPDATE run_history SET
            input_tokens_total = COALESCE(input_tokens_total, 0) + @inTok,
            output_tokens_total = COALESCE(output_tokens_total, 0) + @outTok,
            cached_tokens_total = COALESCE(cached_tokens_total, 0) + @cachedTok
        WHERE runId = @runId
    `).run({
        runId,
        inTok: Number(inputTokens) || 0,
        outTok: Number(outputTokens) || 0,
        cachedTok: Number(cachedTokens) || 0
    });
}

function listDlqEvents({ status, source, limit = 50, offset = 0 } = {}) {
    let sql = 'SELECT * FROM dead_letter_queue WHERE 1=1';
    const args = [];
    if (status) {
        sql += ' AND status = ?';
        args.push(status);
    }
    if (source) {
        sql += ' AND source = ?';
        args.push(source);
    }
    sql += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?';
    args.push(Math.min(limit, 200), offset);
    return db.prepare(sql).all(...args).map(res => ({
        ...res,
        payload: safeJsonParse(res.payload, {})
    }));
}

function getDlqEvent(id) {
    const row = db.prepare('SELECT * FROM dead_letter_queue WHERE id = ?').get(id);
    if (!row) return null;
    return { ...row, payload: safeJsonParse(row.payload, {}) };
}

function updateDlqStatus(id, status, error = null) {
    db.prepare('UPDATE dead_letter_queue SET status = ?, error = COALESCE(?, error), retryCount = retryCount + 1 WHERE id = ?').run(status, error, id);
}

function upsertHealPattern({ scenarioId, failureSignature, workingFixSummary, expiresAt }) {
    db.prepare(`
        INSERT INTO heal_patterns (scenarioId, failureSignature, workingFixSummary, createdAt, expiresAt)
        VALUES (@scenarioId, @failureSignature, @workingFixSummary, @createdAt, @expiresAt)
    `).run({
        scenarioId,
        failureSignature,
        workingFixSummary: workingFixSummary || '',
        createdAt: new Date().toISOString(),
        expiresAt: expiresAt || null
    });
}

function findHealPatternsForScenario(scenarioId) {
    const now = new Date().toISOString();
    return db.prepare(
        `SELECT * FROM heal_patterns WHERE scenarioId = ? AND (expiresAt IS NULL OR expiresAt > ?) ORDER BY id DESC LIMIT 5`
    ).all(scenarioId, now);
}

function pruneExpiredHealPatterns() {
    const now = new Date().toISOString();
    return db.prepare('DELETE FROM heal_patterns WHERE expiresAt IS NOT NULL AND expiresAt <= ?').run(now).changes;
}

function getTopReferenceExamples(framework, limit = 3) {
    const rows = db.prepare(
        `SELECT * FROM reference_examples WHERE framework = ? ORDER BY useCount DESC, lastUsedAt DESC LIMIT ?`
    ).all(String(framework || 'jest'), Math.min(limit, 10));
    return rows;
}

function bumpReferenceExample(framework, scenarioType, scriptBody) {
    const fw = String(framework || 'jest');
    const st = scenarioType != null ? String(scenarioType) : '';
    const body = String(scriptBody || '').slice(0, 12000);
    const now = new Date().toISOString();
    db.prepare(`
        INSERT INTO reference_examples (framework, scriptBody, scenarioType, useCount, lastUsedAt, qualityScore)
        VALUES (@fw, @body, @st, 1, @now, 1.0)
        ON CONFLICT(framework, scenarioType) DO UPDATE SET
            useCount = useCount + 1,
            lastUsedAt = @now,
            scriptBody = excluded.scriptBody
    `).run({ fw, body, st, now });
}

function incrementScenarioMappingStats(projectKey, scenarioIds, mappedIds) {
    const hit = new Set((mappedIds || []).map(String));
    for (const sid of scenarioIds || []) {
        const isHit = hit.has(String(sid));
        db.prepare(`
            UPDATE rtm_scenarios SET
                map_attempts = COALESCE(map_attempts, 0) + 1,
                map_hits = COALESCE(map_hits, 0) + ?
            WHERE scenarioId = ? AND (projectKey = ? OR (projectKey IS NULL AND ? IS NULL))
        `).run(isHit ? 1 : 0, sid, projectKey ?? null, projectKey ?? null);
    }
}

function incrementScenarioTestOutcome(scenarioId, passed) {
    if (!scenarioId) return;
    const col = passed ? 'test_pass_count' : 'test_fail_count';
    db.prepare(`UPDATE rtm_scenarios SET ${col} = COALESCE(${col}, 0) + 1 WHERE scenarioId = ?`).run(scenarioId);
}

function getHealExhaustedByProject(projectKey) {
    if (!projectKey) return [];
    return db.prepare(`
        SELECT tc.* FROM test_cases tc
        WHERE tc.projectKey = ? AND COALESCE(tc.heal_exhausted, 0) = 1 AND tc.status = 'fail'
        ORDER BY tc.lastRunAt DESC
        LIMIT 200
    `).all(projectKey).map(r => ({
        ...r,
        steps: safeJsonParse(r.steps, []),
        testData: safeJsonParse(r.testData, {}),
        codeFiles: safeJsonParse(r.codeFiles, [])
    }));
}

function finalizeRunSuccess(runId, overallSuccessBool) {
    db.prepare(`
        UPDATE run_history SET overall_success = ?, status = ?, completedAt = ?
        WHERE runId = ?
    `).run(
        overallSuccessBool ? 1 : 0,
        overallSuccessBool ? 'completed' : 'failed',
        new Date().toISOString(),
        runId
    );
}

function publishToDLQ(source, payload, errorMsg) {
    const stmt = db.prepare(`
        INSERT INTO dead_letter_queue (source, payload, error, createdAt)
        VALUES (@source, @payload, @error, @createdAt)
    `);
    stmt.run({
        source,
        payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
        error: errorMsg,
        createdAt: new Date().toISOString()
    });
}

function getDLQEvents(status = 'pending') {
    const stmt = db.prepare('SELECT * FROM dead_letter_queue WHERE status = ? ORDER BY createdAt DESC');
    return stmt.all(status).map(res => ({
        ...res,
        payload: safeJsonParse(res.payload, {})
    }));
}

// -- SCENARIO HELPERS --

function upsertScenario(scenario) {
    const stmt = db.prepare(`
        INSERT INTO rtm_scenarios (
            scenarioId, projectKey, epicId, storyId, title, description, 
            acceptanceCriteriaRef, type, priority, status, lastPRTested, 
            testScriptRef, healAttempts, lastRunDate, createdAt
        ) VALUES (
            @scenarioId, @projectKey, @epicId, @storyId, @title, @description,
            @acceptanceCriteriaRef, @type, @priority, @status, @lastPRTested,
            @testScriptRef, @healAttempts, @lastRunDate, @createdAt
        )
        ON CONFLICT(scenarioId) DO UPDATE SET
            title = excluded.title,
            description = excluded.description,
            type = excluded.type,
            priority = excluded.priority,
            epicId = excluded.epicId,
            storyId = excluded.storyId,
            acceptanceCriteriaRef = excluded.acceptanceCriteriaRef
    `);
    
    stmt.run({
        ...scenario,
        acceptanceCriteriaRef: JSON.stringify(scenario.acceptanceCriteriaRef || [])
    });
}

function getScenariosByProject(projectKey) {
    const stmt = db.prepare('SELECT * FROM rtm_scenarios WHERE projectKey = ?');
    const rows = stmt.all(projectKey);
    return rows.map(r => ({
        ...r,
        acceptanceCriteriaRef: safeJsonParse(r.acceptanceCriteriaRef, [])
    }));
}

function markScenariosObsolete(projectKey, epicId, activeIds = []) {
    if (activeIds.length === 0) {
        const stmt = db.prepare('UPDATE rtm_scenarios SET status = "obsolete" WHERE projectKey = ? AND epicId = ?');
        stmt.run(projectKey, epicId);
        return;
    }
    
    const placeholders = activeIds.map(() => '?').join(',');
    const stmt = db.prepare(`UPDATE rtm_scenarios SET status = "obsolete" WHERE projectKey = ? AND epicId = ? AND scenarioId NOT IN (${placeholders})`);
    stmt.run(projectKey, epicId, ...activeIds);
}

// -- RUN HISTORY HELPERS --

function createRun(runId, data) {
    const stmt = db.prepare(`
        INSERT INTO run_history (
            runId, repoFullName, prUrl, status, createdAt, completedAt, 
            events, logs, llm_traces, scenario_statuses, localProjectId
        ) VALUES (
            @runId, @repoFullName, @prUrl, @status, @createdAt, @completedAt,
            @events, @logs, @llm_traces, @scenario_statuses, @localProjectId
        )
    `);
    stmt.run({
        runId,
        repoFullName: data.repoFullName || null,
        prUrl: data.prUrl || null,
        status: data.status || 'running',
        createdAt: data.createdAt || new Date().toISOString(),
        completedAt: data.completedAt || null,
        events: JSON.stringify(data.events || []),
        logs: JSON.stringify(data.logs || []),
        llm_traces: JSON.stringify(data.llm_traces || []),
        scenario_statuses: JSON.stringify(data.scenario_statuses || {}),
        localProjectId: data.localProjectId || null
    });
}

function updateRun(runId, patch) {
    const current = getRun(runId);
    if (!current) return;
    
    const merged = { ...current, ...patch };
    
    const stmt = db.prepare(`
        UPDATE run_history SET
            repoFullName = @repoFullName,
            prUrl = @prUrl,
            status = @status,
            completedAt = @completedAt,
            events = @events,
            logs = @logs,
            llm_traces = @llm_traces,
            scenario_statuses = @scenario_statuses,
            input_tokens_total = @input_tokens_total,
            output_tokens_total = @output_tokens_total,
            cached_tokens_total = @cached_tokens_total,
            overall_success = @overall_success
        WHERE runId = @runId
    `);
    
    stmt.run({
        runId,
        repoFullName: merged.repoFullName || null,
        prUrl: merged.prUrl || null,
        status: merged.status || 'running',
        completedAt: merged.completedAt || null,
        events: JSON.stringify(merged.events || []),
        logs: JSON.stringify(merged.logs || []),
        llm_traces: JSON.stringify(merged.llm_traces || []),
        scenario_statuses: JSON.stringify(merged.scenario_statuses || {}),
        input_tokens_total: merged.input_tokens_total ?? 0,
        output_tokens_total: merged.output_tokens_total ?? 0,
        cached_tokens_total: merged.cached_tokens_total ?? 0,
        overall_success: merged.overall_success !== undefined && merged.overall_success !== null
            ? merged.overall_success
            : null
    });
}

function getRun(runId) {
    const stmt = db.prepare('SELECT * FROM run_history WHERE runId = ?');
    const row = stmt.get(runId);
    if (!row) return null;
    
    return {
        ...row,
        events: safeJsonParse(row.events, []),
        logs: safeJsonParse(row.logs, []),
        llm_traces: safeJsonParse(row.llm_traces, []),
        scenario_statuses: safeJsonParse(row.scenario_statuses, {})
    };
}

function listRuns(repoFullName) {
    let stmt;
    let rows;
    if (repoFullName) {
        stmt = db.prepare('SELECT * FROM run_history WHERE repoFullName = ? ORDER BY createdAt DESC');
        rows = stmt.all(repoFullName);
    } else {
        stmt = db.prepare('SELECT * FROM run_history ORDER BY createdAt DESC');
        rows = stmt.all();
    }
    
    return rows.map(row => ({
        ...row,
        events: safeJsonParse(row.events, []),
        logs: safeJsonParse(row.logs, []),
        llm_traces: safeJsonParse(row.llm_traces, []),
        scenario_statuses: safeJsonParse(row.scenario_statuses, {})
    }));
}

function deleteProjectData(projectKey, repoFullName, localProjectId) {
    // Run the entire cascade inside a single transaction so it is atomic.
    db.transaction(() => {
        // 1. Delete test cases — by projectKey first, then catch any orphans that
        //    are linked only via a scenarioId belonging to this project's scenarios.
        if (projectKey) {
            db.prepare('DELETE FROM test_cases WHERE projectKey = ?').run(projectKey);
        }

        // 2. Delete test cases tied to runs for this project (covers empty-projectKey rows).
        if (localProjectId) {
            db.prepare(`
                DELETE FROM test_cases WHERE runId IN (
                    SELECT runId FROM run_history WHERE localProjectId = ?
                )
            `).run(localProjectId);
        }
        if (repoFullName) {
            db.prepare(`
                DELETE FROM test_cases WHERE runId IN (
                    SELECT runId FROM run_history WHERE repoFullName = ?
                )
            `).run(repoFullName);
        }

        // 3. Delete scenarios.
        if (projectKey) {
            db.prepare('DELETE FROM rtm_scenarios WHERE projectKey = ?').run(projectKey);
        }

        // 4. Delete story sync log.
        if (localProjectId) {
            db.prepare('DELETE FROM story_sync_log WHERE localProjectId = ?').run(localProjectId);
        }
        if (projectKey) {
            db.prepare('DELETE FROM story_sync_log WHERE projectKey = ?').run(projectKey);
        }

        // 5. Delete runs.
        if (localProjectId) {
            db.prepare('DELETE FROM run_history WHERE localProjectId = ?').run(localProjectId);
        }
        if (repoFullName) {
            db.prepare('DELETE FROM run_history WHERE repoFullName = ?').run(repoFullName);
        }
    })();
}

// -- TEST CASE HELPERS --

function upsertTestCase(tc) {
    const stmt = db.prepare(`
        INSERT INTO test_cases (
            testCaseId, scenarioId, projectKey, runId, prUrl,
            title, steps, testData, testScript, language,
            status, version, previousVersionId, codeFiles, healAttempts,
            conversationId, latestResponseId,
            regression, originalScript, originalFailureOutput,
            heal_exhausted, schema_version, source,
            createdAt, lastRunAt
        ) VALUES (
            @testCaseId, @scenarioId, @projectKey, @runId, @prUrl,
            @title, @steps, @testData, @testScript, @language,
            @status, @version, @previousVersionId, @codeFiles, @healAttempts,
            @conversationId, @latestResponseId,
            @regression, @originalScript, @originalFailureOutput,
            @heal_exhausted, @schema_version, @source,
            @createdAt, @lastRunAt
        )
        ON CONFLICT(testCaseId) DO UPDATE SET
            status                = excluded.status,
            testScript            = excluded.testScript,
            testData              = excluded.testData,
            steps                 = excluded.steps,
            healAttempts          = excluded.healAttempts,
            heal_exhausted        = COALESCE(excluded.heal_exhausted, test_cases.heal_exhausted),
            schema_version        = COALESCE(excluded.schema_version, test_cases.schema_version),
            source                  = COALESCE(excluded.source, test_cases.source),
            conversationId        = COALESCE(excluded.conversationId, test_cases.conversationId),
            latestResponseId      = COALESCE(excluded.latestResponseId, test_cases.latestResponseId),
            regression            = COALESCE(excluded.regression, test_cases.regression),
            originalScript        = COALESCE(excluded.originalScript, test_cases.originalScript),
            originalFailureOutput = COALESCE(excluded.originalFailureOutput, test_cases.originalFailureOutput),
            lastRunAt             = excluded.lastRunAt
    `);
    stmt.run({
        testCaseId:            tc.testCaseId,
        scenarioId:            tc.scenarioId,
        projectKey:            tc.projectKey || null,
        runId:                 tc.runId || null,
        prUrl:                 tc.prUrl || null,
        title:                 tc.title || '',
        steps:                 JSON.stringify(tc.steps || []),
        testData:              JSON.stringify(tc.testData || {}),
        testScript:            tc.testScript || '',
        language:              tc.language || 'javascript',
        status:                tc.status || 'pending',
        version:               tc.version || 1,
        previousVersionId:     tc.previousVersionId || null,
        codeFiles:             JSON.stringify(tc.codeFiles || []),
        healAttempts:          tc.healAttempts || 0,
        conversationId:        tc.conversationId || null,
        latestResponseId:      tc.latestResponseId || null,
        regression:            tc.regression || null,
        originalScript:        tc.originalScript || null,
        originalFailureOutput: tc.originalFailureOutput || null,
        heal_exhausted:        tc.heal_exhausted != null ? tc.heal_exhausted : 0,
        schema_version:        tc.schema_version ?? 1,
        source:                  tc.source || 'scenario',
        createdAt:             tc.createdAt || new Date().toISOString(),
        lastRunAt:             tc.lastRunAt || null
    });
}

function updateTestCaseStatus(testCaseId, status, lastRunAt) {
    const stmt = db.prepare('UPDATE test_cases SET status = ?, lastRunAt = ? WHERE testCaseId = ?');
    stmt.run(status, lastRunAt || new Date().toISOString(), testCaseId);
}

function markTestCaseSuperseded(testCaseId) {
    db.prepare("UPDATE test_cases SET status = 'superseded' WHERE testCaseId = ?").run(testCaseId);
}

function getTestCasesByScenario(scenarioId) {
    const rows = db.prepare("SELECT * FROM test_cases WHERE scenarioId = ? AND status != 'superseded' ORDER BY version DESC, createdAt DESC").all(scenarioId);
    return rows.map(r => ({
        ...r,
        steps:     safeJsonParse(r.steps, []),
        testData:  safeJsonParse(r.testData, {}),
        codeFiles: safeJsonParse(r.codeFiles, [])
    }));
}

function getTestCasesByProject(projectKey) {
    const rows = db.prepare("SELECT * FROM test_cases WHERE projectKey = ? AND status != 'superseded' ORDER BY createdAt DESC").all(projectKey);
    return rows.map(r => ({
        ...r,
        steps:     safeJsonParse(r.steps, []),
        testData:  safeJsonParse(r.testData, {}),
        codeFiles: safeJsonParse(r.codeFiles, [])
    }));
}

function getTestCasesByRun(runId) {
    const rows = db.prepare('SELECT * FROM test_cases WHERE runId = ? ORDER BY createdAt ASC').all(runId);
    return rows.map(r => ({
        ...r,
        steps:     safeJsonParse(r.steps, []),
        testData:  safeJsonParse(r.testData, {}),
        codeFiles: safeJsonParse(r.codeFiles, [])
    }));
}

// -- STORY SYNC LOG HELPERS --

function computeStoryHash(story) {
    const payload = [story.summary || '', story.description || '', story.acceptanceCriteria || ''].join('||');
    return crypto.createHash('sha256').update(payload).digest('hex');
}

function getStorySyncRecord(storyKey, localProjectId) {
    const stmt = db.prepare('SELECT * FROM story_sync_log WHERE storyKey = ? AND localProjectId = ?');
    return stmt.get(storyKey, localProjectId) || null;
}

function upsertStorySyncRecord(record) {
    const stmt = db.prepare(`
        INSERT INTO story_sync_log (storyKey, localProjectId, projectKey, epicKey, summary, description, acceptanceCriteria, contentHash, lastSyncedAt)
        VALUES (@storyKey, @localProjectId, @projectKey, @epicKey, @summary, @description, @acceptanceCriteria, @contentHash, @lastSyncedAt)
        ON CONFLICT(storyKey, localProjectId) DO UPDATE SET
            projectKey = excluded.projectKey,
            epicKey = excluded.epicKey,
            summary = excluded.summary,
            description = excluded.description,
            acceptanceCriteria = excluded.acceptanceCriteria,
            contentHash = excluded.contentHash,
            lastSyncedAt = excluded.lastSyncedAt
    `);
    stmt.run({
        storyKey: record.storyKey,
        localProjectId: record.localProjectId || '',
        projectKey: record.projectKey || null,
        epicKey: record.epicKey || null,
        summary: record.summary || '',
        description: record.description || '',
        acceptanceCriteria: record.acceptanceCriteria || '',
        contentHash: record.contentHash || '',
        lastSyncedAt: record.lastSyncedAt || new Date().toISOString()
    });
}

function getStorySyncRecordsByProject(localProjectId) {
    const stmt = db.prepare('SELECT * FROM story_sync_log WHERE localProjectId = ? ORDER BY storyKey ASC');
    return stmt.all(localProjectId);
}

/**
 * Permanently delete a single run and every test case generated by that run.
 * Scenarios are NOT deleted — only the execution artefacts for this run.
 */
function deleteRunData(runId) {
    db.transaction(() => {
        db.prepare('DELETE FROM llm_trace_rows WHERE runId = ?').run(runId);
        db.prepare('DELETE FROM test_cases WHERE runId = ?').run(runId);
        db.prepare('DELETE FROM run_history WHERE runId = ?').run(runId);
    })();
    try {
        const artDir = path.join(__dirname, 'data', 'artifacts', runId);
        fs.rmSync(artDir, { recursive: true, force: true });
    } catch (e) {
        console.warn(`[DB] Artifact cleanup warning for ${runId}: ${e.message}`);
    }
}

/**
 * Remove all generated test cases and pipeline runs so you can simulate a fresh PR.
 * Keeps rtm_scenarios (definitions) and story_sync_log. Resets per-scenario run fields.
 */
function clearAllPipelineExecutionData() {
    db.transaction(() => {
        db.prepare('DELETE FROM test_cases').run();
        db.prepare('DELETE FROM run_history').run();
        db.prepare('DELETE FROM llm_trace_rows').run();
        db.prepare('DELETE FROM webhook_deliveries').run();
        db.prepare('DELETE FROM dead_letter_queue').run();
        db.prepare(`
            UPDATE rtm_scenarios SET
                lastPRTested = NULL,
                testScriptRef = NULL,
                healAttempts = 0,
                lastRunDate = NULL
        `).run();
    })();
    try {
        const artifactsRoot = path.join(__dirname, 'data', 'artifacts');
        fs.rmSync(artifactsRoot, { recursive: true, force: true });
        fs.mkdirSync(artifactsRoot, { recursive: true });
    } catch (e) {
        console.warn(`[DB] Artifact dir clear warning: ${e.message}`);
    }
}

module.exports = {
    deleteProjectData,
    initDb,
    publishToDLQ,
    getDLQEvents,
    listDlqEvents,
    getDlqEvent,
    updateDlqStatus,
    insertWebhookDelivery,
    pruneOldWebhookDeliveries,
    getActiveRunByPrUrl,
    insertLlmTraceRow,
    listLlmTracesByRun,
    addRunTokenUsage,
    upsertHealPattern,
    findHealPatternsForScenario,
    pruneExpiredHealPatterns,
    getTopReferenceExamples,
    bumpReferenceExample,
    incrementScenarioMappingStats,
    incrementScenarioTestOutcome,
    getHealExhaustedByProject,
    finalizeRunSuccess,
    upsertScenario,
    getScenariosByProject,
    markScenariosObsolete,
    createRun,
    updateRun,
    getRun,
    listRuns,
    computeStoryHash,
    getStorySyncRecord,
    upsertStorySyncRecord,
    getStorySyncRecordsByProject,
    upsertTestCase,
    updateTestCaseStatus,
    markTestCaseSuperseded,
    getTestCasesByScenario,
    getTestCasesByProject,
    getTestCasesByRun,
    deleteRunData,
    clearAllPipelineExecutionData,
    DB_MIGRATION_VERSION
};
