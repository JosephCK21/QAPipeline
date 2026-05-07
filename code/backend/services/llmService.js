const OpenAI = require('openai');
const crypto = require('crypto');
const dotenv = require('dotenv');
const db = require('../db');
const { buildAccountFixtureMap } = require('./defaultTestAccountsStore');

dotenv.config();

/** Per-pipeline run id for persisted LLM traces + token rollups (null = don't persist). */
let _llmTraceRunId = null;

function setLlmRunContext(runId) {
    _llmTraceRunId = runId || null;
}

function getLlmRunContext() {
    return _llmTraceRunId;
}

/** Request half of a trace, keyed for pairing with the response phase. */
const _llmPendingRequest = new Map();

function _pendingTraceKey(caller, correlationKey) {
    return `${caller}::${correlationKey || '__default__'}`;
}

// ---------------------------------------------------------------------------
// Client + config
// ---------------------------------------------------------------------------

const client = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 600000 // 10 min — long-running reasoning calls
});

const DEFAULT_MODEL = process.env.OPENAI_MODEL || 'gpt-5.4-mini';
const SCENARIO_EFFORT = process.env.OPENAI_SCENARIO_EFFORT || 'low';
const TESTCASE_EFFORT = process.env.OPENAI_TESTCASE_EFFORT || 'medium';
const HEAL_EFFORT     = process.env.OPENAI_HEAL_EFFORT     || 'high';

// Stateful mode options:
//   'conversation' (default) — use the Conversations API, one conversation per chain.
//                              Items persisted with no 30-day TTL.
//   'chain'                  — use previous_response_id chaining. Items stored 30 days.
//   'zdr'                    — no server-side storage; reasoning passed as encrypted_content
//                              items on every turn (for ZDR compliance).
const STATEFUL_MODE = (process.env.OPENAI_STATEFUL_MODE || 'conversation').toLowerCase();

const REASONING_SUMMARY = process.env.OPENAI_REASONING_SUMMARY || 'auto';

// Extended prompt cache retention. "24h" keeps cached prefixes alive for up
// to 24 hours on supported models (gpt-5.x / gpt-5.x-mini); "in_memory" falls
// back to the 5-10 min default. Supported values: 'in_memory' | '24h'.
const PROMPT_CACHE_RETENTION = process.env.OPENAI_PROMPT_CACHE_RETENTION || '24h';

// Output verbosity hint for GPT-5 series. "low" keeps ambient prose terse,
// which is ideal for our structured-output / classification callers.
const OUTPUT_VERBOSITY = process.env.OPENAI_OUTPUT_VERBOSITY || 'low';

// Reasoning effort for the PR bug-fix classifier. "low" is the fastest
// deterministic setting universally supported across gpt-5.x models (including
// gpt-5.4-mini which does NOT support "minimal"). Override via env if needed.
const CLASSIFIER_EFFORT = process.env.OPENAI_CLASSIFIER_EFFORT || 'low';

// Stable identifiers combined with the prompt-prefix hash to route requests
// that share an `instructions` prefix to the same cache machine. Essential
// for hit rate when many parallel calls share the same static instructions.
const CACHE_KEYS = {
    SCENARIO_STORY:    'qa:scenarios:story',
    SCENARIO_EPIC:     'qa:scenarios:epic',
    JIRA_SCENARIO:     'qa:scenarios:jira',
    TESTCASE_GEN:      'qa:testcases:generate',
    TESTCASE_HEAL:     'qa:testcases:heal',
    PR_MAPPING:        'qa:pr:mapping',
    PR_CLASSIFICATION: 'qa:pr:classification',
    FALLBACK_SMOKE:    'qa:fallback:generate'
};

/**
 * OpenAI Conversations API rejects concurrent requests on the same conversation id.
 * All test cases under one scenario share one conversation anchor; parallel sandbox
 * workers must not heal at the same time.
 */
const _healQueueTailByConversation = new Map();

function runHealQueued(conversationId, fn) {
    if (!conversationId) return fn();
    const prev = _healQueueTailByConversation.get(conversationId) || Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    _healQueueTailByConversation.set(conversationId, next);
    return next;
}

/**
 * Build the prompt-cache params to spread into a responses.create() call.
 * Always attaches a prompt_cache_key; includes prompt_cache_retention when a
 * non-default policy is configured.
 */
function buildCacheParams(cacheKey) {
    const params = { prompt_cache_key: cacheKey };
    if (PROMPT_CACHE_RETENTION && PROMPT_CACHE_RETENTION !== 'in_memory') {
        params.prompt_cache_retention = PROMPT_CACHE_RETENTION;
    }
    return params;
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

/**
 * Emits a single LLM call trace to all connected Socket.IO clients.
 * Called before (phase='request') and after (phase='response') every LLM call.
 */
function emitLlmTrace({
    caller, model, phase, prompt, response, reasoningSummary,
    durationMs, error, conversationId, responseId,
    usage,
    correlationKey
}) {
    const runId = _llmTraceRunId;
    const traceKey = _pendingTraceKey(caller, correlationKey);

    if (phase === 'request' && caller) {
        _llmPendingRequest.set(traceKey, {
            prompt: (prompt || '').slice(0, 120000),
            model: model || DEFAULT_MODEL
        });
    }

    if (global.io) {
        global.io.emit('llm_trace', {
            id: crypto.randomUUID(),
            caller,
            model,
            phase,
            prompt:             phase === 'request'  ? (prompt || '') : undefined,
            response:           phase === 'response' ? (response || '') : undefined,
            reasoningSummary:   phase === 'response' ? (reasoningSummary || '') : undefined,
            durationMs:         phase === 'response' ? durationMs : undefined,
            conversationId:     conversationId || undefined,
            responseId:         responseId || undefined,
            usage:              phase === 'response' ? (usage || undefined) : undefined,
            error,
            correlationKey:     correlationKey || undefined,
            timestamp: new Date().toISOString()
        });
    }

    if (phase === 'response' && runId && runId !== '__jira_sync__' && caller) {
        const pending = _llmPendingRequest.get(traceKey);
        _llmPendingRequest.delete(traceKey);
        try {
            db.insertLlmTraceRow({
                runId,
                traceLabel: caller,
                phase: 'response',
                requestPayload: pending?.prompt != null ? pending.prompt : null,
                responsePayload: [
                    response != null ? String(response).slice(0, 120000) : '',
                    reasoningSummary ? `\n--- reasoning ---\n${reasoningSummary}` : '',
                    error ? `\n--- error ---\n${error}` : ''
                ].join(''),
                tokenUsage: usage || null,
                createdAt: new Date().toISOString()
            });
            if (usage && typeof usage.inputTokens === 'number') {
                db.addRunTokenUsage(runId, {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens || 0,
                    cachedTokens: usage.cachedTokens || 0
                });
            }
        } catch (e) {
            console.warn('[LLM] Failed to persist llm_trace_row:', e.message);
        }
    }

    // Console log cache-hit telemetry so operators can verify that caching is
    // actually working without needing the UI open.
    if (phase === 'response' && usage && typeof usage.inputTokens === 'number') {
        const pct = usage.inputTokens > 0
            ? Math.round((usage.cachedTokens / usage.inputTokens) * 100)
            : 0;
        console.log(`[LLM usage] ${caller}: in=${usage.inputTokens} cached=${usage.cachedTokens} (${pct}%) out=${usage.outputTokens} reasoning=${usage.reasoningTokens}`);
    }
}

// ---------------------------------------------------------------------------
// JSON parsing safety net — rarely fires with strict schemas but kept as a
// defensive fallback for json_object mode and malformed responses.
// ---------------------------------------------------------------------------
function safeParseJSON(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) {
            try { return JSON.parse(fenceMatch[1]); } catch (e2) {}
        }
        const arrStart = text.indexOf('[');
        const arrEnd = text.lastIndexOf(']');
        if (arrStart !== -1 && arrEnd !== -1 && arrEnd > arrStart) {
            try { return JSON.parse(text.substring(arrStart, arrEnd + 1)); } catch (e3) {}
        }
        const objStart = text.indexOf('{');
        const objEnd = text.lastIndexOf('}');
        if (objStart !== -1 && objEnd !== -1 && objEnd > objStart) {
            try { return JSON.parse(text.substring(objStart, objEnd + 1)); } catch (e4) {}
        }
        throw e;
    }
}

