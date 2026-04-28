/**
 * Seed the Pro To-Do FRD Epics (and their Stories) into Jira.
 *
 * Usage:
 *   node scripts/seedTodoJiraIssues.js -p TODO             # dry run (default)
 *   node scripts/seedTodoJiraIssues.js -p TODO --apply     # actually create
 *   node scripts/seedTodoJiraIssues.js --only-epic 2 --apply
 *   node scripts/seedTodoJiraIssues.js --force --apply     # skip idempotency
 *
 * Behaviour:
 *  - Dry-run by default; add --apply to actually write to Jira.
 *  - Skips an Epic (and its stories) if an Epic with the same summary already
 *    exists in the project — unless --force is passed.
 *  - Skips a Story if a Story with the same summary already exists under its
 *    parent Epic — unless --force is passed.
 *  - Polite 150ms delay between creates to stay well under Jira Cloud limits.
 *
 * Required env:
 *   JIRA_BASE_URL, JIRA_USER_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY (or -p)
 */

require('dotenv').config();
const axios = require('axios');

// ---------------------------------------------------------------------------
// Epic + Story data
//   - 4 epics, 20 stories, mapped directly from the Pro To-Do FRD v1.1.
//   - Keep summaries unique — we idempotency-check on them.
// ---------------------------------------------------------------------------
const EPICS = [
    {
        number: 1,
        summary: 'Authentication & Session Management',
        description: 'Secure sign-up, login, logout, and token-based session protection for all to-do operations. Maps to FR-01, FR-02, FR-03, FR-04.',
        stories: [
            {
                summary: 'Register a new account with name, email, and password',
                role: 'new user',
                want: 'to create an account with my name, email, and password',
                so: 'I can start managing my own to-dos',
                ac: [
                    'Name, email, and password are all required; missing any field returns HTTP 400 Bad Request.',
                    'If the email already exists, the server returns HTTP 409 Conflict with a clear error message.',
                    'Password is hashed with SHA-256 before being persisted — the plaintext password is never stored.',
                    'A new user record is appended to users.json with a sequential integer `id`.',
                    'A default welcome to-do is auto-created for the new user with priority `medium`.',
                    'On success the server returns HTTP 201 Created and the UI redirects to the login form.'
                ]
            },
            {
                summary: 'Log in with email and password',
                role: 'registered user',
                want: 'to log in with my email and password',
                so: 'I can access my personal to-do list',
                ac: [
                    'The server hashes the submitted password and compares it against the stored hash.',
                    'Invalid credentials return HTTP 401 Unauthorized with a generic error (no user-enumeration leak).',
                    'On success the server generates a 64-character hex session token via crypto.randomBytes(32) and stores it in sessions.json mapped to the user id.',
                    'The response returns the token, user name, and email with HTTP 200 OK.',
                    'The client persists token, name, and email in localStorage so the session survives page reloads.',
                    'The UI header updates to show the logged-in user name and email.'
                ]
            },
            {
                summary: 'Log out and terminate the current session',
                role: 'logged-in user',
                want: 'to log out',
                so: 'my session token is invalidated and no one else on this device can reach my data',
                ac: [
                    'POST /logout requires a valid Authorization header.',
                    'Missing Authorization header returns HTTP 400 Bad Request with "No token provided.".',
                    'The server removes the token entry from sessions.json, after which the token can no longer authenticate any request.',
                    'The client clears token, name, and email from localStorage and returns the UI to the login/register state.'
                ]
            },
            {
                summary: 'Session persistence and protected routes',
                role: 'logged-in user',
                want: 'my session to remain valid across page refreshes while unauthenticated requests are blocked',
                so: 'I do not have to log in repeatedly but my data stays protected',
                ac: [
                    'All to-do CRUD endpoints plus POST /logout require an Authorization header.',
                    'The requireAuth middleware validates the token against sessions.json before invoking the route handler.',
                    'Missing or invalid tokens return HTTP 401 Unauthorized.',
                    'When the client receives a 401 it clears local session state and shows the login modal.',
                    'Valid tokens resolve to the correct userId so every route operates scoped to that user.'
                ]
            }
        ]
    },
    {
        number: 2,
        summary: 'To-Do Lifecycle (CRUD)',
        description: 'Create, read, update, toggle, and delete to-do items — all scoped to the authenticated user. Maps to FR-05 through FR-10.',
        stories: [
            {
                summary: 'Create a to-do via the Add To-Do modal',
                role: 'logged-in user',
                want: 'to create a new to-do with a title, description, and optional priority',
                so: 'I can track a task I need to complete',
                ac: [
                    'Clicking the floating action button (FAB +) opens the Add To-Do modal with title, description, and priority inputs.',
                    'Title and description are required; submit is disabled when either is empty.',
                    'Priority defaults to `medium` if the user does not pick one; `completed` defaults to `false`.',
                    'Server validates that title is a non-empty string, description is a string, completed is boolean, and priority is one of `low`, `medium`, `high`.',
                    'On success the to-do is persisted with an auto-generated id, createdAt, and updatedAt, and the server returns HTTP 201 Created.',
                    'The to-do list re-renders to include the new card and the modal closes automatically.'
                ]
            },
            {
                summary: 'View all of my to-dos on the board',
                role: 'logged-in user',
                want: 'to see all of my to-dos on the board',
                so: 'I have a single view of everything I need to do',
                ac: [
                    'The to-do list auto-loads on login and on page load when a valid session already exists.',
                    'Only to-dos where userId matches the authenticated user are returned (strict data isolation).',
                    'Each card displays: status badge, priority badge, title, description, createdAt + updatedAt timestamps, and Edit/Delete/Toggle buttons.',
                    'While the GET /todos request is in flight a loading spinner is shown.',
                    'When the user has no matching to-dos an empty-state message "No todos found." is rendered.'
                ]
            },
            {
                summary: 'Retrieve a single to-do by ID',
                role: 'logged-in user',
                want: 'to fetch a single to-do by its id',
                so: 'I can read just that item or share a deep link to it',
                ac: [
                    'GET /todos/:id returns the to-do as JSON with HTTP 200 OK if it belongs to the authenticated user.',
                    'If the id does not exist the server returns HTTP 404 Not Found.',
                    'If the to-do exists but belongs to a different user the server also returns HTTP 404 (no cross-user leakage).'
                ]
            },
            {
                summary: 'Edit an existing to-do',
                role: 'logged-in user',
                want: 'to edit the title, description, completion state, and priority of one of my to-dos',
                so: 'I can keep my task list accurate',
                ac: [
                    'Clicking Edit on a card opens the modal pre-populated with the current title, description, completed state, and priority.',
                    'In edit mode the modal title becomes "Edit To-Do", the submit button reads "Save", and the completed toggle is visible (it is hidden in create mode).',
                    'On submit a PUT /todos/:id request updates the to-do and refreshes updatedAt.',
                    'If priority is omitted from the payload, the existing priority value is preserved.',
                    'Server-side validation still applies to every updated field.',
                    'Editing a to-do that does not exist or belongs to another user returns HTTP 404 Not Found.'
                ]
            },
            {
                summary: 'Toggle completion status of a to-do',
                role: 'logged-in user',
                want: 'to mark a to-do complete or active with a single click',
                so: 'I can quickly move tasks in and out of "done"',
                ac: [
                    'Clicking "Mark Complete" or "Mark Active" sends PATCH /todos/:id/toggle.',
                    'The server inverts the boolean `completed` field and refreshes updatedAt.',
                    'The toggle operation does NOT modify the priority field.',
                    'The card updates visually — the status badge colour changes and the .completed CSS class is applied/removed.',
                    'Toggling a to-do that does not exist or is not owned by the user returns HTTP 404 Not Found.'
                ]
            },
            {
                summary: 'Delete a to-do with confirmation',
                role: 'logged-in user',
                want: 'to permanently delete a to-do I no longer need',
                so: 'my board stays focused on what still matters',
                ac: [
                    'Clicking the Delete button on a card triggers a browser confirm() dialog.',
                    'If the user cancels, no request is made and the to-do remains.',
                    'If confirmed, DELETE /todos/:id removes the to-do from todos.json and the server returns the deleted record with HTTP 200 OK.',
                    'Deleting a to-do that does not exist or is not owned by the user returns HTTP 404 Not Found.',
                    'After a successful delete the to-do list re-renders without the removed item.'
                ]
            }
        ]
    },
    {
        number: 3,
        summary: 'Discovery – Search, Filter, Sort',
        description: 'Help users find and organise their to-dos with server-side search, filter, sort, and a one-click clear. Maps to FR-11, FR-12, FR-13, FR-14.',
        stories: [
            {
                summary: 'Search to-dos by keyword',
                role: 'logged-in user',
                want: 'to search my to-dos by keyword in the title or description',
                so: 'I can quickly find a specific task',
                ac: [
                    'The search input is in the control bar and fires on every keystroke (oninput).',
                    'The keyword is passed to GET /todos as the `search` query parameter.',
                    'The server performs a case-insensitive substring match against both title AND description.',
                    'A clear (×) button next to the search input resets the search and triggers a re-fetch.',
                    'Searching never returns to-dos from other users.'
                ]
            },
            {
                summary: 'Filter to-dos by status',
                role: 'logged-in user',
                want: 'to filter my to-dos by completion status',
                so: 'I can focus on only active or only completed tasks',
                ac: [
                    'The filter dropdown offers at least: All, Active, Completed.',
                    'Selecting Active calls GET /todos?filter=active and returns only to-dos where completed === false.',
                    'Selecting Completed calls GET /todos?filter=completed and returns only to-dos where completed === true.',
                    'Selecting All removes the filter query parameter and returns everything for the user.',
                    'Changing the filter triggers an immediate re-fetch and re-render.'
                ]
            },
            {
                summary: 'Filter to-dos by priority',
                role: 'logged-in user',
                want: 'to filter my to-dos by priority level',
                so: 'I can work on the most urgent tasks first',
                ac: [
                    'The filter dropdown offers Priority: High, Priority: Medium, and Priority: Low options.',
                    'Each option calls GET /todos?priority=<level> and returns only to-dos matching that priority for the authenticated user.',
                    'An invalid priority value returned by a malformed client request should not crash the server.',
                    'Priority filtering is applied server-side, not just in the client.',
                    'To-dos without a priority field (pre-v1.1 data) are treated as `medium` when filtering.'
                ]
            },
            {
                summary: 'Sort to-dos by createdAt, updatedAt, title, or priority',
                role: 'logged-in user',
                want: 'to sort my to-dos by different criteria',
                so: 'I can see the most recent, most recently updated, alphabetical, or most urgent first',
                ac: [
                    'The sort dropdown offers four options: createdAt, updatedAt, title, priority.',
                    'Default sort is `createdAt` newest first (descending).',
                    'updatedAt sort is newest first (descending).',
                    'title sort is alphabetical ascending.',
                    'priority sort orders high → medium → low.',
                    'The sort parameter is applied server-side via GET /todos?sort=<value>.'
                ]
            },
            {
                summary: 'Clear all search, filter, and sort controls in one click',
                role: 'logged-in user',
                want: 'to reset all discovery controls in one action',
                so: 'I can return to my default view without clearing each control individually',
                ac: [
                    'A "Clear Filters" button (filter_alt_off icon) is visible in the control bar.',
                    'Clicking it resets: search input to empty, filter dropdown to `all`, sort dropdown to `createdAt`.',
                    'The to-do list re-fetches and re-renders with the default parameters.',
                    'The button works regardless of which controls were previously active.'
                ]
            }
        ]
    },
    {
        number: 4,
        summary: 'Priority Levels',
        description: 'Assign, update, validate, and visually surface priority levels (low, medium, high) across creation, editing, the dedicated PATCH endpoint, and the UI. Maps to FR-15.',
        stories: [
            {
                summary: 'Set priority when creating a to-do',
                role: 'logged-in user',
                want: 'to pick a priority when I create a to-do',
                so: 'I can flag urgent tasks from the moment they are added',
                ac: [
                    'The Add To-Do modal exposes a priority dropdown defaulting to `medium`.',
                    'POST /todos accepts an optional priority field; omitting it defaults the stored value to `medium`.',
                    'POST /todos with a priority outside {low, medium, high} returns HTTP 400 Bad Request.',
                    'Every newly created to-do has a stored priority field persisted to todos.json.'
                ]
            },
            {
                summary: 'Preserve priority across toggle and partial update',
                role: 'logged-in user',
                want: 'my chosen priority to be preserved when I toggle or partially update a to-do',
                so: 'I never silently lose urgency information',
                ac: [
                    'PATCH /todos/:id/toggle inverts only the completed boolean and does NOT modify priority.',
                    'PUT /todos/:id with priority omitted preserves the existing priority value unchanged.',
                    'A to-do that existed before v1.1 without a priority field is treated as `medium` for all downstream reads and sorts.'
                ]
            },
            {
                summary: 'Update priority via the dedicated PATCH endpoint',
                role: 'logged-in user',
                want: 'a dedicated endpoint to change just the priority of a to-do',
                so: 'I can re-prioritise quickly without resending the entire to-do body',
                ac: [
                    'PATCH /todos/:id/priority with a valid value (`low`, `medium`, `high`) updates only the priority field and refreshes updatedAt.',
                    'The response is the updated to-do object with HTTP 200 OK.',
                    'PATCH /todos/:id/priority with an invalid value returns HTTP 400 Bad Request with the error "Invalid priority. Must be low, medium, or high.".',
                    'PATCH /todos/:id/priority on a non-existent or unowned to-do returns HTTP 404 Not Found with "Record not found.".',
                    'No other fields (title, description, completed) are modified by this endpoint.'
                ]
            },
            {
                summary: 'Filter and sort to-dos by priority',
                role: 'logged-in user',
                want: 'to narrow to only one priority level, or to see everything ordered by urgency',
                so: 'I can focus my attention where it matters most',
                ac: [
                    'GET /todos?priority=high returns only to-dos where priority === "high" for the authenticated user.',
                    'GET /todos?priority=medium and GET /todos?priority=low behave the same way for their levels.',
                    'GET /todos?sort=priority returns to-dos ordered high → medium → low.',
                    'Combining ?sort=priority with a filter (e.g. ?filter=active&sort=priority) returns only active to-dos, still ordered high → medium → low.'
                ]
            },
            {
                summary: 'Priority badge colour coding in the UI',
                role: 'logged-in user',
                want: 'each to-do card to visually signal its priority',
                so: 'I can spot urgent tasks at a glance without reading every card',
                ac: [
                    'Every card renders a priority badge whose CSS class matches the priority: .priority-badge.high, .medium, or .low.',
                    'High badge uses the red colour scheme (background #ffe0e0, text #c0392b).',
                    'Medium badge uses the amber colour scheme (background #fff3cd, text #b8860b).',
                    'Low badge uses the green colour scheme (background #e8f5e9, text #2e7d32).',
                    'The badge label text is "High", "Medium", or "Low" exactly, with correct capitalisation.'
                ]
            }
        ]
    }
];

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------
function parseArgs(argv) {
    const args = {
        projectKey: '',
        apply: false,
        force: false,
        onlyEpic: null,
        delayMs: 150
    };

    for (let i = 2; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--apply')  { args.apply = true; continue; }
        if (arg === '--force')  { args.force = true; continue; }
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
    console.log('  node scripts/seedTodoJiraIssues.js --project <PROJECT_KEY> [--apply]');
    console.log('');
    console.log('Options:');
    console.log('  --project, -p <key>   Jira project key (default: JIRA_PROJECT_KEY)');
    console.log('  --apply               Actually create issues (default is dry-run)');
    console.log('  --force               Skip idempotency checks (always create)');
    console.log('  --only-epic <n>       Seed only the epic with this number (1..4)');
    console.log('  --delay-ms <n>        Delay between creates in ms (default: 150)');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/seedTodoJiraIssues.js -p TODO');
    console.log('  node scripts/seedTodoJiraIssues.js -p TODO --apply');
    console.log('  node scripts/seedTodoJiraIssues.js -p TODO --only-epic 2 --apply');
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

// ---------------------------------------------------------------------------
// ADF (Atlassian Document Format) builders
// ---------------------------------------------------------------------------
function adfDoc(content) {
    return { type: 'doc', version: 1, content };
}
function adfParagraph(text) {
    return { type: 'paragraph', content: [{ type: 'text', text: String(text) }] };
}
function adfHeading(text, level = 3) {
    return { type: 'heading', attrs: { level }, content: [{ type: 'text', text: String(text) }] };
}
function adfBulletList(items) {
    return {
        type: 'bulletList',
        content: items.map((t) => ({
            type: 'listItem',
            content: [{ type: 'paragraph', content: [{ type: 'text', text: String(t) }] }]
        }))
    };
}

function buildEpicDescriptionAdf(epic) {
    return adfDoc([
        adfParagraph(epic.description),
        adfHeading(`Child Stories: ${epic.stories.length}`, 4)
    ]);
}

function buildStoryDescriptionAdf(story) {
    return adfDoc([
        adfParagraph(`As a ${story.role}, I want ${story.want}, so that ${story.so}.`),
        adfHeading('Acceptance Criteria', 3),
        adfBulletList(story.ac)
    ]);
}

// ---------------------------------------------------------------------------
// Idempotency search
// ---------------------------------------------------------------------------
function escapeJqlString(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function findIssueBySummary(http, projectKey, issueType, summary, parentKey = null) {
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
            params: { jql, fields: 'summary,issuetype,parent', maxResults: 5 }
        });
        const issues = Array.isArray(response.data?.issues) ? response.data.issues : [];
        const target = summary.trim().toLowerCase();
        return issues.find((i) =>
            String(i.fields?.summary || '').trim().toLowerCase() === target
        ) || null;
    } catch (err) {
        console.warn(`[seed] idempotency search failed for "${summary}": ${err.response?.data?.errorMessages?.join('; ') || err.message}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Create issue
// ---------------------------------------------------------------------------
async function createIssue(http, payload) {
    const { baseUrl, headers } = http;
    const response = await axios.post(`${baseUrl}/rest/api/3/issue`, payload, { headers });
    return response.data;
}

function buildEpicPayload(projectKey, epic) {
    return {
        fields: {
            project:     { key: projectKey },
            issuetype:   { name: 'Epic' },
            summary:     epic.summary,
            description: buildEpicDescriptionAdf(epic)
        }
    };
}

function buildStoryPayload(projectKey, story, epicKey) {
    return {
        fields: {
            project:     { key: projectKey },
            issuetype:   { name: 'Story' },
            summary:     story.summary,
            description: buildStoryDescriptionAdf(story),
            parent:      { key: epicKey }
        }
    };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
    const args = parseArgs(process.argv);

    if (!args.projectKey) {
        printUsage();
        console.error('\n[seed] ERROR: No project key. Use --project or set JIRA_PROJECT_KEY.');
        process.exit(1);
    }

    const http = getJiraConfig();

    const selectedEpics = args.onlyEpic == null
        ? EPICS
        : EPICS.filter(e => e.number === args.onlyEpic);

    if (selectedEpics.length === 0) {
        console.log(`[seed] No epic matches --only-epic ${args.onlyEpic}. Valid: ${EPICS.map(e => e.number).join(', ')}`);
        return;
    }

    console.log(`[seed] Project: ${args.projectKey}`);
    console.log(`[seed] Mode:    ${args.apply ? 'APPLY' : 'DRY-RUN'}${args.force ? ' (--force)' : ''}`);
    console.log(`[seed] Epics:   ${selectedEpics.map(e => e.number).join(', ')}`);
    console.log('');

    let createdEpics   = 0;
    let skippedEpics   = 0;
    let createdStories = 0;
    let skippedStories = 0;
    let failed         = 0;

    for (const epic of selectedEpics) {
        console.log(`\n[seed] === Epic ${epic.number}: ${epic.summary} ===`);

        let epicKey = null;

        if (!args.force) {
            const existing = await findIssueBySummary(http, args.projectKey, 'Epic', epic.summary);
            if (existing) {
                epicKey = existing.key;
                console.log(`[seed]   epic already exists as ${epicKey} — reusing (stories will still be idempotency-checked).`);
                skippedEpics += 1;
            }
        }

        if (!epicKey) {
            const payload = buildEpicPayload(args.projectKey, epic);
            if (!args.apply) {
                console.log(`[seed]   [DRY-RUN] would create epic: ${epic.summary}`);
            } else {
                try {
                    const created = await createIssue(http, payload);
                    epicKey = created.key;
                    console.log(`[seed]   created epic ${epicKey}: ${epic.summary}`);
                    createdEpics += 1;
                } catch (err) {
                    console.error(`[seed]   FAILED to create epic "${epic.summary}": ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
                    failed += 1;
                    continue;
                }
                await sleep(args.delayMs);
            }
        }

        for (const story of epic.stories) {
            if (!args.force && epicKey) {
                const existingStory = await findIssueBySummary(http, args.projectKey, 'Story', story.summary, epicKey);
                if (existingStory) {
                    console.log(`[seed]     skip (exists ${existingStory.key}): ${story.summary}`);
                    skippedStories += 1;
                    continue;
                }
            }

            if (!args.apply) {
                console.log(`[seed]     [DRY-RUN] would create story under ${epicKey || '(unknown-epic)'}: ${story.summary}`);
                continue;
            }

            if (!epicKey) {
                console.log(`[seed]     skip (no epic key, cannot parent): ${story.summary}`);
                continue;
            }

            try {
                const payload = buildStoryPayload(args.projectKey, story, epicKey);
                const created = await createIssue(http, payload);
                console.log(`[seed]     created story ${created.key}: ${story.summary}`);
                createdStories += 1;
            } catch (err) {
                console.error(`[seed]     FAILED to create story "${story.summary}": ${err.response?.data ? JSON.stringify(err.response.data) : err.message}`);
                failed += 1;
            }
            await sleep(args.delayMs);
        }
    }

    console.log('\n[seed] Done.');
    console.log(`[seed] Epics:   created=${createdEpics} skipped=${skippedEpics}`);
    console.log(`[seed] Stories: created=${createdStories} skipped=${skippedStories}`);
    console.log(`[seed] Failed:  ${failed}`);
    if (!args.apply) {
        console.log('[seed] This was a DRY-RUN. Re-run with --apply to actually create issues.');
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error('[seed] Fatal:', error.response?.data || error.message);
        process.exit(1);
    });
}

module.exports = { EPICS };
