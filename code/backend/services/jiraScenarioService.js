const {
    client,
    DEFAULT_MODEL,
    SCENARIO_EFFORT,
    REASONING_SUMMARY,
    emitLlmTrace,
    extractResponseText,
    extractReasoningSummary,
    safeParseJSON
} = require('./llmService');

function toText(value) {
    return String(value || '').trim();
}

function normalizeStoryKey(storyKey) {
    return toText(storyKey).replace('-', '');
}

// Static instructions — held separately so the same prefix hashes identically
// across calls and benefits from OpenAI prompt caching.
const JIRA_SCENARIO_INSTRUCTIONS = `You are a senior QA engineer generating test scenarios for a software feature.

## Your Task
Generate a comprehensive set of test scenarios for a User Story. Each scenario must:
1. Be traceable to the given User Story (use relatedReq: "<storyKey>").
2. Be one of three types: Positive (happy path), Negative (failure / error handling), or Edge Case (boundary / unusual input).
3. Have a clear, human-readable title that describes what is being verified.
4. Have a 1-2 sentence description of the expected system behavior.
5. Have a unique ID in the format: SCN-{storyKey without dash}-{3-digit number}.

Cover at minimum: 1 positive scenario, 1 negative scenario, 1 edge case.
Generate as many additional scenarios as the story warrants — do not artificially limit to 3.

Also produce one rtmEntry summarising this story as a requirement row.

Respond only with valid JSON matching the schema. No preamble, no markdown fences.`;

function buildPrompt({ epic, story, docTexts }) {
    const cleanEpic = epic || {};
    const cleanStory = story || {};
    const docs = Array.isArray(docTexts) ? docTexts.map((d) => toText(d)).filter(Boolean) : [];

    const acceptance = toText(cleanStory.acceptanceCriteria);
    const hasAcceptance = Boolean(acceptance);
    const hasDocs = docs.length > 0;

    return `## Epic Context
Epic ID: ${toText(cleanEpic.key)}
Epic Title: ${toText(cleanEpic.summary)}
Epic Description:
${toText(cleanEpic.description)}

## User Story Under Test
Story ID: ${toText(cleanStory.key)}
Story Title: ${toText(cleanStory.summary)}
Story Description:
${toText(cleanStory.description)}
${hasAcceptance ? `\nAcceptance Criteria:\n${acceptance}\n` : ''}
${hasDocs ? `\n## Supporting Documentation\n${docs.join('\n\n---\n\n')}\n` : ''}
Use relatedReq = "${toText(cleanStory.key)}" for every scenario.
Example scenario id prefix: SCN-${normalizeStoryKey(cleanStory.key)}-001.`;
}

const JIRA_SCENARIO_SCHEMA = {
    type: 'object',
    properties: {
        scenarios: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    id:          { type: 'string' },
                    title:       { type: 'string' },
                    type:        { type: 'string', enum: ['Positive', 'Negative', 'Edge Case'] },
                    description: { type: 'string' },
                    relatedReq:  { type: 'string' }
                },
                required: ['id', 'title', 'type', 'description', 'relatedReq'],
                additionalProperties: false
            }
        },
        rtmEntry: {
            type: 'object',
            properties: {
                reqId:       { type: 'string' },
                description: { type: 'string' },
                epicKey:     { type: 'string' },
                epicSummary: { type: 'string' }
            },
            required: ['reqId', 'description', 'epicKey', 'epicSummary'],
            additionalProperties: false
        }
    },
    required: ['scenarios', 'rtmEntry'],
    additionalProperties: false
};

function normalizeResult(parsed, story, epic) {
    const cleanStory = story || {};
    const cleanEpic = epic || {};

    const scenarios = Array.isArray(parsed?.scenarios)
        ? parsed.scenarios.map((scenario) => ({
            id: toText(scenario.id),
            title: toText(scenario.title),
            type: toText(scenario.type),
            description: toText(scenario.description),
            relatedReq: toText(scenario.relatedReq) || toText(cleanStory.key)
        }))
        : [];

    const fallbackRtm = {
        reqId: toText(cleanStory.key),
        description: toText(cleanStory.summary),
        epicKey: toText(cleanEpic.key),
        epicSummary: toText(cleanEpic.summary)
    };

    const rtmEntry = {
        reqId: toText(parsed?.rtmEntry?.reqId) || fallbackRtm.reqId,
        description: toText(parsed?.rtmEntry?.description) || fallbackRtm.description,
        epicKey: toText(parsed?.rtmEntry?.epicKey) || fallbackRtm.epicKey,
        epicSummary: toText(parsed?.rtmEntry?.epicSummary) || fallbackRtm.epicSummary
    };

    return { scenarios, rtmEntry };
}

async function generateScenariosFromJiraContext({ epic, story, docTexts }) {
    const issueKey = story?.key || 'unknown-story';

    try {
        if (!client) {
            throw new Error('OpenAI client is unavailable from llmService');
        }

        const model = DEFAULT_MODEL;
        const prompt = buildPrompt({ epic, story, docTexts });

        const _jiraStartMs = Date.now();
        emitLlmTrace({ caller: 'generateScenariosFromJiraContext', model, phase: 'request', prompt });
        const response = await client.responses.create({
            model,
            instructions: JIRA_SCENARIO_INSTRUCTIONS,
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'JiraScenarios',
                    schema: JIRA_SCENARIO_SCHEMA,
                    strict: true
                }
            },
            reasoning: { effort: SCENARIO_EFFORT, summary: REASONING_SUMMARY },
            store: true
        });

        const rawText = extractResponseText(response);
        const reasoningSummary = extractReasoningSummary(response);
        emitLlmTrace({
            caller: 'generateScenariosFromJiraContext',
            model,
            phase: 'response',
            response: rawText,
            reasoningSummary,
            durationMs: Date.now() - _jiraStartMs,
            responseId: response.id
        });
        const parsed = safeParseJSON(rawText);
        return normalizeResult(parsed, story, epic);
    } catch (error) {
        console.error(`[jiraScenarioService.generateScenariosFromJiraContext] Failed for ${issueKey}:`, error.message);
        throw error;
    }
}

module.exports = {
    generateScenariosFromJiraContext
};
