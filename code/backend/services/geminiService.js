const { GoogleGenAI } = require('@google/genai');
const crypto = require('crypto');
const dotenv = require('dotenv');

/**
 * Emits a single LLM call trace to all connected Socket.IO clients.
 * Called before (phase='request') and after (phase='response') every Gemini API call.
 */
function emitLlmTrace({ caller, model, phase, prompt, response, durationMs, error }) {
    if (global.io) {
        global.io.emit('llm_trace', {
            id: crypto.randomUUID(),
            caller,
            model,
            phase,
            prompt:     phase === 'request'  ? (prompt   || '') : undefined,
            response:   phase === 'response' ? (response || '') : undefined,
            durationMs: phase === 'response' ? durationMs : undefined,
            error,
            timestamp: new Date().toISOString()
        });
    }
}

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
            testData: {
                type: "object",
                description: "Named fixture values referenced by the testScript via the injected testData variable. Keys are fixture group names (e.g. 'user', 'todo', 'loginCredentials'), values are plain objects with concrete string/number values. Must NOT be empty — every concrete input value used in the script must appear here."
            },
            testScript:  { type: "string" },
            language:    { type: "string" },
            codeFiles:   { type: "array", items: { type: "string" } },
            isRefinement:{ type: "boolean" }
        },
        required: ["testCaseId", "title", "steps", "testData", "testScript", "language", "codeFiles"]
    }
};

// ---------------------------------------------------------------------------
// testData enforcement — when the LLM returns testData: {} despite the prompt
// instructions, we scan the testScript for testData.X.Y references and build
// realistic placeholder values so the script doesn't crash on undefined access.
// ---------------------------------------------------------------------------
const FIXTURE_DEFAULTS = {
    name:        'Test User',
    email:       'testuser@example.com',
    password:    'Password123!',
    title:       'Test Todo Item',
    description: 'This is a test item',
    priority:    'high',
    completed:   false,
    id:          1,
    token:       'test-token-abc',
    search:      'test',
    status:      'active',
    sort:        'priority'
};

function inferTestDataFromScript(testScript) {
    if (!testScript) return {};

    // Match testData.group.key patterns (e.g. testData.user.email, testData.todo.title)
    const refs = new Set();
    const pattern = /testData\.(\w+)\.(\w+)/g;
    let match;
    while ((match = pattern.exec(testScript)) !== null) {
        refs.add(`${match[1]}.${match[2]}`);
    }

    // Also match testData.group (used as a whole object, e.g. .send(testData.user))
    const groupPattern = /testData\.(\w+)(?!\.\w)/g;
    const wholeGroups = new Set();
    while ((match = groupPattern.exec(testScript)) !== null) {
        // Skip if it's actually testData.group.something (already captured above)
        if (!testScript.substring(match.index).match(/^testData\.\w+\.\w+/)) {
            wholeGroups.add(match[1]);
        }
    }

    if (refs.size === 0 && wholeGroups.size === 0) return {};

    const data = {};

    for (const ref of refs) {
        const [group, key] = ref.split('.');
        if (!data[group]) data[group] = {};
        data[group][key] = FIXTURE_DEFAULTS[key] !== undefined ? FIXTURE_DEFAULTS[key] : `test_${key}`;
    }

    // Known entity templates — when a group is sent as a whole object (e.g.
    // .send(testData.user)), we ensure ALL required fields are present, not just
    // the ones individually accessed in the script.
    const ENTITY_TEMPLATES = {
        user:  { name: 'Test User', email: 'testuser@example.com', password: 'Password123!' },
        todo:  { title: 'Test Todo Item', description: 'This is a test item', priority: 'high', completed: false },
        login: { email: 'testuser@example.com', password: 'Password123!' }
    };

    for (const group of wholeGroups) {
        // Check if it's used as an array (testData.todosList[0])
        const arrPattern = new RegExp(`testData\\.${group}\\[`, 'g');
        if (arrPattern.test(testScript)) {
            if (!data[group]) {
                data[group] = [
                    { title: 'High priority item',   description: 'Test item 1', priority: 'high',   completed: false },
                    { title: 'Medium priority item',  description: 'Test item 2', priority: 'medium', completed: false },
                    { title: 'Low priority item',     description: 'Test item 3', priority: 'low',    completed: false }
                ];
            }
            continue;
        }

        // Find the best matching entity template for this group name
        const groupLower = group.toLowerCase();
        let template = null;
        for (const [entityKey, entityObj] of Object.entries(ENTITY_TEMPLATES)) {
            if (groupLower.includes(entityKey)) {
                template = entityObj;
                break;
            }
        }

        if (data[group]) {
            // Group was already populated from individual key refs — merge in
            // any missing fields from the template so .send() has all required keys
            if (template) {
                for (const [k, v] of Object.entries(template)) {
                    if (data[group][k] === undefined) data[group][k] = v;
                }
            }
        } else {
            // No individual key access found — use template or generic fallback
            data[group] = template
                ? { ...template }
                : { title: 'Test Item', description: 'Auto-generated fixture', priority: 'medium' };
        }
    }

    return data;
}

