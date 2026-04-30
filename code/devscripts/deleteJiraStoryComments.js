const path = require('path');
const { backendRoot, loadBackendEnv } = require('./_paths');
loadBackendEnv();
const axios = require('axios');
const { adfToPlainText } = require(path.join(backendRoot, 'services', 'jiraService'));

function parseArgs(argv) {
    const args = {
        projectKey: '',
        issueType: 'Story',
        apply: false,
        marker: 'AutoQA — Generated Test Scenarios',
        author: '',
        maxIssues: 500
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply') {
            args.apply = true;
            continue;
        }
        if (arg === '--project' || arg === '-p') {
            args.projectKey = String(argv[i + 1] || '').trim();
            i += 1;
            continue;
        }
        if (arg === '--issue-type') {
            args.issueType = String(argv[i + 1] || 'Story').trim();
            i += 1;
            continue;
        }
        if (arg === '--marker') {
            args.marker = String(argv[i + 1] || '').trim();
            i += 1;
            continue;
        }
        if (arg === '--author') {
            args.author = String(argv[i + 1] || '').trim().toLowerCase();
            i += 1;
            continue;
        }
        if (arg === '--max-issues') {
            const parsed = Number(argv[i + 1]);
            args.maxIssues = Number.isFinite(parsed) && parsed > 0 ? parsed : 500;
            i += 1;
            continue;
        }
    }

    if (!args.projectKey) {
        args.projectKey = String(process.env.JIRA_PROJECT_KEY || '').trim();
    }

    return args;
}

function validateEnv() {
    const baseUrl = String(process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
    const email = String(process.env.JIRA_USER_EMAIL || '').trim();
    const token = String(process.env.JIRA_API_TOKEN || '').trim();

    if (!baseUrl || !email || !token) {
        throw new Error('Missing Jira env vars. Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN.');
    }

    const auth = Buffer.from(`${email}:${token}`).toString('base64');
    const headers = {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
    };

    return { baseUrl, headers };
}

async function fetchIssuesByProject(baseUrl, headers, projectKey, issueType, maxIssues) {
    const issues = [];
    const maxResults = 100;
    let startAt = 0;

    while (issues.length < maxIssues) {
        const response = await axios.get(`${baseUrl}/rest/api/3/search/jql`, {
            headers,
            params: {
                jql: `project="${projectKey}" AND issuetype="${issueType}" ORDER BY key ASC`,
                startAt,
                maxResults,
                fields: 'summary'
            }
        });

        const pageIssues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        issues.push(...pageIssues);

        const total = Number(response.data?.total || 0);
        startAt += pageIssues.length;

        if (pageIssues.length === 0 || startAt >= total || issues.length >= maxIssues) {
            break;
        }
    }

    return issues.slice(0, maxIssues).map((issue) => ({ key: issue.key, summary: issue.fields?.summary || '' }));
}

async function fetchAllComments(baseUrl, headers, issueKey) {
    const comments = [];
    const maxResults = 100;
    let startAt = 0;

    while (true) {
        const response = await axios.get(`${baseUrl}/rest/api/3/issue/${issueKey}/comment`, {
            headers,
            params: { startAt, maxResults }
        });
        const page = Array.isArray(response.data?.comments) ? response.data.comments : [];
        comments.push(...page);
        const total = Number(response.data?.total || 0);
        startAt += page.length;
        if (page.length === 0 || startAt >= total) break;
    }

    return comments;
}

function isManagedComment(comment, marker, author) {
    const plainText = String(adfToPlainText(comment?.body) || '').trim();
    const displayName = String(comment?.author?.displayName || '').toLowerCase();
    const email = String(comment?.author?.emailAddress || '').toLowerCase();
    const accountId = String(comment?.author?.accountId || '').toLowerCase();

    const matchesMarker = marker ? plainText.includes(marker) : true;
    const matchesAuthor = author
        ? displayName.includes(author) || email.includes(author) || accountId === author
        : true;

    return matchesMarker && matchesAuthor;
}

async function deleteComment(baseUrl, headers, issueKey, commentId) {
    await axios.delete(`${baseUrl}/rest/api/3/issue/${issueKey}/comment/${commentId}`, { headers });
}

function printUsage() {
    console.log('Usage:');
    console.log('  node code/devscripts/deleteJiraStoryComments.js --project <PROJECT_KEY> [--apply]');
    console.log('');
    console.log('Options:');
    console.log('  --project, -p <key>     Jira project key (defaults to JIRA_PROJECT_KEY)');
    console.log('  --apply                 Actually delete comments (default is dry-run)');
    console.log('  --issue-type <type>     Issue type filter (default: Story)');
    console.log('  --marker <text>         Delete only comments containing marker text');
    console.log('                          Default: AUTOQA_MANAGED_SCENARIOS:');
    console.log('  --author <text>         Optional author filter (display name/email/accountId contains text)');
    console.log('  --max-issues <n>        Max issues to scan (default: 500)');
    console.log('');
    console.log('Examples:');
    console.log('  node code/devscripts/deleteJiraStoryComments.js -p QPT');
    console.log('  node code/devscripts/deleteJiraStoryComments.js -p QPT --apply');
    console.log('  node code/devscripts/deleteJiraStoryComments.js -p QPT --apply --marker "AUTOQA_MANAGED_SCENARIOS:"');
}

async function main() {
    const args = parseArgs(process.argv);

    if (process.argv.includes('--help') || process.argv.includes('-h')) {
        printUsage();
        return;
    }

    if (!args.projectKey) {
        printUsage();
        throw new Error('Project key is required. Pass --project <KEY> or set JIRA_PROJECT_KEY.');
    }

    const { baseUrl, headers } = validateEnv();
    console.log(`[jira-comments-cleanup] Mode: ${args.apply ? 'APPLY (delete)' : 'DRY-RUN (no deletions)'}`);
    console.log(`[jira-comments-cleanup] Project: ${args.projectKey} | IssueType: ${args.issueType}`);
    console.log(`[jira-comments-cleanup] Marker: ${args.marker || '(none)'} | Author: ${args.author || '(none)'} | MaxIssues: ${args.maxIssues}`);

    const issues = await fetchIssuesByProject(baseUrl, headers, args.projectKey, args.issueType, args.maxIssues);
    console.log(`[jira-comments-cleanup] Found ${issues.length} issue(s) to inspect.`);

    let matchedComments = 0;
    let deletedComments = 0;

    for (const issue of issues) {
        const comments = await fetchAllComments(baseUrl, headers, issue.key);
        const targets = comments.filter((comment) => isManagedComment(comment, args.marker, args.author));
        if (targets.length === 0) continue;

        matchedComments += targets.length;
        console.log(`- ${issue.key} (${issue.summary}): ${targets.length} matching comment(s)`);

        if (!args.apply) continue;

        for (const comment of targets) {
            await deleteComment(baseUrl, headers, issue.key, comment.id);
            deletedComments += 1;
            console.log(`  deleted comment ${comment.id}`);
        }
    }

    console.log('');
    console.log(`[jira-comments-cleanup] Done.`);
    console.log(`[jira-comments-cleanup] Matched comments: ${matchedComments}`);
    console.log(`[jira-comments-cleanup] Deleted comments: ${deletedComments}`);
}

main().catch((error) => {
    console.error('[jira-comments-cleanup] Failed:', error.response?.data || error.message);
    process.exit(1);
});
