require('dotenv').config();
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { runJiraPipeline } = require('./jiraPipeline');
const { deleteProjectData, initDb, publishToDLQ, getDLQEvents, upsertScenario, getScenariosByProject, markScenariosObsolete, createRun, updateRun, getRun, listRuns, computeStoryHash, getStorySyncRecord, upsertStorySyncRecord, getStorySyncRecordsByProject, getTestCasesByScenario } = require('./db');
const { githubWebhookSchema, jiraWebhookSchema, projectCreateSchema, validateBody } = require('./schemas');

initDb();

const { deleteAllDocsForProject, addDocToProject, getDocsForProject, removeDocFromProject } = require('./services/documentAssociationStore');
const { getJiraHealth, fetchJiraSpaces, fetchChildStoriesForEpic, fetchReadyIssues } = require('./services/jiraService');
const {
    setJiraWebhookJobProcessor,
    enqueueJiraWebhookJob,
    getJiraWebhookQueueStatus
} = require('./services/jiraWebhookQueueService');
const {
    deleteProject,
    listProjects,
    getProjectById,
    createProject,
    linkJiraSpace,
    linkGithubRepo,
    findProjectByGithubRepo,
    findProjectByJiraProjectKey
} = require('./services/projectStore');

// Storage for uploaded requirements
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'uploads', 'requirements');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        // Sanitizing the filename heavily
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

const jiraDocStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadPath = path.join(__dirname, 'uploads', 'jira-docs');
        if (!fs.existsSync(uploadPath)) {
            fs.mkdirSync(uploadPath, { recursive: true });
        }
        cb(null, uploadPath);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname);
    }
});
const jiraDocUpload = multer({ storage: jiraDocStorage });

const requirementsMapPath = path.join(__dirname, 'data', 'requirementsMap.json');
function getRequirementsMap() {
    if (!fs.existsSync(requirementsMapPath)) return {};
    try {
        let content = fs.readFileSync(requirementsMapPath, 'utf8');
        // Strip BOM if present
        let cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
        cleanContent = cleanContent.replace(/\0/g, '').trim() || '{}';
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error('Failed to parse requirementsMap.json. Resetting map.', e);
        return {};
    }
}
function saveRequirementsMap(map) {
    fs.writeFileSync(requirementsMapPath, JSON.stringify(map, null, 2), 'utf8');
}

const rtmBaselinesPath = path.join(__dirname, 'data', 'rtm_baselines.json');
function getRTMBaselines() {
    if (!fs.existsSync(rtmBaselinesPath)) return {};
    try {
        let content = fs.readFileSync(rtmBaselinesPath, 'utf8');
        let cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
        cleanContent = cleanContent.replace(/\0/g, '').trim() || '{}';
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error('Failed to parse rtm_baselines.json. Resetting map.', e);
        return {};
    }
}
function saveRTMBaselines(map) {
    fs.writeFileSync(rtmBaselinesPath, JSON.stringify(map, null, 2), 'utf8');
}

const http = require('http');
const { Server } = require('socket.io');
const SmeeClient = require('smee-client');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });
global.io = io; // Make available to pipeline.js

app.use(cors());
app.use(express.json({
    verify: (req, res, buf) => {
        req.rawBody = buf;
    }
}));

const PORT = process.env.PORT || 3001;

const REQUIRED_JIRA_ENV_VARS = [
    'JIRA_BASE_URL',
    'JIRA_USER_EMAIL',
    'JIRA_API_TOKEN',
    'JIRA_PROJECT_KEY',
    'JIRA_TRIGGER_STATUS'
];

const jiraWebhookState = {
    endpoint: '/api/webhooks/jira',
    lastTriggeredAt: null,
    lastIssueKey: null,
    lastRunId: null,
    lastAccepted: false,
    lastIgnoredReason: null,
    lastError: null
};