function enforceTestData(testCases) {
    for (const tc of testCases) {
        const hasData = tc.testData && typeof tc.testData === 'object' && Object.keys(tc.testData).length > 0;
        if (!hasData && tc.testScript) {
            const inferred = inferTestDataFromScript(tc.testScript);
            if (Object.keys(inferred).length > 0) {
                console.warn(`[testData-enforce] ${tc.testCaseId}: LLM returned empty testData — inferred ${Object.keys(inferred).length} group(s) from script: ${Object.keys(inferred).join(', ')}`);
                tc.testData = inferred;
            }
        }
    }
    return testCases;
}

/**
 * Generate 2-4 concrete test cases for a single scenario.
 * Returns a plain array of test case objects.
 *
 * @param {object} opts
 * @param {object} opts.scenario
 * @param {string} opts.codeContextSection
 * @param {string} opts.prDiffSection
 * @param {string} opts.dependenciesSection
 * @param {object} opts.refinementContext
 * @param {Array}  opts.alreadyGeneratedSummary - compact summaries of test cases already
 *                 generated for earlier scenarios in this run, to avoid duplication.
 *                 Each entry: { scenarioId, title, type, coveredInputs }
 */
async function generateTestCasesForScenario({ scenario, codeContextSection, prDiffSection, dependenciesSection, refinementContext, alreadyGeneratedSummary = [] }) {
    const refinementHint = refinementContext
        ? `\n[REFINEMENT] This replaces an existing test case (v${refinementContext.version}). Previous script:\n${refinementContext.testScript}\n`
        : '';

    const alreadyCoveredSection = alreadyGeneratedSummary.length > 0
        ? `\n[ALREADY COVERED IN THIS RUN — avoid duplicating this coverage]:\n` +
          alreadyGeneratedSummary.map(s =>
              `- Scenario ${s.scenarioId} | "${s.title}" (${s.type})${s.coveredInputs.length ? ` — inputs used: ${s.coveredInputs.join(', ')}` : ''}`
          ).join('\n') + '\n'
        : '';

    const prompt = `You are an expert QA engineer generating concrete, executable test cases.

Scenario to cover:
  ID: ${scenario.id}
  Description: ${scenario.description}
  Type: ${scenario.type}
  Priority: ${scenario.priority || 'Medium'}

${refinementHint}${alreadyCoveredSection}
[CHANGED CODE DIFF]:
${prDiffSection || 'No diff available.'}

[FULL FILE CONTENTS]:
${codeContextSection || 'No additional context.'}

[DEPENDENCIES / PACKAGE INFO]:
${dependenciesSection || 'Not available.'}

Generate 2-4 concrete test cases for this scenario. Each test case must:
- Have a unique testCaseId in format: TCN-${scenario.id}-<index>
- Have clear step-by-step actions with expected results (Given/When/Then style)
- Have a complete, self-contained, runnable testScript (raw code, no markdown fences)
- Set language to "javascript" or "python" based on what matches the codebase
- List the codeFiles array with paths of PR files this test case exercises
- Set isRefinement: ${refinementContext ? 'true' : 'false'}

SEPARATION OF DATA AND LOGIC (mandatory — strictly enforced):
- Every concrete input value (emails, passwords, names, titles, IDs, amounts, priorities, etc.) MUST go into testData as named keys grouped by entity.
  Example testData: { "user": { "name": "Alice", "email": "alice@test.com", "password": "Pass123!" }, "todo": { "title": "Buy milk", "priority": "high" } }
- testData must NEVER be empty {}. If the test uses any inputs at all, they belong in testData.
- The testScript must NEVER hardcode these values inline. Always reference them via the testData variable.
  Example script usage: request(app).post('/signup').send(testData.user)
- The testData variable is injected automatically as the first line of the script at runtime: const testData = <your testData JSON>;
  Do NOT declare const testData = ... yourself in the testScript.

RULES FOR THE testScript:
- The script runs inside an isolated Docker container where the full app source code is already present.
- The app's dependencies (express, etc.) are pre-installed but the server is NOT already running.
- For Node.js Express apps: use "supertest" — require the server module, pass it directly to supertest, and do NOT call app.listen() yourself.
  Example: const request = require('supertest'); const app = require('./todoServer'); const res = await request(app).post('/todos').send(testData.todo);
- Never make raw HTTP calls to localhost URLs or assume a server is running externally.
- Use CommonJS require() style (not ES modules import).
- The test framework is Jest — use describe/it/expect blocks.
- Never re-declare testData — it is already available as a variable.`;

    const _tcStartMs = Date.now();
    emitLlmTrace({ caller: 'generateTestCasesForScenario', model, phase: 'request', prompt });
    const interaction = await genAI.interactions.create({
        model,
        input: prompt,
        response_mime_type: 'application/json',
        response_format: TEST_CASE_RESPONSE_SCHEMA
    });

    const text = extractInteractionText(interaction);
    emitLlmTrace({ caller: 'generateTestCasesForScenario', model, phase: 'response', response: text, durationMs: Date.now() - _tcStartMs });
    const parsed = safeParseJSON(text);
    if (!Array.isArray(parsed)) throw new Error('generateTestCasesForScenario: expected array from LLM');

    // Guard against the LLM returning empty testData ({}) — if it does, scan
    // the testScript for testData.X.Y references and build realistic fixtures.
    enforceTestData(parsed);

    // Return the interaction id alongside the test cases so the pipeline can
    // thread it through healing calls via previous_interaction_id.
    return { testCases: parsed, interactionId: interaction.id || null };
}