// ---------------------------------------------------------------------------
// Local token pre-flight (tiktoken) — replaces Gemini's countTokens network call
// ---------------------------------------------------------------------------
const MAX_TOKENS_ALLOWED = 30000;

let _encoder = null;
function getEncoder() {
    if (_encoder) return _encoder;
    try {
        // o200k_base is the tokenizer used by the gpt-5 / gpt-4o family.
        const { get_encoding } = require('tiktoken');
        _encoder = get_encoding('o200k_base');
    } catch (err) {
        console.warn('[Token Guard] tiktoken unavailable, token guard will bypass:', err.message);
        _encoder = null;
    }
    return _encoder;
}

async function assertTokenLimit(promptOrContents, modelName) {
    try {
        const enc = getEncoder();
        if (!enc) return;
        const text = typeof promptOrContents === 'string'
            ? promptOrContents
            : JSON.stringify(promptOrContents);
        const tokens = enc.encode(text).length;
        if (tokens > MAX_TOKENS_ALLOWED) {
            throw new Error(`Token guard prevented execution: payload is ${tokens} tokens, which exceeds the maximum limit of ${MAX_TOKENS_ALLOWED} tokens.`);
        }
        console.log(`[Token Guard] Payload is safe (${tokens} tokens, model ${modelName})`);
    } catch (err) {
        if (err.message && err.message.includes('Token guard prevented execution:')) throw err;
        console.warn('[Token Guard] Token counter failed, bypassing guard.', err.message);
    }
}

/**
 * Soft-trim a prompt to fit within a token budget. Cuts from the MIDDLE (keeping
 * the start — usually structured rules + scenario — and the end — usually the
 * most recent context/diff) and inserts a clear marker so the model knows bytes
 * were dropped. When the encoder is unavailable, falls back to a char-length
 * heuristic (~4 chars per token for English/code).
 *
 * @param {string} text
 * @param {number} budgetTokens  hard upper bound
 * @param {string} caller        label for logs
 * @returns {string} possibly-truncated text
 */
function ensureWithinBudget(text, budgetTokens, caller = 'unknown') {
    if (typeof text !== 'string' || text.length === 0) return text || '';
    const enc = getEncoder();

    const measure = enc
        ? (s) => enc.encode(s).length
        : (s) => Math.ceil(s.length / 4);

    const initialTokens = measure(text);
    if (initialTokens <= budgetTokens) return text;

    // Drop from the middle. Keep the first 45% and last 45% of the budget.
    const headBudget = Math.floor(budgetTokens * 0.45);
    const tailBudget = Math.floor(budgetTokens * 0.45);

    const sliceByTokens = (s, tokenCount, fromEnd = false) => {
        if (!enc) {
            const charCount = tokenCount * 4;
            return fromEnd ? s.slice(-charCount) : s.slice(0, charCount);
        }
        const tokens = enc.encode(s);
        if (fromEnd) {
            const picked = tokens.slice(Math.max(0, tokens.length - tokenCount));
            return new TextDecoder().decode(enc.decode(picked));
        }
        const picked = tokens.slice(0, tokenCount);
        return new TextDecoder().decode(enc.decode(picked));
    };

    let head, tail;
    try {
        head = sliceByTokens(text, headBudget, false);
        tail = sliceByTokens(text, tailBudget, true);
    } catch (err) {
        // Fallback to naive char slice on tokenizer decode errors.
        const charBudget = budgetTokens * 4;
        head = text.slice(0, Math.floor(charBudget * 0.45));
        tail = text.slice(-Math.floor(charBudget * 0.45));
    }

    const droppedTokens = initialTokens - measure(head) - measure(tail);
    const marker = `\n\n[... ${droppedTokens} tokens truncated by prompt-budget guard — ${caller} ...]\n\n`;
    const result = head + marker + tail;
    console.warn(`[Token Guard] ${caller}: trimmed prompt from ${initialTokens} -> ${measure(result)} tokens (budget ${budgetTokens}).`);
    return result;
}

/**
 * Default soft budget per-call — leaves headroom under MAX_TOKENS_ALLOWED for
 * reasoning output. Configurable via OPENAI_PROMPT_BUDGET env.
 */
const PROMPT_TOKEN_BUDGET = (() => {
    const raw = Number(process.env.OPENAI_PROMPT_BUDGET);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return Math.floor(MAX_TOKENS_ALLOWED * 0.9);
})();

/**
 * Recognise errors from the Responses API that indicate our stored
 * conversation id or previous_response_id is no longer valid (expired,
 * deleted, or from a different org). Returns true when the caller should
 * retry the request in stateless mode.
 */
function isStaleChainError(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    const status = err.status || err.statusCode;
    const hasChainKeyword =
        msg.includes('previous_response_id') ||
        msg.includes('previous response') ||
        msg.includes('conversation') ||
        msg.includes('response_') ||   // e.g. response_xxxxx not found
        msg.includes('conv_');          // e.g. conv_xxxxx not found
    const hasNotFound = msg.includes('not found') || msg.includes("doesn't exist") || msg.includes('does not exist') || msg.includes('invalid');
    return (status === 404 || status === 400) && hasChainKeyword && hasNotFound;
}

/**
 * Recognise the transient concurrency error from the Conversations API:
 * "Another process is currently operating on this conversation."
 * Unlike stale-chain errors, these should be retried with a short backoff
 * rather than falling back to stateless mode.
 */
