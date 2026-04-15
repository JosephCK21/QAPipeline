const { fetchPRDetails, fetchFullFileContents, inferTestFilePaths, fetchPRDependencies } = require('./services/githubService');
const { cleanupSandbox, createSandbox, executeTest } = require('./services/sandboxService');
const { findProjectByGithubRepo } = require('./services/projectStore');
const { getDocsForProject } = require('./services/documentAssociationStore');
const { extractTextFromFiles } = require('./services/documentParserService');
const { mapPrChangesToScenarios } = require('./services/prScenarioMappingService');
const { generateTestCasesForScenario, repairTestCaseScript } = require('./services/geminiService');

const {
    updateRun, createRun, getScenariosByProject,
    getTestCasesByProject, markTestCaseSuperseded,
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
        if (!projectScenarios || projectScenarios.length === 0) {
            sendEvent('log', { level: 'WARN', message: `PR mapping skipped: no scenarios found for project` });
            return null;
        }

        const prDetails = await fetchPRDetails(prUrl);
        sendEvent('pr_details', prDetails);

        const docs = getDocsForProject(linkedProject.id);
        const documentTexts = await extractTextFromFiles(docs);
        const jiraRtmEntry = { scenarios: projectScenarios };

        const mapping = await mapPrChangesToScenarios({ prDetails, jiraRtmEntry, documentTexts });
        sendEvent('pr_scenario_mapping', { mappings: mapping.mappings });
        sendEvent('log', { level: 'INFO', message: `PR mapping complete: ${mapping.mappings?.length || 0} scenario links found.` });

        return { ...mapping, _prDetails: prDetails };
    } catch (error) {
        sendEvent('log', { level: 'WARN', message: `PR mapping failed: ${error.message}` });
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
    const changedPaths = (prDetails.files || []).map(f => f.filename);

    const [fullFiles, testFiles, dependencies] = await Promise.all([
        fetchFullFileContents(owner, repo, ref, changedPaths),
        fetchFullFileContents(owner, repo, ref, inferTestFilePaths(changedPaths))
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
// Hard-limit retry controller — the core of the new stateful approach
// ---------------------------------------------------------------------------
async function executeTestCaseWithRetries({
    testCase, sandboxDir, runId, prUrl, codeContextSection,
    linkedProject, refinementCandidates, sendEvent,
    runSummary
}) {
    let currentScript = testCase.testScript;
    let finalStatus = 'fail';
    let healAttempts = 0;

    for (let attempt = 1; attempt <= MAX_HEAL_ATTEMPTS; attempt++) {
        const attemptStartedAt = new Date().toISOString();

        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt,
            status: 'running',
            startedAt: attemptStartedAt
        });
        sendEvent('log', { level: 'INFO', message: `[Sandbox] ${testCase.testCaseId} attempt ${attempt}/${MAX_HEAL_ATTEMPTS}` });

        // Run the script
        const sandboxResult = await executeTest(
            sandboxDir,
            testCase.language || 'javascript',
            currentScript,
            `test_${testCase.testCaseId}_attempt${attempt}.spec.${testCase.language === 'python' ? 'py' : 'js'}`
        );

        const attemptEndedAt = new Date().toISOString();

        if (sandboxResult.success) {
            finalStatus = 'pass';
            runSummary.passedCount++;
            runSummary.runningCount = Math.max(0, runSummary.runningCount - 1);

            // Persist final passing script back onto the test case
            upsertTestCase({
                ...testCase,
                testScript: currentScript,
                status: 'pass',
                healAttempts,
                lastRunAt: attemptEndedAt
            });

            sendEvent('test_case_attempt', {
                testCaseId: testCase.testCaseId,
                scenarioId: testCase.scenarioId,
                attempt,
                status: 'pass',
                output: sandboxResult.output,
                startedAt: attemptStartedAt,
                endedAt: attemptEndedAt
            });
            sendEvent('log', { level: 'INFO', message: `[Sandbox] ${testCase.testCaseId}: PASS on attempt ${attempt}` });
            break;
        }

        // Failed — record the attempt
        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt,
            status: 'fail',
            failureOutput: sandboxResult.output || sandboxResult.error || 'No output',
            scriptSnapshot: currentScript,
            startedAt: attemptStartedAt,
            endedAt: attemptEndedAt
        });
        sendEvent('log', { level: 'WARN', message: `[Sandbox] ${testCase.testCaseId}: FAIL on attempt ${attempt}` });

        if (attempt < MAX_HEAL_ATTEMPTS) {
            // Heal: ask LLM to patch the script with failure context
            healAttempts++;
            runSummary.retryCount++;
            sendEvent('log', { level: 'INFO', message: `[Healing] Requesting patch for ${testCase.testCaseId} (attempt ${attempt + 1})...` });
            try {
                currentScript = await repairTestCaseScript({
                    testCase: { ...testCase, testScript: currentScript },
                    failureOutput: sandboxResult.output || sandboxResult.error || 'Unknown failure',
                    codeContextSection,
                    attemptNumber: attempt + 1
                });
            } catch (healErr) {
                sendEvent('log', { level: 'ERROR', message: `[Healing] LLM repair failed: ${healErr.message}` });
                break; // Can't heal — give up early
            }
        }
    }

    if (finalStatus === 'fail') {
        runSummary.failedCount++;
        runSummary.runningCount = Math.max(0, runSummary.runningCount - 1);

        upsertTestCase({
            ...testCase,
            testScript: currentScript,
            status: 'fail',
            healAttempts,
            lastRunAt: new Date().toISOString()
        });

        sendEvent('test_case_attempt', {
            testCaseId: testCase.testCaseId,
            scenarioId: testCase.scenarioId,
            attempt: MAX_HEAL_ATTEMPTS,
            status: 'final_fail',
            endedAt: new Date().toISOString()
        });
        sendEvent('log', { level: 'ERROR', message: `[Sandbox] ${testCase.testCaseId}: FINAL FAIL after ${MAX_HEAL_ATTEMPTS} attempts (${healAttempts} heal(s))` });
    }

    updateTestCaseStatus(testCase.testCaseId, finalStatus);
    return finalStatus;
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
        retryCount: 0
    };

    const emitSummary = () => sendEvent('run_summary_updated', { runId, ...runSummary });

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

        // Phase 3: Code Context
        sendEvent('phase_update', { phase: 'Code Context', status: 'running' });
        let codeContext = { fullFiles: [], testFiles: [], dependencies: '' };
        const prDetails = prMapping?._prDetails || await fetchPRDetails(prUrl);
        try {
            codeContext = await buildCodeContext(prDetails);
            sendEvent('log', { level: 'INFO', message: `Code context: ${codeContext.fullFiles.length} source file(s), ${codeContext.testFiles.length} existing test file(s).` });
        } catch (ctxErr) {
            sendEvent('log', { level: 'WARN', message: `Code context partial: ${ctxErr.message}` });
        }
        sendEvent('phase_update', { phase: 'Code Context', status: 'completed' });

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

        // Phase 4: Test Generation
        sendEvent('phase_update', { phase: 'Test Generation', status: 'running' });

        // Create sandbox once, shared across all test cases in this run
        const sandboxDir = await createSandbox(runId);

        let overallSuccess = false;

        for (const scenarioMapping of mappedScenarios) {
            const scenarioId = scenarioMapping.id || scenarioMapping.scenarioId;
            const scenarioDescription = scenarioMapping.description || '';
            const scenarioType = scenarioMapping.type || '';
            const scenarioPriority = scenarioMapping.priority || 'Medium';

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

            let generatedTestCases = [];
            try {
                generatedTestCases = await generateTestCasesForScenario({
                    scenario: { id: scenarioId, description: scenarioDescription, type: scenarioType, priority: scenarioPriority },
                    codeContextSection,
                    prDiffSection,
                    dependenciesSection: codeContext.dependencies || '',
                    refinementContext
                });
            } catch (genErr) {
                sendEvent('log', { level: 'ERROR', message: `Test case generation failed for ${scenarioId}: ${genErr.message}` });
                sendEvent('scenario_execution_updated', { scenarioId, status: 'error', totals: { passed: 0, failed: 0, running: 0 } });
                continue;
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
                    testCaseId:        tc.testCaseId,
                    scenarioId,
                    projectKey:        linkedProject?.jiraProjectKey || '',
                    runId,
                    prUrl,
                    title:             tc.title,
                    steps:             tc.steps || [],
                    testData:          tc.testData || {},
                    testScript:        tc.testScript || '',
                    language:          tc.language || 'javascript',
                    status:            'pending',
                    version:           tc.isRefinement ? baseVersion : 1,
                    previousVersionId: tc.isRefinement ? (refinementForScenario?.testCase.testCaseId || null) : null,
                    codeFiles:         tc.codeFiles || [],
                    healAttempts:      0,
                    createdAt:         new Date().toISOString()
                };
                upsertTestCase(saved);
                persistedCases.push(saved);
            }

            // Emit detail event so View Details shows generated cases immediately
            sendEvent('test_cases_saved', {
                scenarioId,
                count: persistedCases.length,
                isRefinement: !!refinementContext
            });

            // Phase 5: Sandbox execution with stateful retry per test case
            sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'running' });

            let scenarioPassed = 0;
            let scenarioFailed = 0;

            for (const tc of persistedCases) {
                const tcStatus = await executeTestCaseWithRetries({
                    testCase: tc,
                    sandboxDir,
                    runId,
                    prUrl,
                    codeContextSection,
                    linkedProject,
                    refinementCandidates,
                    sendEvent,
                    runSummary
                });

                if (tcStatus === 'pass') {
                    scenarioPassed++;
                    overallSuccess = true;
                } else {
                    scenarioFailed++;
                }

                emitSummary();
            }

            const scenarioStatus = scenarioFailed === 0 ? 'pass'
                : scenarioPassed === 0 ? 'fail'
                : 'partial';

            sendEvent('scenario_execution_updated', {
                scenarioId,
                status: scenarioStatus,
                totals: { passed: scenarioPassed, failed: scenarioFailed, running: 0 }
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
        cleanupSandbox(runId);
        sendEvent('complete', { success: overallSuccess });

    } catch (error) {
        console.error('\n================ PIPELINE CRASHED =================');
        console.error(error);

        sendEvent('phase_update', { phase: 'Test Generation', status: 'error' });
        sendEvent('log', { level: 'ERROR', message: `Fatal Error: ${error.message}` });
        sendEvent('error', { message: error.message });
        cleanupSandbox(runId);
    }
}

module.exports = { runPipeline };
