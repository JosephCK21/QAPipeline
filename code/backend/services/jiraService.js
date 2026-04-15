const axios = require('axios');
require('dotenv').config();

const REQUIRED_JIRA_ENV_VARS = ['JIRA_BASE_URL', 'JIRA_USER_EMAIL', 'JIRA_API_TOKEN'];

function getMissingJiraEnvVars() {
    return REQUIRED_JIRA_ENV_VARS.filter((key) => !process.env[key] || !String(process.env[key]).trim());
}

function getJiraConfig() {
    const baseUrl = (process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
    const email = (process.env.JIRA_USER_EMAIL || '').trim();
    const token = (process.env.JIRA_API_TOKEN || '').trim();

    if (!baseUrl || !email || !token) {
        throw new Error('Missing Jira configuration. Ensure JIRA_BASE_URL, JIRA_USER_EMAIL, and JIRA_API_TOKEN are set.');
    }

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    return {
        baseUrl,
        headers: {
            Authorization: `Basic ${auth}`,
            Accept: 'application/json',
            'Content-Type': 'application/json'
        }
    };
}

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function adfToPlainText(adfNode) {
    if (adfNode === null || adfNode === undefined) return '';

    if (typeof adfNode === 'string') return adfNode;

    if (Array.isArray(adfNode)) {
        return adfNode
            .map((node) => adfToPlainText(node))
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    if (!isObject(adfNode)) return '';

    const nodeType = adfNode.type;
    if (nodeType === 'text') {
        return adfNode.text || '';
    }

    if (nodeType === 'hardBreak') {
        return '\n';
    }

    const childText = Array.isArray(adfNode.content)
        ? adfNode.content.map((child) => adfToPlainText(child)).join('')
        : '';

    if (!childText) return '';

    if (nodeType === 'paragraph' || nodeType === 'heading' || nodeType === 'listItem') {
        return `${childText.trim()}\n`;
    }

    return childText;
}

function normalizePlainText(text) {
    return String(text || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function getAcceptanceCriteria(fields) {
    if (!isObject(fields)) return '';

    const direct = fields.customfield_10016;
    if (direct) {
        return normalizePlainText(adfToPlainText(direct));
    }

    const candidateKey = Object.keys(fields).find((key) => /acceptance|criteria/i.test(key));
    if (!candidateKey) return '';

    return normalizePlainText(adfToPlainText(fields[candidateKey]));
}

function mapIssueToCleanObject(issue) {
    const fields = issue?.fields || {};
    const parentKey = fields.parent?.key || fields.customfield_10014 || null;

    return {
        key: issue?.key || '',
        summary: fields.summary || '',
        description: normalizePlainText(adfToPlainText(fields.description)),
        issueType: fields.issuetype?.name || '',
        status: fields.status?.name || '',
        acceptanceCriteria: getAcceptanceCriteria(fields),
        parentKey,
        projectKey: fields.project?.key || getProjectKey(issue?.key || '')
    };
}

async function fetchIssue(issueKey) {
    try {
        const { baseUrl, headers } = getJiraConfig();
        const response = await axios.get(`${baseUrl}/rest/api/3/issue/${issueKey}`, { headers });
        return mapIssueToCleanObject(response.data);
    } catch (error) {
        console.error(`[jiraService.fetchIssue] Failed for ${issueKey}:`, error.response?.data || error.message);
        throw error;
    }
}

async function fetchEpicContext(epicKey) {
    try {
        return await fetchIssue(epicKey);
    } catch (error) {
        console.error(`[jiraService.fetchEpicContext] Failed for ${epicKey}:`, error.response?.data || error.message);
        throw error;
    }
}

async function fetchStoriesInProject(projectKey) {
    try {
        const { baseUrl, headers } = getJiraConfig();
        const jql = `project=${projectKey} AND issuetype=Story`;

        const response = await axios.get(`${baseUrl}/rest/api/3/search/jql`, {
            headers,
            params: {
                jql,
                maxResults: 100,
                fields: 'summary,description,status,parent,project,issuetype,customfield_10014,customfield_10016'
            }
        });

        const issues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        return issues.map(mapIssueToCleanObject);
    } catch (error) {
        console.error(`[jiraService.fetchStoriesInProject] Failed for ${projectKey}:`, error.response?.data || error.message);
        throw error;
    }
}

async function fetchReadyIssues(projectKey, targetStatus) {
    try {
        const { baseUrl, headers } = getJiraConfig();
        // project = "PID" AND status = "Selected for Development" AND issuetype = Story
        const jql = `project="${projectKey}" AND status="${targetStatus}" AND issuetype = Story`;

        const response = await axios.get(`${baseUrl}/rest/api/3/search/jql`, {
            headers,
            params: {
                jql,
                maxResults: 100,
                fields: 'summary,description,status,parent,project,issuetype,customfield_10014,customfield_10016'
            }
        });

        const issues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        return issues.map(mapIssueToCleanObject);
    } catch (error) {
        console.error(`[jiraService.fetchReadyIssues] Failed for ${projectKey}:`, error.response?.data || error.message);
        throw error;
    }
}

function buildScenarioParagraphs(scenarios) {
    const safeScenarios = Array.isArray(scenarios) ? scenarios : [];

    return safeScenarios.flatMap((scenario, index) => {
        const type = scenario?.type || 'Scenario';
        const title = scenario?.title || 'Untitled scenario';
        const desc = scenario?.description || 'No description provided.';
        const priority = scenario?.priority || 'Medium';
        const acRefs = Array.isArray(scenario?.acceptanceCriteriaRef) ? scenario.acceptanceCriteriaRef.join(', ') : '';

        const blocks = [
            {
                type: 'heading',
                attrs: { level: 3 },
                content: [
                    { type: 'text', text: `Scenario ${index + 1}: ${title}` }
                ]
            },
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: `Type: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: `${type}` },
                    { type: 'text', text: `  |  Priority: `, marks: [{ type: 'strong' }] },
                    { type: 'text', text: `${String(priority).replace(/\b\w/g, c => c.toUpperCase())}` }
                ]
            },
            {
                type: 'paragraph',
                content: [
                    { type: 'text', text: desc }
                ]
            }
        ];

        if (acRefs) {
            blocks.push({
                type: 'paragraph',
                content: [
                    { type: 'text', text: `Covers: `, marks: [{ type: 'strong' }, { type: 'em' }] },
                    { type: 'text', text: acRefs, marks: [{ type: 'em' }] }
                ]
            });
        }

        blocks.push({ type: 'rule' });

        return blocks;
    });
}

const AUTOQA_COMMENT_MARKER = 'AUTOQA_MANAGED_SCENARIOS:';

function normalizeScenarioForSignature(scenario) {
    return {
        id: String(scenario?.id || '').trim(),
        type: String(scenario?.type || '').trim(),
        title: String(scenario?.title || '').trim(),
        description: String(scenario?.description || '').trim(),
        relatedReq: String(scenario?.relatedReq || scenario?.parentReq || '').trim()
    };
}

function buildScenarioSignature(scenarios) {
    const normalized = (Array.isArray(scenarios) ? scenarios : [])
        .map(normalizeScenarioForSignature)
        .sort((a, b) => `${a.id}:${a.description}`.localeCompare(`${b.id}:${b.description}`));

    return Buffer.from(JSON.stringify(normalized)).toString('base64');
}

function buildScenarioCommentBody(scenarios) {
    return {
        body: {
            type: 'doc',
            version: 1,
            content: [
                {
                    type: 'heading',
                    attrs: { level: 2 },
                    content: [
                        { type: 'text', text: 'AutoQA — Generated Test Scenarios' }
                    ]
                },
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: 'The following test scenarios were automatically generated by analysing this User Story and its parent Epic.' }
                    ]
                },
                { type: 'rule' },
                ...buildScenarioParagraphs(scenarios),
                {
                    type: 'paragraph',
                    content: [
                        { type: 'text', text: `Generated by AutoQA on ${new Date().toISOString().split('T')[0]}. Do not edit manually.`, marks: [{ type: 'em' }] }
                    ]
                }
            ]
        }
    };
}

function extractManagedCommentSignature(comment) {
    const plain = normalizePlainText(adfToPlainText(comment?.body));
    const markerIndex = plain.indexOf(AUTOQA_COMMENT_MARKER);
    if (markerIndex === -1) return '';
    return plain.slice(markerIndex + AUTOQA_COMMENT_MARKER.length).split('\n')[0].trim();
}

async function findManagedScenarioComment(issueKey) {
    const { baseUrl, headers } = getJiraConfig();
    const response = await axios.get(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
        headers,
        params: {
            maxResults: 100,
            orderBy: '-created'
        }
    });

    const comments = Array.isArray(response.data?.comments) ? response.data.comments : [];
    for (let idx = comments.length - 1; idx >= 0; idx -= 1) {
        const comment = comments[idx];
        const plain = normalizePlainText(adfToPlainText(comment?.body));
        if (plain.includes(AUTOQA_COMMENT_MARKER) || plain.includes('AutoQA - Generated Test Scenarios')) {
            return comment;
        }
    }

    return null;
}

async function postScenarioComment(issueKey, scenarios) {
    try {
        const allowedProject = process.env.JIRA_PROJECT_KEY;
        if (allowedProject && !issueKey.startsWith(`${allowedProject}-`)) {
            console.log(`[jiraService] Skipping comment on ${issueKey} because it does not belong to the allowed project: ${allowedProject}`);
            return { posted: false, updated: false, skipped: true, reason: 'Project Restricted' };
        }

        const { baseUrl, headers } = getJiraConfig();
        const payload = buildScenarioCommentBody(scenarios);
        const existingManagedComment = await findManagedScenarioComment(issueKey);

        if (!existingManagedComment) {
            await axios.post(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, payload, { headers });
            return { posted: true, updated: false, skipped: false };
        }

        // Update the existing AutoQA comment instead of creating a new one
        await axios.put(
            `${baseUrl}/rest/api/3/issue/${issueKey}/comment/${existingManagedComment.id}`,
            payload,
            { headers }
        );

        return {
            posted: false,
            updated: true,
            skipped: false,
            commentId: existingManagedComment.id
        };
    } catch (error) {
        console.error(`[jiraService.postScenarioComment] Failed for ${issueKey}:`, error.response?.data || error.message);
        throw error;
    }
}

async function fetchChildStoriesForEpic(epicKey) {
    const { baseUrl, headers } = getJiraConfig();
    const primaryJql = `(\"Epic Link\" = \"${epicKey}\" OR parent = \"${epicKey}\") AND issuetype = Story ORDER BY key ASC`;
    const fallbackJql = `parent = \"${epicKey}\" AND issuetype = Story ORDER BY key ASC`;

    const runSearch = async (jql) => {
        const response = await axios.get(`${baseUrl}/rest/api/3/search/jql`, {
            headers,
            params: {
                jql,
                maxResults: 100,
                fields: 'summary,description,status,parent,project,issuetype,customfield_10014,customfield_10016'
            }
        });

        const issues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        return issues.map(mapIssueToCleanObject);
    };

    try {
        return await runSearch(primaryJql);
    } catch (error) {
        console.warn(`[jiraService.fetchChildStoriesForEpic] Primary JQL failed for ${epicKey}, trying fallback.`);
        try {
            return await runSearch(fallbackJql);
        } catch (fallbackError) {
            console.error(
                `[jiraService.fetchChildStoriesForEpic] Failed for ${epicKey}:`,
                fallbackError.response?.data || fallbackError.message
            );
            throw fallbackError;
        }
    }
}

function getProjectKey(issueKey) {
    if (!issueKey || typeof issueKey !== 'string') return '';
    return issueKey.split('-')[0] || '';
}

async function getJiraHealth(projectKey) {
    const missingVars = getMissingJiraEnvVars();
    const normalizedProjectKey = String(projectKey || process.env.JIRA_PROJECT_KEY || '').trim();

    const result = {
        configured: {
            ok: missingVars.length === 0,
            missingVars
        },
        auth: {
            ok: false,
            accountId: null,
            displayName: null,
            emailAddress: null,
            error: null
        },
        project: {
            key: normalizedProjectKey,
            ok: false,
            name: null,
            error: null
        }
    };

    if (missingVars.length > 0) {
        result.auth.error = `Missing environment variables: ${missingVars.join(', ')}`;
        result.project.error = 'Project check skipped because Jira configuration is incomplete.';
        return result;
    }

    try {
        const { baseUrl, headers } = getJiraConfig();

        const myselfRes = await axios.get(`${baseUrl}/rest/api/3/myself`, { headers });
        result.auth.ok = true;
        result.auth.accountId = myselfRes.data?.accountId || null;
        result.auth.displayName = myselfRes.data?.displayName || null;
        result.auth.emailAddress = myselfRes.data?.emailAddress || null;

        if (!normalizedProjectKey) {
            result.project.error = 'No project key configured for project health check.';
            return result;
        }

        try {
            const projectRes = await axios.get(`${baseUrl}/rest/api/3/project/${encodeURIComponent(normalizedProjectKey)}`, { headers });
            result.project.ok = true;
            result.project.name = projectRes.data?.name || null;
        } catch (projectError) {
            result.project.error = projectError.response?.data?.errorMessages?.join('; ') || projectError.message;
        }

        return result;
    } catch (error) {
        result.auth.error = error.response?.data?.errorMessages?.join('; ') || error.message;
        if (!result.project.error) {
            result.project.error = 'Project check skipped because authentication failed.';
        }
        return result;
    }
}

async function fetchJiraSpaces() {
    try {
        const { baseUrl, headers } = getJiraConfig();
        const response = await axios.get(`${baseUrl}/rest/api/3/project/search`, {
            headers,
            params: {
                maxResults: 100,
                expand: 'lead'
            }
        });

        const values = Array.isArray(response.data?.values) ? response.data.values : [];
        return values.map((project) => ({
            id: project.id,
            key: project.key,
            name: project.name,
            projectTypeKey: project.projectTypeKey,
            leadDisplayName: project.lead?.displayName || null
        }));
    } catch (error) {
        console.error('[jiraService.fetchJiraSpaces] Failed:', error.response?.data || error.message);
        throw error;
    }
}

module.exports = {
    adfToPlainText,
    fetchIssue,
    fetchEpicContext,
    fetchChildStoriesForEpic,
    fetchStoriesInProject,
    fetchReadyIssues,
    postScenarioComment,
    getProjectKey,
    getMissingJiraEnvVars,
    getJiraHealth,
    fetchJiraSpaces
};
