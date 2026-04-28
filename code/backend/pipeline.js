const { fetchPRDetails, fetchFullFileContents, inferTestFilePaths, fetchPRDependencies } = require('./services/githubService');
const { cleanupSandboxPool, createSandboxPool, executeTest } = require('./services/sandboxService');
const { findProjectByGithubRepo } = require('./services/projectStore');
const { getDocsForProject } = require('./services/documentAssociationStore');
const { extractTextFromFiles } = require('./services/documentParserService');
const { mapPrChangesToScenarios } = require('./services/prScenarioMappingService');
const { classifyPrAsBugFix } = require('./services/prClassificationService');
const { generateTestCasesForScenario, repairTestCaseScript } = require('./services/llmService');

const {
    updateRun, createRun, getScenariosByProject,
    getTestCasesByProject, getTestCasesByScenario, markTestCaseSuperseded,
    upsertTestCase, updateTestCaseStatus
} = require('./db');

const MAX_HEAL_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Event logger: writes to DB and broadcasts via Socket.IO
// ---------------------------------------------------------------------------
function createEventLogger(runId) {
    return (type, data) => {
        const updateParams = {};
        let logsMsg = null;

        if (type === 'phase_update') {
            updateParams.status = data.status;
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
        } else if (type === 'error') {
            updateParams.status = 'failed';
            logsMsg = `[ERROR] ${data.message}`;
        } else if (type === 'run_summary_updated') {
            // Store compact summary in events list for fast row rendering
            updateParams.events = [{ type: 'run_summary_updated', data, timestamp: new Date().toISOString() }];
        } else if (type === 'test_case_attempt') {
            // Store each attempt as a detailed event for View Details
            updateParams.events = [{ type: 'test_case_attempt', data, timestamp: new Date().toISOString() }];
        } else if (type === 'scenario_execution_updated') {
            updateParams.events = [{ type: 'scenario_execution_updated', data, timestamp: new Date().toISOString() }];
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
// PR scenario mapping (unchanged from previous version)
// ---------------------------------------------------------------------------
async function attachPrScenarioMapping(runId, prUrl, repoFullName, sendEvent) {
    try {
        const linkedProject = findProjectByGithubRepo(repoFullName);
        if (!linkedProject?.id) {
            sendEvent('log', { level: 'WARN', message: `PR mapping skipped: no linked local project for ${repoFullName}` });
            return null;
        }

        const projectScenarios = getScenariosByProject(linkedProject.jiraProjectKey || linkedProject.id);
        sendEvent('log', { level: 'INFO', message: `PR mapping: found ${projectScenarios?.length || 0} scenario(s) in DB for project key "${linkedProject.jiraProjectKey || linkedProject.id}"` });
        if (!projectScenarios || projectScenarios.length === 0) {
            sendEvent('log', { level: 'WARN', message: `PR mapping skipped: no scenarios found for project` });
            return null;
        }

        const docs = getDocsForProject(linkedProject.id);
        const [prDetails, documentTexts] = await Promise.all([
            fetchPRDetails(prUrl),
            extractTextFromFiles(docs)
        ]);
        sendEvent('log', { level: 'INFO', message: `PR mapping: fetched PR with ${prDetails?.files?.length || 0} changed file(s): ${(prDetails?.files || []).map(f => f.filename).join(', ')}` });
        sendEvent('pr_details', prDetails);
        sendEvent('log', { level: 'INFO', message: `PR mapping: ${documentTexts?.length || 0} project document(s) loaded` });

        const jiraRtmEntry = { scenarios: projectScenarios };

        const mapping = await mapPrChangesToScenarios({ prDetails, jiraRtmEntry, documentTexts });
        sendEvent('pr_scenario_mapping', { mappings: mapping.mappings });
        sendEvent('log', { level: 'INFO', message: `PR mapping complete: ${mapping.mappings?.length || 0} scenario links found.` });

        return { ...mapping, _prDetails: prDetails };
    } catch (error) {
        sendEvent('log', { level: 'WARN', message: `PR mapping failed: ${error.message} | stack: ${error.stack?.split('\n')[1] || ''}` });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Code context fetching
// ---------------------------------------------------------------------------
function parsePROwnerRepo(prDetails) {
    try {
        const [owner, repo] = (prDetails.headRepoFullName || '').split('/');
        return { owner: owner || null, repo: repo || null };
    } catch {
        return { owner: null, repo: null };
    }
}

async function buildCodeContext(prDetails) {
    const { owner, repo } = parsePROwnerRepo(prDetails);
    if (!owner || !repo) return { fullFiles: [], testFiles: [], dependencies: '' };

    const ref = prDetails.headRef || 'main';
    const NON_CODE_EXTS = new Set(['.md', '.txt', '.rst', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.lock', '.log']);
    const changedPaths = (prDetails.files || [])
        .map(f => f.filename)
        .filter(p => {
            const ext = p.includes('.') ? '.' + p.split('.').pop().toLowerCase() : '';
            return !NON_CODE_EXTS.has(ext);
        });

    const [fullFiles, testFiles, dependencies] = await Promise.all([
        fetchFullFileContents(owner, repo, ref, changedPaths),
        fetchFullFileContents(owner, repo, ref, inferTestFilePaths(changedPaths), { quiet: true })
            .then(r => r.filter(f => !f.content.startsWith('// Could not fetch'))),
        fetchPRDependencies(`https://github.com/${owner}/${repo}/pull/${(prDetails._prUrl || '').split('/').pop() || '1'}`)
            .catch(() => 'Not available')
    ]);

    return { fullFiles, testFiles, dependencies };
}

// ---------------------------------------------------------------------------
// Refinement candidate detection
// ---------------------------------------------------------------------------
function detectRefinementCandidates(repoFullName, prChangedFilenames) {
    const linkedProject = findProjectByGithubRepo(repoFullName);
    if (!linkedProject?.jiraProjectKey) return [];

    const existingTestCases = getTestCasesByProject(linkedProject.jiraProjectKey);
    const prFileSet = new Set(prChangedFilenames);

    return existingTestCases
        .filter(tc => (Array.isArray(tc.codeFiles) ? tc.codeFiles : []).some(f => prFileSet.has(f)))
        .map(tc => ({ testCase: tc, scenarioId: tc.scenarioId }));
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
            executing.splice(executing.indexOf(p), 1);
        });
        executing.push(p);

        if (executing.length >= pool.length) {
            await Promise.race(executing);
        }
    }

    await Promise.all(executing);
}

// ---------------------------------------------------------------------------
// Hard-limit retry controller — the core of the new stateful approach
// ---------------------------------------------------------------------------
async function executeTestCaseWithRetries({
    testCase, containerName, sandboxDir, runId, prUrl, codeContextSection,
    linkedProject, refinementCandidates, sendEvent,
    runSummary,
    regressionMode = false,
    scenarioDescription = ''
}) {
    let currentScript = testCase.testScript;
    let finalStatus = 'fail';
    let healAttempts = 0;

    // Regression mode only: capture the pristine script + the first failure output
    // so we can surface them as a potential-regression signal even when healing succeeds.
    const originalScriptSnapshot = regressionMode ? (testCase.testScript || '') : null;
    let firstFailureOutput = null;

    // Stateful bookkeeping for the conversation between the pipeline and the LLM:
    //   - conversationId: shared Conversations API id for this test case (preferred chain mechanism)
    //   - currentInteractionId: latest response.id, used as fallback/zdr-mode chain
    // Both are populated from the initial test-case generation call and mutated after every heal.
    let conversationId = testCase.conversationId || null;
    let currentInteractionId = testCase.latestResponseId || testCase.generationInteractionId || null;

    // Manual history — used only as a fallback when neither conversation nor previous_response_id is available.
    const attemptHistory = [];

    // Encrypted reasoning items (ZDR mode only). Passed back in each subsequent
    // heal call so the model retains its chain-of-thought across attempts even
    // when the Conversations API / previous_response_id path is unavailable.
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

        // Run the script inside the persistent container.
        // testCase.testData is passed separately and injected as a preamble by the sandbox,
        // so the script can reference all fixture values via the testData variable.
        const sandboxResult = await executeTest(
            containerName,
            sandboxDir,
            testCase.language || 'javascript',
            currentScript,
            `test_${testCase.testCaseId}_attempt${attempt}.spec.${testCase.language === 'python' ? 'py' : 'js'}`,
            testCase.testData || {}
        );

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

            // Regression stamping: clean_pass when the pristine script passed first try,
            // 'adapted' when healing had to change it to make it green.
            const regressionStamp = regressionMode
                ? (healAttempts === 0 ? 'clean_pass' : 'adapted')
                : null;

            // Persist final passing script back onto the test case
            upsertTestCase({
                ...testCase,
                testScript: currentScript,
                status: 'pass',
                healAttempts,
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
            break;
        }

        // Record this failure in the history before healing
        const failureOutput = sandboxResult.output || sandboxResult.error || 'No output';
        // Keep the TAIL of the failure output, not the head — stack traces and
        // "expected X got Y" lines are almost always at the end. Older code
        // kept the first 1500 chars which usually showed only boot/log noise.
        attemptHistory.push({
            attemptNumber: attempt,
            scriptUsed: currentScript,
            failureOutput: failureOutput.slice(-3500)
        });

        // Regression mode: remember the very first failure so we can retain it
        // alongside an adapted/healed script as a potential-regression signal.
        if (regressionMode && firstFailureOutput === null) {
            firstFailureOutput = failureOutput;
        }

        // Failed — record the attempt
        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt,
            status: 'fail',
            failureOutput,
            scriptSnapshot: currentScript,
            regression: regressionMode ? 'pending' : null,
            startedAt: attemptStartedAt,
            endedAt: attemptEndedAt
        });
        const failureSnippet = failureOutput.slice(0, 2000);
        sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId}: FAIL on attempt ${attempt}` });
        sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId} failure output: ${failureSnippet}` });

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
                    scenarioDescription
                });
                currentScript = healResult.repairedScript;
                currentInteractionId = healResult.interactionId || currentInteractionId;
                // Refresh encrypted reasoning items for the next heal (ZDR mode).
                // Non-ZDR modes return [] here, which harmlessly overrides nothing.
                if (Array.isArray(healResult.reasoningItems) && healResult.reasoningItems.length > 0) {
                    currentReasoningItems = healResult.reasoningItems;
                }
                // Stale-chain signal from llmService — the stored conversationId
                // is invalid (expired/deleted). Drop it so we don't keep trying
                // the same dead anchor on every subsequent heal.
                if (healResult.chainWasStale) {
                    sendEvent('log', { level: 'WARN', message: `[Healing] Stored conversation/response anchor was stale — continuing stateless.` });
                    conversationId = null;
                    currentInteractionId = healResult.interactionId || null;
                }

                // Persist the latest response id so a server restart can resume the chain.
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
    return finalStatus;
}

