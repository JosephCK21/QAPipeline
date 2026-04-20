const { fetchIssue, fetchChildStoriesForEpic, postScenarioComment } = require('./services/jiraService');
const { getDocsForProject } = require('./services/documentAssociationStore');
const { extractTextFromFiles } = require('./services/documentParserService');
const { generateTestScenarios, generateTestScenariosForEpic } = require('./services/llmService');
const { upsertScenario, markScenariosObsolete, updateRun, createRun, computeStoryHash, upsertStorySyncRecord } = require('./db');
const { getProjectById } = require('./services/projectStore');

const TYPE_MAP = {
    happy_path: 'Happy Path',
    positive:   'Happy Path',
    edge_case:  'Edge Case',
    negative:   'Negative',
    boundary:   'Boundary'
};

function normalizeScenarioType(raw) {
    const key = String(raw || '').toLowerCase().replace(/[\s-]+/g, '_');
    return TYPE_MAP[key] || String(raw || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Persist per-story scenarios and post Jira comment after generation
async function processStoryScenarios(story, rawScenarios, epicId, projectData, generatedScenarios, activeScenarioIds) {
    const scenariosForJiraComment = [];
    for (const scenario of rawScenarios) {
        const scenarioData = {
            ...scenario,
            scenarioId: scenario.scenarioId || 'SCN-' + story.key + '-' + Math.random().toString(36).substring(7),
            type: normalizeScenarioType(scenario.type),
            projectKey: projectData.jiraProjectKey,
            status: 'pending',
            lastPRTested: null,
            testScriptRef: null,
            healAttempts: 0,
            lastRunDate: null,
            createdAt: new Date().toISOString()
        };
        upsertScenario(scenarioData);
        generatedScenarios.push(scenarioData);
        activeScenarioIds.push(scenarioData.scenarioId);
        scenariosForJiraComment.push(scenarioData);
    }

    await postScenarioComment(story.key, scenariosForJiraComment);

    // Guard: only write sync record if the project still exists (prevents stale
    // entries when a project is deleted while the async pipeline is still running)
    if (getProjectById(projectData.projectId)) {
        upsertStorySyncRecord({
            storyKey: story.key,
            localProjectId: projectData.projectId,
            projectKey: projectData.jiraProjectKey,
            epicKey: epicId || null,
            summary: story.summary || '',
            description: story.description || '',
            acceptanceCriteria: story.acceptanceCriteria || '',
            contentHash: computeStoryHash(story),
            lastSyncedAt: new Date().toISOString()
        });
    } else {
        console.warn(`[Jira Pipeline] Project ${projectData.projectId} was deleted before sync record could be written for ${story.key}. Skipping.`);
    }
}

async function runJiraPipeline(runId, issueKey, projectData) {
    createRun(runId, { repoFullName: projectData.githubRepoFullName, status: 'running', localProjectId: projectData.projectId });
    
    try {
        const docs = getDocsForProject(projectData.projectId);
        const localDocsText = await extractTextFromFiles(docs);
        
        const generatedScenarios = [];
        const activeScenarioIds = [];
        let storiesToProcess = [];
        let epicContext = { summary: 'N/A' };
        let epicId = null;

        const isBatchJob = Array.isArray(projectData.storyKeys) && projectData.storyKeys.length > 0;

        if (isBatchJob) {
            // Batch mode: issueKey is the epic key, storyKeys lists the stories to process
            epicId = issueKey;
            epicContext = await fetchIssue(issueKey);
            const allChildren = await fetchChildStoriesForEpic(issueKey);
            // Only process the stories that were identified as new/changed
            const storyKeySet = new Set(projectData.storyKeys);
            storiesToProcess = allChildren.filter(s => storyKeySet.has(s.key));

            if (storiesToProcess.length === 0) {
                console.warn(`[Jira Pipeline] Batch job for epic ${issueKey}: none of the expected story keys found among children.`);
            } else {
                updateRun(runId, { logs: [{ timestamp: new Date().toISOString(), level: 'INFO', message: `Batch generating scenarios for epic ${issueKey} — ${storiesToProcess.length} stories` }] });
                const allScenarios = await generateTestScenariosForEpic(epicContext, storiesToProcess, localDocsText);

                for (const story of storiesToProcess) {
                    const storyScenarios = allScenarios.filter(sc => sc.storyId === story.key);
                    await processStoryScenarios(story, storyScenarios, epicId, projectData, generatedScenarios, activeScenarioIds);
                }
            }
        } else {
            // Single-story or explicit epic mode (unchanged behaviour for webhook-triggered jobs)
            const issue = await fetchIssue(issueKey);
            const isEpic = String(issue.issueType || '').toLowerCase() === 'epic';

            if (isEpic) {
                epicContext = issue;
                epicId = issueKey;
                storiesToProcess = await fetchChildStoriesForEpic(issueKey);
            } else {
                storiesToProcess = [issue];
                epicId = issue.parentKey || null;
                if (epicId) {
                    try {
                        epicContext = await fetchIssue(epicId);
                    } catch (e) {
                        console.warn(`[Jira Pipeline] Failed to fetch parent epic context for ${issueKey}: ${e.message}`);
                    }
                } else {
                    epicContext = { summary: 'No Parent Epic Found' };
                }
            }

            for (const story of storiesToProcess) {
                updateRun(runId, { logs: [{ timestamp: new Date().toISOString(), level: 'INFO', message: 'Generating scenarios for story ' + story.key }] });
                const scenarios = await generateTestScenarios(story, epicContext, localDocsText);
                await processStoryScenarios(story, scenarios, epicId, projectData, generatedScenarios, activeScenarioIds);
            }

            // If an explicit epic was processed, mark disappeared scenarios obsolete
            if (isEpic) {
                markScenariosObsolete(projectData.jiraProjectKey, epicId, activeScenarioIds);
            }
        }

        updateRun(runId, { status: 'completed', completedAt: new Date().toISOString() });
        
        if (global.io) {
            global.io.emit('jira_scenarios_generated', {
                epicId: epicId || null,
                stories: storiesToProcess.map(s => ({
                    storyId: s.key,
                    scenarios: generatedScenarios.filter(sc => sc.storyId === s.key)
                }))
            });
            global.io.emit('refresh_data');
        }
    } catch (err) {
        console.error('[Jira Pipeline] Failed:', err.message);
        updateRun(runId, { status: 'failed', completedAt: new Date().toISOString(), logs: [{ timestamp: new Date().toISOString(), level: 'ERROR', message: err.message }] });
        if (global.io) global.io.emit('refresh_data');
    }
}

module.exports = {
    runJiraPipeline
};
