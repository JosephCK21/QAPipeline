const { randomUUID } = require('crypto');

const DEFAULT_CONCURRENCY = Math.max(1, Number(process.env.JIRA_QUEUE_CONCURRENCY || 2));
const DEFAULT_DEDUPE_WINDOW_MS = Math.max(60000, Number(process.env.JIRA_WEBHOOK_DEDUPE_MS || 5 * 60 * 1000));

const projectQueues = new Map();
const processingProjects = new Set();
const recentKeys = new Map();

let processor = null;
let activeWorkers = 0;
let completedJobs = 0;
let failedJobs = 0;

function pruneRecentKeys() {
    const now = Date.now();
    for (const [key, expiresAt] of recentKeys.entries()) {
        if (expiresAt <= now) {
            recentKeys.delete(key);
        }
    }
}

function setJiraWebhookJobProcessor(fn) {
    processor = fn;
}

function enqueueJiraWebhookJob(job) {
    if (!job || !job.projectId || !job.issueKey) {
        throw new Error('enqueueJiraWebhookJob requires projectId and issueKey');
    }

    pruneRecentKeys();

    const dedupeKey = String(job.idempotencyKey || `${job.projectId}:${job.issueKey}`).trim();
    if (dedupeKey && recentKeys.has(dedupeKey)) {
        return { queued: false, duplicate: true, jobId: null };
    }

    if (dedupeKey) {
        recentKeys.set(dedupeKey, Date.now() + DEFAULT_DEDUPE_WINDOW_MS);
    }

    const queuedJob = {
        id: randomUUID(),
        projectId: String(job.projectId),
        issueKey: String(job.issueKey),
        storyKeys: Array.isArray(job.storyKeys) ? job.storyKeys : undefined,
        projectName: String(job.projectName || ''),
        jiraProjectKey: String(job.jiraProjectKey || ''),
        githubRepoFullName: String(job.githubRepoFullName || ''),
        source: String(job.source || 'jira-webhook'),
        enqueuedAt: new Date().toISOString(),
        dedupeKey
    };

    const queue = projectQueues.get(queuedJob.projectId) || [];
    queue.push(queuedJob);
    projectQueues.set(queuedJob.projectId, queue);

    schedule();

    if (typeof global !== 'undefined' && global.io) {
        global.io.emit('jira_queue_updated', getJiraWebhookQueueStatus());
    }

    return { queued: true, duplicate: false, jobId: queuedJob.id };
}

function schedule() {
    if (!processor) return;
    if (activeWorkers >= DEFAULT_CONCURRENCY) return;

    for (const [projectId, queue] of projectQueues.entries()) {
        if (activeWorkers >= DEFAULT_CONCURRENCY) break;
        if (!Array.isArray(queue) || queue.length === 0) {
            projectQueues.delete(projectId);
            continue;
        }
        if (processingProjects.has(projectId)) continue;

        startNextJob(projectId);
    }
}

async function startNextJob(projectId) {
    const queue = projectQueues.get(projectId);
    if (!Array.isArray(queue) || queue.length === 0 || processingProjects.has(projectId)) {
        return;
    }

    const job = queue.shift();
    if (queue.length === 0) {
        projectQueues.delete(projectId);
    } else {
        projectQueues.set(projectId, queue);
    }

    processingProjects.add(projectId);
    activeWorkers += 1;

    try {
        await processor(job);
        completedJobs += 1;
    } catch (error) {
        failedJobs += 1;
        console.error(`[Jira Queue] Job ${job.id} failed for ${job.issueKey}:`, error.message);
    } finally {
        processingProjects.delete(projectId);
        activeWorkers = Math.max(0, activeWorkers - 1);
        schedule();
    }
}

function getJiraWebhookQueueStatus() {
    let queuedJobs = 0;
    const projects = [];

    for (const [projectId, queue] of projectQueues.entries()) {
        const count = Array.isArray(queue) ? queue.length : 0;
        queuedJobs += count;
        projects.push({
            projectId,
            queuedJobs: count,
            isProcessing: processingProjects.has(projectId)
        });
    }

    return {
        queuedJobs,
        activeWorkers,
        concurrency: DEFAULT_CONCURRENCY,
        processingProjects: processingProjects.size,
        completedJobs,
        failedJobs,
        projects
    };
}

module.exports = {
    setJiraWebhookJobProcessor,
    enqueueJiraWebhookJob,
    getJiraWebhookQueueStatus
};
