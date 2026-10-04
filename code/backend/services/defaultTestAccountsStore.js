const fs = require('fs');
const path = require('path');

const ACCOUNTS_DIR = path.join(__dirname, '..', 'data', 'default-test-accounts');
const ACCOUNT_ID_RE = /^[a-zA-Z][a-zA-Z0-9_]*$/;
const MAX_ACCOUNTS = 20;
const MAX_EMAIL_LEN = 320;
const MAX_PASSWORD_LEN = 512;
const MAX_LABEL_LEN = 200;
const MAX_DISPLAY_NAME_LEN = 200;

function assertSafeProjectId(projectId) {
    const id = String(projectId || '').trim();
    if (!id || id.includes('..') || !/^[\w-]+$/.test(id)) {
        throw new Error('Invalid project id');
    }
    return id;
}

function accountsFilePath(projectId) {
    return path.join(ACCOUNTS_DIR, `${assertSafeProjectId(projectId)}.json`);
}

function ensureDir() {
    if (!fs.existsSync(ACCOUNTS_DIR)) {
        fs.mkdirSync(ACCOUNTS_DIR, { recursive: true });
    }
}

/**
 * Raw config from disk (internal). Passwords included.
 */
function readConfigInternal(projectId) {
    assertSafeProjectId(projectId);
    const fp = accountsFilePath(projectId);
    if (!fs.existsSync(fp)) return null;
    try {
        const text = fs.readFileSync(fp, 'utf8');
        const cleaned = (text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text).replace(/\0/g, '').trim();
        if (!cleaned) return null;
        const parsed = JSON.parse(cleaned);
        if (!parsed || typeof parsed !== 'object') return null;
        return normalizeStoredConfig(parsed);
    } catch {
        return null;
    }
}

function normalizeStoredConfig(parsed) {
    const enabled = Boolean(parsed.enabled);
    const defaultAccountId =
        parsed.defaultAccountId === null || parsed.defaultAccountId === undefined || parsed.defaultAccountId === ''
            ? null
            : String(parsed.defaultAccountId).trim();

    let accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];

    accounts = accounts
        .filter((a) => a && typeof a === 'object')
        .map((a) => ({
            id: String(a.id || '').trim(),
            label: typeof a.label === 'string' ? a.label.trim().slice(0, MAX_LABEL_LEN) : '',
            email: typeof a.email === 'string' ? a.email.trim().slice(0, MAX_EMAIL_LEN) : '',
            password: typeof a.password === 'string' ? a.password.slice(0, MAX_PASSWORD_LEN) : '',
            displayName:
                typeof a.displayName === 'string'
                    ? a.displayName.trim().slice(0, MAX_DISPLAY_NAME_LEN)
                    : ''
        }))
        .filter((a) => a.id);

    return {
        enabled,
        defaultAccountId:
            defaultAccountId && accounts.some((a) => a.id === defaultAccountId) ? defaultAccountId : null,
        accounts
    };
}

/**
 * Payload for dashboard (no plaintext passwords).
 */
function getDefaultTestAccountsForApi(projectId) {
    const raw = readConfigInternal(projectId);
    if (!raw) {
        return { enabled: false, defaultAccountId: null, accounts: [] };
    }
    return {
        enabled: Boolean(raw.enabled),
        defaultAccountId: raw.defaultAccountId,
        accounts: raw.accounts.map((a) => ({
            id: a.id,
            label: a.label,
            email: a.email,
            passwordSet: Boolean(a.password && a.password.length > 0),
            displayName: a.displayName
        }))
    };
}

/**
 * Full config for pipeline / LLM (passwords intact). Returns null if disabled or no accounts.
 */
function getDefaultTestAccountsForPipeline(projectId) {
    const raw = readConfigInternal(projectId);
    if (!raw || !raw.enabled || !raw.accounts.length) return null;
    const accounts = raw.accounts.filter((a) => a.email && a.password);
    if (!accounts.length) return null;

    const defaultId =
        raw.defaultAccountId && accounts.some((a) => a.id === raw.defaultAccountId)
            ? raw.defaultAccountId
            : accounts[0].id;

    return {
        enabled: true,
        defaultAccountId: defaultId,
        accounts
    };
}

/**
 * Map account id -> { email, password, displayName, label } for fixture inference.
 */