function warnMissingJiraEnvVars() {
    const missing = REQUIRED_JIRA_ENV_VARS.filter((key) => !process.env[key] || !String(process.env[key]).trim());
    if (missing.length === 0) return;

    console.warn('\n[Jira Config] Missing environment variables (Jira pipeline will be disabled until set):');
    missing.forEach((key) => console.warn(`  - ${key}`));
    console.warn('[Jira Config] Add them to code/backend/.env and restart the backend.\n');
}

setJiraWebhookJobProcessor(async (job) => {
    const runId = uuidv4();

    jiraWebhookState.lastTriggeredAt = new Date().toISOString();
    jiraWebhookState.lastAccepted = true;
    jiraWebhookState.lastRunId = runId;
    jiraWebhookState.lastIssueKey = job.issueKey;
    jiraWebhookState.lastError = null;
    jiraWebhookState.lastIgnoredReason = null;

    if (global.io) {
        global.io.emit('jira_story_triggered', {
            runId,
            issueKey: job.issueKey,
            localProjectId: job.projectId,
            localProjectName: job.projectName || ''
        });
        global.io.emit('refresh_data');
    }

    await runJiraPipeline(runId, job.issueKey, {
        projectId: job.projectId,
        projectName: job.projectName || '',
        jiraProjectKey: job.jiraProjectKey || '',
        githubRepoFullName: job.githubRepoFullName || '',
        storyKeys: job.storyKeys || null
    });
});

