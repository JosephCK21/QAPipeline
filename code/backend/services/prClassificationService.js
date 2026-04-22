const {
    client,
    DEFAULT_MODEL,
    CLASSIFIER_EFFORT,
    REASONING_SUMMARY,
    OUTPUT_VERBOSITY,
    CACHE_KEYS,
    buildCacheParams,
    emitLlmTrace,
    extractResponseText,
    extractReasoningSummary,
    extractUsage,
    safeParseJSON,
    assertTokenLimit,
    ensureWithinBudget,
    PROMPT_TOKEN_BUDGET
} = require('./llmService');

const { fetchIssue } = require('./jiraService');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_CONFIDENCE_THRESHOLD = 0.6;

function getConfidenceThreshold() {
    const raw = Number(process.env.REGRESSION_BUGFIX_CONFIDENCE_THRESHOLD);
    if (!Number.isFinite(raw) || raw < 0 || raw > 1) return DEFAULT_CONFIDENCE_THRESHOLD;
    return raw;
}

// Match Jira-style keys like ABC-123 or QPT-4. Case-sensitive to avoid false positives.
const JIRA_KEY_PATTERN = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

// ---------------------------------------------------------------------------
// Static classifier instructions — held separately for OpenAI prompt caching.
// ---------------------------------------------------------------------------
const CLASSIFIER_INSTRUCTIONS = `You are an expert software-engineering reviewer classifying pull requests.

Your single job is to decide whether a PR is "just a bug fix" as opposed to a new feature, refactor, or behavioural change.

A PR counts as "just a bug fix" when:
- It corrects incorrect behaviour in existing functionality.
- It does NOT introduce new user-visible features, new endpoints, or new capabilities.
- It does NOT change the documented contract of existing functionality (signatures, schemas, response shapes, permissions, etc.) in a way callers would notice beyond the fix itself.
- Tiny collateral changes (error handling, null checks, type coercion, dependency bumps, comment/test tweaks) are still bug-fix territory.

Signals in the PR title / body that usually indicate a bug fix:
- "fix:", "bug:", "hotfix:", "patch:", "resolves", "fixes #..."
- Issue references pointing at Bug-type issues.

Signals AGAINST a bug fix:
- "feat:", "feature:", "add ", "new ", "implement ", "introduce ".
- Net-new files, new routes, new database columns, new config options, new UI screens.
- Refactors or rewrites where the diff is mostly reorganisation.

Return a JSON object with exactly these fields:
- isBugFix: boolean
- confidence: number between 0 and 1
- rationale: one or two short sentences explaining the verdict.`;

const CLASSIFIER_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        isBugFix:   { type: 'boolean' },
        confidence: { type: 'number' },
        rationale:  { type: 'string' }
    },
    required: ['isBugFix', 'confidence', 'rationale'],
    additionalProperties: false
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractJiraKeys(prDetails) {
    const haystack = [
        prDetails?.title || '',
        prDetails?.body || '',
        prDetails?.branch || '',
        prDetails?.headRef || ''
    ].join(' \n ');

    const keys = new Set();
    let match;
    JIRA_KEY_PATTERN.lastIndex = 0;
    while ((match = JIRA_KEY_PATTERN.exec(haystack)) !== null) {
        keys.add(match[1]);
    }
    return Array.from(keys);
}