function isConversationBusyError(err) {
    if (!err) return false;
    const msg = String(err.message || '').toLowerCase();
    return (err.status === 400 || err.statusCode === 400) &&
           msg.includes('another process is currently operating');
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------
function extractResponseText(response) {
    if (typeof response.output_text === 'string' && response.output_text.length > 0) {
        return response.output_text;
    }
    const chunks = [];
    const output = Array.isArray(response.output) ? response.output : [];
    for (const item of output) {
        if (item.type !== 'message') continue;
        const content = Array.isArray(item.content) ? item.content : [];
        for (const c of content) {
            if (typeof c.text === 'string') chunks.push(c.text);
            else if (c.text && typeof c.text.value === 'string') chunks.push(c.text.value);
        }
    }
    return chunks.join('');
}

/**
 * Collect the reasoning summary the model produced while thinking.
 * Only populated when the request asked for `reasoning.summary = 'auto'|'concise'|'detailed'`
 * AND the model emitted one (not guaranteed on every turn).
 */
function extractReasoningSummary(response) {
    const output = Array.isArray(response.output) ? response.output : [];
    const summaries = [];
    for (const item of output) {
        if (item.type !== 'reasoning') continue;
        const summary = Array.isArray(item.summary) ? item.summary : [];
        for (const s of summary) {
            if (typeof s.text === 'string') summaries.push(s.text);
            else if (s.text && typeof s.text.value === 'string') summaries.push(s.text.value);
        }
    }
    return summaries.join('\n\n');
}

/**
 * Pull the raw reasoning items out of a response so we can re-submit them on
 * the next turn in ZDR mode. These items include encrypted_content when
 * `include: ['reasoning.encrypted_content']` was set on the request.
 */
function extractReasoningItems(response) {
    const output = Array.isArray(response.output) ? response.output : [];
    return output.filter((item) => item.type === 'reasoning');
}

/**
 * Normalise token-usage stats from a Responses API response, including
 * cache-hit telemetry. prompt_tokens_details.cached_tokens tells us how
 * many input tokens were served from cache at 40-80% discount — the key
 * signal that our static `instructions` + prompt_cache_key are working.
 */
function extractUsage(response) {
    const usage = response?.usage || {};
    const inputTokens = usage.input_tokens ?? usage.prompt_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? usage.completion_tokens ?? 0;
    const cachedTokens = usage.input_tokens_details?.cached_tokens
        ?? usage.prompt_tokens_details?.cached_tokens
        ?? 0;
    const reasoningTokens = usage.output_tokens_details?.reasoning_tokens
        ?? usage.completion_tokens_details?.reasoning_tokens
        ?? 0;
    return { inputTokens, outputTokens, cachedTokens, reasoningTokens };
}

// ---------------------------------------------------------------------------
// Conversations API helpers
// ---------------------------------------------------------------------------

/**
 * Create a new Conversation. Responses attached to a conversation share
 * context automatically — no need to thread previous_response_id.
 * Items in a conversation have no 30-day TTL.
 *
 * Returns the conversation id string, or null if the API call fails
 * (callers should fall back to previous_response_id chaining).
 */
async function createConversation(metadata = {}) {
    if (STATEFUL_MODE !== 'conversation') return null;
    try {
        const conv = await client.conversations.create({ metadata });
        return conv.id || null;
    } catch (err) {
        console.warn('[llmService] createConversation failed, falling back to previous_response_id chaining:', err.message);
        return null;
    }
}

/**
 * Build the stateful bookkeeping params (store, conversation, previous_response_id,
 * include, prior reasoning items) for a `responses.create` call based on the
 * active stateful mode and what we have available from prior turns.
 *
 * Returns: { store, conversation?, previous_response_id?, include?, _priorReasoningItems? }
 *
 * `_priorReasoningItems` is a non-API bookkeeping field — callers pass the
 * result through `applyStatefulInput()` which prepends those items to the
 * actual `input` param. Do NOT spread this straight into responses.create().
 */
function buildStatefulParams({ conversationId = null, previousResponseId = null, priorReasoningItems = [] } = {}) {
    if (STATEFUL_MODE === 'zdr') {
        return {
            store: false,
            include: ['reasoning.encrypted_content'],
            _priorReasoningItems: Array.isArray(priorReasoningItems) ? priorReasoningItems : []
        };
    }

    if (STATEFUL_MODE === 'conversation' && conversationId) {
        return { store: true, conversation: conversationId };
    }

    // 'chain' mode, or 'conversation' mode without a conversation id yet —
    // fall through to previous_response_id.
    if (previousResponseId) {
        return { store: true, previous_response_id: previousResponseId };
    }

    // First turn, nothing to chain from. Still store so future turns can.
    return { store: true };
}

/**
 * Strip the bookkeeping `_priorReasoningItems` key out of the stateful params
 * before they're spread into `responses.create(...)`. Use together with
 * `applyStatefulInput` below.
 */
function stripInternalParams(stateful) {
    const { _priorReasoningItems, ...rest } = stateful || {};
    return rest;
}

/**
 * Build the final `input` param for `responses.create`. In ZDR mode we have
 * to prepend reasoning items (with encrypted_content) from the prior turn so
 * the model retains its chain-of-thought — in every other mode the input is
 * returned untouched.
 */
function applyStatefulInput(baseInput, stateful) {
    const priorItems = stateful?._priorReasoningItems;
    if (!Array.isArray(priorItems) || priorItems.length === 0) {
        return baseInput;
    }
    const baseItems = typeof baseInput === 'string'
        ? [{ role: 'user', content: baseInput }]
        : (Array.isArray(baseInput) ? baseInput : [baseInput]);
    return [...priorItems, ...baseItems];
}

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

function buildLoginUserFixtureTemplates(accountFixtureMap, defaultAccountId) {
    const keys = accountFixtureMap && typeof accountFixtureMap === 'object' ? Object.keys(accountFixtureMap) : [];
    if (keys.length === 0) {
        return {
            user:  { name: 'Test User', email: 'testuser@example.com', password: 'Password123!' },
            login: { email: 'testuser@example.com', password: 'Password123!' }
        };
    }
    const id =
        defaultAccountId && accountFixtureMap[defaultAccountId]
            ? defaultAccountId
            : keys[0];
    const acc = accountFixtureMap[id];
    const name = (acc.displayName && String(acc.displayName).trim()) || 'Test User';
    return {
        user:  { name, email: acc.email, password: acc.password },
        login: { email: acc.email, password: acc.password }
    };
}

function pickFixtureValueForRef(group, key, accountFixtureMap) {
    const acc = accountFixtureMap && accountFixtureMap[group];
    if (!acc) {
        return FIXTURE_DEFAULTS[key] !== undefined ? FIXTURE_DEFAULTS[key] : `test_${key}`;
    }
    if (key === 'email') return acc.email;
    if (key === 'password') return acc.password;
    if (key === 'name' || key === 'displayName') {
        return (acc.displayName && String(acc.displayName).trim()) || FIXTURE_DEFAULTS[key];
    }
    return FIXTURE_DEFAULTS[key] !== undefined ? FIXTURE_DEFAULTS[key] : `test_${key}`;
}

/**
 * @param {string} testScript
 * @param {{ accountFixtureMap: Record<string, object>, defaultAccountId: string|null }|null} fixtureContext
 */
function inferTestDataFromScript(testScript, fixtureContext = null) {
    if (!testScript) return {};

    const accountFixtureMap =
        fixtureContext && fixtureContext.accountFixtureMap && typeof fixtureContext.accountFixtureMap === 'object'
            ? fixtureContext.accountFixtureMap
            : null;
    const defaultAccountId =
        fixtureContext && fixtureContext.defaultAccountId != null ? fixtureContext.defaultAccountId : null;

    const refs = new Set();
    const pattern = /testData\.(\w+)\.(\w+)/g;
    let match;
    while ((match = pattern.exec(testScript)) !== null) {
        refs.add(`${match[1]}.${match[2]}`);
    }

    const groupPattern = /testData\.(\w+)(?!\.\w)/g;
    const wholeGroups = new Set();
    while ((match = groupPattern.exec(testScript)) !== null) {
        if (!testScript.substring(match.index).match(/^testData\.\w+\.\w+/)) {
            wholeGroups.add(match[1]);
        }
    }

    if (refs.size === 0 && wholeGroups.size === 0) return {};

    const data = {};

    for (const ref of refs) {
        const [group, key] = ref.split('.');
        if (!data[group]) data[group] = {};
        data[group][key] = pickFixtureValueForRef(group, key, accountFixtureMap);
    }

    const loginUserTemplates = buildLoginUserFixtureTemplates(accountFixtureMap, defaultAccountId);

    const ENTITY_TEMPLATES = {
        user:  { name: loginUserTemplates.user.name, email: loginUserTemplates.user.email, password: loginUserTemplates.user.password },
        todo:  { title: 'Test Todo Item', description: 'This is a test item', priority: 'high', completed: false },
        login: { email: loginUserTemplates.login.email, password: loginUserTemplates.login.password }
    };

    for (const group of wholeGroups) {
        const arrPattern = new RegExp(`testData\\.${group}\\[`, 'g');
        if (arrPattern.test(testScript)) {
            if (!data[group]) {
                data[group] = [
                    { title: 'High priority item',  description: 'Test item 1', priority: 'high',   completed: false },
                    { title: 'Medium priority item', description: 'Test item 2', priority: 'medium', completed: false },
                    { title: 'Low priority item',    description: 'Test item 3', priority: 'low',    completed: false }
                ];
            }
            continue;
        }

        const groupLower = group.toLowerCase();
        let template = null;
        for (const [entityKey, entityObj] of Object.entries(ENTITY_TEMPLATES)) {
            if (groupLower.includes(entityKey)) {
                template = entityObj;
                break;
            }
        }

        if (accountFixtureMap && accountFixtureMap[group]) {
            const acc = accountFixtureMap[group];
            const accTemplate = {
                email: acc.email,
                password: acc.password,
                displayName: acc.displayName || '',
                name: (acc.displayName && String(acc.displayName).trim()) || 'Test User'
            };
            if (data[group]) {
                for (const [k, v] of Object.entries(accTemplate)) {
                    if (data[group][k] === undefined) data[group][k] = v;
                }
            } else {
                data[group] = { ...accTemplate };
            }
            continue;
        }

        if (data[group]) {
            if (template) {
                for (const [k, v] of Object.entries(template)) {
                    if (data[group][k] === undefined) data[group][k] = v;
                }
            }
        } else {
            data[group] = template
                ? { ...template }
                : { title: 'Test Item', description: 'Auto-generated fixture', priority: 'medium' };
        }
    }

    return data;
}

function formatConfiguredAccountsPromptSection(config) {
    if (!config?.accounts?.length) return '';

    const lines = config.accounts.map((a) => {
        const label = a.label ? ` (${a.label})` : '';
        const hasDn = !!(a.displayName && String(a.displayName).trim());
        const dnHint = hasDn ? ` / testData.${a.id}.displayName` : '';
        return `- id="${a.id}"${label}: use testData.${a.id}.email / testData.${a.id}.password${dnHint} — values email=${a.email} password=${a.password}${hasDn ? ` displayName="${String(a.displayName).replace(/"/g, '\\"')}"` : ''}`;
    });

    let defLine = '';
    if (config.defaultAccountId && config.accounts.some((a) => a.id === config.defaultAccountId)) {
        defLine =
            `\nWhen the scenario needs a generic user without naming a role, prefer testData.${config.defaultAccountId} (the configured default).\n`;
        defLine +=
            `If you use testData.login or testData.user, fill them with the SAME values as testData.${config.defaultAccountId}.\n`;
    }

    return (
        `\n[CONFIGURED TEST ACCOUNTS — USE ONLY THESE FOR SIGN-IN AND USER FIXTURES]:\n` +
        `${lines.join('\n')}` +
        defLine +
        `Pick the account id that fits the scenario (e.g. privileged flows use an admin id when listed). Do NOT invent random emails/passwords unless the scenario explicitly requires a user outside this list. Prefer configured accounts for logged-in behavior.\n`
    );
}

