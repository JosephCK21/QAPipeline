const { fetchPRDetails, fetchFullFileContents, inferTestFilePaths, fetchPRDependencies } = require('./services/githubService');
const {
    preparePrGitWorkspace,
    readFilesFromWorkspace,
    readDepsFromWorkspace
} = require('./services/prGitWorkspace');
const { cleanupSandboxPool, createSandboxPool } = require('./services/sandboxService');
const { findProjectByGithubRepo } = require('./services/projectStore');
const { readSandboxEnv } = require('./services/sandboxEnvStore');
const { getDefaultTestAccountsForPipeline } = require('./services/defaultTestAccountsStore');
const { getDocsForProject } = require('./services/documentAssociationStore');
const { extractTextFromFiles } = require('./services/documentParserService');
const { mapPrChangesToScenarios } = require('./services/prScenarioMappingService');
const { classifyPrAsBugFix } = require('./services/prClassificationService');
const { pruneFileContentForContext } = require('./services/astPrunerService');
const { generateTestCasesForScenario, setLlmRunContext } = require('./services/llmService');
const { CURRENT_SCHEMA_VERSION } = require('./schemas');
const {
    MAX_HEAL_ATTEMPTS, mapPool, buildGenerationSummaryEntry,
    createEventLogger, executeWithPool, executeTestCaseWithRetries
} = require('./pipelineHelpers');

const fssync = require('fs');
const {
    createRun, getScenariosByProject,
    getTestCasesByProject, getTestCasesByScenario, markTestCaseSuperseded,
    upsertTestCase,
    incrementScenarioMappingStats
} = require('./db');

/** Max concurrent OpenAI test-case generation calls per run (improves prompt-cache routing vs unbounded fan-out). */
const LLM_GEN_MAX_CONCURRENT = Math.max(1, parseInt(process.env.AUTOQA_LLM_MAX_CONCURRENT_GENERATION || '4', 10) || 4);

/** Recent completed scenarios passed as alreadyGeneratedSummary (0 = disable). */
const LLM_ALREADY_GENERATED_MAX = Math.max(0, parseInt(process.env.AUTOQA_LLM_ALREADY_GENERATED_MAX_ENTRIES || '12', 10) || 12);

// ---------------------------------------------------------------------------
// PR file classification
// ---------------------------------------------------------------------------
function shouldSkipFileForFallback(filename) {
    const n = String(filename || '').replace(/\\/g, '/');
    if (!n.trim()) return true;
    const lower = n.toLowerCase();
    const ext = lower.includes('.') ? lower.slice(lower.lastIndexOf('.')) : '';
    const skipExts = new Set(['.md', '.json', '.lock', '.yaml', '.yml', '.env', '.gitignore', '.css', '.scss', '.svg', '.png', '.jpg', '.jpeg', '.ico']);
    if (skipExts.has(ext) || lower.endsWith('.gitignore')) return true;
    if (lower.endsWith('.d.ts')) return true;
    if (lower.endsWith('.config.js') || lower.endsWith('.config.ts') || lower.endsWith('.config.cjs')) return true;
    const skipPathBits = ['/node_modules/', '/__tests__/', '/test/', '/spec/', '/dist/', '/build/', '/migrations/', '/devscripts/'];
    if (skipPathBits.some(b => lower.includes(b))) return true;
    return false;
}

