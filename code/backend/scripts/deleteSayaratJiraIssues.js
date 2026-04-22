/**
 * Delete the Sayarat FRD Epics (and their Stories) that were seeded into Jira.
 *
 * Usage:
 *   node scripts/deleteSayaratJiraIssues.js -p QPT                # dry run (default)
 *   node scripts/deleteSayaratJiraIssues.js -p QPT --apply --yes  # actually delete
 *   node scripts/deleteSayaratJiraIssues.js --only-epic 3 --apply --yes
 *
 * Behaviour:
 *  - Dry-run by default. Requires BOTH --apply AND --yes to actually delete.
 *  - Matches epics + stories by exact (case-insensitive) summary from
 *    seedSayaratJiraIssues.js's EPICS data.
 *  - Deletes child stories first, then the parent epic (stories are linked by
 *    parent, not subtasks, but we still order it deterministically).
 *  - Polite 150ms delay between deletes.
 *
 * Required env (same as the seed script):
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (or -p)
 */

require('dotenv').config();
const axios = require('axios');
const { EPICS } = require('./seedSayaratJiraIssues');

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        projectKey: '',
        apply: false,
        confirm: false,
        onlyEpic: null,
        delayMs: 150
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply')  { args.apply = true; continue; }
        if (arg === '--yes' || arg === '-y') { args.confirm = true; continue; }
        if (arg === '--project' || arg === '-p') {
            args.projectKey = String(argv[i + 1] || '').trim();
            i += 1;
            continue;
        }
        if (arg === '--only-epic') {
            const n = Number(argv[i + 1]);
            args.onlyEpic = Number.isFinite(n) ? n : null;
            i += 1;
            continue;
        }
        if (arg === '--delay-ms') {
            const n = Number(argv[i + 1]);
            args.delayMs = Number.isFinite(n) && n >= 0 ? n : 150;
            i += 1;
            continue;
        }
    }

    if (!args.projectKey) {
        args.projectKey = String(process.env.JIRA_PROJECT_KEY || '').trim();
    }
    return args;
}

function printUsage() {
    console.log('Usage:');
    console.log('  node scripts/deleteSayaratJiraIssues.js --project <PROJECT_KEY> [--apply --yes]');
    console.log('');
    console.log('Options:');
    console.log('  --project, -p <key>   Jira project key (default: JIRA_PROJECT_KEY)');
    console.log('  --apply               Actually delete (default is dry-run)');
    console.log('  --yes, -y             Confirm destructive delete (required with --apply)');
    console.log('  --only-epic <n>       Delete only the epic with this number (1..10) + its stories');
    console.log('  --delay-ms <n>        Delay between deletes in ms (default: 150)');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/deleteSayaratJiraIssues.js -p QPT                # dry run of all');
    console.log('  node scripts/deleteSayaratJiraIssues.js -p QPT --apply --yes  # delete everything');
    console.log('  node scripts/deleteSayaratJiraIssues.js -p QPT --only-epic 5 --apply --yes');
}

