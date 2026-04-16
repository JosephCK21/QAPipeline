const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'data', 'autoqa.db');

let db;

function initDb() {
    // Ensure data directory exists
    if (!fs.existsSync(path.join(__dirname, 'data'))) {
        fs.mkdirSync(path.join(__dirname, 'data'));
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
        payload: res.payload ? JSON.parse(res.payload) : {}
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
        acceptanceCriteriaRef: JSON.parse(r.acceptanceCriteriaRef || '[]')
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
            scenario_statuses = @scenario_statuses
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
        scenario_statuses: JSON.stringify(merged.scenario_statuses || {})
    });
}

function getRun(runId) {
    const stmt = db.prepare('SELECT * FROM run_history WHERE runId = ?');
    const row = stmt.get(runId);
    if (!row) return null;
    
    return {
        ...row,
        events: JSON.parse(row.events || '[]'),
        logs: JSON.parse(row.logs || '[]'),
        llm_traces: JSON.parse(row.llm_traces || '[]'),
        scenario_statuses: JSON.parse(row.scenario_statuses || '{}')
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
        events: JSON.parse(row.events || '[]'),
        logs: JSON.parse(row.logs || '[]'),
        llm_traces: JSON.parse(row.llm_traces || '[]'),
        scenario_statuses: JSON.parse(row.scenario_statuses || '{}')
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
            status, version, previousVersionId, codeFiles, healAttempts, createdAt, lastRunAt
        ) VALUES (
            @testCaseId, @scenarioId, @projectKey, @runId, @prUrl,
            @title, @steps, @testData, @testScript, @language,
            @status, @version, @previousVersionId, @codeFiles, @healAttempts, @createdAt, @lastRunAt
        )
        ON CONFLICT(testCaseId) DO UPDATE SET
            status        = excluded.status,
            testScript    = excluded.testScript,
            testData      = excluded.testData,
            steps         = excluded.steps,
            healAttempts  = excluded.healAttempts,
            lastRunAt     = excluded.lastRunAt
    `);
    stmt.run({
        testCaseId:        tc.testCaseId,
        scenarioId:        tc.scenarioId,
        projectKey:        tc.projectKey || null,
        runId:             tc.runId || null,
        prUrl:             tc.prUrl || null,
        title:             tc.title || '',
        steps:             JSON.stringify(tc.steps || []),
        testData:          JSON.stringify(tc.testData || {}),
        testScript:        tc.testScript || '',
        language:          tc.language || 'javascript',
        status:            tc.status || 'pending',
        version:           tc.version || 1,
        previousVersionId: tc.previousVersionId || null,
        codeFiles:         JSON.stringify(tc.codeFiles || []),
        healAttempts:      tc.healAttempts || 0,
        createdAt:         tc.createdAt || new Date().toISOString(),
        lastRunAt:         tc.lastRunAt || null
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
        steps:     JSON.parse(r.steps     || '[]'),
        testData:  JSON.parse(r.testData  || '{}'),
        codeFiles: JSON.parse(r.codeFiles || '[]')
    }));
}

function getTestCasesByProject(projectKey) {
    const rows = db.prepare("SELECT * FROM test_cases WHERE projectKey = ? AND status != 'superseded' ORDER BY createdAt DESC").all(projectKey);
    return rows.map(r => ({
        ...r,
        steps:     JSON.parse(r.steps     || '[]'),
        testData:  JSON.parse(r.testData  || '{}'),
        codeFiles: JSON.parse(r.codeFiles || '[]')
    }));
}

function getTestCasesByRun(runId) {
    const rows = db.prepare('SELECT * FROM test_cases WHERE runId = ? ORDER BY createdAt ASC').all(runId);
    return rows.map(r => ({
        ...r,
        steps:     JSON.parse(r.steps     || '[]'),
        testData:  JSON.parse(r.testData  || '{}'),
        codeFiles: JSON.parse(r.codeFiles || '[]')
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

module.exports = {
    deleteProjectData,
    initDb,
    publishToDLQ,
    getDLQEvents,
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
    getTestCasesByRun
};
