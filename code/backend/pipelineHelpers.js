const crypto = require('crypto');
const { executeTest, validateSyntaxLocal } = require('./services/sandboxService');
const { repairTestCaseScript } = require('./services/llmService');
const {
    updateRun, upsertTestCase, updateTestCaseStatus,
    incrementScenarioTestOutcome, upsertHealPattern, bumpReferenceExample
} = require('./db');

const MAX_HEAL_ATTEMPTS = 3;

/**
 * Run async work over items with at most `limit` in flight (pool / semaphore).
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} fn
 * @returns {Promise<R[]>}
 */
async function mapPool(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            results[i] = await fn(items[i], i);
        }
    };
    const n = Math.min(Math.max(1, limit), Math.max(1, items.length));
    await Promise.all(Array.from({ length: n }, worker));
    return results;
}

/**
 * Compact summary for [ALREADY COVERED IN THIS RUN] in test-case generation.
 * @param {string} scenarioId
 * @param {string} scenarioTitle
 * @param {string} scenarioType
 * @param {Array<{ title?: string, testData?: object }>} generatedTestCases
 */
function buildGenerationSummaryEntry(scenarioId, scenarioTitle, scenarioType, generatedTestCases) {
    const coveredInputs = [];
    for (const tc of generatedTestCases || []) {
        if (tc?.title) coveredInputs.push(String(tc.title).slice(0, 120));
        const td = tc?.testData;
        if (td && typeof td === 'object') {
            for (const [g, obj] of Object.entries(td)) {
                if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                    for (const k of Object.keys(obj)) coveredInputs.push(`${g}.${k}`);
                }
            }
        }
    }
    const uniq = [...new Set(coveredInputs)].slice(0, 24);
    return { scenarioId, title: scenarioTitle || scenarioId, type: scenarioType || '', coveredInputs: uniq };
}

// ---------------------------------------------------------------------------
// Event logger: writes to DB and broadcasts via Socket.IO
// ---------------------------------------------------------------------------
function createEventLogger(runId) {
    return (type, data) => {
        const updateParams = {};
        let logsMsg = null;

        if (type === 'phase_update') {
            logsMsg = `[Phase] ${data.phase}: ${data.status}`;
        } else if (type === 'log') {
            console.log(`[Pipeline] ${data.level}: ${data.message}`);
            logsMsg = data.message;
        } else if (type === 'pr_details') {
            updateParams.prDetails = data;
        } else if (type === 'init') {
            updateParams.repoFullName = data.repoFullName;
        } else if (type === 'complete') {
            updateParams.status = data.success ? 'completed' : 'failed';
            updateParams.completedAt = new Date().toISOString();
            updateParams.overall_success = data.success ? 1 : 0;
            if (typeof data.passedCount === 'number') {
                updateParams.finished_passed_count = data.passedCount;
            }
            if (typeof data.failedCount === 'number') {
                updateParams.finished_failed_count = data.failedCount;
            }
            if (typeof data.testCaseCount === 'number') {
                updateParams.finished_test_case_count = data.testCaseCount;
            }
        } else if (type === 'error') {
            updateParams.status = 'failed';
            logsMsg = `[ERROR] ${data.message}`;
        } else if (type === 'run_summary_updated') {
            updateParams.events = [{ type: 'run_summary_updated', data, timestamp: new Date().toISOString() }];
        } else if (type === 'test_case_attempt') {
            updateParams.events = [{ type: 'test_case_attempt', data, timestamp: new Date().toISOString() }];
        } else if (type === 'scenario_execution_updated') {
            updateParams.events = [{ type: 'scenario_execution_updated', data, timestamp: new Date().toISOString() }];
        } else if (type === 'test_execution_started' || type === 'test_execution_ended') {
            if (global.io) {
                global.io.emit(type, { runId, ...data });
            }
            return;
        }

        if (logsMsg) {
            updateParams.logs = [{ timestamp: new Date().toISOString(), level: data.level || 'INFO', message: logsMsg }];
        }

        updateRun(runId, updateParams);

        if (global.io) {
            global.io.emit('run_updated', { runId, type, data });
            global.io.emit('refresh_data');
        }
    };
}