function buildAccountFixtureMap(pipelineConfig) {
    if (!pipelineConfig?.accounts?.length) return {};
    const out = {};
    for (const a of pipelineConfig.accounts) {
        out[a.id] = {
            email: a.email,
            password: a.password,
            displayName: a.displayName || '',
            label: a.label || ''
        };
    }
    return out;
}

function writeDefaultTestAccounts(projectId, body) {
    assertSafeProjectId(projectId);
    const existing = readConfigInternal(projectId);
    const existingPasswordById = {};
    if (existing?.accounts) {
        for (const a of existing.accounts) {
            if (a.id && a.password) existingPasswordById[a.id] = a.password;
        }
    }

    const enabled = Boolean(body.enabled);

    let defaultAccountId =
        body.defaultAccountId === null || body.defaultAccountId === undefined || body.defaultAccountId === ''
            ? null
            : String(body.defaultAccountId).trim();

    const incoming = Array.isArray(body.accounts) ? body.accounts : [];
    const seenIds = new Set();
    const accounts = [];

    for (let i = 0; i < incoming.length; i++) {
        const row = incoming[i];
        if (!row || typeof row !== 'object') continue;
        const id = String(row.id || '').trim();
        if (!id) continue;
        if (!ACCOUNT_ID_RE.test(id)) {
            const err = new Error(
                `Invalid account id "${id}": must start with a letter and contain only letters, digits, underscores.`
            );
            err.statusCode = 400;
            throw err;
        }
        if (seenIds.has(id)) {
            const err = new Error(`Duplicate account id "${id}".`);
            err.statusCode = 400;
            throw err;
        }
        seenIds.add(id);

        const email = String(row.email || '').trim().slice(0, MAX_EMAIL_LEN);
        const label = typeof row.label === 'string' ? row.label.trim().slice(0, MAX_LABEL_LEN) : '';
        const displayName =
            typeof row.displayName === 'string' ? row.displayName.trim().slice(0, MAX_DISPLAY_NAME_LEN) : '';

        let password = typeof row.password === 'string' ? row.password.slice(0, MAX_PASSWORD_LEN) : '';
        if (!password.length && existingPasswordById[id]) {
            password = existingPasswordById[id];
        }

        accounts.push({
            id,
            label,
            email,
            password,
            displayName
        });
    }

    if (accounts.length > MAX_ACCOUNTS) {
        const err = new Error(`At most ${MAX_ACCOUNTS} test accounts allowed.`);
        err.statusCode = 400;
        throw err;
    }

    if (enabled) {
        if (!accounts.length) {
            const err = new Error('When default test accounts are enabled, add at least one account.');
            err.statusCode = 400;
            throw err;
        }
        for (const a of accounts) {
            if (!a.email) {
                const err = new Error(`Account "${a.id}" requires an email address.`);
                err.statusCode = 400;
                throw err;
            }
            if (!a.password) {
                const err = new Error(
                    `Account "${a.id}" requires a password (set password on new accounts, or save once with password).`
                );
                err.statusCode = 400;
                throw err;
            }
        }
        if (defaultAccountId && !accounts.some((a) => a.id === defaultAccountId)) {
            defaultAccountId = null;
        }
        if (accounts.length > 1 && defaultAccountId == null) {
            const err = new Error(
                'Select a default account for generic testData.login / testData.user when you have multiple accounts.'
            );
            err.statusCode = 400;
            throw err;
        }
        if (accounts.length === 1) {
            defaultAccountId = accounts[0].id;
        }
    } else {
        if (defaultAccountId && !accounts.some((a) => a.id === defaultAccountId)) {
            defaultAccountId = null;
        }
        if (accounts.length === 1) {
            defaultAccountId = accounts[0].id;
        }
    }

    const toStore = normalizeStoredConfig({
        enabled,
        defaultAccountId,
        accounts
    });

    ensureDir();
    const fp = accountsFilePath(projectId);
    fs.writeFileSync(fp, JSON.stringify(toStore, null, 2), 'utf8');
}

function deleteDefaultTestAccounts(projectId) {
    try {
        assertSafeProjectId(projectId);
        const fp = accountsFilePath(projectId);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
        /* ignore */
    }
}

module.exports = {
    getDefaultTestAccountsForApi,
    getDefaultTestAccountsForPipeline,
    buildAccountFixtureMap,
    writeDefaultTestAccounts,
    deleteDefaultTestAccounts,
    ACCOUNT_ID_RE,
    MAX_ACCOUNTS,
    ACCOUNTS_DIR
};
