const fs = require('fs');
const path = require('path');

const SANDBOX_ENV_DIR = path.join(__dirname, '..', 'data', 'sandbox-env');
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_PREFIX = 'AUTOQA_';
const AUTOQA_WHITELIST = new Set(['AUTOQA_E2E_BASE_URL']);

function assertSafeProjectId(projectId) {
    const id = String(projectId || '').trim();
    if (!id || id.includes('..') || !/^[\w-]+$/.test(id)) {
        throw new Error('Invalid project id');
    }
    return id;
}

function sandboxEnvFilePath(projectId) {
    return path.join(SANDBOX_ENV_DIR, `${assertSafeProjectId(projectId)}.json`);
}

function ensureDir() {
    try {
        if (!fs.existsSync(SANDBOX_ENV_DIR)) {
            fs.mkdirSync(SANDBOX_ENV_DIR, { recursive: true });
        }
    } catch (err) {
        console.error('[SandboxEnv] failed to ensure directory');
        throw err;
    }
}

/**
 * Normalize env map from disk: string values only; drop invalid keys and AUTOQA_* (no logging of values).
 */
function normalizeEnvMap(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (typeof k !== 'string' || !KEY_RE.test(k)) continue;
        if (k.startsWith(RESERVED_PREFIX) && !AUTOQA_WHITELIST.has(k)) continue;
        if (v == null) continue;
        out[k] = typeof v === 'string' ? v : String(v);
    }
    return out;
}

/**
 * Returns env map for Docker injection (never includes AUTOQA_* or invalid keys).
 */
function readSandboxEnv(projectId) {
    try {
        assertSafeProjectId(projectId);
        const fp = sandboxEnvFilePath(projectId);
        if (!fs.existsSync(fp)) return {};
        const text = fs.readFileSync(fp, 'utf8');
        const cleaned = (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).replace(/\0/g, '').trim();
        if (!cleaned) return {};
        const parsed = JSON.parse(cleaned);
        return normalizeEnvMap(parsed);
    } catch (err) {
        const id = String(projectId || '').trim();
        console.error(`[SandboxEnv] failed for project ${id}`);
        return {};
    }
}

function assertWritableEnv(env) {
    if (env == null || typeof env !== 'object' || Array.isArray(env)) {
        throw new Error('env must be a plain object');
    }
    for (const [k, v] of Object.entries(env)) {
        if (typeof k !== 'string' || !KEY_RE.test(k)) {
            const err = new Error(`Invalid sandbox env key "${k}": use ASCII letters, digits, underscore; first char letter or underscore.`);
            err.statusCode = 400;
            throw err;
        }
        if (k.startsWith(RESERVED_PREFIX)) {
            const err = new Error(
                'Keys prefixed with AUTOQA_ are reserved for the AutoQA harness and must not be set as project sandbox env (they would override Playwright/base URL and other behavior inside the container).'
            );
            err.statusCode = 400;
            throw err;
        }
        if (v != null && typeof v !== 'string') {
            const err = new Error(`Env values must be strings (key: ${k})`);
            err.statusCode = 400;
            throw err;
        }
    }
}

/**
 * Replace entire env file with given map (omit keys => removed).
 */
function writeSandboxEnv(projectId, env) {
    assertWritableEnv(env);
    ensureDir();
    const fp = sandboxEnvFilePath(projectId);
    const normalized = {};
    for (const [k, v] of Object.entries(env)) {
        if (v == null) continue;
        normalized[k] = String(v);
    }
    try {
        fs.writeFileSync(fp, JSON.stringify(normalized, null, 2), 'utf8');
    } catch (err) {
        const id = String(projectId || '').trim();
        console.error(`[SandboxEnv] failed for project ${id}`);
        throw err;
    }
}

function deleteSandboxEnv(projectId) {
    try {
        assertSafeProjectId(projectId);
        const fp = sandboxEnvFilePath(projectId);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch (err) {
        const id = String(projectId || '').trim();
        console.error(`[SandboxEnv] failed for project ${id}`);
    }
}

module.exports = {
    readSandboxEnv,
    writeSandboxEnv,
    deleteSandboxEnv,
    KEY_RE,
    RESERVED_PREFIX
};
