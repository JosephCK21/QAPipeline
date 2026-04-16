const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');

function safeParseJSON(text) {
    try {
        return JSON.parse(text);
    } catch(e) {
        // Try extracting from markdown code fences
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            try { return JSON.parse(fenceMatch[1]); } catch(e2) {}
        }
        // Try extracting outermost JSON array (handles trailing text after array)
        const arrStart = text.indexOf('[');
        const arrEnd = text.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
            try { return JSON.parse(text.substring(arrStart, arrEnd + 1)); } catch(e3) {}
        }
        // Try extracting outermost JSON object
        const objStart = text.indexOf('{');
        const objEnd = text.lastIndexOf('}');
        if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
            try { return JSON.parse(text.substring(objStart, objEnd + 1)); } catch(e4) {}
        }
        throw e;
    }
}

dotenv.config();

const genAI = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: { timeout: 600000 } // Extended to 10 minutes for slow generative text models
});

const MAX_TOKENS_ALLOWED = 30000;

async function assertTokenLimit(promptOrContents, modelName) {
    try {
        const response = await genAI.models.countTokens({
            model: modelName,
            contents: promptOrContents
        });
        if (response.totalTokens > MAX_TOKENS_ALLOWED) {
            throw new Error(`Token guard prevented execution: payload is ${response.totalTokens} tokens, which exceeds the maximum limit of ${MAX_TOKENS_ALLOWED} tokens.`);
        }
        console.log(`[Token Guard] Payload is safe (${response.totalTokens} tokens)`);
    } catch (err) {
        if (err.message.includes('Token guard prevented execution:')) throw err;
        console.warn('[Token Guard] Token counter failed or unsupported for this model, bypassing guard.', err.message);
    }
}

const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

// ---------------------------------------------------------------------------
// STATEFUL, BACKEND-ORCHESTRATED GENERATION — NO TOOL/FUNCTION CALLS
// ---------------------------------------------------------------------------

const TEST_CASE_RESPONSE_SCHEMA = {
    type: "array",
    items: {
        type: "object",
        properties: {
            testCaseId:  { type: "string" },
            title:       { type: "string" },
            steps: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        action:         { type: "string" },
                        expectedResult: { type: "string" }
                    },
                    required: ["action", "expectedResult"]
                }
            },
            testData:   { type: "object" },
            testScript:  { type: "string" },
            language:    { type: "string" },
            codeFiles:   { type: "array", items: { type: "string" } },
            isRefinement:{ type: "boolean" }
        },
        required: ["testCaseId", "title", "steps", "testData", "testScript", "language", "codeFiles"]
    }
};

/**
 * Generate 2-4 concrete test cases for a single scenario.
 * Returns a plain array of test case objects.
 */
async function generateTestCasesForScenario({ scenario, codeContextSection, prDiffSection, dependenciesSection, refinementContext }) {
    const refinementHint = refinementContext
        ? `\n[REFINEMENT] This replaces an existing test case (v${refinementContext.version}). Previous script:\n${refinementContext.testScript}\n`
        : '';

    const prompt = `You are an expert QA engineer generating concrete, executable test cases.

Scenario to cover:
  ID: ${scenario.id}
  Description: ${scenario.description}
  Type: ${scenario.type}
  Priority: ${scenario.priority || 'Medium'}

${refinementHint}
[CHANGED CODE DIFF]:
${prDiffSection || 'No diff available.'}

[FULL FILE CONTENTS]:
${codeContextSection || 'No additional context.'}

[DEPENDENCIES / PACKAGE INFO]:
${dependenciesSection || 'Not available.'}

Generate 2-4 concrete test cases for this scenario. Each test case must:
- Have a unique testCaseId in format: TCN-${scenario.id}-<index>
- Have clear step-by-step actions with expected results (Given/When/Then style)
- Have realistic testData with concrete input values (no placeholders)
- Have a complete, self-contained, runnable testScript (raw code, no markdown fences)
- Set language to "javascript" or "python" based on what matches the codebase
- List the codeFiles array with paths of PR files this test case exercises
- Set isRefinement: ${refinementContext ? 'true' : 'false'}

IMPORTANT RULES FOR THE testScript:
- The script runs inside an isolated Docker container where the full app source code is already present.
- The app's dependencies (express, etc.) are pre-installed but the server is NOT already running.
- For Node.js Express apps: use "supertest" — require the server module, pass it directly to supertest, and do NOT call app.listen() yourself. Example: const request = require('supertest'); const app = require('./todoServer'); const res = await request(app).post('/todos').send({...});
- Never make raw HTTP calls to localhost URLs or assume a server is running externally.
- Use CommonJS require() style (not ES modules import).
- The test framework is Jest — use describe/it/expect blocks.
- Test data must be concrete hardcoded values, never placeholders.`;

    const interaction = await genAI.interactions.create({
        model,
        input: prompt,
        response_format: TEST_CASE_RESPONSE_SCHEMA
    });

    const text = extractInteractionText(interaction);
    const parsed = safeParseJSON(text);
    if (!Array.isArray(parsed)) throw new Error('generateTestCasesForScenario: expected array from LLM');
    return parsed;
}