// ---------------------------------------------------------------------------
// Jira config + HTTP
// ---------------------------------------------------------------------------
function getJiraConfig() {
    const baseUrl = String(process.env.JIRA_BASE_URL || '').trim().replace(/\/$/, '');
    const email   = String(process.env.JIRA_USER_EMAIL || '').trim();
    const token   = String(process.env.JIRA_API_TOKEN || '').trim();
    if (!baseUrl || !email || !token) {
        throw new Error('Missing Jira env vars. Set JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN.');
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeJqlString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// ---------------------------------------------------------------------------
// Find ALL issues matching a summary (returns array; handles duplicates).
// ---------------------------------------------------------------------------
async function findAllIssuesBySummary(http, projectKey, issueType, summary, parentKey = null) {
    const { baseUrl, headers } = http;
    const jqlParts = [
        `project = "${escapeJqlString(projectKey)}"`,
        `issuetype = "${escapeJqlString(issueType)}"`,
        `summary ~ "\\"${escapeJqlString(summary)}\\""`
    ];
    if (parentKey) jqlParts.push(`parent = "${escapeJqlString(parentKey)}"`);
    const jql = jqlParts.join(' AND ');

    try {
        const response = await axios.get(`${baseUrl}/rest/api/3/search/jql`, {
            headers,
            params: { jql, fields: 'summary,issuetype,parent,status', maxResults: 50 }
        });
        const issues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        const target = summary.trim().toLowerCase();
        return issues.filter((i) =>
            String(i.fields?.summary || '').trim().toLowerCase() === target
        );
    } catch (err) {
        console.warn(`[delete] search failed for "${summary}": ${err.response?.data?.errorMessages?.join('; ') || err.message}`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Delete an issue by key. Returns true on success, false otherwise.
// ---------------------------------------------------------------------------
async function deleteIssue(http, issueKey) {
    const { baseUrl, headers } = http;
    try {
        await axios.delete(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
            headers,
            params: { deleteSubtasks: 'true' }
        });
        return true;
    } catch (err) {
        const msg = err.response?.data?.errorMessages?.join('; ')
            || err.response?.data?.errors
            || err.message;
        console.error(`[delete] failed to delete ${issueKey}: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`);
        if (err.response?.status === 403) {
            console.error('[delete] 403 Forbidden — your Jira user needs the "Delete Issues" permission for this project.');
        }
        return false;
    }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv);

    if (!args.projectKey) {
        printUsage();
        console.error('\n[delete] ERROR: No project key. Use --project or set JIRA_PROJECT_KEY.');
        process.exit(1);
    }

    if (args.apply && !args.confirm) {
        printUsage();
        console.error('\n[delete] ERROR: --apply requires --yes to confirm destructive delete.');
        process.exit(1);
    }

    const http = getJiraConfig();

    const selectedEpics = args.onlyEpic == null
        ? EPICS
        : EPICS.filter(e => e.number === args.onlyEpic);

    if (selectedEpics.length === 0) {
        console.log(`[delete] No epic matches --only-epic ${args.onlyEpic}. Valid: ${EPICS.map(e => e.number).join(', ')}`);
        return;
    }

    console.log(`[delete] Project: ${args.projectKey}`);
    console.log(`[delete] Mode:    ${args.apply ? 'APPLY (deletes!)' : 'DRY-RUN'}`);
    console.log(`[delete] Epics:   ${selectedEpics.map(e => e.number).join(', ')}`);
    console.log('');

    let deletedStories = 0;
    let deletedEpics   = 0;
    let notFound       = 0;
    let failed         = 0;

    for (const epic of selectedEpics) {
        console.log(`\n[delete] === Epic ${epic.number}: ${epic.summary} ===`);

        const epicMatches = await findAllIssuesBySummary(http, args.projectKey, 'Epic', epic.summary);
        if (epicMatches.length === 0) {
            console.log(`[delete]   epic not found — skipping its stories.`);
            notFound += 1;
            continue;
        }
        if (epicMatches.length > 1) {
            console.log(`[delete]   WARNING: ${epicMatches.length} duplicate epics found; all will be processed.`);
        }

        for (const epicIssue of epicMatches) {
            const epicKey = epicIssue.key;
            console.log(`[delete]   epic: ${epicKey}`);

            // Delete stories under THIS epic first.
            for (const story of epic.stories) {
                const storyMatches = await findAllIssuesBySummary(http, args.projectKey, 'Story', story.summary, epicKey);
                if (storyMatches.length === 0) {
                    console.log(`[delete]     story "${story.summary}": not found`);
                    notFound += 1;
                    continue;
                }
                for (const st of storyMatches) {
                    if (!args.apply) {
                        console.log(`[delete]     [DRY-RUN] would delete story ${st.key}: ${story.summary}`);
                        deletedStories += 1;
                        continue;
                    }
                    const ok = await deleteIssue(http, st.key);
                    if (ok) {
                        console.log(`[delete]     DELETED story ${st.key}: ${story.summary}`);
                        deletedStories += 1;
                    } else {
                        failed += 1;
                    }
                    await sleep(args.delayMs);
                }
            }

            // Then delete the epic itself.
            if (!args.apply) {
                console.log(`[delete]   [DRY-RUN] would delete epic ${epicKey}: ${epic.summary}`);
                deletedEpics += 1;
                continue;
            }
            const ok = await deleteIssue(http, epicKey);
            if (ok) {
                console.log(`[delete]   DELETED epic ${epicKey}: ${epic.summary}`);
                deletedEpics += 1;
            } else {
                failed += 1;
            }
            await sleep(args.delayMs);
        }
    }

    console.log('\n[delete] Done.');
    console.log(`[delete] Stories ${args.apply ? 'deleted' : 'would-delete'}: ${deletedStories}`);
    console.log(`[delete] Epics   ${args.apply ? 'deleted' : 'would-delete'}: ${deletedEpics}`);
    console.log(`[delete] Not found: ${notFound}`);
    console.log(`[delete] Failed:    ${failed}`);
    if (!args.apply) {
        console.log('[delete] This was a DRY-RUN. Re-run with --apply --yes to actually delete.');
    }
}

main().catch((error) => {
    console.error('[delete] Fatal:', error.response?.data || error.message);
    process.exit(1);
});