function isFrontendPathForFallback(filename) {
    const n = String(filename || '').replace(/\\/g, '/');
    const lower = n.toLowerCase();
    if (/\.(jsx|tsx|vue|svelte)$/i.test(lower)) return true;
    if (/\/src\/(components|pages|views|screens|ui)\//i.test(n)) return true;
    const inClientArea = /\/(frontend|client|web)\//i.test(lower) && !lower.includes('/node_modules/');
    if (inClientArea) return true;
    return false;
}

function isBackendPathForFallback(filename) {
    const n = String(filename || '').replace(/\\/g, '/');
    const lower = n.toLowerCase();
    if (/\.(js|ts)$/i.test(lower) && !lower.endsWith('.d.ts')) return true;
    if (/\/(api|routes|services|controllers|middleware|backend)\//i.test(lower)) return true;
    return false;
}

/**
 * GitHub PR file list → entries with fileType backend|frontend; non-code paths dropped.
 * @param {Array<{ filename: string, patch?: string }>} prFiles
 */
function classifyChangedFiles(prFiles) {
    const out = [];
    for (const f of prFiles || []) {
        const filename = f.filename;
        if (!filename || shouldSkipFileForFallback(filename)) continue;
        let fileType = null;
        if (isFrontendPathForFallback(filename)) fileType = 'frontend';
        else if (isBackendPathForFallback(filename)) fileType = 'backend';
        else continue;
        out.push({
            filename,
            patch: typeof f.patch === 'string' ? f.patch : '',
            fileType
        });
    }
    return out;
}


// ---------------------------------------------------------------------------
// PR scenario mapping (unchanged from previous version)
// ---------------------------------------------------------------------------
/**
 * Runs PR scenario mapping using optional pre-built prDetails from a git workspace (REST-sparing).
 * @param {{ bootstrapPrDetails?: object | null }} [opts]
 */
async function attachPrScenarioMapping(runId, prUrl, repoFullName, sendEvent, opts = {}) {
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
        const seeded = opts.bootstrapPrDetails || null;
        const prDetailsLoader = seeded ? Promise.resolve(seeded) : fetchPRDetails(prUrl);
        const [prDetails, documentTexts] = await Promise.all([
            prDetailsLoader.then((p) => {
                const d = p && typeof p === 'object' ? p : {};
                if (!d._prUrl) d._prUrl = prUrl;
                return d;
            }),
            extractTextFromFiles(docs)
        ]);
        sendEvent('log', { level: 'INFO', message: `PR mapping: fetched PR with ${prDetails?.files?.length || 0} changed file(s): ${(prDetails?.files || []).map(f => f.filename).join(', ')}` });
        sendEvent('pr_details', prDetails);
        sendEvent('log', { level: 'INFO', message: `PR mapping: ${documentTexts?.length || 0} project document(s) loaded` });

        const jiraRtmEntry = { scenarios: projectScenarios };

        const mapping = await mapPrChangesToScenarios({ prDetails, jiraRtmEntry, documentTexts });
        sendEvent('pr_scenario_mapping', { mappings: mapping.mappings });
        sendEvent('log', { level: 'INFO', message: `PR mapping complete: ${mapping.mappings?.length || 0} scenario links found.` });

        try {
            const pk = linkedProject.jiraProjectKey || linkedProject.id;
            const mappedIds = (mapping.mappings || []).map((m) => m.scenarioId || m.id).filter(Boolean);
            const allIds = projectScenarios.map((s) => s.scenarioId).filter(Boolean);
            incrementScenarioMappingStats(pk, allIds, mappedIds);
        } catch (mapStatErr) {
            sendEvent('log', { level: 'WARN', message: `PR mapping stats update skipped: ${mapStatErr.message}` });
        }

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

    if (prDetails._workspaceRoot && fssync.existsSync(prDetails._workspaceRoot)) {
        const [fullFiles, testFiles, dependencies] = await Promise.all([
            readFilesFromWorkspace(prDetails._workspaceRoot, changedPaths),
            readFilesFromWorkspace(prDetails._workspaceRoot, inferTestFilePaths(changedPaths), { quiet: true })
                .then(r => r.filter(f => !f.content.startsWith('// Could not fetch'))),
            readDepsFromWorkspace(prDetails._workspaceRoot).catch(() => 'Not available')
        ]);
        return { fullFiles, testFiles, dependencies };
    }

    const [fullFiles, testFiles, dependencies] = await Promise.all([
        fetchFullFileContents(owner, repo, ref, changedPaths),
        fetchFullFileContents(owner, repo, ref, inferTestFilePaths(changedPaths), { quiet: true })
            .then(r => r.filter(f => !f.content.startsWith('// Could not fetch'))),
        fetchPRDependencies(`https://github.com/${owner}/${repo}/pull/${(prDetails._prUrl || '').split('/').pop() || '1'}`, {
            workspaceRoot: prDetails._workspaceRoot
        })
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
    codeContextSection, sandboxPool, sendEvent, runSummary,
    configuredTestAccounts = null
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
            scenarioDescription: scenario.description || '',
            configuredTestAccounts
        });

        if (tcStatus === 'pass') {
            scenarioResults[scenario.scenarioId].passed++;
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

    const overallSuccess = scenarioPlans.every((p) => {
        const r = scenarioResults[p.scenario.scenarioId];
        return r && r.failed === 0 && r.passed > 0;
    });

    return { success: overallSuccess, scenarios: scenarioPlans.map((p) => p.scenario.scenarioId) };
}

// ---------------------------------------------------------------------------
// Main pipeline entry point
// ---------------------------------------------------------------------------

async function runPipeline(runId, prUrl, repoFullName) {
    setLlmRunContext(runId);

    let sendEvent;
    try {
        try {
            const linkedProjectEarly = findProjectByGithubRepo(repoFullName);
            const localEarly = linkedProjectEarly?.id || null;
            createRun(runId, { status: 'running', repoFullName, localProjectId: localEarly, prUrl });
        } catch (createErr) {
            if (createErr && createErr.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                console.warn('[Pipeline] Duplicate active run for same PR skipped:', prUrl);
                setLlmRunContext(null);
                return;
            }
            throw createErr;
        }

        sendEvent = createEventLogger(runId);
        sendEvent('init', { repoFullName });
    } catch (outer) {
        setLlmRunContext(null);
        throw outer;
    }

    const linkedProject = findProjectByGithubRepo(repoFullName);
    const localProjectId = linkedProject?.id || null;
    const configuredTestAccounts = localProjectId ? getDefaultTestAccountsForPipeline(localProjectId) : null;

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

    // Declared here so the catch/finally block can always clean up the pool and PR workspace.
    let _sandboxPool = null;
    let _prWsCleanup = null;

    try {
        // Phase 1: Initializing
        sendEvent('phase_update', { phase: 'Initializing', status: 'running' });
        sendEvent('phase_update', { phase: 'Initializing', status: 'completed' });

        // Phase 2: PR Mapping — optional git-first workspace (suppresses REST listFiles + per-file pulls)
        sendEvent('phase_update', { phase: 'PR Mapping', status: 'running' });

        const useRestFiles = /^1|true|yes$/i.test(String(process.env.AUTOQA_PR_USE_REST_FILES || '').trim());
        let bootstrapPrDetails = null;
        if (!useRestFiles) {
            sendEvent('log', {
                level: 'INFO',
                message: '[PR ingest] Git-first mode: materializing PR via local git checkout (mapping/context skip REST listFiles getContent/raw).'
            });
            try {
                const { prDetails: wsDetails, cleanup } = await preparePrGitWorkspace(runId, prUrl);
                bootstrapPrDetails = wsDetails;
                _prWsCleanup = cleanup;
                sendEvent('log', {
                    level: 'INFO',
                    message: `[PR ingest] Git workspace ready: ${wsDetails.files?.length || 0} changed file(s) at ${wsDetails._workspaceRoot}`
                });
            } catch (wsErr) {
                sendEvent('log', {
                    level: 'WARN',
                    message: `[PR ingest] Git workspace failed (${wsErr.message}); falling back to REST file listing.`
                });
            }
        } else {
            sendEvent('log', {
                level: 'INFO',
                message: '[PR ingest] AUTOQA_PR_USE_REST_FILES set — legacy REST listFiles + raw fetches for PR files.'
            });
        }

        const prMapping = await attachPrScenarioMapping(runId, prUrl, repoFullName, sendEvent, {
            bootstrapPrDetails
        });
        sendEvent('phase_update', { phase: 'PR Mapping', status: 'completed' });

        const mappedScenarios = prMapping?.mappings || [];
        const hasMappedScenarios = mappedScenarios.length > 0;
        runSummary.scenarioCount = mappedScenarios.length;
        emitSummary();

        let prDetails = prMapping?._prDetails || bootstrapPrDetails || null;
        if (!prDetails) {
            prDetails = await fetchPRDetails(prUrl);
        }
        if (prDetails && typeof prDetails === 'object' && !prDetails._prUrl) {
            prDetails._prUrl = prUrl;
        }

        const classifiedAll = classifyChangedFiles(prDetails.files || []);
        const coveredFilenames = new Set(
            mappedScenarios.flatMap((m) =>
                (Array.isArray(m.impactedFiles) ? m.impactedFiles : [])
                    .map((x) => String(x || '').trim())
                    .filter(Boolean)
            )
        );

        if (!hasMappedScenarios) {
            const reason = classifiedAll.length === 0
                ? 'No scenarios mapped and no testable PR files — nothing to run.'
                : `No scenarios mapped (0/${mappedScenarios.length}) despite ${classifiedAll.length} testable file(s). The mapping LLM could not link PR changes to any known scenario. Verify scenario descriptions cover the changed functionality, or reduce PR scope.`;
            sendEvent('log', { level: 'WARN', message: reason });
            sendEvent('phase_update', { phase: 'Test Generation', status: 'skipped' });
            sendEvent('phase_update', { phase: 'Sandbox Testing', status: 'skipped' });
            sendEvent('complete', {
                success: true,
                passedCount: runSummary.passedCount,
                failedCount: runSummary.failedCount,
                testCaseCount: runSummary.passedCount + runSummary.failedCount
            });
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
        sendEvent('log', {
            level: 'INFO',
            message: `[Enrichment] Resolved ${enrichedCount}/${mappedScenarios.length} mapped scenario(s) against RTM rows (project "${rtmProjectKey || 'n/a'}").`
        });

        // Phase 2.5 + 3 + Sandbox — run in parallel.
        // Classification, code context fetch, and sandbox creation are all
        // independent and only need prDetails. Running them concurrently
        // saves 15-30 seconds per run (Docker clone + npm install overlaps
        // with LLM classification + GitHub file fetches).
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
            const sandboxEnvForRun = localProjectId ? readSandboxEnv(localProjectId) : {};
            const pool = await createSandboxPool(runId, prDetails, 2, { sandboxEnv: sandboxEnvForRun });
            sendEvent('log', { level: 'INFO', message: `[Sandbox] Created pool of ${pool.length} containers` });
            sendEvent('phase_update', { phase: 'Sandbox Setup', status: 'completed' });
            return pool;
        })();

        // Wait for classification and context. Do NOT wait for sandbox setup here!
        const [classification, codeContext] = await Promise.all([
            classifyTask, codeContextTask
        ]);

        // Build single concatenated context string for LLM prompts (prune very large files for token budget)
        const codeContextSection = [
            ...(codeContext.fullFiles || []).map(f => {
                const text = pruneFileContentForContext(f.path, f.content, {
                    onPrune: p => sendEvent('log', { level: 'DEBUG', message: `[Code context] Pruned large file body for tokens: ${p}` })
                });
                return `=== FILE: ${f.path} ===\n${text}`;
            }),
            ...(codeContext.testFiles || []).map(f => {
                const text = pruneFileContentForContext(f.path, f.content, {
                    onPrune: p => sendEvent('log', { level: 'DEBUG', message: `[Code context] Pruned large file body for tokens: ${p}` })
                });
                return `=== EXISTING TEST: ${f.path} ===\n${text}`;
            })
        ].join('\n\n');

        const NON_CODE_EXTS_DIFF = new Set(['.md', '.txt', '.rst', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.lock', '.log', '.webm', '.mp4', '.zip']);
        const codeContextPaths = new Set((codeContext.fullFiles || []).map(f => f.path));
        const prDiffSection = (prDetails.files || [])
            .filter(f => {
                const ext = f.filename.includes('.') ? '.' + f.filename.split('.').pop().toLowerCase() : '';
                return !NON_CODE_EXTS_DIFF.has(ext);
            })
            .filter(f => !codeContextPaths.has(f.filename))
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
        // cases for every scenario in every epic the PR touches. Skip mapped
        // scenario generation.
        // ------------------------------------------------------------------
        if (regressionFeatureEnabled && classification.isBugFix && mappedScenarios.length > 0) {
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
                runSummary,
                configuredTestAccounts
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
            sendEvent('complete', {
                success: overallSuccess,
                passedCount: runSummary.passedCount,
                failedCount: runSummary.failedCount,
                testCaseCount: runSummary.passedCount + runSummary.failedCount
            });
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
                            scenarioDescription,
                            configuredTestAccounts
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
                            status: failed === 0 ? 'running' : 'partial', // Interim status
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

        // Test-case LLM generation: bounded concurrency + sliding-window summary for dedupe hints
        const generationSummary = [];
        sendEvent('log', {
            level: 'INFO',
            message: `Test-case LLM pool: max ${LLM_GEN_MAX_CONCURRENT} concurrent; already-covered hint window=${LLM_ALREADY_GENERATED_MAX}`
        });

        const generatedResults = (await mapPool(
            mappedScenarios,
            LLM_GEN_MAX_CONCURRENT,
            async (scenarioMapping) => {
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

            const alreadyGeneratedSummary =
                LLM_ALREADY_GENERATED_MAX > 0
                    ? generationSummary.slice(-LLM_ALREADY_GENERATED_MAX)
                    : [];

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
                    alreadyGeneratedSummary,
                    conversationId: priorConversationId,
                    previousInteractionId: priorResponseId,
                    configuredTestAccounts
                });
                generatedTestCases = genResult.testCases;
                generationInteractionId = genResult.interactionId;
                scenarioConversationId = genResult.conversationId || scenarioConversationId;
                sendEvent('log', { level: 'INFO', message: `[Generation] conversation=${scenarioConversationId || 'n/a'} response=${generationInteractionId || 'unavailable'} (stateful chain anchors)` });
            } catch (genErr) {
                scenarioResults[scenarioId].failed++;
                sendEvent('log', { level: 'ERROR', message: `Test case generation failed for ${scenarioId}: ${genErr.message}` });
                sendEvent('scenario_execution_updated', { scenarioId, status: 'error', totals: { passed: 0, failed: 0, running: 0 } });
                return null;
            }

            sendEvent('log', { level: 'INFO', message: `Generated ${generatedTestCases.length} test case(s) for ${scenarioId}` });

            if (generatedTestCases.length > 0) {
                generationSummary.push(
                    buildGenerationSummaryEntry(scenarioId, scenarioTitle, scenarioType, generatedTestCases)
                );
            }

            if (generatedTestCases.length === 0) {
                scenarioResults[scenarioId].failed++;
                sendEvent('log', { level: 'WARN', message: `[Generation] Scenario ${scenarioId}: model returned zero test cases — counted as failure for run success rollup.` });
                sendEvent('scenario_execution_updated', { scenarioId, status: 'fail', totals: { passed: 0, failed: 0, running: 0 } });
                return { scenarioId, persistedCases: [], scenarioDescription };
            }
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
                    createdAt:               new Date().toISOString(),
                    schema_version:          CURRENT_SCHEMA_VERSION
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
            }
        )).filter(Boolean);

        // Signal that no more test cases will be queued
        isGenerationFinished = true;
        sendEvent('phase_update', { phase: 'Test Generation', status: 'completed' });

        // Wait for the background executor to finish the remaining queue and all active executions
        await executionTaskPromise;

        const scenarioRollupOk = mappedScenarios.every((m) => {
            const sid = m.id || m.scenarioId;
            const r = scenarioResults[sid];
            return r && r.failed === 0 && r.passed > 0;
        });

        overallSuccess = scenarioRollupOk;

        // Finalize statuses for Phase 5
        for (const m of mappedScenarios) {
            const scenarioId = m.id || m.scenarioId;
            const { passed, failed } = scenarioResults[scenarioId];
            const scenarioStatus = failed === 0 && passed > 0 ? 'pass'
                : passed === 0 ? 'fail'
                : 'partial';

            sendEvent('scenario_execution_updated', {
                scenarioId,
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
        sendEvent('complete', {
            success: overallSuccess,
            passedCount: runSummary.passedCount,
            failedCount: runSummary.failedCount,
            testCaseCount: runSummary.passedCount + runSummary.failedCount
        });

    } catch (error) {
        console.error('\n================ PIPELINE CRASHED =================');
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
        if (_sandboxPool) {
            cleanupSandboxPool(runId, _sandboxPool);
        }
    } finally {
        try {
            if (typeof _prWsCleanup === 'function') {
                await _prWsCleanup();
            }
        } catch (cleanupErr) {
            console.warn('[Pipeline] PR workspace cleanup failed:', cleanupErr.message);
        }
        setLlmRunContext(null);
    }
}

module.exports = { runPipeline };