/**
 * Given a failing test case, produce a repaired script.
 * Returns the raw patched script string only.
 */
async function repairTestCaseScript({ testCase, failureOutput, codeContextSection, attemptNumber }) {
    const prompt = `You are an expert test engineer. A test script failed during execution. Fix it.

Test Case: ${testCase.testCaseId}
Title: ${testCase.title}
Language: ${testCase.language}
Attempt number: ${attemptNumber} of 3

[FAILED SCRIPT]:
${testCase.testScript}

[SANDBOX FAILURE OUTPUT]:
${failureOutput}

[RELEVANT SOURCE CODE CONTEXT]:
${codeContextSection || 'Not available.'}

[TEST DATA]:
${JSON.stringify(testCase.testData, null, 2)}

Return ONLY the corrected, complete, self-contained test script. No explanation, no markdown fences, no comments about what you changed. Just the raw executable code.`;

    const interaction = await genAI.interactions.create({
        model,
        input: prompt
    });

    const text = extractInteractionText(interaction);
    // Strip any accidental markdown fences
    return text.replace(/^```(?:\w+)?\n?/gm, '').replace(/^```$/gm, '').trim();
}

const SCENARIO_SYSTEM_INSTRUCTION = `You are a senior QA engineer specialising in functional and non-functional testing.
Your task is to produce concrete, actionable test scenarios — not vague checks.

Rules:
- Each scenario description must clearly state: the exact precondition, the action performed, and the expected outcome.
- Do NOT use generic phrases like "verify the system works" — be specific about data, state, and expected result.
- Cover all four types for every acceptance criterion where applicable: happy_path, edge_case, negative, boundary.
- For negative scenarios: specify exactly what invalid input or broken state is used and what error/response is expected.
- For boundary scenarios: call out the exact limit being tested (e.g. max length, zero value, first/last item).
- For edge cases: consider concurrency, empty states, special characters, or unusual but valid combinations.
- scenarioId must be unique within the array and follow the pattern SCN-<storyKey>-<index> (e.g. SCN-QPT-4-1).
- storyId must exactly match the story key (e.g. QPT-4).
- epicId must exactly match the epic key.
- Return ONLY valid JSON. No markdown fences. No explanation text.`;

// Plain JSON Schema — required by interactions.create() response_format (no Type.* enums)
const SCENARIO_RESPONSE_SCHEMA = {
    type: "array",
    items: {
        type: "object",
        properties: {
            scenarioId:            { type: "string" },
            storyId:               { type: "string" },
            epicId:                { type: "string" },
            title:                 { type: "string" },
            description:           { type: "string" },
            acceptanceCriteriaRef: { type: "array", items: { type: "string" } },
            type:                  { type: "string" },
            priority:              { type: "string" }
        },
        required: ["scenarioId", "storyId", "epicId", "title", "description", "acceptanceCriteriaRef", "type", "priority"]
    }
};