function formatConfiguredAccountsHealReminder(config) {
    if (!config?.accounts?.length) return '';
    const ids = config.accounts.map((a) => a.id).join(', ');
    const extra = config.defaultAccountId ? ` Default for generic login/user: "${config.defaultAccountId}".` : '';
    return (
        `\n[CONFIGURED TEST ACCOUNTS]: Allowed credential groups: ${ids}.${extra}` +
        ` Do NOT replace with placeholders (example.com, Password123!, etc.).`
    );
}

function enforceTestData(testCases, fixtureContext = null) {
    for (const tc of testCases) {
        const hasData = tc.testData && typeof tc.testData === 'object' && Object.keys(tc.testData).length > 0;
        if (!hasData && tc.testScript) {
            const inferred = inferTestDataFromScript(tc.testScript, fixtureContext);
            if (Object.keys(inferred).length > 0) {
                console.warn(`[testData-enforce] ${tc.testCaseId}: LLM returned empty testData — inferred ${Object.keys(inferred).length} group(s) from script: ${Object.keys(inferred).join(', ')}`);
                tc.testData = inferred;
            }
        }
    }
    return testCases;
}

/** Normalize LLM steps to { action, expectedResult } for DB + dashboard (supports legacy string[]). */
function normalizeTestCaseSteps(testCases) {
    for (const tc of testCases || []) {
        const raw = tc.steps;
        if (!Array.isArray(raw)) {
            tc.steps = [];
            continue;
        }
        tc.steps = raw.map((s) => {
            if (typeof s === 'string') {
                return { action: s.trim(), expectedResult: '' };
            }
            if (s && typeof s === 'object') {
                const action = String(s.action != null ? s.action : '')
                    || String(s.description != null ? s.description : '')
                    || String(s.text != null ? s.text : '');
                const expectedResult = String(
                    s.expectedResult != null ? s.expectedResult
                        : s.expected != null ? s.expected
                            : ''
                );
                return { action: action.trim(), expectedResult: expectedResult.trim() };
            }
            return { action: '', expectedResult: '' };
        });
    }
    return testCases;
}

// ---------------------------------------------------------------------------
// Structured Output schemas (strict json_schema)
// ---------------------------------------------------------------------------

// Root MUST be an object for strict mode — wrap arrays in { scenarios: [...] }.
const SCENARIO_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        scenarios: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    scenarioId:            { type: 'string' },
                    storyId:               { type: 'string' },
                    epicId:                { type: 'string' },
                    title:                 { type: 'string' },
                    description:           { type: 'string' },
                    acceptanceCriteriaRef: { type: 'array', items: { type: 'string' } },
                    type:                  { type: 'string' },
                    priority:              { type: 'string' }
                },
                required: ['scenarioId', 'storyId', 'epicId', 'title', 'description', 'acceptanceCriteriaRef', 'type', 'priority'],
                additionalProperties: false
            }
        }
    },
    required: ['scenarios'],
    additionalProperties: false
};

// Structural schema for test-case generation. testData is intentionally a
// free-form object (keys are arbitrary fixture group names), so this schema
// is used in non-strict mode — it enforces the SHAPE of every other field
// while leaving testData flexible. enforceTestData() remains the safety net.
const TESTCASE_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        testCases: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    testCaseId:    { type: 'string' },
                    title:         { type: 'string' },
                    steps: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                action:           { type: 'string' },
                                expectedResult:  { type: 'string' }
                            },
                            required: ['action'],
                            additionalProperties: false
                        }
                    },
                    testData:      { type: 'object', additionalProperties: true },
                    testScript:    { type: 'string' },
                    language:      { type: 'string', enum: ['javascript', 'python'] },
                    codeFiles:     { type: 'array', items: { type: 'string' } },
                    isRefinement:  { type: 'boolean' },
                    testStrategy:  { type: 'string', enum: ['e2e', 'api', 'linked'] }
                },
                required: ['testCaseId', 'title', 'steps', 'testData', 'testScript', 'language', 'codeFiles', 'isRefinement']
            }
        }
    },
    required: ['testCases']
};

/** Structured output for heal/repair — single field keeps parsing reliable. */
const HEAL_RESPONSE_SCHEMA = {
    type: 'object',
    properties: {
        testScript: { type: 'string' }
    },
    required: ['testScript'],
    additionalProperties: false
};

// ---------------------------------------------------------------------------
// Static instruction blocks — held OUTSIDE the variable prompt so the same
// prefix hashes identically on every call and benefits from OpenAI's automatic
// prompt caching (40-80% input-token discount on cache hits).
// ---------------------------------------------------------------------------

const SCENARIO_SYSTEM_INSTRUCTION = `You are a senior QA engineer specialising in functional and non-functional testing.
Your task is to produce concrete, actionable test scenarios — not vague checks.

These scenarios are consumed by an automated PR pipeline that mostly verifies behaviour through real browser E2E (Playwright)
when a user interface exists. Write scenarios so each one maps cleanly to a small set of observable checks.

Rules:
- Each scenario description must clearly state: the exact precondition, the action performed, and the expected outcome.
- Do NOT use generic phrases like "verify the system works" — be specific about data, state, and expected result.
- Where the story implies a UI: phrase the expected outcome in terms a user or tester can SEE (visible labels, messages,
  list contents, disabled buttons, empty states, navigation). Prefer role/label semantics ("Save" button, field "Email")
  over raw CSS selectors or hex colours. Reserve pixel-exact colours/classes only when the acceptance criterion truly
  demands visual design compliance.
- Where the story is API-only (no user-facing surface): state HTTP status, key response fields, and persistence or side
  effects explicitly so API-level automation can assert them. If both UI and API apply, tie them in one outcome (e.g.
  submit in UI + reflected data + optional status).
- Cover all four types for every acceptance criterion where applicable: happy_path, edge_case, negative, boundary.
- For negative scenarios: specify exactly what invalid input or broken state is used and what error/response is expected.
- For boundary scenarios: call out the exact limit being tested (e.g. max length, zero value, first/last item).
- For edge cases: consider concurrency, empty states, special characters, or unusual but valid combinations.
- Keep one clear verification focus per scenario — avoid stacking many unrelated assertions in a single description.
- scenarioId must be unique within the array and follow the pattern SCN-<storyKey>-<index> (e.g. SCN-QPT-4-1).
- storyId must exactly match the story key (e.g. QPT-4).
- epicId must exactly match the epic key.
Output shape is enforced by the API schema — no markdown or explanation, only the structured response.`;

