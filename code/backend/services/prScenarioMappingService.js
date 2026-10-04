const {
    client,
    DEFAULT_MODEL,
    TESTCASE_EFFORT,
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
    MAPPING_TOKEN_BUDGET
} = require('./llmService');

const MAPPING_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        mappings: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    scenarioId:     { type: 'string' },
                    requirementId:  { type: 'string' },
                    confidence:     { type: 'number' },
                    rationale:      { type: 'string' },
                    impactedFiles:  { type: 'array', items: { type: 'string' } }
                },
                required: ['scenarioId', 'requirementId', 'confidence', 'rationale', 'impactedFiles'],
                additionalProperties: false
            }
        },
        unresolvedChanges: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    filename: { type: 'string' },
                    reason:   { type: 'string' }
                },
                required: ['filename', 'reason'],
                additionalProperties: false
            }
        }
    },
    required: ['mappings', 'unresolvedChanges'],
    additionalProperties: false
};

// Static instructions — held separately for OpenAI prompt caching.
const PR_MAPPING_INSTRUCTIONS = `You are an expert QA impact analyst.

Your job is to map which RTM test scenarios are relevant to the changes in a pull request.

MAPPING RULES:
1) Map ONLY to scenarioId values from the catalog provided in the user message — do not invent new IDs.
2) A changed file can map to multiple scenarios.
3) Only include scenarios that are genuinely affected by the code changes.
4) confidence must be a number between 0 and 1.
5) For every changed file you cannot map confidently, include it in unresolvedChanges.

Return a JSON object with "mappings" and "unresolvedChanges" arrays matching the provided schema.`;

function normalizeScenarioItem(item) {
    return {
        id: String(item?.scenarioId || item?.id || '').trim(),
        title: String(item?.title || '').trim(),
        description: String(item?.description || '').trim(),
        type: String(item?.type || '').trim(),
        storyId: String(item?.storyId || '').trim(),
        relatedReq: String(item?.relatedReq || item?.parentReq || '').trim(),
        obsolete: Boolean(item?.obsolete)
    };
}

function normalizeResult(parsed, files, scenarios) {
    const scenarioById = new Map((scenarios || []).map((s) => [s.id, s]));

    const mappings = Array.isArray(parsed?.mappings)
        ? parsed.mappings
            .map((entry) => {
                const scenarioId = String(entry?.scenarioId || '').trim();
                if (!scenarioById.has(scenarioId)) return null;
                const confidenceRaw = Number(entry?.confidence);
                const confidence = Number.isFinite(confidenceRaw)
                    ? Math.max(0, Math.min(1, confidenceRaw))
                    : 0;
                return {
                    scenarioId,
                    requirementId: String(entry?.requirementId || scenarioById.get(scenarioId)?.relatedReq || '').trim(),
                    confidence,
                    rationale: String(entry?.rationale || '').trim(),
                    impactedFiles: Array.isArray(entry?.impactedFiles)
                        ? entry.impactedFiles.map((f) => String(f || '').trim()).filter(Boolean)
                        : []
                };
            })
            .filter(Boolean)
        : [];

    const unresolvedDefault = (files || []).map((file) => ({
        filename: String(file?.filename || '').trim(),
        reason: 'No confident scenario mapping returned by model'
    })).filter((item) => item.filename);

    const unresolvedChanges = Array.isArray(parsed?.unresolvedChanges)
        ? parsed.unresolvedChanges
            .map((entry) => ({
                filename: String(entry?.filename || '').trim(),
                reason: String(entry?.reason || 'Unresolved change').trim()
            }))
            .filter((entry) => entry.filename)
        : unresolvedDefault;

    return { mappings, unresolvedChanges };
}

const CODE_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs',
    '.py', '.rb', '.java', '.go', '.cs', '.cpp', '.c', '.h',
    '.php', '.swift', '.kt', '.rs', '.scala',
    '.html', '.css', '.scss', '.sass', '.less',
    '.json', '.yaml', '.yml', '.toml', '.env',
    '.sh', '.bash', '.ps1', '.sql'
]);

function isCodeFile(filename) {
    const ext = filename.includes('.') ? '.' + filename.split('.').pop().toLowerCase() : '';
    return CODE_EXTENSIONS.has(ext);
}