function extractInteractionText(interaction) {
    const outputs = Array.isArray(interaction.outputs) ? interaction.outputs : [];
    const textOutputs = outputs.filter(o => o.type === 'text');
    return textOutputs.length > 0 ? textOutputs[textOutputs.length - 1].text : '';
}

async function generateTestScenarios(story, epicContext, localDocsText) {
    const currentModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    console.log(`[Gemini] Generating scenarios for story ${story.key}...`);

    const prompt = `Epic: ${epicContext.key || 'N/A'} — ${epicContext.summary}
Story ID: ${story.key}
Story Title: ${story.summary}
Story Description: ${story.description || 'None'}
Acceptance Criteria: ${story.acceptanceCriteria || 'None'}
Supporting Documents: ${localDocsText || 'None'}

Generate a thorough set of test scenarios covering all four types (happy_path, edge_case, negative, boundary) for every acceptance criterion.
Return a JSON array where each object has: scenarioId, storyId, epicId, title, description, acceptanceCriteriaRef, type, priority.`;

    try {
        await assertTokenLimit(prompt, currentModel);
        const interaction = await genAI.interactions.create({
            model: currentModel,
            input: prompt,
            systemInstruction: SCENARIO_SYSTEM_INSTRUCTION,
            response_format: SCENARIO_RESPONSE_SCHEMA
        });

        const text = extractInteractionText(interaction);
        const parsed = safeParseJSON(text);
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        console.error(`[Gemini] Error generating scenarios for story ${story.key}:`, error.message);
        throw new Error(`LLM Generation Failed for Scenarios: ${error.message}`);
    }
}

async function generateTestScenariosForEpic(epicContext, stories, localDocsText) {
    const currentModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const epicLabel = epicContext.key || epicContext.summary;
    console.log(`[Gemini] Batch scenario generation for epic ${epicLabel} — ${stories.length} stories...`);

    const storiesSection = stories.map((s, i) =>
        `Story ${i + 1} — ${s.key}: ${s.summary}\nDescription: ${s.description || 'None'}\nAcceptance Criteria: ${s.acceptanceCriteria || 'None'}`
    ).join('\n\n---\n\n');

    const prompt = `Epic: ${epicContext.key || 'N/A'} — ${epicContext.summary}
Supporting Documents: ${localDocsText || 'None'}

Process ALL ${stories.length} user stories below. Generate test scenarios for EACH story.
Valid storyId values: ${stories.map(s => s.key).join(', ')}
Valid epicId value: ${epicContext.key || 'N/A'}

${storiesSection}

Return a single flat JSON array containing all scenarios for all stories.
Each object must have: scenarioId, storyId, epicId, title, description, acceptanceCriteriaRef, type, priority.
Cover all four types (happy_path, edge_case, negative, boundary) per acceptance criterion.`;

    try {
        await assertTokenLimit(prompt, currentModel);
        const interaction = await genAI.interactions.create({
            model: currentModel,
            input: prompt,
            systemInstruction: SCENARIO_SYSTEM_INSTRUCTION,
            response_format: SCENARIO_RESPONSE_SCHEMA
        });

        const text = extractInteractionText(interaction);
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        throw new Error('Batch response was empty or invalid JSON array');
    } catch (error) {
        console.warn(`[Gemini] Batch generation failed for epic ${epicLabel} (${error.message}). Falling back to per-story calls...`);
        const allScenarios = [];
        for (const story of stories) {
            try {
                const storyScenarios = await generateTestScenarios(story, epicContext, localDocsText);
                allScenarios.push(...storyScenarios);
            } catch (storyError) {
                console.error(`[Gemini] Per-story fallback also failed for ${story.key}:`, storyError.message);
            }
        }
        if (allScenarios.length === 0) {
            throw new Error(`LLM Batch Generation Failed (batch + per-story fallback both failed): ${error.message}`);
        }
        return allScenarios;
    }
}

module.exports = {
    genAI,
    generateTestScenarios,
    generateTestScenariosForEpic,
    generateTestCasesForScenario,
    repairTestCaseScript
};