// ---------------------------------------------------------------------------
// Epic-wide regression runner
//
// Triggered when the PR is classified as "just a bug fix". We skip new test
// generation and instead re-execute every existing, latest-version test case
// for every scenario under every epic that the PR touches.
//
// Reuses executeTestCaseWithRetries with regressionMode=true so healing still
// runs (per user choice) but each test case ends up stamped as one of:
//   - clean_pass:       passed on the first attempt, no heal needed
//   - adapted:          passed but only after healing — original failure is
//                       retained as a potential regression signal
//   - regression_fail:  could not be made green after MAX_HEAL_ATTEMPTS
// ---------------------------------------------------------------------------
async function runEpicRegression({
    runId, prUrl, mappedScenarios, linkedProject, prDetails,
    codeContextSection, sandboxPool, sendEvent, runSummary
}) {
    // 1. Resolve which epic(s) the PR touches via the mapped scenarios.
    const projectKey = linkedProject?.jiraProjectKey || linkedProject?.id;
    const allProjectScenarios = getScenariosByProject(projectKey) || [];
    const scenarioById = new Map(allProjectScenarios.map((s) => [s.scenarioId, s]));

    const epicIds = new Set();
    for (const m of mappedScenarios) {
        const scenarioId = m.id || m.scenarioId;
        const scenario = scenarioById.get(scenarioId);
        if (scenario?.epicId) epicIds.add(scenario.epicId);
    }

    if (epicIds.size === 0) {
        sendEvent('log', { level: 'WARN', message: '[Regression] No epic could be resolved from mapped scenarios — nothing to regress.' });
        return { success: true, scenarios: [] };
    }

    // 2. Collect every non-obsolete scenario under those epics.
    const epicScenarios = allProjectScenarios.filter((s) =>
        epicIds.has(s.epicId) && s.status !== 'obsolete'
    );

    sendEvent('log', {
        level: 'INFO',
        message: `[Regression] Epic(s): ${Array.from(epicIds).join(', ')} — ${epicScenarios.length} scenario(s) to re-test`
    });

    // 3. Load the latest runnable test cases for each scenario.
    const scenarioPlans = [];
    let totalTestCases = 0;
    for (const scenario of epicScenarios) {
        const cases = getTestCasesByScenario(scenario.scenarioId)
            .filter((tc) => tc.testScript && tc.testScript.trim().length > 0);

        // getTestCasesByScenario orders by version DESC, so the first row per
        // (scenarioId) is the latest version. Keep only that — older versions
        // are superseded history, not the current surface area.
        const latestByScenario = new Map();
        for (const tc of cases) {
            if (!latestByScenario.has(tc.scenarioId)) {
                latestByScenario.set(tc.scenarioId, []);
            }
            const bucket = latestByScenario.get(tc.scenarioId);
            if (bucket.length === 0 || bucket[0].version === tc.version) {
                bucket.push(tc);
            }
        }
        const runnableCases = Array.from(latestByScenario.values()).flat();

        if (runnableCases.length > 0) {
            scenarioPlans.push({ scenario, testCases: runnableCases });
            totalTestCases += runnableCases.length;
        }
    }

    if (totalTestCases === 0) {
        sendEvent('log', { level: 'WARN', message: '[Regression] No existing test cases found for the affected epic(s) — nothing to run.' });
        return { success: true, scenarios: [] };
    }

    runSummary.scenarioCount = scenarioPlans.length;
    runSummary.testCaseCount = totalTestCases;
    runSummary.runningCount  = totalTestCases;

    sendEvent('regression_summary', {
        epicIds:         Array.from(epicIds),
        scenarioCount:   scenarioPlans.length,
        testCaseCount:   totalTestCases
    });

    // 4. Execute every test case against the PR's code concurrently in pool
    let overallSuccess = false;
    sendEvent('phase_update', { phase: 'Regression Execution', status: 'running' });

    const scenarioResults = {};
    const allTasks = [];

    for (const { scenario, testCases } of scenarioPlans) {
        scenarioResults[scenario.scenarioId] = { passed: 0, failed: 0 };
        sendEvent('scenario_execution_updated', {
            scenarioId: scenario.scenarioId,
            status: 'running',
            totals: { passed: 0, failed: 0, running: testCases.length }
        });
        sendEvent('log', { level: 'INFO', message: `[Regression] Scenario ${scenario.scenarioId}: running ${testCases.length} existing test case(s)` });

        for (const tc of testCases) {
            allTasks.push({ scenario, tc });
        }
    }

    await executeWithPool(allTasks, sandboxPool, async (task, container) => {
        const { scenario, tc } = task;
        const runnable = { ...tc, runId, prUrl };

        const tcStatus = await executeTestCaseWithRetries({
            testCase: runnable,
            containerName: container.containerName,
            sandboxDir: container.sandboxDir,
            runId,
            prUrl,
            codeContextSection,
            linkedProject,
            refinementCandidates: [],
            sendEvent,
            runSummary,
            regressionMode: true,
            scenarioDescription: scenario.description || ''
        });

        if (tcStatus === 'pass') {
            scenarioResults[scenario.scenarioId].passed++;
            overallSuccess = true;
        } else {
            scenarioResults[scenario.scenarioId].failed++;
        }

        const { passed, failed } = scenarioResults[scenario.scenarioId];
        sendEvent('scenario_execution_updated', {
            scenarioId: scenario.scenarioId,
            status: failed === 0 ? 'running' : 'partial', // Interim status
            totals: { passed, failed, running: 0 }
        });
    });

    // Finalize statuses
    for (const { scenario } of scenarioPlans) {
        const { passed, failed } = scenarioResults[scenario.scenarioId];
        const scenarioStatus = failed === 0 ? 'pass'
            : passed === 0 ? 'fail'
            : 'partial';

        sendEvent('scenario_execution_updated', {
            scenarioId: scenario.scenarioId,
            status: scenarioStatus,
            totals: { passed, failed, running: 0 }
        });
    }

    sendEvent('phase_update', { phase: 'Regression Execution', status: 'completed' });
    return { success: overallSuccess, scenarios: scenarioPlans.map((p) => p.scenario.scenarioId) };
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------
async function runPipeline(runId, prUrl, repoFullName) {
    const linkedProject = findProjectByGithubRepo(repoFullName);
    const localProjectId = linkedProject?.id || null;
    createRun(runId, { status: 'running', repoFullName, localProjectId });
    const sendEvent = createEventLogger(runId);
    sendEvent('init', { repoFullName });

    // Shared counters emitted to UI as compact summary on each row
    const runSummary = {
        scenarioCount: 0,
        testCaseCount: 0,
        passedCount: 0,
        failedCount: 0,
        runningCount: 0,
        retryCount: 0,
        scenariosGeneratingLeft: 0
    };

    const emitSummary = () => sendEvent('run_summary_updated', { runId, ...runSummary });

    // Declared here so the catch block can always clean up the pool.
    let _sandboxPool = null;

    try {
        // Phase 1: Initializing
        sendEvent('phase_update', { phase: 'Initializing', status: 'running' });
        sendEvent('phase_update', { phase: 'Initializing', status: 'completed' });

        // Phase 2: PR Mapping
        sendEvent('phase_update', { phase: 'PR Mapping', status: 'running' });
        const prMapping = await attachPrScenarioMapping(runId, prUrl, repoFullName, sendEvent);
        sendEvent('phase_update', { phase: 'PR Mapping', status: 'completed' });

        const mappedScenarios = prMapping?.mappings || [];
        runSummary.scenarioCount = mappedScenarios.length;
        emitSummary();

        if (mappedScenarios.length === 0) {
            sendEvent('log', { level: 'WARN', message: 'No scenarios mapped to this PR — nothing to test.' });
            sendEvent('complete', { success: true });
            return;
        }

        // Enrichment: build a lookup of RTM scenarios (title, description, type,
        // priority, acceptanceCriteriaRef, storyId, epicId) so we can pass the
        // full context into generation. The PR-mapping LLM only returns minimal
        // fields; without this merge the test-case generator would see a bare
        // scenarioId with no acceptance criteria and have to guess.
        const rtmProjectKey = linkedProject?.jiraProjectKey || linkedProject?.id;
        const rtmRows = rtmProjectKey ? (getScenariosByProject(rtmProjectKey) || []) : [];
        const rtmById = new Map(rtmRows.map(r => [r.scenarioId, r]));
        const enrichedCount = mappedScenarios.reduce((acc, m) => acc + (rtmById.has(m.scenarioId || m.id) ? 1 : 0), 0);
        sendEvent('log', { level: 'INFO', message: `[Enrichment] Resolved ${enrichedCount}/${mappedScenarios.length} mapped scenarios against RTM rows (project "${rtmProjectKey || 'n/a'}").` });

        // Phase 2.5 + 3 + Sandbox — run in parallel.
        // Classification, code context fetch, and sandbox creation are all
        // independent and only need prDetails. Running them concurrently
        // saves 15-30 seconds per run (Docker clone + npm install overlaps
        // with LLM classification + GitHub file fetches).
        const prDetails = prMapping?._prDetails || await fetchPRDetails(prUrl);
        const regressionFeatureEnabled = String(process.env.REGRESSION_ENABLED || 'true').toLowerCase() !== 'false';

        // --- Classification task (async) ---
        const classifyTask = (async () => {
            if (!regressionFeatureEnabled) {
                sendEvent('log', { level: 'INFO', message: '[Classification] Disabled via REGRESSION_ENABLED=false — running standard flow.' });
                return { isBugFix: false, confidence: 0, rationale: 'Classification skipped', source: 'disabled', jiraIssueKeys: [], jiraBugKeys: [] };
            }
            sendEvent('phase_update', { phase: 'Classification', status: 'running' });
            try {
                const result = await classifyPrAsBugFix({ prDetails });
                sendEvent('pr_classification', result);
                sendEvent('log', {
                    level: 'INFO',
                    message: `[Classification] isBugFix=${result.isBugFix} (source=${result.source}, confidence=${Number(result.confidence).toFixed(2)}): ${result.rationale}`
                });
                return result;
            } catch (err) {
                sendEvent('log', { level: 'WARN', message: `[Classification] Failed: ${err.message} — falling back to standard flow.` });
                return { isBugFix: false, confidence: 0, rationale: `Classifier failed: ${err.message}`, source: 'error', jiraIssueKeys: [], jiraBugKeys: [] };
            } finally {
                sendEvent('phase_update', { phase: 'Classification', status: 'completed' });
            }
        })();

        // --- Code Context task (async) ---
        const codeContextTask = (async () => {
            sendEvent('phase_update', { phase: 'Code Context', status: 'running' });
            let ctx = { fullFiles: [], testFiles: [], dependencies: '' };
            try {
                ctx = await buildCodeContext(prDetails);
                sendEvent('log', { level: 'INFO', message: `Code context: ${ctx.fullFiles.length} source file(s), ${ctx.testFiles.length} existing test file(s).` });
            } catch (ctxErr) {
                sendEvent('log', { level: 'WARN', message: `Code context partial: ${ctxErr.message}` });
            }
            sendEvent('phase_update', { phase: 'Code Context', status: 'completed' });
            return ctx;
        })();

        // --- Sandbox task (async) ---
        const sandboxTask = (async () => {
            sendEvent('phase_update', { phase: 'Sandbox Setup', status: 'running' });
            // Spin up a pool of 2 Docker containers for parallel testing
            const pool = await createSandboxPool(runId, prDetails, 2);
            sendEvent('log', { level: 'INFO', message: `[Sandbox] Created pool of ${pool.length} containers` });
            sendEvent('phase_update', { phase: 'Sandbox Setup', status: 'completed' });
            return pool;
        })();

        // Wait for classification and context. Do NOT wait for sandbox setup here!
        const [classification, codeContext] = await Promise.all([
            classifyTask, codeContextTask
        ]);

        // Build single concatenated context string for LLM prompts
        const codeContextSection = [
            ...(codeContext.fullFiles || []).map(f => `=== FILE: ${f.path} ===\n${f.content}`),
            ...(codeContext.testFiles || []).map(f => `=== EXISTING TEST: ${f.path} ===\n${f.content}`)
        ].join('\n\n');

        const prDiffSection = (prDetails.files || [])
            .map(f => `--- ${f.filename} ---\n${f.patch || '(no patch)'}`)
            .join('\n\n');

        // Refinement: mark old test cases as superseded
        const changedFilenames = (prDetails.files || []).map(f => f.filename);
        const refinementCandidates = detectRefinementCandidates(repoFullName, changedFilenames);
        if (refinementCandidates.length > 0) {
            sendEvent('log', { level: 'INFO', message: `Refinement: ${refinementCandidates.length} existing test case(s) will be updated.` });
            for (const { testCase } of refinementCandidates) {
                markTestCaseSuperseded(testCase.testCaseId);
            }
        }

        let overallSuccess = false;

        // ------------------------------------------------------------------
        // Regression path: PR classified as a bug fix — re-run existing test
        // cases for every scenario in every epic the PR touches. Skip the
        // normal generation loop.
        // ------------------------------------------------------------------
        if (regressionFeatureEnabled && classification.isBugFix) {
            sendEvent('log', { level: 'INFO', message: '[Pipeline] Entering epic-wide regression path (bug fix PR). Waiting for sandbox pool...' });
            sendEvent('phase_update', { phase: 'Test Generation', status: 'skipped' });
            runSummary.scenariosGeneratingLeft = 0;

            const sandboxPool = await sandboxTask;
            _sandboxPool = sandboxPool;

            const regressionResult = await runEpicRegression({
                runId,
                prUrl,
                mappedScenarios,
                linkedProject,
                prDetails,
                codeContextSection,
                sandboxPool,
                sendEvent,
                runSummary
            });

            overallSuccess = regressionResult.success;

            sendEvent('phase_update', {
                phase: 'Test Healing',
                status: 'completed',
                skipped: runSummary.retryCount === 0
            });
            sendEvent('phase_update', { phase: 'Pass', status: overallSuccess ? 'completed' : 'failed' });

            emitSummary();
            cleanupSandboxPool(runId, sandboxPool);
            sendEvent('complete', { success: overallSuccess });
            return;
        }

        // ------------------------------------------------------------------
        // Standard path: non-bug-fix PR — generate new test cases per scenario.
        // ------------------------------------------------------------------
        // Phase 4 & 5: Pipelined Test Generation & Sandbox Execution
        sendEvent('phase_update', { phase: 'Test Generation', status: 'running' });
        sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'running' });

        runSummary.scenariosGeneratingLeft = mappedScenarios.length;
        emitSummary();

        const executionQueue = [];
        let isGenerationFinished = false;
        const scenarioResults = {};
        
        for (const m of mappedScenarios) {
            scenarioResults[m.id || m.scenarioId] = { passed: 0, failed: 0 };
        }

        // ------------------------------------------------------------------
        // Background Executor: Pulls generated test cases from the queue as 
        // soon as they are ready, provided the sandbox pool has finished starting.
        // ------------------------------------------------------------------
        const executionTaskPromise = (async () => {
            const sandboxPool = await sandboxTask;
            _sandboxPool = sandboxPool;
            const availableContainers = [...sandboxPool];
            const executing = [];

            while (!isGenerationFinished || executionQueue.length > 0 || executing.length > 0) {
                if (executionQueue.length === 0 || availableContainers.length === 0) {
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }

                const taskItem = executionQueue.shift();
                const container = availableContainers.pop();

                const p = (async () => {
                    const { scenarioId, scenarioDescription, tc } = taskItem;
                    try {
                        const tcStatus = await executeTestCaseWithRetries({
                            testCase: tc,
                            containerName: container.containerName,
                            sandboxDir: container.sandboxDir,
                            runId,
                            prUrl,
                            codeContextSection,
                            linkedProject,
                            refinementCandidates,
                            sendEvent,
                            runSummary,
                            scenarioDescription
                        });

                        if (tcStatus === 'pass') {
                            scenarioResults[scenarioId].passed++;
                            overallSuccess = true;
                        } else {
                            scenarioResults[scenarioId].failed++;
                        }
                        emitSummary();

                        const { passed, failed } = scenarioResults[scenarioId];
                        sendEvent('scenario_execution_updated', {
                            scenarioId,
                            status: failed === 0 ? 'running' : 'partial', // Interim status
                            totals: { passed, failed, running: 0 }
                        });
                    } finally {
                        availableContainers.push(container);
                        executing.splice(executing.indexOf(p), 1);
                    }
                })();
                
                // Clear out from executing array when done
                p.finally(() => {
                    executing.splice(executing.indexOf(p), 1);
                });
                executing.push(p);
            }
        })();

        // Map over all scenarios and run LLM generation in parallel
        const generationPromises = mappedScenarios.map(async (scenarioMapping) => {
            try {
            const scenarioId = scenarioMapping.id || scenarioMapping.scenarioId;
            // Merge RTM row (authoritative for description, type, priority,
            // title, AC refs) with mapping result (authoritative for confidence
            // / rationale / impactedFiles). Mapping fields win when present
            // because the mapper may have refined the description for this PR.
            const rtmRow = rtmById.get(scenarioId) || {};
            const scenarioDescription = scenarioMapping.description || rtmRow.description || '';
            const scenarioType = scenarioMapping.type || rtmRow.type || '';
            const scenarioPriority = scenarioMapping.priority || rtmRow.priority || 'Medium';
            const scenarioTitle = rtmRow.title || '';
            const scenarioAcRef = Array.isArray(rtmRow.acceptanceCriteriaRef) ? rtmRow.acceptanceCriteriaRef : [];

            sendEvent('scenario_execution_updated', {
                scenarioId,
                status: 'generating',
                totals: { passed: 0, failed: 0, running: 0 }
            });
            sendEvent('log', { level: 'INFO', message: `Generating test cases for scenario: ${scenarioId}` });

            // Find refinement context for this scenario (previous test case to update)
            const refinementForScenario = refinementCandidates.find(rc => rc.scenarioId === scenarioId);
            const refinementContext = refinementForScenario
                ? { version: refinementForScenario.testCase.version, testScript: refinementForScenario.testCase.testScript }
                : null;

            // When refining, reuse the prior test case's conversation so the model
            // keeps the full reasoning history of why the previous version existed.
            const priorConversationId = refinementForScenario?.testCase?.conversationId || null;
            const priorResponseId = refinementForScenario?.testCase?.latestResponseId || null;

            let generatedTestCases = [];
            let generationInteractionId = null;
            let scenarioConversationId = priorConversationId;
            try {
                const genResult = await generateTestCasesForScenario({
                    scenario: {
                        id: scenarioId,
                        title: scenarioTitle,
                        description: scenarioDescription,
                        type: scenarioType,
                        priority: scenarioPriority,
                        acceptanceCriteriaRef: scenarioAcRef
                    },
                    codeContextSection,
                    prDiffSection,
                    dependenciesSection: codeContext.dependencies || '',
                    refinementContext,
                    alreadyGeneratedSummary: [], // Context tracking removed to allow parallel execution
                    conversationId: priorConversationId,
                    previousInteractionId: priorResponseId
                });
                generatedTestCases = genResult.testCases;
                generationInteractionId = genResult.interactionId;
                scenarioConversationId = genResult.conversationId || scenarioConversationId;
                sendEvent('log', { level: 'INFO', message: `[Generation] conversation=${scenarioConversationId || 'n/a'} response=${generationInteractionId || 'unavailable'} (stateful chain anchors)` });
            } catch (genErr) {
                sendEvent('log', { level: 'ERROR', message: `Test case generation failed for ${scenarioId}: ${genErr.message}` });
                sendEvent('scenario_execution_updated', { scenarioId, status: 'error', totals: { passed: 0, failed: 0, running: 0 } });
                return null;
            }

            sendEvent('log', { level: 'INFO', message: `Generated ${generatedTestCases.length} test case(s) for ${scenarioId}` });
            runSummary.testCaseCount += generatedTestCases.length;
            runSummary.runningCount += generatedTestCases.length;
            emitSummary();

            // Persist generated test cases
            const baseVersion = refinementContext ? (refinementForScenario.testCase.version + 1) : 1;
            const persistedCases = [];
            for (const tc of generatedTestCases) {
                const saved = {
                    testCaseId:              tc.testCaseId,
                    scenarioId,
                    projectKey:              linkedProject?.jiraProjectKey || '',
                    runId,
                    prUrl,
                    title:                   tc.title,
                    steps:                   tc.steps || [],
                    testData:                tc.testData || {},
                    testScript:              tc.testScript || '',
                    language:                tc.language || 'javascript',
                    status:                  'pending',
                    version:                 tc.isRefinement ? baseVersion : 1,
                    previousVersionId:       tc.isRefinement ? (refinementForScenario?.testCase.testCaseId || null) : null,
                    codeFiles:               tc.codeFiles || [],
                    healAttempts:            0,
                    // Stateful anchors — conversation owns the chain; response id is the latest turn,
                    // also retained as generationInteractionId for backward compatibility with in-flight runs.
                    conversationId:          scenarioConversationId,
                    latestResponseId:        generationInteractionId,
                    generationInteractionId,
                    createdAt:               new Date().toISOString()
                };
                upsertTestCase(saved);
                persistedCases.push(saved);
                
                // Pipeline to background executor!
                executionQueue.push({ scenarioId, scenarioDescription, tc: saved });
            }

            // Emit detail event so View Details shows generated cases immediately
            sendEvent('test_cases_saved', {
                scenarioId,
                count: persistedCases.length,
                isRefinement: !!refinementContext
            });

            return { scenarioId, persistedCases, scenarioDescription };
            } finally {
                runSummary.scenariosGeneratingLeft = Math.max(0, runSummary.scenariosGeneratingLeft - 1);
                emitSummary();
            }
        });

        // Wait for all scenarios to finish generating in parallel
        const generatedResults = (await Promise.all(generationPromises)).filter(Boolean);
        
        // Signal that no more test cases will be queued
        isGenerationFinished = true;
        sendEvent('phase_update', { phase: 'Test Generation', status: 'completed' });

        // Wait for the background executor to finish the remaining queue and all active executions
        await executionTaskPromise;

        // Finalize statuses for Phase 5
        for (const result of generatedResults) {
            const { passed, failed } = scenarioResults[result.scenarioId];
            const scenarioStatus = failed === 0 && passed > 0 ? 'pass'
                : passed === 0 ? 'fail'
                : 'partial';

            sendEvent('scenario_execution_updated', {
                scenarioId: result.scenarioId,
                status: scenarioStatus,
                totals: { passed, failed, running: 0 }
            });
        }

        sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'completed' });

        // Phase 6: Healing phase marker (now embedded in retry controller — mark completed)
        sendEvent('phase_update', {
            phase: 'Test Healing',
            status: runSummary.retryCount > 0 ? 'completed' : 'completed',
            skipped: runSummary.retryCount === 0
        });

        sendEvent('phase_update', { phase: 'Pass', status: overallSuccess ? 'completed' : 'failed' });

        emitSummary();
        if (_sandboxPool) {
            cleanupSandboxPool(runId, _sandboxPool);
        }
        sendEvent('complete', { success: overallSuccess });

    } catch (error) {
        console.error('\n================ PIPELINE CRASHED =================');
        console.error(error);

        sendEvent('phase_update', { phase: 'Test Generation', status: 'error' });
        sendEvent('log', { level: 'ERROR', message: `Fatal Error: ${error.message}` });
        sendEvent('error', { message: error.message });
        sendEvent('complete', { success: false });
        if (_sandboxPool) {
            cleanupSandboxPool(runId, _sandboxPool);
        }
    }
}

module.exports = { runPipeline };