function buildDiffDigest(prDetails, maxPatchChars = 1500, maxFiles = 20) {
    const files = Array.isArray(prDetails?.files) ? prDetails.files : [];
    const slim = files.slice(0, maxFiles).map((f) => ({
        filename: f.filename,
        status:   f.status,
        patch:    String(f.patch || '').slice(0, maxPatchChars)
    }));
    const truncatedFileNote = files.length > maxFiles
        ? `\n(${files.length - maxFiles} additional file(s) omitted from digest)`
        : '';
    return { slim, truncatedFileNote, totalFiles: files.length };
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/**
 * Classify a PR as a bug fix or not.
 *
 * Logic:
 *   1. Extract Jira keys from title / body / branch.
 *   2. For each key, fetch the Jira issue. If ANY has issueType === 'Bug',
 *      short-circuit with { isBugFix: true, source: 'jira' }.
 *   3. Otherwise ask the LLM to classify from title + body + diff digest.
 *   4. Combine: Jira Bug wins. Otherwise trust the LLM if confidence is at
 *      or above REGRESSION_BUGFIX_CONFIDENCE_THRESHOLD (default 0.6).
 *
 * Returns: { isBugFix, confidence, rationale, source, jiraIssueKeys, jiraBugKeys }
 *   source: 'jira' | 'llm' | 'both' | 'error'
 */
async function classifyPrAsBugFix({ prDetails }) {
    const jiraKeys = extractJiraKeys(prDetails);

    // 1. Jira check
    let jiraBugKeys = [];
    let jiraIssues = [];
    for (const key of jiraKeys) {
        try {
            const issue = await fetchIssue(key);
            jiraIssues.push({ key, issueType: issue?.issueType || '' });
            if (String(issue?.issueType || '').toLowerCase() === 'bug') {
                jiraBugKeys.push(key);
            }
        } catch (err) {
            console.warn(`[prClassificationService] Could not fetch Jira issue ${key}: ${err.message}`);
        }
    }

    // 2. LLM classification
    //
    // Short-circuit: if Jira already said "Bug", we trust that verdict and skip
    // the LLM call entirely to save tokens + latency. Set
    // REGRESSION_CLASSIFIER_LLM_EVEN_IF_JIRA_BUG=true to always ask the LLM for
    // a rationale regardless (useful during debugging / observability work).
    const alwaysRunLLM = String(process.env.REGRESSION_CLASSIFIER_LLM_EVEN_IF_JIRA_BUG || '').toLowerCase() === 'true';
    if (jiraBugKeys.length > 0 && !alwaysRunLLM) {
        console.log(`[prClassificationService] Jira Bug short-circuit (${jiraBugKeys.join(', ')}) — skipping LLM classifier.`);
        return {
            isBugFix:      true,
            confidence:    1,
            rationale:     `Linked Jira Bug issue(s) ${jiraBugKeys.join(', ')} — LLM classifier skipped (short-circuit).`,
            source:        'jira',
            jiraIssueKeys: jiraKeys,
            jiraBugKeys
        };
    }

    const { slim, truncatedFileNote, totalFiles } = buildDiffDigest(prDetails);

    const rawPrompt = `PR TITLE: ${prDetails?.title || '(none)'}
PR BRANCH: ${prDetails?.branch || '(none)'}
PR BODY:
${prDetails?.body || '(empty)'}

LINKED JIRA ISSUES: ${jiraIssues.length ? JSON.stringify(jiraIssues) : 'none detected'}

CHANGED FILES (${totalFiles} total):
${JSON.stringify(slim, null, 2)}${truncatedFileNote}

Classify this PR per the instructions. Return JSON only.`;

    const prompt = ensureWithinBudget(rawPrompt, PROMPT_TOKEN_BUDGET, 'classifyPrAsBugFix');
    await assertTokenLimit(prompt, DEFAULT_MODEL);

    let llmVerdict = null;
    try {
        const _start = Date.now();
        emitLlmTrace({ caller: 'classifyPrAsBugFix', model: DEFAULT_MODEL, phase: 'request', prompt });
        const response = await client.responses.create({
            model: DEFAULT_MODEL,
            instructions: CLASSIFIER_INSTRUCTIONS,
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'PrBugFixClassification',
                    schema: CLASSIFIER_RESPONSE_SCHEMA,
                    strict: true
                },
                verbosity: OUTPUT_VERBOSITY
            },
            reasoning: { effort: CLASSIFIER_EFFORT, summary: REASONING_SUMMARY },
            ...buildCacheParams(CACHE_KEYS.PR_CLASSIFICATION),
            store: true
        });

        const rawText = extractResponseText(response);
        const reasoningSummary = extractReasoningSummary(response);
        const usage = extractUsage(response);
        emitLlmTrace({
            caller: 'classifyPrAsBugFix',
            model: DEFAULT_MODEL,
            phase: 'response',
            response: rawText,
            reasoningSummary,
            durationMs: Date.now() - _start,
            responseId: response.id,
            usage
        });

        const parsed = safeParseJSON(rawText);
        if (parsed && typeof parsed === 'object') {
            llmVerdict = {
                isBugFix:   Boolean(parsed.isBugFix),
                confidence: Math.max(0, Math.min(1, Number(parsed.confidence) || 0)),
                rationale:  String(parsed.rationale || '').trim()
            };
        }
    } catch (err) {
        console.error(`[prClassificationService] LLM classification failed: ${err.message}`);
    }

    // 3. Combine
    if (jiraBugKeys.length > 0) {
        return {
            isBugFix:      true,
            confidence:    1,
            rationale:     llmVerdict?.rationale
                ? `Linked Jira Bug issue(s) ${jiraBugKeys.join(', ')} — LLM note: ${llmVerdict.rationale}`
                : `Linked Jira Bug issue(s) ${jiraBugKeys.join(', ')}`,
            source:        llmVerdict ? 'both' : 'jira',
            jiraIssueKeys: jiraKeys,
            jiraBugKeys
        };
    }

    if (!llmVerdict) {
        return {
            isBugFix:      false,
            confidence:    0,
            rationale:     'Classifier failed (no Jira Bug found and LLM call errored).',
            source:        'error',
            jiraIssueKeys: jiraKeys,
            jiraBugKeys:   []
        };
    }

    const threshold = getConfidenceThreshold();
    const passesThreshold = llmVerdict.isBugFix && llmVerdict.confidence >= threshold;

    return {
        isBugFix:      passesThreshold,
        confidence:    llmVerdict.confidence,
        rationale:     llmVerdict.isBugFix && !passesThreshold
            ? `${llmVerdict.rationale} (confidence ${llmVerdict.confidence.toFixed(2)} below threshold ${threshold})`
            : llmVerdict.rationale,
        source:        'llm',
        jiraIssueKeys: jiraKeys,
        jiraBugKeys:   []
    };
}

module.exports = {
    classifyPrAsBugFix,
    extractJiraKeys
};
