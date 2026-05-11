const { v4: uuidv4 } = require('uuid');
const { crawlSiteForContext } = require('./services/siteCrawlerService');
const { extractTextFromFiles } = require('./services/documentParserService');
const { generateLiveSiteScenarios, generateLiveSiteTestCases, normalizeTestCaseSteps, setLlmRunContext } = require('./services/llmService');
const { createLiveSiteSandboxPool, cleanupSandboxPool } = require('./services/sandboxService');
const {
    createEventLogger, mapPool, executeTestCaseWithRetries, MAX_HEAL_ATTEMPTS
} = require('./pipelineHelpers');
const { createRun, upsertTestCase } = require('./db');
const { CURRENT_SCHEMA_VERSION } = require('./schemas');

/** Max concurrent LLM test-case generation calls per live-site run. */
const LLM_GEN_MAX_CONCURRENT = Math.max(1, parseInt(process.env.AUTOQA_LLM_MAX_CONCURRENT_GENERATION || '4', 10) || 4);

/**
 * Run the live-site testing pipeline.
 *
 * @param {string} runId
 * @param {object} params
 * @param {string} params.targetUrl   - The live website URL
 * @param {string} [params.frdText]   - Raw FRD text (if pasted)
 * @param {Array}  [params.frdFiles]  - Uploaded FRD file metadata (for documentParserService)
 * @param {string} [params.projectId] - Local project ID for organizing
 */