app.get('/api/projects', (req, res) => {
    try {
        const projects = listProjects();
        res.json(projects);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/projects', validateBody(projectCreateSchema), (req, res) => {
    try {
        const project = createProject(req.body?.projectKey || req.body?.name);
        if (global.io) global.io.emit('refresh_data');
        res.status(201).json(project);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/projects/:projectId', (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        res.json(project);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:projectId', (req, res) => {
    try {
        const { projectId } = req.params;
        const deletedProject = deleteProject(projectId);
        
        if (!deletedProject) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // 1. Delete associated docs physical files and store entry
        deleteAllDocsForProject(projectId);

        // 2. Delete database records (SQL)
        deleteProjectData(deletedProject.jiraProjectKey, deletedProject.githubRepoFullName, projectId);

        // 3. Cleanup local JSON stores
        if (deletedProject.githubRepoFullName) {
            const reqMap = getRequirementsMap();
            const repo = deletedProject.githubRepoFullName;
            if (reqMap[repo]) {
                if (fs.existsSync(reqMap[repo].path)) {
                    try { fs.unlinkSync(reqMap[repo].path); } catch(e) {}
                }
                delete reqMap[repo];
                saveRequirementsMap(reqMap);
            }
            
            const rtmMap = getRTMBaselines();
            if (rtmMap[repo]) {
                delete rtmMap[repo];
                saveRTMBaselines(rtmMap);
            }
        }

        if (global.io) global.io.emit('refresh_data');
        res.status(200).json({ success: true, deletedProject });
    } catch (error) {
        console.error('[Delete Project] Failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/projects/:projectId/jira-link', (req, res) => {
    try {
        const project = linkJiraSpace(
            req.params.projectId,
            req.body?.jiraProjectKey,
            req.body?.jiraProjectName
        );
        if (global.io) global.io.emit('refresh_data');
        res.json(project);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.post('/api/projects/:projectId/sync-jira', async (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.jiraProjectKey) return res.status(400).json({ error: 'No Jira space linked' });

        const targetStatus = String(process.env.JIRA_TRIGGER_STATUS || 'Selected for Development').trim();
        const issues = await fetchReadyIssues(project.jiraProjectKey, targetStatus);
        
        let queuedCount = 0;
        let skippedCount = 0;

        // Filter to only new/changed stories
        const changedIssues = [];
        for (const issue of issues) {
            const currentHash = computeStoryHash(issue);
            const existing = getStorySyncRecord(issue.key, project.id);
            if (existing && existing.contentHash === currentHash) {
                skippedCount++;
            } else {
                changedIssues.push(issue);
            }
        }

        // Group changed stories by parent epic key; orphans (no parent) get individual jobs
        const epicGroups = new Map();
        const orphanIssues = [];
        for (const issue of changedIssues) {
            if (issue.parentKey) {
                const group = epicGroups.get(issue.parentKey) || [];
                group.push(issue);
                epicGroups.set(issue.parentKey, group);
            } else {
                orphanIssues.push(issue);
            }
        }

        const ts = new Date().toISOString();

        // Enqueue one batch job per epic group
        for (const [epicKey, epicStories] of epicGroups.entries()) {
            const result = enqueueJiraWebhookJob({
                projectId: project.id,
                projectName: project.name,
                issueKey: epicKey,
                storyKeys: epicStories.map(s => s.key),
                jiraProjectKey: project.jiraProjectKey,
                githubRepoFullName: project.githubRepoFullName || '',
                source: 'api-sync',
                idempotencyKey: `sync:${epicKey}:${ts}`
            });
            if (result.queued) queuedCount += epicStories.length;
        }

        // Enqueue individual jobs for orphan stories (no parent epic)
        for (const issue of orphanIssues) {
            const result = enqueueJiraWebhookJob({
                projectId: project.id,
                projectName: project.name,
                issueKey: issue.key,
                jiraProjectKey: project.jiraProjectKey,
                githubRepoFullName: project.githubRepoFullName || '',
                source: 'api-sync',
                idempotencyKey: `sync:${issue.key}:${ts}`
            });
            if (result.queued) queuedCount++;
        }

        console.log(`[Jira Sync] ${issues.length} issues found, ${queuedCount} queued (new/changed in ${epicGroups.size} epic batch(es) + ${orphanIssues.length} individual), ${skippedCount} skipped (unchanged)`);
        res.json({ 
            message: `Jira sync complete. ${queuedCount} new/changed stories queued, ${skippedCount} unchanged skipped.`,
            queuedCount,
            skippedCount,
            totalFound: issues.length
        });
    } catch (error) {
        console.error('[Jira Sync] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.patch('/api/projects/:projectId/github-link', (req, res) => {
    try {
        const project = linkGithubRepo(req.params.projectId, req.body?.githubRepoFullName);
        if (global.io) global.io.emit('refresh_data');
        res.json(project);
    } catch (error) {
        res.status(400).json({ error: error.message });
    }
});

app.get('/api/jira/spaces', async (req, res) => {
    try {
        const spaces = await fetchJiraSpaces();
        res.json(spaces);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectId/jira-rtm', (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.jiraProjectKey) {
            return res.json({ requirements: [], scenarios: [], lastUpdated: null });
        }

        const storyRecords = getStorySyncRecordsByProject(project.id);
        const dbScenarios = getScenariosByProject(project.jiraProjectKey);

        // Build a metadata lookup from story_sync_log
        const syncMap = new Map(storyRecords.map(r => [r.storyKey, r]));

        const activeScenarios = dbScenarios.filter(s => s.status !== 'obsolete');

        // Derive requirements from rtm_scenarios.storyId as the primary source so that
        // stories with scenarios always appear, even if story_sync_log is incomplete
        // (e.g. process killed between Jira comment post and sync log write)
        const uniqueStoryIds = [...new Set(activeScenarios.map(s => s.storyId).filter(Boolean))];
        const requirements = uniqueStoryIds.map(storyId => {
            const meta = syncMap.get(storyId);
            return {
                reqId: storyId,
                description: meta?.summary || storyId,
                epicKey: meta?.epicKey || 'UNSCOPED',
                lastSyncedAt: meta?.lastSyncedAt || null
            };
        });

        const scenarios = activeScenarios.map(s => {
            const testCases = getTestCasesByScenario(s.scenarioId).map(tc => ({
                testCaseId:        tc.testCaseId,
                title:             tc.title,
                steps:             tc.steps,
                testData:          tc.testData,
                testScript:        tc.testScript,
                language:          tc.language,
                status:            tc.status,
                version:           tc.version,
                previousVersionId: tc.previousVersionId,
                codeFiles:         tc.codeFiles,
                prUrl:             tc.prUrl,
                runId:             tc.runId,
                createdAt:         tc.createdAt,
                lastRunAt:         tc.lastRunAt,
                healAttempts:      tc.healAttempts
            }));

            const bestStatus = testCases.length > 0
                ? (testCases.some(tc => tc.status === 'fail') ? 'fail'
                    : testCases.every(tc => tc.status === 'pass') ? 'pass'
                    : 'pending')
                : (s.status || 'pending');

            return {
                id: s.scenarioId,
                title: s.title || '',
                type: s.type || '',
                description: s.description || '',
                parentReq: s.storyId || '',
                status: s.status || 'pending',
                priority: s.priority || '',
                execStatus: bestStatus,
                lastPRTested: s.lastPRTested || null,
                testScriptRef: s.testScriptRef || null,
                testCases
            };
        });

        const latestSync = storyRecords.reduce((latest, r) => {
            if (!r.lastSyncedAt) return latest;
            return !latest || r.lastSyncedAt > latest ? r.lastSyncedAt : latest;
        }, null);

        res.json({ requirements, scenarios, lastUpdated: latestSync });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectId/scenarios', (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });
        if (!project.jiraProjectKey) return res.json([]);

        const scenarios = getScenariosByProject(project.jiraProjectKey);
        res.json(scenarios);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/projects/:projectId/jira-documents', (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        res.json(getDocsForProject(project.id));
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/projects/:projectId/jira-documents', jiraDocUpload.fields([
    { name: 'files', maxCount: 20 },
    { name: 'file', maxCount: 1 }
]), (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) {
            return res.status(404).json({ error: 'Project not found' });
        }
        if (!project.jiraProjectKey) {
            return res.status(400).json({ error: 'Link a Jira space before uploading Jira documents' });
        }

        const uploadedFiles = [
            ...((req.files && Array.isArray(req.files.files)) ? req.files.files : []),
            ...((req.files && Array.isArray(req.files.file)) ? req.files.file : [])
        ];

        if (uploadedFiles.length === 0) {
            return res.status(400).json({ error: 'At least one file is required' });
        }

        uploadedFiles.forEach((file) => {
            const fileMetadata = {
                path: path.resolve(file.path),
                mimeType: file.mimetype,
                originalName: file.originalname,
                uploadedAt: new Date().toISOString()
            };
            addDocToProject(project.id, fileMetadata);
        });

        if (global.io) global.io.emit('refresh_data');
        return res.status(200).json({
            uploaded: true,
            uploadedCount: uploadedFiles.length,
            message: 'Documents stored. They will be used the next time Jira webhook processing runs.'
        });
    } catch (error) {
        console.error('[Project Jira Documents] Upload failed:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

app.delete('/api/projects/:projectId/jira-documents', (req, res) => {
    try {
        const project = getProjectById(req.params.projectId);
        if (!project) return res.status(404).json({ error: 'Project not found' });

        const filePath = String(req.body?.filePath || '').trim();
        removeDocFromProject(project.id, filePath);
        if (global.io) global.io.emit('refresh_data');
        return res.status(200).json({ deleted: true });
    } catch (error) {
        console.error('[Project Jira Documents] Delete failed:', error.message);
        return res.status(500).json({ error: error.message });
    }
});

// --- Requirements Endpoints ---
app.get('/api/github/repos/requirements', (req, res) => {
    res.json(getRequirementsMap());
});

app.get('/api/github/repos/:owner/:repo/branch-tree', async (req, res) => {
    const { owner, repo } = req.params;
    try {
        const { fetchRepoBranchTree } = require('./services/githubService');
        const branches = await fetchRepoBranchTree(owner, repo);
        res.json(branches);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/github/repos/requirements', upload.single('file'), async (req, res) => {
    if (!req.file || !req.body.repoFullName) {
        return res.status(400).json({ error: 'File and repoFullName are required' });
    }
    const map = getRequirementsMap();
    const repo = req.body.repoFullName;
    
    // Remove old file if it exists
    if (map[repo] && fs.existsSync(map[repo].path)) {
        try { fs.unlinkSync(map[repo].path); } catch (e) { console.error('Could not delete old file', e); }
    }

    map[repo] = {
        path: req.file.path,
        filename: req.file.filename,
        originalname: req.file.originalname,
        mimetype: req.file.mimetype,
        uploadedAt: new Date().toISOString()
    };
    saveRequirementsMap(map);
    
    if (global.io) global.io.emit('refresh_data');
    res.json({ success: true, file: map[repo] });
});

app.delete('/api/github/repos/requirements', (req, res) => {
    const { repoFullName } = req.body;
    const map = getRequirementsMap();
    if (map[repoFullName]) {
        if (fs.existsSync(map[repoFullName].path)) {
            try { fs.unlinkSync(map[repoFullName].path); } catch (e) { console.error('Could not delete file', e); }
        }
        delete map[repoFullName];
        saveRequirementsMap(map);
    }
    res.json({ success: true });
});

// Backend APIs for GitHub integration
app.get('/api/github/repos', async (req, res) => {
    try {
        const { fetchUserRepositories } = require('./services/githubService');
        const repos = await fetchUserRepositories();
        res.json(repos);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const runHistoryPath = path.join(__dirname, 'data', 'runHistory.json');

function getRunHistory() {
    if (!fs.existsSync(runHistoryPath)) return {};
    try {
        let content = fs.readFileSync(runHistoryPath, 'utf8');
        // Strip BOM if present
        let cleanContent = content.charCodeAt(0) === 0xFEFF ? content.slice(1) : content;
        // Strip null bytes and weird unicode artifacts commonly causing syntax errors
        cleanContent = cleanContent.replace(/\0/g, '').trim();
        if (!cleanContent) return {};
        return JSON.parse(cleanContent);
    } catch (e) {
        console.error('Failed to parse runHistory.json, resetting.', e);
        return {};
    }
}

// In-memory lock to prevent duplicate pipeline runs for the same PR URL.
// When a PR event arrives while a run for that URL is already in flight,
// we skip the duplicate to avoid wasting Docker/LLM resources.
const _activePipelineRuns = new Map();

function verifyGitHubSignature(req) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) return true; // no secret configured — skip verification
    const sig = req.headers['x-hub-signature-256'];
    if (!sig) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret)
        .update(JSON.stringify(req.body))
        .digest('hex');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}

// Webhook endpoint to receive GitHub push/PR events
app.post('/api/webhooks/github', validateBody(githubWebhookSchema), (req, res) => {
    if (!verifyGitHubSignature(req)) {
        console.warn('[Webhook] GitHub signature verification failed — rejecting request.');
        return res.status(401).json({ error: 'Invalid signature' });
    }

    // Respond immediately with 202 Accepted
    res.status(202).send('Accepted');

    const event = req.headers['x-github-event'];
    
    if (event === 'repository') {
        const { action, repository } = req.body;
        if (action === 'created' || action === 'publicized') {
            console.log(`[Webhook] Repository ${action}: ${repository.full_name}`);
            if (global.io) {
                global.io.emit('repo_created', { repoFullName: repository.full_name, action });
                global.io.emit('refresh_data');
            }
        }
    } else if (event === 'create') {
        const { ref_type, ref, repository } = req.body;
        if (ref_type === 'branch') {
            console.log(`[Webhook] Branch created: ${ref} in ${repository.full_name}`);
            if (global.io) {
                global.io.emit('branch_created', { branchName: ref, repoFullName: repository.full_name });
                global.io.emit('refresh_data');
            }
        }
    } else if (event === 'pull_request') {
        const { action, pull_request, repository } = req.body;
        
        if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
            const prUrl = pull_request.html_url;
            const repoFullName = repository.full_name;
            const linkedProject = findProjectByGithubRepo(repoFullName);

            if (!linkedProject || !linkedProject.jiraProjectKey) {
                console.log(`[Webhook] Ignored PR for ${repoFullName}: repo is not linked to a complete local project (Jira + GitHub).`);
                if (global.io) {
                    global.io.emit('refresh_data');
                }
                return;
            }

            // Deduplication: skip if a pipeline is already running for this PR.
            if (_activePipelineRuns.has(prUrl)) {
                const existingRunId = _activePipelineRuns.get(prUrl);
                console.log(`[Webhook] Skipping duplicate PR event for ${prUrl} — run ${existingRunId} is already in flight.`);
                return;
            }

            const runId = uuidv4();
            _activePipelineRuns.set(prUrl, runId);
            
            console.log(`[Webhook] PR ${action}: ${prUrl} in ${repoFullName}. Starting run ${runId}`);
            
            // Emit a new PR event to React frontend immediately
            if (global.io) {
                global.io.emit('pr_opened', {
                    runId,
                    repoFullName,
                    prUrl,
                    action,
                    localProjectId: linkedProject.id,
                    localProjectName: linkedProject.name
                });
                global.io.emit('refresh_data');
            }
            
            // Kick off the pipeline asynchronously
            const { runPipeline } = require('./pipeline');
            runPipeline(runId, prUrl, repoFullName)
                .catch(err => {
                    console.error(`[Pipeline Error] Run ${runId}:`, err);
                    publishToDLQ('github_webhook', { runId, prUrl, repoFullName }, err.message);
                })
                .finally(() => {
                    _activePipelineRuns.delete(prUrl);
                });
        }
    }
});

function verifyJiraWebhookSignature(req, res, next) {
    const secret = process.env.JIRA_WEBHOOK_SECRET;
    if (!secret) return next();

    const signature = req.headers['x-hub-signature'];
    if (!signature) {
        console.error('[Jira Webhook] Missing X-Hub-Signature header');
        return res.status(401).json({ error: 'Missing X-Hub-Signature header' });
    }

    const payload = req.rawBody ? req.rawBody.toString('utf8') : '';
    const hmac = crypto.createHmac('sha256', secret);
    const digest = 'sha256=' + hmac.update(payload).digest('hex');

    try {
        if (!crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature))) {
            console.error(`[Jira Webhook] Signatures do not match. Expected ${digest}, got ${signature}`);
            return res.status(401).json({ error: 'Signatures do not match' });
        }
    } catch(e) {
        console.error('[Jira Webhook] Error comparing signatures:', e);
        return res.status(401).json({ error: 'Invalid signature format' });
    }

    next();
}

app.post('/api/webhooks/jira', verifyJiraWebhookSignature, validateBody(jiraWebhookSchema), (req, res) => {
    const body = req.body || {};
    console.log('\n=======================================');
    console.log('[Jira Webhook] RAW PAYLOAD RECEIVED:');
    console.dir(body, { depth: null, colors: true });
    console.log('=======================================\n');

    const respondIgnored = (reason, issueKey = body?.issue?.key || null) => {
        jiraWebhookState.lastTriggeredAt = new Date().toISOString();
        jiraWebhookState.lastAccepted = false;
        jiraWebhookState.lastRunId = null;
        jiraWebhookState.lastIssueKey = issueKey;
        jiraWebhookState.lastError = null;
        jiraWebhookState.lastIgnoredReason = reason;
        return res.status(200).json({ received: false, reason });
    };

    const enqueueStory = (linkedProject, payloadProjectKey, issueKey, idempotencyKey) => {
        return enqueueJiraWebhookJob({
            projectId: linkedProject.id,
            projectName: linkedProject.name,
            issueKey,
            jiraProjectKey: linkedProject.jiraProjectKey || payloadProjectKey,
            githubRepoFullName: linkedProject.githubRepoFullName || '',
            source: 'jira-webhook',
            idempotencyKey
        });
    };

    (async () => {
        try {
        const isIssueUpdated = body.webhookEvent === 'jira:issue_updated';
        const issueType = String(body?.issue?.fields?.issuetype?.name || '').toLowerCase();
        const isStory = issueType === 'story';
        const isEpic = issueType === 'epic';
        const payloadProjectKey = String(body?.issue?.fields?.project?.key || '').trim();
        const linkedProject = findProjectByJiraProjectKey(payloadProjectKey);
        const isLinkedProject = Boolean(linkedProject);
        const changelogItems = Array.isArray(body?.changelog?.items) ? body.changelog.items : [];
        const targetStatus = String(process.env.JIRA_TRIGGER_STATUS || 'Selected for Development').trim();
        const hasTargetTransition = changelogItems.some((item) => {
            return item?.field === 'status' && String(item?.toString || '').trim() === targetStatus;
        });
        const issueKey = String(body?.issue?.key || '').trim();
        const dedupeBase = `${body?.timestamp || ''}:${body?.changelog?.id || ''}`;

        if (!isIssueUpdated) {
            return respondIgnored('Only jira:issue_updated events are processed', issueKey || null);
        }
        if (!isLinkedProject) {
            return respondIgnored('Project is not linked in local project settings', issueKey || null);
        }
        if (!hasTargetTransition) {
            return respondIgnored('Issue transition does not match configured trigger status', issueKey || null);
        }
        if (!issueKey) {
            return respondIgnored('Missing issue key in webhook payload', null);
        }
        if (!isEpic && !isStory) {
            return respondIgnored(`Unsupported issue type: ${issueType || 'unknown'} - only Stories or Epics are processed for scenarios`, issueKey);
        }

        const enqueueResult = enqueueStory(linkedProject, payloadProjectKey, issueKey, `${dedupeBase}:${issueKey}`);

        jiraWebhookState.lastTriggeredAt = new Date().toISOString();
        jiraWebhookState.lastAccepted = enqueueResult.queued;
        jiraWebhookState.lastRunId = null;
        jiraWebhookState.lastIssueKey = issueKey;
        jiraWebhookState.lastError = null;
        jiraWebhookState.lastIgnoredReason = enqueueResult.duplicate
            ? 'Ignored duplicate webhook within dedupe window'
            : null;

        return res.status(200).json({
            received: true,
            issueType: issueType,
            queued: enqueueResult.queued,
            duplicate: enqueueResult.duplicate,
            queue: getJiraWebhookQueueStatus()
        });
        } catch (error) {
            console.error('[Jira Webhook] Failed to process payload:', error.message);
            publishToDLQ('jira_webhook', body, error.message);
            jiraWebhookState.lastTriggeredAt = new Date().toISOString();
            jiraWebhookState.lastAccepted = false;
            jiraWebhookState.lastError = error.message;
            return res.status(200).json({ received: false, error: error.message });
        }
    })();
});

app.get('/api/jira/queue', (req, res) => {
    try {
        res.json(getJiraWebhookQueueStatus());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/jira/health', async (req, res) => {
    try {
        const projectKey = String(req.query.projectKey || process.env.JIRA_PROJECT_KEY || '').trim();
        const health = await getJiraHealth(projectKey);
        const lastRun = jiraWebhookState.lastRunId ? getRun(jiraWebhookState.lastRunId) : null;

        const webhook = {
            endpoint: jiraWebhookState.endpoint,
            triggerStatus: process.env.JIRA_TRIGGER_STATUS || '',
            projectKey: process.env.JIRA_PROJECT_KEY || '',
            lastTriggeredAt: jiraWebhookState.lastTriggeredAt,
            lastIssueKey: jiraWebhookState.lastIssueKey,
            lastRunId: jiraWebhookState.lastRunId,
            lastAccepted: jiraWebhookState.lastAccepted,
            lastIgnoredReason: jiraWebhookState.lastIgnoredReason,
            lastError: jiraWebhookState.lastError,
            lastRunStatus: lastRun?.status || null,
            queue: getJiraWebhookQueueStatus()
        };

        const webhookReady = health.configured.ok && health.auth.ok;

        res.json({
            ...health,
            webhook,
            summary: {
                authOk: health.auth.ok,
                projectOk: health.project.ok,
                webhookReady
            }
        });
    } catch (error) {
        console.error('[Jira Health] Failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/runs/:runId/artifacts/:testCaseKey/:artifactFile', (req, res) => {
    try {
        const ARTIFACT_NAME_RE = /^[a-zA-Z0-9._-]+\.(png|zip)$/;
        const { runId, testCaseKey, artifactFile } = req.params;
        if (!ARTIFACT_NAME_RE.test(artifactFile)) {
            return res.status(400).json({ error: 'Invalid artifact name' });
        }
        const artifactsBase = path.resolve(path.join(__dirname, 'data', 'artifacts'));
        const resolved = path.resolve(path.join(artifactsBase, runId, testCaseKey, artifactFile));
        if (!resolved.startsWith(artifactsBase)) {
            return res.status(400).json({ error: 'Bad path' });
        }
        if (!fs.existsSync(resolved)) {
            return res.status(404).json({ error: 'Not found' });
        }
        const ext = path.extname(artifactFile).toLowerCase();
        const ct = ext === '.png' ? 'image/png' : ext === '.zip' ? 'application/zip' : 'application/octet-stream';
        res.setHeader('Content-Type', ct);
        fs.createReadStream(resolved).pipe(res);
    } catch (err) {
        console.error('[Artifacts] Serve failed:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/runs/:runId/test-cases', (req, res) => {
    try {
        const { getTestCasesByRun } = require('./db');
        const testCases = getTestCasesByRun(req.params.runId);
        res.json(testCases);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/runs', (req, res) => {
    try {
        res.json(listRuns());
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/github/repos/:owner/:repo/baseline', (req, res) => {
    const { owner, repo } = req.params;
    const rtmPath = path.join(__dirname, 'data', 'rtm_baselines.json');
    if (!fs.existsSync(rtmPath)) return res.json({});
    
    try {
        const content = fs.readFileSync(rtmPath, 'utf8');
        const baselines = JSON.parse(content);
        res.json(baselines[`${owner}/${repo}`] || {});
    } catch(e) {
        res.status(500).json({ error: 'Failed to parse baseline RTM' });
    }
});

app.get('/api/runs/:runId', (req, res) => {
    try {
        const run = getRun(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }
        res.json(run);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/runs/:runId', (req, res) => {
    try {
        const { deleteRunData } = require('./db');
        const run = getRun(req.params.runId);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }
        deleteRunData(req.params.runId);
        if (global.io) global.io.emit('refresh_data');
        res.json({ success: true, runId: req.params.runId });
    } catch (error) {
        console.error('[Delete Run] Failed:', error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen = undefined; // Avoid accidentally using app.listen
server.listen(PORT, async () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
    warnMissingJiraEnvVars();
    
    // Spin up smee helper for local webhooks
    try {
        const smeeGithub = new SmeeClient({
            source: 'https://smee.io/autoqa-solutions21-xyz987', // Unique persistent Smee channel for GitHub
            target: `http://localhost:${PORT}/api/webhooks/github`,
            logger: console
        });
        const eventsGithub = smeeGithub.start();

        const smeeJira = new SmeeClient({
            source: 'https://smee.io/autoqa-jira-xyz987', // Unique persistent Smee channel for Jira
            target: `http://localhost:${PORT}/api/webhooks/jira`,
            logger: console
        });
        const eventsJira = null; // smeeJira.start(); // Disabled in favor of API pull

        console.log(`\n========================================================================`);
        console.log(`🌐 GITHUB WEBHOOK URL: https://smee.io/autoqa-solutions21-xyz987`);
        console.log(`   Paste this URL into GitHub Webhook settings (Content type: application/json)`);
        console.log(`   [Jira Webhooks are disabled in favor of manual API Sync Pulls]`);
        console.log(`========================================================================\n`);

    } catch(err) {
        console.error('Failed to start Smee client:', err.message);
    }
});