async function mapPrChangesToScenarios({ prDetails, jiraRtmEntry, documentTexts = [] }) {
    const allFiles = Array.isArray(prDetails?.files) ? prDetails.files : [];
    const skipped = allFiles.filter(f => !isCodeFile(f.filename));
    const files = allFiles.filter(f => isCodeFile(f.filename));
    if (skipped.length > 0) {
        console.log(`[prScenarioMappingService] Skipping ${skipped.length} non-code file(s) from mapping: ${skipped.map(f => f.filename).join(', ')}`);
    }
    const scenarios = (Array.isArray(jiraRtmEntry?.scenarios) ? jiraRtmEntry.scenarios : [])
        .map(normalizeScenarioItem)
        .filter((scenario) => scenario.id && !scenario.obsolete);

    console.log(`[prScenarioMappingService] Files in PR: ${files.length} | Active scenarios after normalization: ${scenarios.length}`);
    if (scenarios.length > 0) {
        console.log(`[prScenarioMappingService] Scenario IDs: ${scenarios.map(s => s.id).slice(0, 10).join(', ')}`);
    }

    if (!files.length || !scenarios.length) {
        console.warn(`[prScenarioMappingService] Early return — files: ${files.length}, scenarios: ${scenarios.length}`);
        return {
            mappings: [],
            unresolvedChanges: files.map((file) => ({
                filename: String(file?.filename || '').trim(),
                reason: scenarios.length ? 'No file changes available' : 'No active scenarios available'
            })).filter((item) => item.filename)
        };
    }

    const model = DEFAULT_MODEL;

    const enrichedFiles = files.map((file) => ({
        filename: file.filename,
        status: file.status,
        patch: String(file.patch || '').slice(0, 6000),
        fullContent: String(file.content || '').slice(0, 6000)
    }));

    // Variable-only payload — the static mapping rules live in PR_MAPPING_INSTRUCTIONS.
    const rawPrompt = `SCENARIO CATALOG (these are the only valid scenarioId values):
${JSON.stringify(scenarios, null, 2)}

PULL REQUEST CONTEXT:
Title: ${prDetails?.title || 'N/A'}
Branch: ${prDetails?.branch || 'N/A'}

CHANGED FILES (with diffs and full content):
${JSON.stringify(enrichedFiles, null, 2)}

PROJECT DOCUMENTS:
${JSON.stringify(documentTexts.slice(0, 5), null, 2)}`;

    // Even with the per-file 6k char cap above, mass file changes can blow
    // past the budget — soft-trim from the middle (scenario catalog is at the
    // top; instructions are the priority for caching).
    const prompt = ensureWithinBudget(rawPrompt, MAPPING_TOKEN_BUDGET, 'mapPrChangesToScenarios');
    await assertTokenLimit(prompt, model);

    console.log(`[prScenarioMappingService] Calling LLM (${model}) with ${enrichedFiles.length} file(s) and ${scenarios.length} scenario(s)`);

    try {
        const _prStartMs = Date.now();
        emitLlmTrace({ caller: 'mapPrChangesToScenarios', model, phase: 'request', prompt, correlationKey: 'pr_mapping' });
        const response = await client.responses.create({
            model,
            instructions: PR_MAPPING_INSTRUCTIONS,
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'PrScenarioMapping',
                    schema: MAPPING_RESPONSE_SCHEMA,
                    strict: true
                },
                verbosity: OUTPUT_VERBOSITY
            },
            reasoning: { effort: TESTCASE_EFFORT, summary: REASONING_SUMMARY },
            ...buildCacheParams(CACHE_KEYS.PR_MAPPING),
            store: true
        });

        const rawText = extractResponseText(response);
        const reasoningSummary = extractReasoningSummary(response);
        const usage = extractUsage(response);
        emitLlmTrace({
            caller: 'mapPrChangesToScenarios',
            model,
            phase: 'response',
            response: rawText,
            reasoningSummary,
            durationMs: Date.now() - _prStartMs,
            responseId: response.id,
            usage,
            correlationKey: 'pr_mapping'
        });
        console.log(`[prScenarioMappingService] Raw LLM response (first 500 chars): ${rawText.slice(0, 500)}`);
        const parsed = safeParseJSON(rawText);
        console.log(`[prScenarioMappingService] Parsed mappings: ${Array.isArray(parsed?.mappings) ? parsed.mappings.length : 'parse error'}`);
        return normalizeResult(parsed, files, scenarios);
    } catch (error) {
        console.error('[prScenarioMappingService.mapPrChangesToScenarios] Failed:', error?.message, error?.status, JSON.stringify(error?.errorDetails || ''));
        return {
            mappings: [],
            unresolvedChanges: files.map((file) => ({
                filename: String(file?.filename || '').trim(),
                reason: `Mapping service error: ${error.message}`
            })).filter((item) => item.filename)
        };
    }
}

module.exports = {
    mapPrChangesToScenarios
};