async function runLiveSitePipeline(runId, params) {
    const { targetUrl, frdText, frdFiles, projectId } = params;

    setLlmRunContext(runId);

    let sendEvent;
    try {
        createRun(runId, {
            status: 'running',
            runType: 'live_site',
            targetUrl,
            localProjectId: projectId || null
        });
        sendEvent = createEventLogger(runId);
        sendEvent('init', { repoFullName: targetUrl });
    } catch (outer) {
        setLlmRunContext(null);
        throw outer;
    }

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

    let _sandboxPool = null;

    try {
        // Phase 1: Site Crawl
        sendEvent('phase_update', { phase: 'Site Crawl', status: 'running' });
        sendEvent('log', { level: 'INFO', message: `[Live Site] Crawling ${targetUrl}...` });

        let crawlResult;
        try {
            crawlResult = await crawlSiteForContext(targetUrl, { runId });
            sendEvent('log', { level: 'INFO', message: `[Live Site] Crawled ${crawlResult.pages.length} page(s)` });
        } catch (crawlErr) {
            sendEvent('log', { level: 'ERROR', message: `[Live Site] Crawl failed: ${crawlErr.message}` });
            crawlResult = { pages: [], baseUrl: targetUrl };
        }
        sendEvent('phase_update', { phase: 'Site Crawl', status: 'completed' });

        // Build consolidated site snapshot for LLM
        const siteSnapshot = crawlResult.pages
            .map(p => `=== PAGE: ${p.url} (${p.title}) ===\n${p.snapshot}`)
            .join('\n\n');

        // Phase 2: FRD Parse
        sendEvent('phase_update', { phase: 'FRD Parse', status: 'running' });
        let resolvedFrdText = frdText || '';
        if (frdFiles && frdFiles.length > 0) {
            try {
                const docTexts = await extractTextFromFiles(frdFiles);
                resolvedFrdText = docTexts.join('\n\n---\n\n');
                sendEvent('log', { level: 'INFO', message: `[Live Site] Parsed ${frdFiles.length} FRD document(s)` });
            } catch (parseErr) {
                sendEvent('log', { level: 'WARN', message: `[Live Site] FRD parse failed: ${parseErr.message}` });
            }
        }
        if (!resolvedFrdText.trim()) {
            sendEvent('log', { level: 'WARN', message: '[Live Site] No FRD text provided — generating exploratory scenarios from site structure only.' });
        }
        sendEvent('phase_update', { phase: 'FRD Parse', status: 'completed' });

        // Phase 3: Scenario Generation
        sendEvent('phase_update', { phase: 'Scenario Generation', status: 'running' });
        sendEvent('log', { level: 'INFO', message: '[Live Site] Generating test scenarios from FRD + site snapshot...' });

        const scenarioResult = await generateLiveSiteScenarios({
            frdText: resolvedFrdText,
            siteSnapshot,
            baseUrl: targetUrl
        });
        const scenarios = scenarioResult.scenarios || [];
        runSummary.scenarioCount = scenarios.length;
        emitSummary();

        sendEvent('log', { level: 'INFO', message: `[Live Site] Generated ${scenarios.length} scenario(s)` });
        sendEvent('phase_update', { phase: 'Scenario Generation', status: 'completed' });

        if (scenarios.length === 0) {
            sendEvent('log', { level: 'WARN', message: '[Live Site] No scenarios generated — nothing to test.' });
            sendEvent('complete', { success: true, passedCount: 0, failedCount: 0, testCaseCount: 0 });
            return;
        }

        // Phase 4 & 5: Test Generation + Sandbox Execution (pipelined)
        sendEvent('phase_update', { phase: 'Test Generation', status: 'running' });
        sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'running' });

        runSummary.scenariosGeneratingLeft = scenarios.length;
        emitSummary();

        // Start sandbox creation in parallel with test generation
        const sandboxTask = (async () => {
            sendEvent('phase_update', { phase: 'Sandbox Setup', status: 'running' });
            const pool = await createLiveSiteSandboxPool(runId, targetUrl, 2);
            sendEvent('log', { level: 'INFO', message: `[Sandbox] Created pool of ${pool.length} live-site containers` });
            sendEvent('phase_update', { phase: 'Sandbox Setup', status: 'completed' });
            return pool;
        })();

        const executionQueue = [];
        let isGenerationFinished = false;
        const scenarioResults = {};
        for (const s of scenarios) {
            scenarioResults[s.id] = { passed: 0, failed: 0 };
        }

        // Background executor — drains executionQueue using the sandbox pool
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
                            prUrl: targetUrl,
                            codeContextSection: '',
                            linkedProject: null,
                            refinementCandidates: [],
                            sendEvent,
                            runSummary,
                            scenarioDescription,
                            configuredTestAccounts: null
                        });

                        if (tcStatus === 'pass') {
                            scenarioResults[scenarioId].passed++;
                        } else {
                            scenarioResults[scenarioId].failed++;
                        }
                        emitSummary();

                        const { passed, failed } = scenarioResults[scenarioId];
                        sendEvent('scenario_execution_updated', {
                            scenarioId,
                            status: failed === 0 ? 'running' : 'partial',
                            totals: { passed, failed, running: 0 }
                        });
                    } finally {
                        availableContainers.push(container);
                        const idx = executing.indexOf(p);
                        if (idx !== -1) executing.splice(idx, 1);
                    }
                })();

                executing.push(p);
            }
        })();

        // Generate test cases for each scenario with bounded concurrency
        await mapPool(scenarios, LLM_GEN_MAX_CONCURRENT, async (scenario) => {
            try {
                const scenarioId = scenario.id;

                sendEvent('scenario_execution_updated', {
                    scenarioId,
                    status: 'generating',
                    totals: { passed: 0, failed: 0, running: 0 }
                });
                sendEvent('log', { level: 'INFO', message: `[Live Site] Generating tests for scenario: ${scenarioId} — ${scenario.title}` });

                let generated;
                try {
                    generated = await generateLiveSiteTestCases({
                        scenario,
                        siteSnapshot,
                        baseUrl: targetUrl
                    });
                } catch (genErr) {
                    scenarioResults[scenarioId].failed++;
                    sendEvent('log', { level: 'ERROR', message: `[Live Site] Test generation failed for ${scenarioId}: ${genErr.message}` });
                    sendEvent('scenario_execution_updated', { scenarioId, status: 'error', totals: { passed: 0, failed: 0, running: 0 } });
                    return;
                }

                const testCases = generated.testCases || [];
                normalizeTestCaseSteps(testCases);
                sendEvent('log', { level: 'INFO', message: `[Live Site] Generated ${testCases.length} test case(s) for ${scenarioId}` });

                if (testCases.length === 0) {
                    scenarioResults[scenarioId].failed++;
                    sendEvent('scenario_execution_updated', { scenarioId, status: 'fail', totals: { passed: 0, failed: 0, running: 0 } });
                    return;
                }

                runSummary.testCaseCount += testCases.length;
                runSummary.runningCount += testCases.length;
                emitSummary();

                for (const tc of testCases) {
                    const saved = {
                        testCaseId: tc.testCaseId || `TCN-${scenarioId}-${uuidv4().slice(0, 6)}`,
                        scenarioId,
                        projectKey: '',
                        runId,
                        prUrl: targetUrl,
                        title: tc.title || '',
                        steps: tc.steps || [],
                        testData: tc.testData || {},
                        testScript: tc.testScript || '',
                        language: tc.language || 'javascript',
                        status: 'pending',
                        version: 1,
                        previousVersionId: null,
                        codeFiles: [],
                        healAttempts: 0,
                        conversationId: null,
                        latestResponseId: generated.interactionId || null,
                        generationInteractionId: generated.interactionId || null,
                        createdAt: new Date().toISOString(),
                        schema_version: CURRENT_SCHEMA_VERSION
                    };
                    upsertTestCase(saved);
                    executionQueue.push({
                        scenarioId,
                        scenarioDescription: scenario.description || '',
                        tc: saved
                    });
                }
            } finally {
                runSummary.scenariosGeneratingLeft = Math.max(0, runSummary.scenariosGeneratingLeft - 1);
                emitSummary();
            }
        });

        isGenerationFinished = true;
        sendEvent('phase_update', { phase: 'Test Generation', status: 'completed' });

        // Wait for all executions to finish
        await executionTaskPromise;

        // Finalize scenario statuses
        let overallSuccess = true;
        for (const scenario of scenarios) {
            const { passed, failed } = scenarioResults[scenario.id];
            const status = failed === 0 && passed > 0 ? 'pass'
                : passed === 0 ? 'fail' : 'partial';

            if (failed > 0 || passed === 0) overallSuccess = false;

            sendEvent('scenario_execution_updated', {
                scenarioId: scenario.id,
                status,
                totals: { passed, failed, running: 0 }
            });
        }

        sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'completed' });
        sendEvent('phase_update', {
            phase: 'Test Healing',
            status: 'completed',
            skipped: runSummary.retryCount === 0
        });
        sendEvent('phase_update', { phase: 'Pass', status: overallSuccess ? 'completed' : 'failed' });

        emitSummary();
        if (_sandboxPool) cleanupSandboxPool(runId, _sandboxPool);

        sendEvent('complete', {
            success: overallSuccess,
            passedCount: runSummary.passedCount,
            failedCount: runSummary.failedCount,
            testCaseCount: runSummary.passedCount + runSummary.failedCount
        });

    } catch (error) {
        console.error('\n================ LIVE SITE PIPELINE CRASHED =================');
        console.error(error);

        sendEvent('phase_update', { phase: 'Test Generation', status: 'error' });
        sendEvent('log', { level: 'ERROR', message: `Fatal Error: ${error.message}` });
        sendEvent('error', { message: error.message });
        sendEvent('complete', {
            success: false,
            passedCount: runSummary.passedCount,
            failedCount: runSummary.failedCount,
            testCaseCount: runSummary.passedCount + runSummary.failedCount
        });
        if (_sandboxPool) cleanupSandboxPool(runId, _sandboxPool);
    } finally {
        setLlmRunContext(null);
    }
}

module.exports = { runLiveSitePipeline };