const TESTCASE_GENERATION_INSTRUCTIONS = `You are an expert QA engineer generating concrete, executable test cases for an isolated Docker sandbox.

TESTING STRATEGY — FRONTEND-FIRST (strictly enforced):
- DEFAULT: Generate Playwright E2E tests that exercise the REAL UI in a headed browser.
  Every scenario that involves user-visible behavior (forms, navigation, data display,
  CRUD operations, authentication flows, page rendering) MUST be tested via Playwright.
- LINKED FRONTEND+API: When a scenario involves both frontend UI and backend API calls
  (e.g. form submission → POST /api/todos → result appears in list), the test MUST verify
  the full round-trip through the UI. Do NOT test the API in isolation — interact with the
  frontend that calls it and verify the result is visible on the page.
- API-ONLY FALLBACK: Use Jest+supertest ONLY for pure backend endpoints with NO frontend
  representation (e.g. webhook handlers, cron jobs, internal microservice APIs, CLI tools).
  If the API has ANY frontend page that calls it, use Playwright instead.
- NEVER generate both a Playwright test AND a Jest test for the same scenario.
- Set testStrategy to "e2e" for Playwright tests, "linked" for Playwright tests that verify
  API side-effects through the UI, or "api" for Jest+supertest API-only tests.

SEPARATION OF DATA AND LOGIC (mandatory — strictly enforced):
- Every concrete input value (emails, passwords, names, titles, IDs, amounts, priorities, etc.) MUST go into testData as named keys grouped by entity.
  Example testData: { "user": { "name": "Alice", "email": "alice@test.com", "password": "Pass123!" }, "todo": { "title": "Buy milk", "priority": "high" } }
- testData must NEVER be empty {}. If the test uses any inputs at all, they belong in testData.
- The testScript must NEVER hardcode these values inline. Always reference them via the testData variable.
  Example: await page.getByLabel('Email').fill(testData.user.email);
- The testData variable is injected automatically as the first line of the script at runtime: const testData = <your testData JSON>;
  Do NOT declare const testData = ... yourself in the testScript.

RULES FOR THE testScript:
- The script runs inside an isolated Docker container where the full app source code is already present.
- The app's dependencies (express, etc.) are pre-installed but the server is NOT already running for Jest/API tests.
- AVAILABLE TEST PACKAGES (already installed): jest, supertest, jest-environment-node, @playwright/test, fs, path, vm, crypto, and Node.js built-ins.
- DO NOT require or import packages beyond those above (no jsdom, cheerio, enzyme, testing-library, puppeteer).

PLAYWRIGHT BROWSER E2E (primary — use for ALL UI-testable scenarios):
- Use CommonJS: const { test, expect } = require('@playwright/test');
- Structure: one test.describe block containing 1-3 focused test() calls per file.
- The sandbox starts the app dev server (npm run dev or npm start) and runs Playwright against it.
- Base URL: use process.env.AUTOQA_E2E_BASE_URL if set (trimmed, no trailing slash); otherwise infer from codeContext (Vite → 5173, Next/react-scripts → 3000).
- Prefer web-first assertions on locators: await expect(page.getByRole('button', { name: /submit/i })).toBeVisible()
- Use accessibility-driven selectors (getByRole, getByLabel, getByPlaceholder, getByText) over CSS selectors.
- For linked tests: interact with the UI, then verify the result is visible in the UI.
- On failure, screenshots and video are captured automatically — do not add page.screenshot() solely for diagnostics.
- Tests run in headed mode with a live browser viewer — keep actions clear and sequential.

Jest + supertest (API-ONLY fallback — use ONLY when no frontend UI exists for the endpoint):
- For Node.js Express: use "supertest" only — require the server module, pass it to supertest, do NOT call app.listen().
  Example: const request = require('supertest'); const app = require('./todoServer'); const res = await request(app).post('/todos').send(testData.todo);
- FORBIDDEN: reaching into Express internals (app._router, middleware walking, hand-rolled req/res mocks).
- Jest structure: wrap tests in describe() and it() with async/await. Use expect() for assertions.
- Naming hygiene: never use the same identifier for a helper function and a const/let.
- Use CommonJS require() style (not ES modules import).
- Never re-declare testData — it is already available as a variable.

SERVER CLEANUP (mandatory — prevents Jest from hanging on open handles):
- Tests run with --forceExit and --runInBand, but you MUST still ensure clean teardown.
- If you store a reference to a server or HTTP agent, close it in afterAll.
- NEVER leave setInterval, setTimeout, or open socket/database connections running after tests complete.

FILE-BASED STORAGE APPS (important for apps using JSON file storage):
- If the app under test uses file-based storage (e.g. JSON files like todos.json, users.json), the sandbox resets these files to empty state ([] or {}) before each test execution.
- Each test script starts with a CLEAN, EMPTY data store. Do NOT assume any pre-existing data.
- Your test must create all the data it needs (e.g. signup a user, then login, then create todos).
- Use unique test data values per test case to reduce collision risk.

STEPS (dashboard / RTM):
- For each test case, "steps" MUST be an array of objects with "action" (string, required) and optional "expectedResult" (string).
- Each "action" is a short imperative line describing what the user or automation does; "expectedResult" is what should be observable after that step when helpful.
- Do NOT emit bare strings inside "steps" — only objects { "action": "...", "expectedResult": "..." }.

Produce 2–4 test cases per scenario; required fields and object shape are defined by the API response schema — do not echo the schema in prose.`;

const HEAL_INSTRUCTIONS = `You are an expert test engineer fixing a failing test script for an isolated Docker sandbox.
The testData variable is already injected as the first line at runtime — do NOT redeclare it.
Do not hardcode any values that exist in testData — always reference them as testData.<group>.<key>.
Fix any SyntaxError or duplicate identifier (e.g. a helper function name reused as const) — rename variables so every binding is unique.
If the script uses @playwright/test, prefer web-first assertions on locators (expect(locator)...); fix selectors, timeouts, and page.goto origins to respect process.env.AUTOQA_E2E_BASE_URL when set, otherwise match the inferred dev-server port from the repo; do not add page.screenshot() only for failure dumps — failure screenshots are automatic.
If the script uses app._router, manual middleware walking, or fake req/res mocks for an Express app, rewrite it to use supertest against the exported app with async/await and describe/it.
If the app uses file-based storage (JSON files), the data files are reset to empty ([] or {}) before each test run. The test must create all data it needs (signup, login, create records) — never assume pre-existing data.
Ensure no open handles (servers, intervals, sockets) remain after tests — add afterAll cleanup if needed.
If you already tried a similar approach in a previous turn and it failed, use a completely different strategy.
Return structured output only: JSON object with one key "testScript" whose value is the full corrected script body as a string (raw executable code, no markdown fences, no commentary outside the string).`;

/**
 * Few-shot structural templates for JSON testScript output (style/layout only — not runnable against a specific repo).
 * Injected only into generateTestCasesForScenario user input ([REFERENCE EXAMPLES] block).
 */
const FEW_SHOT_EXAMPLES = {
    javascript: `const { test, expect } = require('@playwright/test');

test.describe('StructuralExample_FrontendFirst', () => {
  test('creates a record through the UI and verifies it appears', async ({ page }) => {
    // Navigate to the app
    await page.goto('/');

    // Interact with the real UI using accessibility-driven selectors
    await page.getByPlaceholder('Enter title').fill(testData.item.title);
    await page.getByRole('button', { name: /add/i }).click();

    // Verify the result is visible in the UI
    await expect(page.getByText(testData.item.title)).toBeVisible();
  });

  test('validates required field shows error on empty submit', async ({ page }) => {
    await page.goto('/');

    // Submit empty form
    await page.getByRole('button', { name: /add/i }).click();

    // Verify error feedback appears
    await expect(page.getByText(/required/i)).toBeVisible();
  });
});`,
    python: `import pytest
from unittest.mock import MagicMock


@pytest.fixture
def test_data():
    return {"req": {"id": "stub-001"}, "expected_ok": True}


def test_structural_fixture_and_mock(test_data):
    mock_widget = MagicMock()
    mock_widget.load.return_value = {"id": "mock-record", "ok": test_data["expected_ok"]}

    out = mock_widget.load(test_data["req"]["id"])
    assert mock_widget.load.called
    assert out["ok"] is test_data["expected_ok"]
`
};

// ---------------------------------------------------------------------------
// Test case generation
//
// NOTE: testData is intentionally a dynamic free-form object (keys are arbitrary
// fixture group names). We use json_schema with strict: false so testData can be
// an open object; enforceTestData() remains the safety net if the model returns testData: {}.
// ---------------------------------------------------------------------------

/**
 * Generate 2-4 concrete test cases for a single scenario.
 *
 * Returns { testCases, interactionId, conversationId, reasoningSummary }.
 *
 * @param {object} opts
 * @param {object} opts.scenario
 * @param {string} opts.codeContextSection
 * @param {string} opts.prDiffSection
 * @param {string} opts.dependenciesSection
 * @param {object} opts.refinementContext
 * @param {Array}  opts.alreadyGeneratedSummary
 * @param {string} opts.conversationId          - attach this call to an existing conversation,
 *                                                 or pass null and we'll create one.
 * @param {string} opts.previousInteractionId   - when resuming a prior test-case generation
 *                                                 (e.g. refinement) without a conversation id.
 */

/**
 * Detects frontend files and client-side JS patterns in the provided code context.
 * Used to explicitly signal the LLM to write Playwright E2E tests instead of API tests.
 */