// ---------------------------------------------------------------------------
// Concurrent Sandbox Pool Execution Queue
// ---------------------------------------------------------------------------
async function executeWithPool(tasks, pool, executeFn) {
    if (!pool || pool.length === 0) throw new Error('No containers in pool');
    const availableContainers = [...pool];
    const executing = [];

    for (const task of tasks) {
        const processTask = async (taskItem) => {
            while (availableContainers.length === 0) {
                await new Promise(r => setTimeout(r, 50));
            }
            const container = availableContainers.pop();
            try {
                await executeFn(taskItem, container);
            } finally {
                availableContainers.push(container);
            }
        };

        const p = processTask(task).then(() => {
            const idx = executing.indexOf(p);
            if (idx !== -1) executing.splice(idx, 1);
        });
        executing.push(p);

        if (executing.length >= pool.length) {
            await Promise.race(executing);
        }
    }

    await Promise.all(executing);
}

// ---------------------------------------------------------------------------
// Hard-limit retry controller — the core of the stateful approach
// ---------------------------------------------------------------------------
async function executeTestCaseWithRetries({
    testCase, containerName, sandboxDir, runId, prUrl, codeContextSection,
    linkedProject, refinementCandidates, sendEvent,
    runSummary,
    regressionMode = false,
    scenarioDescription = '',
    configuredTestAccounts = null
}) {
    let currentScript = testCase.testScript;
    let finalStatus = 'fail';
    let healAttempts = 0;

    const originalScriptSnapshot = regressionMode ? (testCase.testScript || '') : null;
    let firstFailureOutput = null;

    let conversationId = testCase.conversationId || null;
    let currentInteractionId = testCase.latestResponseId || testCase.generationInteractionId || null;

    const attemptHistory = [];

    let currentReasoningItems = null;

    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
        const attemptStartedAt = new Date().toISOString();

        updateTestCaseStatus(testCase.testCaseId, 'running', attemptStartedAt);
        testCase.status = 'running';

        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt,
            status: 'running',
            startedAt: attemptStartedAt
        });
        sendEvent('log', { level: 'INFO', message: `[Sandbox] ${testCase.testCaseId} attempt ${attempt}/${MAX_HEAL_ATTEMPTS}` });

        const syntaxCheck = validateSyntaxLocal(currentScript, testCase.language || 'javascript');

        let sandboxResult;
        if (!syntaxCheck.valid) {
            sendEvent('phase_update', { phase: 'Syntax Validation', status: 'failed' });
            sendEvent('log', {
                level: 'WARN',
                message: `[Syntax validation] ${testCase.testCaseId} attempt ${attempt}: ${syntaxCheck.error}`
            });
            sandboxResult = {
                success: false,
                output: `[Syntax validation] ${syntaxCheck.error}`,
                error: syntaxCheck.error,
                failureScreenshots: [],
                traces: [],
                videos: []
            };
        } else {
            sendEvent('test_execution_started', {
                testCaseId: testCase.testCaseId,
                scenarioId: testCase.scenarioId,
                title: testCase.title,
                attempt,
                containerName
            });

            try {
                sandboxResult = await executeTest(
                    containerName,
                    sandboxDir,
                    testCase.language || 'javascript',
                    currentScript,
                    `test_${testCase.testCaseId}_attempt${attempt}.spec.${testCase.language === 'python' ? 'py' : 'js'}`,
                    testCase.testData || {},
                    {
                        runId,
                        testCaseId: testCase.testCaseId,
                        attempt
                    }
                );
            } catch (execErr) {
                sandboxResult = {
                    success: false,
                    output: `[Sandbox executor error] ${execErr.message}`,
                    error: execErr.message,
                    failureScreenshots: [],
                    traces: [],
                    videos: []
                };
            } finally {
                sendEvent('test_execution_ended', {
                    testCaseId: testCase.testCaseId,
                    scenarioId: testCase.scenarioId,
                    status: sandboxResult?.success ? 'pass' : 'fail',
                    containerName
                });
            }
        }

        const attemptEndedAt = new Date().toISOString();

        if (sandboxResult.success) {
            runSummary.passedCount++;
            runSummary.runningCount = Math.max(0, runSummary.runningCount - 1);
        }
        const genLeft = runSummary.scenariosGeneratingLeft ?? 0;
        const progressLine = `[Sandbox][${testCase.runId || runId}] ${testCase.testCaseId} attempt ${attempt}/${MAX_HEAL_ATTEMPTS}: ${sandboxResult.success ? 'PASS' : 'FAIL'}. Tests still without final verdict: ${runSummary.runningCount}; scenario(s) still generating: ${genLeft}`;
        console.log(progressLine);
        sendEvent('log', { level: 'INFO', message: progressLine });

        if (sandboxResult.success) {
            finalStatus = 'pass';

            const regressionStamp = regressionMode
                ? (healAttempts === 0 ? 'clean_pass' : 'adapted')
                : null;

            upsertTestCase({
                ...testCase,
                testScript: currentScript,
                status: 'pass',
                healAttempts,
                heal_exhausted: 0,
                conversationId,
                latestResponseId: currentInteractionId,
                regression:            regressionStamp,
                originalScript:        regressionStamp === 'adapted' ? originalScriptSnapshot : null,
                originalFailureOutput: regressionStamp === 'adapted' ? firstFailureOutput : null,
                lastRunAt: attemptEndedAt
            });

            sendEvent('test_case_attempt', {
                testCaseId: testCase.testCaseId,
                scenarioId: testCase.scenarioId,
                attempt,
                status: 'pass',
                output: sandboxResult.output,
                failureScreenshots: sandboxResult.failureScreenshots || [],
                traces: sandboxResult.traces || [],
                videos: sandboxResult.videos || [],
                regression: regressionStamp,
                startedAt: attemptStartedAt,
                endedAt: attemptEndedAt
            });
            sendEvent('log', {
                level: 'INFO',
                message: regressionStamp === 'adapted'
                    ? `[Sandbox] ${testCase.testCaseId}: PASS on attempt ${attempt} (adapted — original failure retained as potential regression)`
                    : `[Sandbox] ${testCase.testCaseId}: PASS on attempt ${attempt}`
            });
            try {
                if (healAttempts > 0 && attemptHistory.length > 0) {
                    const lastFail = String(attemptHistory[attemptHistory.length - 1]?.failureOutput || '').slice(-2400);
                    const failureSignature = crypto.createHash('sha256').update(lastFail).digest('hex').slice(0, 48);
                    upsertHealPattern({
                        scenarioId: testCase.scenarioId,
                        failureSignature,
                        workingFixSummary: `Recovered after ${healAttempts} heal(s)`
                    });
                }
                const fw = testCase.language === 'python' ? 'pytest' : 'jest';
                bumpReferenceExample(fw, '', currentScript);
            } catch (persistErr) {
                sendEvent('log', { level: 'WARN', message: `[Pipeline] Pattern/reference promotion skipped: ${persistErr.message}` });
            }
            break;
        }

        const failureOutput = sandboxResult.output || sandboxResult.error || 'No output';
        attemptHistory.push({
            attemptNumber: attempt,
            scriptUsed: currentScript,
            failureOutput: failureOutput.slice(-3500)
        });

        if (regressionMode && firstFailureOutput === null) {
            firstFailureOutput = failureOutput;
        }

        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt,
            status: 'fail',
            failureOutput,
            scriptSnapshot: currentScript,
            failureScreenshots: sandboxResult.failureScreenshots || [],
            traces: sandboxResult.traces || [],
            videos: sandboxResult.videos || [],
            regression: regressionMode ? 'pending' : null,
            startedAt: attemptStartedAt,
            endedAt: attemptEndedAt
        });
        const failureSnippet = failureOutput.slice(0, 2000);
        sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId}: FAIL on attempt ${attempt}` });
        sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId} failure output: ${failureSnippet}` });

        const INFRA_FAILURE_PATTERNS = /ERR_CONNECTION_REFUSED|ECONNREFUSED|ERR_CONNECTION_RESET|net::ERR_ABORTED|Dev server not running/i;
        const isInfraFailure = INFRA_FAILURE_PATTERNS.test(failureOutput);
        if (isInfraFailure) {
            sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId}: Infrastructure failure detected (dev server unreachable) — skipping heal, marking as fail.` });
            break;
        }

        if (attempt < MAX_HEAL_ATTEMPTS) {
            healAttempts++;
            runSummary.retryCount++;
            const healMode = conversationId
                ? `stateful (conversation=${conversationId})`
                : (currentInteractionId ? `stateful (previous_response_id=${currentInteractionId})` : 'stateless (manual history)');
            sendEvent('log', { level: 'INFO', message: `[Healing] Requesting patch for ${testCase.testCaseId} (attempt ${attempt + 1}, ${healMode})...` });
            updateTestCaseStatus(testCase.testCaseId, 'healing');
            testCase.status = 'healing';
            try {
                const healResult = await repairTestCaseScript({
                    testCase: { ...testCase, testScript: currentScript },
                    failureOutput,
                    codeContextSection,
                    attemptNumber: attempt + 1,
                    conversationId,
                    previousInteractionId: currentInteractionId,
                    attemptHistory,
                    priorReasoningItems: currentReasoningItems,
                    scenarioDescription,
                    configuredTestAccounts
                });
                currentScript = healResult.repairedScript;
                currentInteractionId = healResult.interactionId || currentInteractionId;
                if (Array.isArray(healResult.reasoningItems) && healResult.reasoningItems.length > 0) {
                    currentReasoningItems = healResult.reasoningItems;
                }
                if (healResult.chainWasStale) {
                    sendEvent('log', { level: 'WARN', message: `[Healing] Stored conversation/response anchor was stale — continuing stateless.` });
                    conversationId = null;
                    currentInteractionId = healResult.interactionId || null;
                }

                upsertTestCase({
                    ...testCase,
                    testScript: currentScript,
                    healAttempts,
                    conversationId,
                    latestResponseId: currentInteractionId,
                    status: 'running'
                });
                testCase.status = 'running';
            } catch (healErr) {
                sendEvent('log', { level: 'ERROR', message: `[Healing] LLM repair failed: ${healErr.message}` });
                break;
            }
        }
    }

    if (finalStatus === 'fail') {
        runSummary.failedCount++;
        runSummary.runningCount = Math.max(0, runSummary.runningCount - 1);

        const regressionStamp = regressionMode ? 'regression_fail' : null;

        upsertTestCase({
            ...testCase,
            testScript: currentScript,
            status: 'fail',
            healAttempts,
            heal_exhausted: 1,
            conversationId,
            latestResponseId: currentInteractionId,
            regression:            regressionStamp,
            originalScript:        regressionMode ? originalScriptSnapshot : null,
            originalFailureOutput: regressionMode ? firstFailureOutput : null,
            lastRunAt: new Date().toISOString()
        });

        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt: MAX_HEAL_ATTEMPTS,
            status: 'final_fail',
            regression: regressionStamp,
            endedAt: new Date().toISOString()
        });
        sendEvent('log', {
            level: 'ERROR',
            message: regressionMode
                ? `[Regression] ${testCase.testCaseId}: REGRESSION FAIL — existing script could not be made green after ${MAX_HEAL_ATTEMPTS} attempts (${healAttempts} heal(s))`
                : `[Sandbox] ${testCase.testCaseId}: FINAL FAIL after ${MAX_HEAL_ATTEMPTS} attempts (${healAttempts} heal(s))`
        });
    }

    updateTestCaseStatus(testCase.testCaseId, finalStatus);
    try {
        incrementScenarioTestOutcome(testCase.scenarioId, finalStatus === 'pass');
    } catch (e) {
        console.warn('[Pipeline] incrementScenarioTestOutcome skipped:', e.message);
    }
    return finalStatus;
}

module.exports = {
    MAX_HEAL_ATTEMPTS,
    mapPool,
    buildGenerationSummaryEntry,
    createEventLogger,
    executeWithPool,
    executeTestCaseWithRetries
};