/**
 * Given a failing test case, produce a repaired script.
 * Returns { repairedScript, interactionId } so the caller can chain the next heal.
 *
 * When `previousInteractionId` is supplied the API server already holds the full
 * conversation history (every prior prompt + response). We only send what is NEW —
 * the failure output and a short instruction. The model sees everything from the
 * prior turns automatically via server-side state (previous_interaction_id).
 *
 * When `previousInteractionId` is absent (e.g. the initial interaction id was not
 * stored), we fall back to the manual self-contained prompt so nothing breaks.
 *
 * NOTE: system_instruction, response_format, generation_config are interaction-scoped
 * and are NOT inherited via previous_interaction_id — they must be re-specified.
 *
 * @param {object} opts
 * @param {object} opts.testCase               - Current test case (with latest testScript)
 * @param {string} opts.failureOutput          - Output from the most recent failed attempt
 * @param {string} opts.codeContextSection
 * @param {number} opts.attemptNumber          - The attempt number about to be run (2 or 3)
 * @param {string|null} opts.previousInteractionId - id from the prior interaction to chain from
 * @param {Array}  opts.attemptHistory         - Fallback only: [{attemptNumber, scriptUsed, failureOutput}]
 */
async function repairTestCaseScript({ testCase, failureOutput, codeContextSection, attemptNumber, previousInteractionId = null, attemptHistory = [] }) {
    let input;
    const callParams = { model };

    if (previousInteractionId) {
        // Stateful path — server has the full prior conversation.
        // We only send what is new: the failure output and the repair instruction.
        // system_instruction is re-specified (it is interaction-scoped, not inherited).
        input = `The script failed on attempt ${attemptNumber - 1}. Here is the sandbox output:

[SANDBOX FAILURE OUTPUT]:
${failureOutput}

The failed script that produced this output:
${testCase.testScript}

Fix the script. If you already tried a similar approach in a previous turn and it failed, use a completely different strategy.

Return ONLY the corrected script body. No explanation, no markdown fences, no comments about what changed. Just the raw executable code.`;

        callParams.previous_interaction_id = previousInteractionId;
        callParams.system_instruction = `You are an expert test engineer fixing a failing test script.
The testData variable is already injected as the first line at runtime — do NOT redeclare it.
Do not hardcode any values that exist in testData — always reference them as testData.<group>.<key>.
Return only raw executable code with no markdown fences.`;
    } else {
        // Stateless fallback — self-contained prompt with manual history injection.
        const historySection = attemptHistory.length > 0
            ? `\n[PREVIOUS ATTEMPT HISTORY — do NOT repeat these approaches]:\n` +
              attemptHistory.map(h =>
                  `--- Attempt ${h.attemptNumber} script ---\n${h.scriptUsed}\n--- Attempt ${h.attemptNumber} failure ---\n${h.failureOutput}`
              ).join('\n\n')
            : '';

        input = `You are an expert test engineer. A test script failed during execution. Fix it.

Test Case: ${testCase.testCaseId}
Title: ${testCase.title}
Language: ${testCase.language}
Attempt number: ${attemptNumber} of 3
${historySection}
[CURRENT FAILED SCRIPT]:
${testCase.testScript}

[CURRENT SANDBOX FAILURE OUTPUT]:
${failureOutput}

[RELEVANT SOURCE CODE CONTEXT]:
${codeContextSection || 'Not available.'}

[TEST DATA]:
${JSON.stringify(testCase.testData, null, 2)}

IMPORTANT — DATA/LOGIC SEPARATION:
- The testData object above is injected automatically as "const testData = ...;" as the very first line before your script runs.
- Do NOT declare const testData = ... yourself in the returned script — it is already available.
- Do NOT hardcode any values that exist in testData. Always reference them as testData.<group>.<key>.
- If a value is missing from testData that the fixed script needs, add it to the script as a local variable, NOT by redeclaring testData.

If you already tried an approach in a previous attempt and it failed, use a different strategy this time.

Return ONLY the corrected script body. No explanation, no markdown fences, no comments about what changed. Just the raw executable code.`;
    }

    const _healStartMs = Date.now();
    emitLlmTrace({ caller: 'repairTestCaseScript', model, phase: 'request', prompt: input });
    const interaction = await genAI.interactions.create({ ...callParams, input });

    const text = extractInteractionText(interaction);
    emitLlmTrace({ caller: 'repairTestCaseScript', model, phase: 'response', response: text, durationMs: Date.now() - _healStartMs });

    const repairedScript = text.replace(/^```(?:\w+)?\n?/gm, '').replace(/^```$/gm, '').trim();
    return { repairedScript, interactionId: interaction.id || null };
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

/**
 * Generate scenarios for a single story.
 *
 * @param {object} story
 * @param {object} epicContext
 * @param {string} localDocsText
 * @param {Array}  alreadyGeneratedScenarios - compact [{scenarioId, storyId, title}] from prior
 *                 stories in the same epic fallback loop; prevents ID collisions & duplicate coverage.
 */
async function generateTestScenarios(story, epicContext, localDocsText, alreadyGeneratedScenarios = []) {
    const currentModel = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    console.log(`[Gemini] Generating scenarios for story ${story.key}...`);

    const alreadyGeneratedSection = alreadyGeneratedScenarios.length > 0
        ? `\n[ALREADY ASSIGNED SCENARIO IDs — do NOT reuse any of these IDs and avoid duplicating their coverage]:\n` +
          alreadyGeneratedScenarios.map(s => `- ${s.scenarioId} (${s.storyId}): ${s.title}`).join('\n') + '\n'
        : '';

    const prompt = `Epic: ${epicContext.key || 'N/A'} — ${epicContext.summary}
Story ID: ${story.key}
Story Title: ${story.summary}
Story Description: ${story.description || 'None'}
Acceptance Criteria: ${story.acceptanceCriteria || 'None'}
Supporting Documents: ${localDocsText || 'None'}
${alreadyGeneratedSection}
Generate a thorough set of test scenarios covering all four types (happy_path, edge_case, negative, boundary) for every acceptance criterion.
Return a JSON array where each object has: scenarioId, storyId, epicId, title, description, acceptanceCriteriaRef, type, priority.`;

    try {
        await assertTokenLimit(prompt, currentModel);
        const _scStartMs = Date.now();
        emitLlmTrace({ caller: 'generateTestScenarios', model: currentModel, phase: 'request', prompt });
        const interaction = await genAI.interactions.create({
            model: currentModel,
            input: prompt,
            systemInstruction: SCENARIO_SYSTEM_INSTRUCTION,
            response_mime_type: 'application/json',
            response_format: SCENARIO_RESPONSE_SCHEMA
        });

        const text = extractInteractionText(interaction);
        emitLlmTrace({ caller: 'generateTestScenarios', model: currentModel, phase: 'response', response: text, durationMs: Date.now() - _scStartMs });
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
        const _epicStartMs = Date.now();
        emitLlmTrace({ caller: 'generateTestScenariosForEpic', model: currentModel, phase: 'request', prompt });
        const interaction = await genAI.interactions.create({
            model: currentModel,
            input: prompt,
            systemInstruction: SCENARIO_SYSTEM_INSTRUCTION,
            response_mime_type: 'application/json',
            response_format: SCENARIO_RESPONSE_SCHEMA
        });

        const text = extractInteractionText(interaction);
        emitLlmTrace({ caller: 'generateTestScenariosForEpic', model: currentModel, phase: 'response', response: text, durationMs: Date.now() - _epicStartMs });
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
        throw new Error('Batch response was empty or invalid JSON array');
    } catch (error) {
        console.warn(`[Gemini] Batch generation failed for epic ${epicLabel} (${error.message}). Falling back to per-story calls...`);
        const allScenarios = [];
        for (const story of stories) {
            try {
                // Pass all scenarios already generated so far so the LLM
                // uses unique IDs and doesn't duplicate coverage across stories.
                const storyScenarios = await generateTestScenarios(
                    story, epicContext, localDocsText, allScenarios
                );
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
    emitLlmTrace,
    generateTestScenarios,
    generateTestScenariosForEpic,
    generateTestCasesForScenario,
    repairTestCaseScript
};