function detectFrontendFiles(codeContextSection) {
    const FRONTEND_EXTS = /\.(html|htm|jsx|tsx|vue|svelte|css|scss)$/i;
    const FRONTEND_DIRS = /\b(public|src|pages|components|views|client|frontend)\b/i;
    const CLIENT_JS_PATTERNS = /\b(document\.|window\.|addEventListener|querySelector|getElementById|fetch\(|XMLHttpRequest|React\.|createApp|mount\()\b/;
    
    const lines = (codeContextSection || '').split('\n');
    const frontendFiles = [];
    
    for (const line of lines) {
        const match = line.match(/^=== FILE: (.+?) ===/);
        if (match) {
            const filePath = match[1];
            if (FRONTEND_EXTS.test(filePath) || FRONTEND_DIRS.test(filePath)) {
                frontendFiles.push(filePath);
            }
        }
    }
    
    const hasClientPatterns = CLIENT_JS_PATTERNS.test(codeContextSection);
    
    return {
        frontendFiles,
        hasFrontendSignals: frontendFiles.length > 0 || hasClientPatterns
    };
}

async function generateTestCasesForScenario({
    scenario,
    codeContextSection,
    prDiffSection,
    dependenciesSection,
    refinementContext,
    alreadyGeneratedSummary = [],
    conversationId = null,
    previousInteractionId = null,
    priorReasoningItems = [],
    configuredTestAccounts = null
}) {
    if (!scenario?.id) {
        throw new Error('generateTestCasesForScenario: scenario.id is required');
    }
    const traceCorrelationKey = scenario.id;

    // Lazily create a conversation for this scenario if we don't already have one.
    let activeConversationId = conversationId;
    if (!activeConversationId && STATEFUL_MODE === 'conversation') {
        activeConversationId = await createConversation({
            caller: 'generateTestCasesForScenario',
            scenarioId: String(scenario.id)
        });
    }

    const refinementHint = refinementContext
        ? `\n[REFINEMENT] This replaces an existing test case (v${refinementContext.version || 1}). Previous script:\n${refinementContext.testScript || '(not available)'}\n`
        : '';

    const alreadyCoveredSection = alreadyGeneratedSummary.length > 0
        ? `\n[ALREADY COVERED IN THIS RUN — avoid duplicating this coverage]:\n` +
          alreadyGeneratedSummary.map(s =>
              `- Scenario ${s.scenarioId} | "${s.title}" (${s.type})${s.coveredInputs.length ? ` — inputs used: ${s.coveredInputs.join(', ')}` : ''}`
          ).join('\n') + '\n'
        : '';

    let fixtureContext = null;
    let configuredAccountsSection = '';
    if (configuredTestAccounts?.accounts?.length) {
        fixtureContext = {
            accountFixtureMap: buildAccountFixtureMap(configuredTestAccounts),
            defaultAccountId: configuredTestAccounts.defaultAccountId || null
        };
        configuredAccountsSection = formatConfiguredAccountsPromptSection(configuredTestAccounts);
    }

    // Variable-only portion (scenario-specific); the static rules live in
    // TESTCASE_GENERATION_INSTRUCTIONS for prompt caching.
    const acRef = Array.isArray(scenario.acceptanceCriteriaRef) && scenario.acceptanceCriteriaRef.length > 0
        ? `\n  Acceptance Criteria (refs): ${scenario.acceptanceCriteriaRef.join(', ')}`
        : '';
    const scenarioTitleLine = scenario.title ? `\n  Title: ${scenario.title}` : '';

    const { frontendFiles, hasFrontendSignals } = detectFrontendFiles(codeContextSection);
    const frontendDetectionSection = hasFrontendSignals
        ? `\n[FRONTEND DETECTION]:
Frontend files detected in this codebase: ${frontendFiles.slice(0, 5).join(', ')}${frontendFiles.length > 5 ? ' and more' : ''}
→ This app HAS a frontend UI. You MUST use Playwright for ALL test cases.
  Do NOT use Jest+supertest. Test through the browser UI.
  If the scenario describes REST/API actions (e.g. "POST /todos"), you MUST translate these into corresponding UI interactions. Instead of sending an HTTP request, script the browser to fill out the relevant form or click the relevant button that triggers that submission.`
        : '';

    const rawPrompt = `Scenario to cover:
  ID: ${scenario.id}${scenarioTitleLine}
  Description: ${scenario.description || '(no description provided)'}
  Type: ${scenario.type || '(unspecified)'}
  Priority: ${scenario.priority || 'Medium'}${acRef}
${frontendDetectionSection}
${refinementHint}${alreadyCoveredSection}${configuredAccountsSection}
[CHANGED CODE DIFF]:
${prDiffSection || 'No diff available.'}

[FULL FILE CONTENTS]:
${codeContextSection || 'No additional context.'}

[DEPENDENCIES / PACKAGE INFO]:
${dependenciesSection || 'Not available.'}

[REFERENCE EXAMPLES]
These snippets illustrate FORMATTING AND STYLE ONLY. They are not the repository under review; do not copy paths or mocks literally—adapt the patterns to this PR's actual modules and filenames.
At runtime JavaScript scripts receive an injected preamble: const testData = {"..."}; — the examples below reference testData the same way your testScript must (never declare const testData yourself).

--- JavaScript structural example ---
${FEW_SHOT_EXAMPLES.javascript}

--- Python structural example ---
${FEW_SHOT_EXAMPLES.python}
${(() => {
        try {
            const rows = [
                ...db.getTopReferenceExamples('playwright', 2),
                ...db.getTopReferenceExamples('jest', 0),
                ...db.getTopReferenceExamples('pytest', 1)
            ];
            if (!rows.length) return '';
            return (
                '\n[REPOSITORY-STYLE EXAMPLES — from prior passing runs, formatting only]\n' +
                rows.map((r) => `--- ${r.framework} (uses ~${r.useCount || 1}×) ---\n${String(r.scriptBody || '').slice(0, 3500)}`).join('\n\n')
            );
        } catch {
            return '';
        }
    })()}

Generate 2-4 concrete test cases for this scenario. Each test case must:
- Have a unique testCaseId in format: TCN-${scenario.id}-<index>
- Have clear step-by-step actions with expected results (Given/When/Then style)
- Have a complete, self-contained, runnable testScript (raw code, no markdown fences)
- Set language to "javascript" or "python" based on what matches the codebase
- List the codeFiles array with paths of PR files this test case exercises
- Set isRefinement: ${refinementContext ? 'true' : 'false'}
${hasFrontendSignals ? '\nCRITICAL OVERRIDE: This codebase has frontend files. Generate ONLY Playwright E2E tests.\nDo NOT generate Jest+supertest tests. testStrategy must be "e2e" or "linked" for every test case.\n' : ''}`;

    // Soft-trim oversized PRs before token guard so we never hard-fail the pipeline.
    const prompt = ensureWithinBudget(rawPrompt, PROMPT_TOKEN_BUDGET, 'generateTestCasesForScenario');
    await assertTokenLimit(prompt, DEFAULT_MODEL);

    const stateful = buildStatefulParams({
        conversationId: activeConversationId,
        previousResponseId: previousInteractionId,
        priorReasoningItems
    });
    const finalInput = applyStatefulInput(prompt, stateful);

    const _tcStartMs = Date.now();
    emitLlmTrace({
        caller: 'generateTestCasesForScenario',
        model: DEFAULT_MODEL,
        phase: 'request',
        prompt,
        conversationId: activeConversationId,
        correlationKey: traceCorrelationKey
    });

    // Retry loop for transient "conversation busy" errors from the Conversations API.
    // These occur when the prior scenario's response hasn't fully finalized before
    // the next call arrives. Exponential backoff: 2s → 4s → 8s.
    const MAX_BUSY_RETRIES = 3;
    let response;
    for (let busyAttempt = 0; ; busyAttempt++) {
        try {
            response = await client.responses.create({
                model: DEFAULT_MODEL,
                instructions: TESTCASE_GENERATION_INSTRUCTIONS,
                input: finalInput,
                text: {
                    format: {
                        type: 'json_schema',
                        name: 'TestCases',
                        schema: TESTCASE_RESPONSE_SCHEMA,
                        strict: false
                    },
                    verbosity: OUTPUT_VERBOSITY
                },
                reasoning: { effort: TESTCASE_EFFORT, summary: REASONING_SUMMARY },
                ...buildCacheParams(CACHE_KEYS.TESTCASE_GEN),
                ...stripInternalParams(stateful)
            });
            break; // success — exit retry loop
        } catch (busyErr) {
            if (isConversationBusyError(busyErr) && busyAttempt < MAX_BUSY_RETRIES) {
                const delayMs = 2000 * Math.pow(2, busyAttempt); // 2s, 4s, 8s
                console.log(`[LLM] Conversation busy — retrying in ${delayMs}ms (attempt ${busyAttempt + 1}/${MAX_BUSY_RETRIES})`);
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            throw busyErr; // non-retryable or exhausted retries
        }
    }

    const text = extractResponseText(response);
    const reasoningSummary = extractReasoningSummary(response);
    const usage = extractUsage(response);
    const reasoningItems = extractReasoningItems(response);
    emitLlmTrace({
        caller: 'generateTestCasesForScenario',
        model: DEFAULT_MODEL,
        phase: 'response',
        response: text,
        reasoningSummary,
        durationMs: Date.now() - _tcStartMs,
        conversationId: activeConversationId,
        responseId: response.id,
        usage,
        correlationKey: traceCorrelationKey
    });

    const parsed = safeParseJSON(text);
    const testCases = Array.isArray(parsed)
        ? parsed
        : (Array.isArray(parsed?.testCases) ? parsed.testCases : null);
    if (!testCases) throw new Error('generateTestCasesForScenario: expected testCases array from LLM');

    normalizeTestCaseSteps(testCases);
    enforceTestData(testCases, fixtureContext);

    return {
        testCases,
        interactionId: response.id || null,
        conversationId: activeConversationId,
        reasoningSummary,
        reasoningItems,
        usage
    };
}

/**
 * Given a failing test case, produce a repaired script.
 * Returns { repairedScript, interactionId, conversationId, reasoningSummary }
 * so the caller can chain the next heal.
 *
 * State-threading preference (in order):
 *   1. conversationId (conversation mode) — preferred
 *   2. previousInteractionId (chain mode or conversation fallback)
 *   3. attemptHistory stuffed into the prompt (stateless fallback)
 *
 * @param {object} opts
 * @param {object} opts.testCase                - Current test case (with latest testScript)
 * @param {string} opts.failureOutput           - Output from the most recent failed attempt
 * @param {string} opts.codeContextSection
 * @param {number} opts.attemptNumber           - The attempt number about to be run (2 or 3)
 * @param {string|null} opts.conversationId     - Conversation to attach this call to
 * @param {string|null} opts.previousInteractionId - id from the prior response to chain from
 * @param {Array}  opts.attemptHistory          - Fallback only: [{attemptNumber, scriptUsed, failureOutput}]
 */
async function repairTestCaseScript({
    testCase,
    failureOutput,
    codeContextSection,
    attemptNumber,
    conversationId = null,
    previousInteractionId = null,
    priorReasoningItems = [],
    attemptHistory = [],
    scenarioDescription = '',
    configuredTestAccounts = null
}) {
    if (!testCase?.testCaseId) {
        throw new Error('repairTestCaseScript: testCase.testCaseId is required');
    }

    return runHealQueued(conversationId, async () => {
    let healPatternSection = '';
    try {
        if (testCase?.scenarioId) {
            const rows = db.findHealPatternsForScenario(testCase.scenarioId);
            if (rows?.length) {
                healPatternSection =
                    `\n[PAST SUCCESSFUL FIXES ON THIS SCENARIO — use as strategy hints only]:\n` +
                    rows.map((r) => `- ${String(r.workingFixSummary || '').trim() || '(no summary)'}`).join('\n') +
                    '\n';
            }
        }
    } catch {
        healPatternSection = '';
    }

    const configuredAccountsHealReminder = formatConfiguredAccountsHealReminder(configuredTestAccounts || null);

    let input;
    const hasState = Boolean(conversationId) || Boolean(previousInteractionId);

    if (hasState) {
        // Stateful path — the prior turn's script, instructions, and failure
        // reasoning are already in context. We only send what is NEW.
        input = `The script failed on attempt ${attemptNumber - 1}. Here is the sandbox output:

[SANDBOX FAILURE OUTPUT]:
${failureOutput}

The failed script that produced this output:
${testCase.testScript}

Fix the script.${configuredAccountsHealReminder}${healPatternSection}`;
    } else {
        // Stateless fallback — self-contained prompt with manual history injection.
        const historySection = attemptHistory.length > 0
            ? `\n[PREVIOUS ATTEMPT HISTORY — do NOT repeat these approaches]:\n` +
              attemptHistory.map(h =>
                  `--- Attempt ${h.attemptNumber} script ---\n${h.scriptUsed}\n--- Attempt ${h.attemptNumber} failure ---\n${h.failureOutput}`
              ).join('\n\n')
            : '';

        const intentSection = scenarioDescription
            ? `\n[WHAT THIS TEST VERIFIES]:\n${scenarioDescription}\n`
            : '';

        input = `A test script failed during execution. Fix it.

Test Case: ${testCase.testCaseId}
Title: ${testCase.title}
Language: ${testCase.language}
Attempt number: ${attemptNumber} of 3
${intentSection}${healPatternSection}${historySection}
[CURRENT FAILED SCRIPT]:
${testCase.testScript}

[CURRENT SANDBOX FAILURE OUTPUT]:
${failureOutput}

[RELEVANT SOURCE CODE CONTEXT]:
${codeContextSection || 'Not available.'}

[TEST DATA]:
${JSON.stringify(testCase.testData, null, 2)}

If you already tried an approach in a previous attempt and it failed, use a different strategy this time.${configuredAccountsHealReminder}`;
    }

    // Soft-trim before token guard — heal prompts can be large when the
    // stateless fallback path is taken (full code context + attempt history).
    input = ensureWithinBudget(input, PROMPT_TOKEN_BUDGET, 'repairTestCaseScript');
    await assertTokenLimit(input, DEFAULT_MODEL);

    const stateful = buildStatefulParams({
        conversationId,
        previousResponseId: previousInteractionId,
        priorReasoningItems
    });
    const finalInput = applyStatefulInput(input, stateful);

    const _healStartMs = Date.now();
    emitLlmTrace({
        caller: 'repairTestCaseScript',
        model: DEFAULT_MODEL,
        phase: 'request',
        prompt: input,
        conversationId,
        correlationKey: testCase.testCaseId
    });

    const callOpenAI = async (statefulParams, inputPayload) => {
        const MAX_BUSY_RETRIES = 5;
        for (let busyAttempt = 0; ; busyAttempt++) {
            try {
                return await client.responses.create({
                    model: DEFAULT_MODEL,
                    instructions: HEAL_INSTRUCTIONS,
                    input: inputPayload,
                    text: {
                        format: {
                            type: 'json_schema',
                            name: 'HealedTestScript',
                            schema: HEAL_RESPONSE_SCHEMA,
                            strict: true
                        },
                        verbosity: OUTPUT_VERBOSITY
                    },
                    reasoning: { effort: HEAL_EFFORT, summary: REASONING_SUMMARY },
                    ...buildCacheParams(CACHE_KEYS.TESTCASE_HEAL),
                    ...stripInternalParams(statefulParams)
                });
            } catch (err) {
                if (err?.error?.message?.includes('Another process is currently operating on this conversation') && busyAttempt < MAX_BUSY_RETRIES) {
                    const delayMs = Math.pow(2, busyAttempt) * 2000;
                    console.warn(`[LLM] Heal conversation busy — retrying in ${delayMs}ms (attempt ${busyAttempt + 1}/${MAX_BUSY_RETRIES})`);
                    await new Promise(r => setTimeout(r, delayMs));
                    continue;
                }
                throw err;
            }
        }
    };

    let response;
    let chainWasStale = false;
    try {
        response = await callOpenAI(stateful, finalInput);
    } catch (err) {
        if (hasState && isStaleChainError(err)) {
            chainWasStale = true;
            console.warn(`[repairTestCaseScript] Stored chain anchor is stale (${err.status || '?'}): ${err.message}. Retrying stateless.`);
            // Re-plan: stateless fallback. Rebuild the long self-contained prompt.
            const historySection = attemptHistory.length > 0
                ? `\n[PREVIOUS ATTEMPT HISTORY — do NOT repeat these approaches]:\n` +
                  attemptHistory.map(h =>
                      `--- Attempt ${h.attemptNumber} script ---\n${h.scriptUsed}\n--- Attempt ${h.attemptNumber} failure ---\n${h.failureOutput}`
                  ).join('\n\n')
                : '';
            let fallbackInput = `A test script failed during execution. Fix it.

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

If you already tried an approach in a previous attempt and it failed, use a different strategy this time.${configuredAccountsHealReminder}`;
            fallbackInput = ensureWithinBudget(fallbackInput, PROMPT_TOKEN_BUDGET, 'repairTestCaseScript:fallback');
            await assertTokenLimit(fallbackInput, DEFAULT_MODEL);
            const statelessParams = buildStatefulParams({}); // no conversation, no previous_response_id
            response = await callOpenAI(statelessParams, fallbackInput);
        } else {
            throw err;
        }
    }

    const text = extractResponseText(response);
    const reasoningSummary = extractReasoningSummary(response);
    const usage = extractUsage(response);
    const reasoningItems = extractReasoningItems(response);
    emitLlmTrace({
        caller: 'repairTestCaseScript',
        model: DEFAULT_MODEL,
        phase: 'response',
        response: text,
        reasoningSummary,
        durationMs: Date.now() - _healStartMs,
        conversationId,
        responseId: response.id,
        usage,
        correlationKey: testCase.testCaseId
    });

    let repairedScript = '';
    try {
        const parsed = safeParseJSON(text);
        if (parsed && typeof parsed.testScript === 'string') repairedScript = parsed.testScript.trim();
    } catch (_) {
        repairedScript = '';
    }
    if (!repairedScript) {
        repairedScript = String(text || '').replace(/^```(?:\w+)?\n?/gm, '').replace(/^```$/gm, '').trim();
    }
    return {
        repairedScript,
        interactionId: response.id || null,
        // When the chain was stale, the previous conversationId is meaningless —
        // signal that to the caller by returning null so it stops retrying the
        // same dead anchor on subsequent attempts.
        conversationId: chainWasStale ? null : conversationId,
        chainWasStale,
        reasoningSummary,
        reasoningItems,
        usage
    };
    });
}

// ---------------------------------------------------------------------------
// Scenario generation (per-story and per-epic) — one-shot calls, no chaining.
// ---------------------------------------------------------------------------

async function generateTestScenarios(story, epicContext, localDocsText, alreadyGeneratedScenarios = []) {
    const currentModel = DEFAULT_MODEL;
    console.log(`[LLM] Generating scenarios for story ${story.key}...`);

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
Bias descriptions toward outcomes that can be verified in a browser when the product has a UI; keep API-only stories precise for HTTP/persistence checks.
Structured response shape is enforced by the API — focus on substantive scenario content.`;

    try {
        await assertTokenLimit(prompt, currentModel);
        const _scStartMs = Date.now();
        emitLlmTrace({ caller: 'generateTestScenarios', model: currentModel, phase: 'request', prompt });
        const response = await client.responses.create({
            model: currentModel,
            instructions: SCENARIO_SYSTEM_INSTRUCTION,
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'Scenarios',
                    schema: SCENARIO_RESPONSE_SCHEMA,
                    strict: true
                },
                verbosity: OUTPUT_VERBOSITY
            },
            reasoning: { effort: SCENARIO_EFFORT, summary: REASONING_SUMMARY },
            ...buildCacheParams(CACHE_KEYS.SCENARIO_STORY),
            store: true
        });

        const text = extractResponseText(response);
        const reasoningSummary = extractReasoningSummary(response);
        const usage = extractUsage(response);
        emitLlmTrace({
            caller: 'generateTestScenarios',
            model: currentModel,
            phase: 'response',
            response: text,
            reasoningSummary,
            durationMs: Date.now() - _scStartMs,
            responseId: response.id,
            usage
        });
        const parsed = safeParseJSON(text);
        if (Array.isArray(parsed?.scenarios)) return parsed.scenarios;
        if (Array.isArray(parsed)) return parsed;
        return [];
    } catch (error) {
        console.error(`[LLM] Error generating scenarios for story ${story.key}:`, error.message);
        throw new Error(`LLM Generation Failed for Scenarios: ${error.message}`);
    }
}

async function generateTestScenariosForEpic(epicContext, stories, localDocsText) {
    const currentModel = DEFAULT_MODEL;
    const epicLabel = epicContext.key || epicContext.summary;
    console.log(`[LLM] Batch scenario generation for epic ${epicLabel} — ${stories.length} stories...`);

    const storiesSection = stories.map((s, i) =>
        `Story ${i + 1} — ${s.key}: ${s.summary}\nDescription: ${s.description || 'None'}\nAcceptance Criteria: ${s.acceptanceCriteria || 'None'}`
    ).join('\n\n---\n\n');

    const prompt = `Epic: ${epicContext.key || 'N/A'} — ${epicContext.summary}
Supporting Documents: ${localDocsText || 'None'}

Process ALL ${stories.length} user stories below. Generate test scenarios for EACH story.
Valid storyId values: ${stories.map(s => s.key).join(', ')}
Valid epicId value: ${epicContext.key || 'N/A'}

${storiesSection}

Cover all four types (happy_path, edge_case, negative, boundary) per acceptance criterion for every story.
Bias descriptions toward user-visible, observable outcomes when stories involve a UI; keep pure-API stories explicit on status, body, and storage.
Structured response shape is enforced by the API — include every story via valid storyId / epicId.`;

    try {
        await assertTokenLimit(prompt, currentModel);
        const _epicStartMs = Date.now();
        emitLlmTrace({ caller: 'generateTestScenariosForEpic', model: currentModel, phase: 'request', prompt });
        const response = await client.responses.create({
            model: currentModel,
            instructions: SCENARIO_SYSTEM_INSTRUCTION,
            input: prompt,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'EpicScenarios',
                    schema: SCENARIO_RESPONSE_SCHEMA,
                    strict: true
                },
                verbosity: OUTPUT_VERBOSITY
            },
            reasoning: { effort: SCENARIO_EFFORT, summary: REASONING_SUMMARY },
            ...buildCacheParams(CACHE_KEYS.SCENARIO_EPIC),
            store: true
        });

        const text = extractResponseText(response);
        const reasoningSummary = extractReasoningSummary(response);
        const usage = extractUsage(response);
        emitLlmTrace({
            caller: 'generateTestScenariosForEpic',
            model: currentModel,
            phase: 'response',
            response: text,
            reasoningSummary,
            durationMs: Date.now() - _epicStartMs,
            responseId: response.id,
            usage
        });
        const parsed = safeParseJSON(text);
        const scenarios = Array.isArray(parsed?.scenarios)
            ? parsed.scenarios
            : (Array.isArray(parsed) ? parsed : []);
        if (scenarios.length > 0) return scenarios;
        throw new Error('Batch response was empty or invalid JSON');
    } catch (error) {
        console.warn(`[LLM] Batch generation failed for epic ${epicLabel} (${error.message}). Falling back to per-story calls...`);
        const allScenarios = [];
        for (const story of stories) {
            try {
                const storyScenarios = await generateTestScenarios(
                    story, epicContext, localDocsText, allScenarios
                );
                allScenarios.push(...storyScenarios);
            } catch (storyError) {
                console.error(`[LLM] Per-story fallback also failed for ${story.key}:`, storyError.message);
            }
        }
        if (allScenarios.length === 0) {
            throw new Error(`LLM Batch Generation Failed (batch + per-story fallback both failed): ${error.message}`);
        }
        return allScenarios;
    }
}

module.exports = {
    client,
    setLlmRunContext,
    getLlmRunContext,
    DEFAULT_MODEL,
    SCENARIO_EFFORT,
    TESTCASE_EFFORT,
    HEAL_EFFORT,
    CLASSIFIER_EFFORT,
    STATEFUL_MODE,
    REASONING_SUMMARY,
    OUTPUT_VERBOSITY,
    PROMPT_CACHE_RETENTION,
    CACHE_KEYS,
    buildCacheParams,
    emitLlmTrace,
    safeParseJSON,
    extractResponseText,
    extractReasoningSummary,
    extractReasoningItems,
    extractUsage,
    assertTokenLimit,
    ensureWithinBudget,
    PROMPT_TOKEN_BUDGET,
    isStaleChainError,
    createConversation,
    buildStatefulParams,
    stripInternalParams,
    applyStatefulInput,
    generateTestScenarios,
    generateTestScenariosForEpic,
    generateTestCasesForScenario,
    repairTestCaseScript
};
