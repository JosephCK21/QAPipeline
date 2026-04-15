const { Type } = require('@google/genai');
const { genAI } = require('./geminiService');

function safeParseJSON(text) {
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch (error) {
        const blockMatch = String(text).match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (blockMatch) {
            try {
                return JSON.parse(blockMatch[1]);
            } catch (innerError) {
                // Continue to fallback parsing.
            }
        }

        const first = String(text).indexOf('{');
        const last = String(text).lastIndexOf('}');
        if (first !== -1 && last !== -1 && last > first) {
            return JSON.parse(String(text).slice(first, last + 1));
        }

        throw error;
    }
}

function toText(value) {
    return String(value || '').trim();
}

function normalizeStoryKey(storyKey) {
    return toText(storyKey).replace('-', '');
}

function buildPrompt({ epic, story, docTexts }) {
    const cleanEpic = epic || {};
    const cleanStory = story || {};
    const docs = Array.isArray(docTexts) ? docTexts.map((d) => toText(d)).filter(Boolean) : [];

    const acceptance = toText(cleanStory.acceptanceCriteria);
    const hasAcceptance = Boolean(acceptance);
    const hasDocs = docs.length > 0;

    return `You are a senior QA engineer generating test scenarios for a software feature.

## Epic Context
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
${hasDocs ? `\n## Supporting Documentation\nThe following supplementary documents have been uploaded for additional context:\n${docs.join('\n\n---\n\n')}\n` : ''}
## Your Task
Generate a comprehensive set of test scenarios for this User Story. Each scenario must:
1. Be traceable to the User Story above (use relatedReq: "${toText(cleanStory.key)}").
2. Be one of three types: Positive (happy path), Negative (failure / error handling), or Edge Case (boundary / unusual input).
3. Have a clear, human-readable title that describes what is being verified.
4. Have a 1-2 sentence description of the expected system behavior.
5. Have a unique ID in the format: SCN-{storyKey without dash}-{3-digit number} (e.g., SCN-${normalizeStoryKey(cleanStory.key)}-001).

Cover at minimum: 1 positive scenario, 1 negative scenario, 1 edge case.
Generate as many additional scenarios as the story warrants — do not artificially limit to 3.

Also produce one rtmEntry summarising this story as a requirement row.

Respond only with valid JSON matching the schema. No preamble, no markdown fences.`;
}

function responseSchema() {
    return {
        type: Type.OBJECT,
        properties: {
            scenarios: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        id: { type: Type.STRING },
                        title: { type: Type.STRING },
                        type: { type: Type.STRING, enum: ['Positive', 'Negative', 'Edge Case'] },
                        description: { type: Type.STRING },
                        relatedReq: { type: Type.STRING }
                    },
                    required: ['id', 'title', 'type', 'description', 'relatedReq']
                }
            },
            rtmEntry: {
                type: Type.OBJECT,
                properties: {
                    reqId: { type: Type.STRING },
                    description: { type: Type.STRING },
                    epicKey: { type: Type.STRING },
                    epicSummary: { type: Type.STRING }
                },
                required: ['reqId', 'description', 'epicKey', 'epicSummary']
            }
        },
        required: ['scenarios', 'rtmEntry']
    };
}

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
        if (!genAI) {
            throw new Error('Gemini client is unavailable from geminiService');
        }

        const model = process.env.GEMINI_MODEL || 'gemma-4-31b-it';
        const prompt = buildPrompt({ epic, story, docTexts });

        const response = await genAI.models.generateContent({
            model,
            contents: prompt,
            config: {
                responseSchema: responseSchema(),
                responseMimeType: 'application/json'
            }
        });

        const parsed = safeParseJSON(response.text);
        return normalizeResult(parsed, story, epic);
    } catch (error) {
        console.error(`[jiraScenarioService.generateScenariosFromJiraContext] Failed for ${issueKey}:`, error.message);
        throw error;
    }
}

module.exports = {
    generateScenariosFromJiraContext
};
