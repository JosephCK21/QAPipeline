const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { exec, execFile, execFileSync, spawn } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const execFilePromise = util.promisify(execFile);

/**
 * Runs a command using spawn instead of execFile.
 * On Windows, execFile/execFilePromise has a race condition where stdout/stderr
 * pipes are destroyed before all data is read when the child exits non-zero
 * (Node.js issue #56430). spawn does not destroy output streams, so it
 * reliably captures the full output regardless of exit code.
 */
function spawnCapture(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const timeout = options.timeout || 120000;
        const child = spawn(command, args, {
            detached: false,  // MUST be false on Windows to keep pipes connected
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        const chunks = { stdout: [], stderr: [] };
        child.stdout.on('data', (d) => chunks.stdout.push(d));
        child.stderr.on('data', (d) => chunks.stderr.push(d));

        const timer = setTimeout(() => {
            child.kill();
            reject(Object.assign(
                new Error(`Timed out after ${timeout}ms`),
                { stdout: Buffer.concat(chunks.stdout).toString(), stderr: Buffer.concat(chunks.stderr).toString(), killed: true }
            ));
        }, timeout);

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            const stdout = Buffer.concat(chunks.stdout).toString();
            const stderr = Buffer.concat(chunks.stderr).toString();
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err = new Error(`Command failed with exit code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                err.code = code;
                reject(err);
            }
        });
    });
}

const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// ---------------------------------------------------------------------------
// DEPENDENCY EXTRACTION
// ---------------------------------------------------------------------------

function extractDependencies(code, language) {
    let deps = new Set();
    if (language === 'javascript') {
        try {
            const ast = babelParser.parse(code, {
                sourceType: 'module',
                plugins: ['jsx', 'typescript']
            });
            traverse(ast, {
                ImportDeclaration(nodePath) {
                    const source = nodePath.node.source.value;
                    if (!source.startsWith('.') && !source.startsWith('/')) {
                        deps.add(source.split('/')[0]);
                    }
                },
                CallExpression(nodePath) {
                    if (nodePath.node.callee.name === 'require') {
                        const args = nodePath.node.arguments;
                        if (args.length > 0 && args[0].type === 'StringLiteral') {
                            const source = args[0].value;
                            if (!source.startsWith('.') && !source.startsWith('/')) {
                                deps.add(source.split('/')[0]);
                            }
                        }
                    }
                }
            });
        } catch (e) {
            console.warn('[Sandbox] AST parsing failed, falling back to regex', e.message);
            const requires = [...code.matchAll(/require\(['"]([^.\/][^'"]+)['"]\)/g)];
            const imports = [...code.matchAll(/from\s+['"]([^.\/][^'"]+)['"]/g)];
            requires.concat(imports).forEach(match => deps.add(match[1].split('/')[0]));
        }
    } else if (language === 'python') {
        const imports = [...code.matchAll(/^import\s+([^\s.]+)/gm)];
        const fromImports = [...code.matchAll(/^from\s+([^\s.]+)\s+import/gm)];
        imports.concat(fromImports).forEach(match => deps.add(match[1]));
    }

    // Strip built-in Node.js modules — they are never npm packages.
    const NODE_BUILTINS = new Set([
        'fs', 'path', 'os', 'http', 'https', 'net', 'crypto', 'stream',
        'util', 'events', 'assert', 'buffer', 'child_process', 'cluster',
        'dns', 'domain', 'punycode', 'querystring', 'readline', 'repl',
        'string_decoder', 'timers', 'tls', 'tty', 'url', 'v8', 'vm', 'zlib',
        'module', 'process'
    ]);
    NODE_BUILTINS.forEach(b => deps.delete(b));

    return Array.from(deps);
}

// ---------------------------------------------------------------------------
// DOCKER HELPERS — use execFile to avoid shell quoting issues on Windows
// ---------------------------------------------------------------------------

async function dockerRun(args, timeoutMs = 120000) {
    return execFilePromise('docker', args, { timeout: timeoutMs });
}

/**
 * `docker run` against mcr.microsoft.com/playwright pulls a multi‑GB image on first use.
 * A short timeout (SANDBOX_TIMEOUT_MS) SIGTERM‑kills the pull mid‑stream → misleading
 * "Container startup failed" errors. Override with SANDBOX_DOCKER_PULL_TIMEOUT_MS only for that step.
 */
function getDockerBaseImagePullTimeoutMs() {
    const raw = process.env.SANDBOX_DOCKER_PULL_TIMEOUT_MS;
    if (raw !== undefined && String(raw).trim() !== '') {
        const n = parseInt(raw, 10);
        return Number.isFinite(n) && n >= 60000 ? n : 1_200_000;
    }
    return 1_200_000; // 20 minutes default for cold pull
}

const PLAYWRIGHT_WAIT_ON_MS = 30000;

/** Written into the clone so executeTest uses the same app root as createSandboxPool */
const APP_ROOT_MARKER = '.autoqa-app-root';
const MAX_APP_DISCOVERY_DEPTH = 6;
const SKIP_APP_SCAN_DIRS = new Set([
    'node_modules', '.git', '.next', 'dist', 'build', 'coverage', '.nuxt',
    'out', '__pycache__', 'venv', '.venv', 'target', 'playwright-report'
]);

/**
 * @param {object|null} pkg
 * @returns {boolean}
 */
function isWebAppPackageJson(pkg) {
    if (!pkg || typeof pkg !== 'object') return false;
    const scripts = pkg.scripts || {};
    if (!scripts.dev && !scripts.start) return false;
    const d = { ...pkg.dependencies, ...pkg.devDependencies };
    if (!d || typeof d !== 'object') return false;
    if (d.next || d.vite || d['react-scripts']) return true;
    for (const k of Object.keys(d)) {
        if (k.startsWith('@next/')) return true;
    }
    return false;
}

/**
 * @param {string} absDir
 * @returns {object|null}
 */
function tryReadPackageJsonSync(absDir) {
    const p = path.join(absDir, 'package.json');
    try {
        const raw = fssync.readFileSync(p, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * Host-side scan: shallowest dir under sandboxDir whose package.json qualifies as a web app.
 * @param {string} sandboxDir
 * @returns {string} POSIX relative path from clone root, or '' for root.
 */
function discoverAppRootRelative(sandboxDir) {
    const override = String(process.env.AUTOQA_APP_SUBPATH || '').trim()
        .replace(/^\/+/, '')
        .replace(/\\/g, '/');
    if (override) {
        const abs = path.join(sandboxDir, ...override.split('/').filter(Boolean));
        const pkg = tryReadPackageJsonSync(abs);
        if (isWebAppPackageJson(pkg)) {
            return override;
        }
        console.warn(`[Sandbox] AUTOQA_APP_SUBPATH="${override}" is not a valid web app root; scanning instead.`);
    }

    /** @type {{ rel: string, depth: number }[]} */
    const candidates = [];

    /**
     * @param {string} relPosix segments joined by /
     * @param {number} depth directory depth from root
     */
    function walk(relPosix, depth) {
        if (depth > MAX_APP_DISCOVERY_DEPTH) return;
        const abs = relPosix ? path.join(sandboxDir, ...relPosix.split('/')) : sandboxDir;
        const pkg = tryReadPackageJsonSync(abs);
        if (isWebAppPackageJson(pkg)) {
            candidates.push({
                rel: relPosix,
                depth: relPosix ? relPosix.split('/').length : 0
            });
        }
        let entries;
        try {
            entries = fssync.readdirSync(abs, { withFileTypes: true });
        } catch {
            return;
        }
        for (const ent of entries) {
            if (!ent.isDirectory()) continue;
            const name = ent.name;
            if (SKIP_APP_SCAN_DIRS.has(name)) continue;
            const nextRel = relPosix ? `${relPosix}/${name}` : name;
            walk(nextRel, depth + 1);
        }
    }

    walk('', 0);
    if (candidates.length === 0) return '';
    candidates.sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        return a.rel.localeCompare(b.rel);
    });
    return candidates[0].rel;
}

/**
 * @param {string} sandboxDir
 * @param {string} relPosix
 */
async function writeAppRootMarker(sandboxDir, relPosix) {
    const line = (relPosix || '').trim().replace(/\\/g, '/');
    await fs.writeFile(
        path.join(sandboxDir, APP_ROOT_MARKER),
        line ? `${line}\n` : '\n',
        'utf8'
    );
}

/**
 * @param {string} sandboxDir
 * @returns {Promise<string|null>} null if marker missing
 */
async function readAppRootMarker(sandboxDir) {
    try {
        const raw = await fs.readFile(path.join(sandboxDir, APP_ROOT_MARKER), 'utf8');
        return raw.trim().replace(/\\/g, '/');
    } catch {
        return null;
    }
}

/**
 * @param {string} sandboxDir
 * @param {string} relPosix
 */
function appDirAbs(sandboxDir, relPosix) {
    const r = (relPosix || '').trim();
    if (!r) return sandboxDir;
    return path.join(sandboxDir, ...r.split('/').filter(Boolean));
}

/**
 * Docker -w path for npm run dev (Linux mount /app).
 * @param {string} relPosix '' or 'sayarat-web' or 'apps/web'
 */
function dockerAppWorkdir(relPosix) {
    const r = (relPosix || '').trim().replace(/^\/+|\/+$/g, '').replace(/\\/g, '/');
    return r ? `/app/${r}` : '/app';
}

/**
 * Keep in sync with mcr.microsoft.com/playwright Docker tag (v{VER}-jammy)
 * and devDependency @playwright/test in createSandboxPool.
 */
const PLAYWRIGHT_VERSION = '1.59.1';

/** Playwright traces allowed by env AUTOQA_PLAYWRIGHT_TRACE */
const PLAYWRIGHT_TRACE_MODES = new Set(['on', 'retain-on-failure', 'on-first-retry']);

/** Playwright video modes allowed by env AUTOQA_PLAYWRIGHT_VIDEO */
const PLAYWRIGHT_VIDEO_MODES = new Set(['on', 'off', 'retain-on-failure', 'on-first-retry']);

/** Whether live browser streaming (VNC) is enabled */
function isLiveBrowserEnabled() {
    const v = (process.env.AUTOQA_LIVE_BROWSER || 'true').trim().toLowerCase();
    return v === 'true' || v === '1';
}

/** Base port for noVNC WebSocket connections */
const VNC_BASE_PORT = Math.max(1024, parseInt(process.env.AUTOQA_VNC_BASE_PORT || '6080', 10));

/** SlowMo when live browser is active (makes tests watchable) */
const LIVE_SLOWMO_MS = Math.max(0, parseInt(process.env.AUTOQA_LIVE_SLOWMO_MS || '300', 10));

/** @returns {string} */
function sanitizeArtifactSegment(id) {
    return String(id || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 160);
}

/**
 * @returns {string}
 */
function buildPlaywrightAutoqaConfigSource() {
    return `'use strict';
const { defineConfig, devices } = require('@playwright/test');
const TRACE = process.env.AUTOQA_PLAYWRIGHT_TRACE || 'off';
const TRACE_OK = new Set(${JSON.stringify([...PLAYWRIGHT_TRACE_MODES])});
const VIDEO = process.env.AUTOQA_PLAYWRIGHT_VIDEO || 'on';
const VIDEO_OK = new Set(${JSON.stringify([...PLAYWRIGHT_VIDEO_MODES])});
const LIVE = process.env.AUTOQA_LIVE_BROWSER === '1' || process.env.AUTOQA_LIVE_BROWSER === 'true';
const HEADED = LIVE || process.env.AUTOQA_PLAYWRIGHT_HEADED === '1' || process.env.AUTOQA_PLAYWRIGHT_HEADED === 'true';
const SLOWMO = LIVE
    ? parseInt(process.env.AUTOQA_LIVE_SLOWMO_MS || '300', 10) || 300
    : parseInt(process.env.AUTOQA_PLAYWRIGHT_SLOWMO_MS || '0', 10) || 0;
function parsePositive(ms) {
    const n = parseInt(ms || '', 10);
    return Number.isFinite(n) && n > 0 ? n : null;
}
function parseRetries(v) {
    const n = parseInt(v ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
}
const ROOT_TIMEOUT = parsePositive(process.env.AUTOQA_PLAYWRIGHT_TEST_TIMEOUT_MS);
const EXPECT_MS = parsePositive(process.env.AUTOQA_PLAYWRIGHT_EXPECT_TIMEOUT_MS);
const ACTION_MS = parsePositive(process.env.AUTOQA_PLAYWRIGHT_ACTION_TIMEOUT_MS);
const RETRIES = parseRetries(process.env.AUTOQA_PLAYWRIGHT_RETRIES);
const _baseRaw = (process.env.AUTOQA_E2E_BASE_URL || '').trim();
const BASE = _baseRaw.endsWith('/') ? _baseRaw.slice(0, -1) : _baseRaw;
module.exports = defineConfig({
    testDir: '.',
    testMatch: /autoqa\\.spec\\.js$/,
    forbidOnly: true,
    fullyParallel: false,
    workers: 1,
    ...(ROOT_TIMEOUT !== null ? { timeout: ROOT_TIMEOUT } : {}),
    ...(RETRIES !== null ? { retries: RETRIES } : {}),
    reporter: process.env.AUTOQA_PLAYWRIGHT_HTML_REPORT === '1'
        ? [['list'], ['html', { outputFolder: 'test-results/playwright-html', open: 'never' }]]
        : [['list']],
    outputDir: 'test-results/playwright-autoqa',
    ...(EXPECT_MS !== null ? { expect: { timeout: EXPECT_MS } } : {}),
    use: {
        ...devices['Desktop Chrome'],
        headless: !HEADED,
        screenshot: 'only-on-failure',
        video: VIDEO_OK.has(VIDEO) ? VIDEO : 'on',
        trace: TRACE_OK.has(TRACE) ? TRACE : 'off',
        ...(BASE ? { baseURL: BASE } : {}),
        ...(ACTION_MS !== null ? { actionTimeout: ACTION_MS } : {}),
        ...(HEADED ? {
            launchOptions: {
                ...(SLOWMO > 0 ? { slowMo: SLOWMO } : {}),
                args: [
                    '--disable-dev-shm-usage',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-gpu',
                    '--window-size=1280,720'
                ]
            }
        } : (SLOWMO > 0 ? { launchOptions: { slowMo: SLOWMO } } : {}))
    }
});
`;
}

/**
 * @param {string} dir
 * @param {{ ext: Set<string>, out: string[] }} acc
 */
async function collectFilesByExtension(dir, acc) {
    let entries = [];
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const ent of entries) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) {
            await collectFilesByExtension(p, acc);
        } else {
            const ext = path.extname(ent.name).toLowerCase();
            if (acc.ext.has(ext)) acc.out.push(p);
        }
    }
}

/**
 * Copy Playwright output (screenshots, traces) into backend data/artifacts for the UI.
 * @param {string} sandboxDir
 * @param {{ runId: string, testCaseId: string, attempt: number }} ctx
 */
async function persistPlaywrightArtifacts(sandboxDir, ctx) {
    const empty = { failureScreenshots: [], traces: [], videos: [] };
    if (!ctx?.runId || !ctx.testCaseId) return empty;

    const pwRoot = path.join(sandboxDir, 'test-results', 'playwright-autoqa');
    const acc = { ext: new Set(['.png', '.zip', '.webm']), out: [] };
    await collectFilesByExtension(pwRoot, acc);

    /** @type {string[]} */
    const pngFiles = acc.out.filter(f => f.endsWith('.png')).sort();
    /** @type {string[]} */
    const zipFiles = acc.out.filter(f => f.endsWith('.zip')).sort();
    /** @type {string[]} */
    const webmFiles = acc.out.filter(f => f.endsWith('.webm')).sort();

    if (pngFiles.length === 0 && zipFiles.length === 0 && webmFiles.length === 0) return empty;

    const safeTc = sanitizeArtifactSegment(ctx.testCaseId);
    const artifactsRoot = path.join(__dirname, '..', 'data', 'artifacts');
    const destDir = path.join(artifactsRoot, ctx.runId, safeTc);

    await fs.mkdir(destDir, { recursive: true });

    const encodeSeg = (s) => encodeURIComponent(String(s));

    /** @type {{ url: string, fileName: string }[]} */
    const failureScreenshots = [];
    pngFiles.forEach((src, idx) => {
        const destName = `attempt-${ctx.attempt}-screenshot-${idx}.png`;
        const destAbs = path.join(destDir, destName);
        try {
            require('fs').copyFileSync(src, destAbs);
        } catch (e) {
            console.warn(`[Sandbox] Copy screenshot failed ${src}: ${e.message}`);
            return;
        }
        failureScreenshots.push({
            fileName: destName,
            url: `/api/runs/${encodeSeg(ctx.runId)}/artifacts/${encodeSeg(safeTc)}/${encodeSeg(destName)}`
        });
    });

    /** @type {{ url: string, fileName: string }[]} */
    const traces = [];
    zipFiles.forEach((src, idx) => {
        const destName = `attempt-${ctx.attempt}-trace-${idx}.zip`;
        const destAbs = path.join(destDir, destName);
        try {
            require('fs').copyFileSync(src, destAbs);
        } catch (e) {
            console.warn(`[Sandbox] Copy trace failed ${src}: ${e.message}`);
            return;
        }
        traces.push({
            fileName: destName,
            url: `/api/runs/${encodeSeg(ctx.runId)}/artifacts/${encodeSeg(safeTc)}/${encodeSeg(destName)}`
        });
    });

    /** @type {{ url: string, fileName: string }[]} */
    const videos = [];
    webmFiles.forEach((src, idx) => {
        const destName = `attempt-${ctx.attempt}-video-${idx}.webm`;
        const destAbs = path.join(destDir, destName);
        try {
            require('fs').copyFileSync(src, destAbs);
        } catch (e) {
            console.warn(`[Sandbox] Copy video failed ${src}: ${e.message}`);
            return;
        }
        videos.push({
            fileName: destName,
            url: `/api/runs/${encodeSeg(ctx.runId)}/artifacts/${encodeSeg(safeTc)}/${encodeSeg(destName)}`
        });
    });

    return { failureScreenshots, traces, videos };
}

/**
 * @param {string} absDir directory containing package.json (clone root or nested app)
 * @returns {Promise<object|null>}
 */
async function loadPackageJsonAt(absDir) {
    const p = path.join(absDir, 'package.json');
    try {
        const raw = await fs.readFile(p, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * @param {string | undefined} script
 * @returns {number | null}
 */
function extractPortFromNpmScript(script) {
    if (!script || typeof script !== 'string') return null;
    const patterns = [
        /--port(?:=|\s+)(\d+)/i,
        /(?:^|\s)-p\s+(\d+)(?=\s|$)/,
        /\bPORT\s*=\s*(\d+)/i
    ];
    for (const re of patterns) {
        const m = script.match(re);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > 0 && n < 65536) return n;
        }
    }
    return null;
}

/**
 * Best-effort read of Vite `server.port` from common config filenames.
 * @param {string} appRootAbs clone root or nested app directory on the host
 * @returns {Promise<number | null>}
 */
async function readVitePortFromSandbox(appRootAbs) {
    const names = [
        'vite.config.js', 'vite.config.mjs', 'vite.config.cjs',
        'vite.config.ts', 'vite.config.mts', 'vite.config.cts'
    ];
    for (const name of names) {
        const fp = path.join(appRootAbs, name);
        try {
            const text = await fs.readFile(fp, 'utf8');
            const serverPort = text.match(/\bserver\s*:\s*\{[^}]*\bport\s*:\s*(\d+)/);
            if (serverPort) {
                const n = parseInt(serverPort[1], 10);
                if (Number.isFinite(n) && n > 0 && n < 65536) return n;
            }
            const anyPort = text.match(/\bport\s*:\s*(\d{2,5})\b/);
            if (anyPort) {
                const n = parseInt(anyPort[1], 10);
                if (Number.isFinite(n) && n > 0 && n < 65536) return n;
            }
        } catch {
            continue;
        }
    }
    return null;
}

/**
 * @param {string} appRootAbs directory containing the app package.json + vite configs (host path)
 * @param {object|null} pkg
 * @returns {Promise<{ devShellCmd: string | null, port: number, targetUrl: string }>}
 */
async function resolveDevCommandAndTargetUrl(appRootAbs, pkg) {
    const envBase = process.env.AUTOQA_E2E_BASE_URL;
    const trimmed = typeof envBase === 'string' ? envBase.trim() : '';
    if (trimmed) {
        const targetUrl = trimmed.replace(/\/$/, '');
        let port = 5173;
        try {
            const u = new URL(targetUrl);
            if (u.port) port = parseInt(u.port, 10);
            else if (u.protocol === 'https:') port = 443;
            else if (u.protocol === 'http:') port = 80;
        } catch {
            /* keep default */
        }
        const scripts = pkg?.scripts || {};
        const devShellCmd = scripts.dev ? 'npm run dev' : scripts.start ? 'npm run start' : 'node todoServer.js || node server.js';
        return { devShellCmd, port, targetUrl };
    }

    if (!pkg || typeof pkg !== 'object') {
        const fromVite = await readVitePortFromSandbox(appRootAbs);
        const port = fromVite ?? 3000; // default to 3000 if not vite
        return { devShellCmd: 'node todoServer.js || node server.js', port, targetUrl: `http://localhost:${port}` };
    }

    const scripts = pkg.scripts || {};
    let devShellCmd = null;
    if (scripts.dev) devShellCmd = 'npm run dev';
    else if (scripts.start) devShellCmd = 'npm run start';
    else devShellCmd = 'node todoServer.js || node server.js';

    const merged = { ...pkg.dependencies, ...pkg.devDependencies };
    const keys = Object.keys(merged);
    const has = (name) => keys.includes(name);

    let port = extractPortFromNpmScript(scripts.dev)
        ?? extractPortFromNpmScript(scripts.start);
    if (port == null) {
        port = await readVitePortFromSandbox(appRootAbs);
    }
    if (port == null) {
        if (has('vite')) port = 5173;
        else if (has('next') || has('@next/next') || has('react-scripts')) port = 3000;
        else port = 3000; // Default for Express / unknown
    }

    const targetUrl = `http://localhost:${port}`;
    return { devShellCmd, port, targetUrl };
}

async function killPlaywrightBackgroundProcesses(containerName) {
    try {
        await execFilePromise(
            'docker',
            ['exec', containerName, 'sh', '-c', '[ -s /tmp/autoqa-dev.pid ] && kill "$(cat /tmp/autoqa-dev.pid)" 2>/dev/null || true; pkill -f node || true; rm -f /tmp/autoqa-dev.pid'],
            { timeout: 30000 }
        );
    } catch (e) {
        console.warn(`[Sandbox] Playwright dev server cleanup warning: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// SANDBOX LIFECYCLE
// ---------------------------------------------------------------------------

const SANDBOX_MAX_CONCURRENT = Math.max(1, parseInt(process.env.SANDBOX_MAX_CONCURRENT || '3', 10));

let _sandboxActiveCreations = 0;
const _sandboxCreationWaiters = [];

function acquireSandboxCreationSlot() {
    if (_sandboxActiveCreations < SANDBOX_MAX_CONCURRENT) {
        _sandboxActiveCreations++;
        return Promise.resolve();
    }
    return new Promise((resolve) => _sandboxCreationWaiters.push(resolve));
}

function releaseSandboxCreationSlot() {
    _sandboxActiveCreations = Math.max(0, _sandboxActiveCreations - 1);
    const next = _sandboxCreationWaiters.shift();
    if (next) {
        _sandboxActiveCreations++;
        next();
    }
}

/**
 * Creates a pool of sandbox directories, clones the repo into each, starts
 * multiple persistent Docker containers for the run, and pre-installs dependencies.
 *
 * Returns an array of { sandboxDir, containerName } objects.
 */
async function clonePrRepoToSandbox(prDetails, sandboxDir, timeoutMs) {
    if (!prDetails.headRepoFullName || !prDetails.headRef) {
        throw new Error('clonePrRepoToSandbox: missing headRepoFullName/headRef');
    }
    const token = process.env.GITHUB_TOKEN;
    const shallowUrl = `https://github.com/${prDetails.headRepoFullName}.git`;
    if (token) {
        const b64 = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
        await spawnCapture(
            'git',
            [
                '-c', `http.extraHeader=AUTHORIZATION: basic ${b64}`,
                'clone', '--depth', '1',
                '-b', prDetails.headRef,
                shallowUrl,
                sandboxDir
            ],
            { timeout: timeoutMs }
        );
    } else {
        await execPromise(`git clone --depth 1 -b ${prDetails.headRef} "${shallowUrl}" "${sandboxDir}"`, { timeout: timeoutMs });
    }
}

async function createSandboxPool(runId, prDetails, concurrency = 2, options = {}) {
    const createPromises = [];

    for (let i = 1; i <= concurrency; i++) {
        createPromises.push((async () => {
            await acquireSandboxCreationSlot();
            try {

            const baseTmp = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
            const sandboxDir = path.join(baseTmp, 'autoqa-sandbox', `${runId}-${i}`);
            const containerName = `autoqa-sandbox-${runId}-${i}`;

            await fs.mkdir(sandboxDir, { recursive: true });

            // -- Clone or flat-drop ------------------------------------------------
            try {
                if (prDetails.headRepoFullName && prDetails.headRef) {
                    const timeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
                    await clonePrRepoToSandbox(prDetails, sandboxDir, timeoutMs);
                    console.log(`[Sandbox] Cloned repo into pool ${i}`);

                    // Overlay mock data if present
                    await Promise.all((prDetails.files || []).map(async file => {
                        if (file.filename === 'mock_data.json') {
                            await fs.writeFile(path.join(sandboxDir, 'mock_data.json'), file.content, 'utf8');
                        }
                    }));
                } else {
                    await Promise.all((prDetails.files || []).map(async file => {
                        const filePath = path.join(sandboxDir, path.basename(file.filename));
                        await fs.writeFile(filePath, file.content, 'utf8');
                    }));
                }
            } catch (err) {
                console.error(`[Sandbox] Clone failed for pool ${i}, falling back to flat file drop:`, err.message);
                await Promise.all((prDetails.files || []).map(async file => {
                    const filePath = path.join(sandboxDir, path.basename(file.filename));
                    await fs.writeFile(filePath, file.content, 'utf8');
                }));
            }

            const appRel = discoverAppRootRelative(sandboxDir);
            await writeAppRootMarker(sandboxDir, appRel);
            console.log(`[Sandbox] App root for npm/dev: ${dockerAppWorkdir(appRel)}`);

            // -- Start ONE persistent container ------------------------------------
            const volumeDir = sandboxDir.replace(/\\/g, '/');
            const runTimeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
            const dockerRunTimeoutMs = getDockerBaseImagePullTimeoutMs();
            const installTimeoutMs = Math.max(runTimeoutMs, 300000);
            const liveMode = isLiveBrowserEnabled();
            const vncPort = liveMode ? VNC_BASE_PORT + (i - 1) : null;

            try {
                await execFilePromise('docker', ['rm', '-f', containerName]).catch(() => { });

                const dockerRunArgs = [
                    'run', '-d',
                    '--name', containerName,
                    '-v', `${volumeDir}:/app`,
                    '-w', '/app'
                ];

                // Map VNC port and set DISPLAY for live browser mode
                if (liveMode && vncPort) {
                    dockerRunArgs.push('-p', `${vncPort}:6080`);
                    dockerRunArgs.push('-e', 'DISPLAY=:99');
                    dockerRunArgs.push('-e', 'AUTOQA_LIVE_BROWSER=true');
                    dockerRunArgs.push('-e', `AUTOQA_LIVE_SLOWMO_MS=${LIVE_SLOWMO_MS}`);
                }

                const sandboxEnv =
                    options.sandboxEnv && typeof options.sandboxEnv === 'object' && !Array.isArray(options.sandboxEnv)
                        ? options.sandboxEnv
                        : {};
                for (const [envKey, envVal] of Object.entries(sandboxEnv)) {
                    if (envVal == null) continue;
                    dockerRunArgs.push('-e', `${envKey}=${String(envVal)}`);
                }

                dockerRunArgs.push(
                    `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy`,
                    'tail', '-f', '/dev/null'
                );

                await dockerRun(dockerRunArgs, dockerRunTimeoutMs);
                console.log(`[Sandbox] Container started: ${containerName}${liveMode ? ` (VNC port ${vncPort})` : ''}`);

                // -- Install VNC stack for live browser viewing ----------------------
                if (liveMode) {
                    const vncInstallTimeoutMs = Math.max(installTimeoutMs, 600000); // 10 min min for VNC install
                    console.log(`[Sandbox] Installing VNC stack in ${containerName} (timeout ${Math.round(vncInstallTimeoutMs / 1000)}s)...`);
                    try {
                        await spawnCapture('docker', [
                            'exec', containerName, 'sh', '-c',
                            'DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends xvfb x11vnc novnc python3-websockify && rm -rf /var/lib/apt/lists/*'
                        ], { timeout: vncInstallTimeoutMs });
                    } catch (vncInstErr) {
                        // spawnCapture throws on non-zero exit, but the install may have succeeded
                        // despite debconf warnings on stderr. Check if x11vnc is actually installed.
                        try {
                            await execFilePromise('docker', [
                                'exec', containerName, 'which', 'x11vnc'
                            ], { timeout: 10000 });
                            console.log(`[Sandbox] VNC packages installed (debconf warnings ignored) in ${containerName}`);
                        } catch {
                            console.error(`[Sandbox] VNC install truly failed in ${containerName}: ${vncInstErr.message}`);
                            throw vncInstErr;
                        }
                    }

                    // Write VNC startup script into the container
                    const vncStartScript = [
                        '#!/bin/sh',
                        'export DISPLAY=:99',
                        'Xvfb :99 -screen 0 1280x720x24 &',
                        'sleep 1',
                        'x11vnc -display :99 -forever -nopw -shared -rfbport 5900 &',
                        'websockify --web=/usr/share/novnc/ 6080 localhost:5900 &',
                        'echo "VNC stack started"',
                        'wait'
                    ].join('\n');
                    await fs.writeFile(path.join(sandboxDir, '.autoqa-vnc-start.sh'), vncStartScript, 'utf8');

                    await execFilePromise('docker', [
                        'exec', containerName, 'chmod', '+x', '/app/.autoqa-vnc-start.sh'
                    ], { timeout: 10000 });
                    await execFilePromise('docker', [
                        'exec', '-d', containerName, '/app/.autoqa-vnc-start.sh'
                    ], { timeout: 10000 });

                    // Give VNC services time to start
                    await new Promise(r => setTimeout(r, 3000));
                    console.log(`[Sandbox] VNC stack ready in ${containerName} — noVNC at http://localhost:${vncPort}`);

                    // Emit Socket.IO event so frontend knows VNC is available
                    if (typeof global !== 'undefined' && global.io) {
                        global.io.emit('sandbox_vnc_ready', {
                            runId,
                            containerId: i,
                            containerName,
                            vncPort,
                            vncUrl: `http://localhost:${vncPort}/vnc.html?autoconnect=true&resize=scale&reconnect=true&reconnect_delay=1000`
                        });
                    }
                }

                const appPkgPath = path.join(sandboxDir, appRel, 'package.json');
                if (fssync.existsSync(appPkgPath)) {
                    await dockerRun([
                        'exec', '-w', dockerAppWorkdir(appRel), containerName,
                        'npm', 'install', '--no-audit', '--no-fund', '--no-package-lock'
                    ], installTimeoutMs);
                    console.log(`[Sandbox] Pre-installed app dependencies in ${containerName} (cwd ${dockerAppWorkdir(appRel)}).`);
                }

                await dockerRun([
                    'exec', containerName,
                    'npm', 'install', '--no-audit', '--no-fund', '--no-package-lock',
                    'jest', 'supertest', 'jest-environment-node', `@playwright/test@${PLAYWRIGHT_VERSION}`, 'wait-on'
                ], installTimeoutMs);
                console.log(`[Sandbox] Pre-installed jest, @playwright/test, and wait-on in ${containerName}.`);
            } catch (err) {
                console.error(`[Sandbox] Container startup failed for ${containerName}:`, err.message);
                throw err;
            }

            return { sandboxDir, containerName, vncPort };
            } finally {
                releaseSandboxCreationSlot();
            }
        })());
    }

    return await Promise.all(createPromises);
}

/**
 * Writes the test file to the sandbox directory (which is mounted into the
 * running container), then executes it via `docker exec`.
 *
 * Uses `spawnCapture` instead of `execFilePromise` for the test runner step.
 * On Windows, Node.js execFile has a race condition (issue #56430) where
 * stdout/stderr pipes are destroyed before all data is read when the child
 * exits non-zero. spawn with `detached: false` keeps the pipes connected,
 * reliably capturing the full Jest/Playwright/pytest output even on failure — which is
 * critical for the healer to see what went wrong.
 */
async function executeTest(containerName, sandboxDir, testLanguage, testContent, testFilename, testData = {}, artifactContext = null) {
    const isPlaywrightTest = testLanguage === 'javascript'
        && typeof testContent === 'string'
        && testContent.includes('@playwright/test');

    let scriptToRun = testContent;
    if (testLanguage === 'javascript') {
        scriptToRun = `const testData = ${JSON.stringify(testData, null, 2)};\n\n${testContent}`;
    } else if (testLanguage === 'python') {
        scriptToRun = `import json as _json\ntest_data = _json.loads(${JSON.stringify(JSON.stringify(testData))})\n\n${testContent}`;
    }

    // Reset JSON data files before each test to prevent cross-test state pollution.
    // The container is persistent across all test cases in a run, so prior test
    // executions may have mutated these files, leaving stale/corrupt state.
    const dataResets = { 'todos.json': '[]', 'users.json': '[]', 'sessions.json': '{}' };
    for (const [file, content] of Object.entries(dataResets)) {
        const filePath = path.join(sandboxDir, file);
        if (fssync.existsSync(filePath)) {
            await fs.writeFile(filePath, content, 'utf8');
        }
    }

    const effectiveTestFilename = isPlaywrightTest ? 'autoqa.spec.js' : testFilename;
    const testPath = path.join(sandboxDir, effectiveTestFilename);
    await fs.writeFile(testPath, scriptToRun, 'utf8');

    const dependencies = extractDependencies(testContent, testLanguage);
    const testTimeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);

    try {
        if (testLanguage === 'javascript') {
            // extractDependencies maps '@playwright/test' to '@playwright' (first path segment).
            const PREINSTALLED = new Set([
                'jest', 'supertest', 'jest-environment-node', '@playwright/test', '@playwright', 'wait-on'
            ]);
            const extraDeps = dependencies.filter(d => !PREINSTALLED.has(d));

            if (extraDeps.length > 0) {
                await execFilePromise(
                    'docker',
                    ['exec', containerName, 'npm', 'install', ...extraDeps, '--no-audit', '--no-fund', '--no-package-lock'],
                    { timeout: testTimeout }
                );
            }

            if (isPlaywrightTest) {
                const playwrightConfigPath = path.join(sandboxDir, 'playwright.autoqa.config.cjs');
                await fs.writeFile(playwrightConfigPath, buildPlaywrightAutoqaConfigSource(), 'utf8');

                const pwOut = path.join(sandboxDir, 'test-results', 'playwright-autoqa');
                const pwHtml = path.join(sandboxDir, 'test-results', 'playwright-html');
                await fs.rm(pwOut, { recursive: true, force: true }).catch(() => {});
                await fs.rm(pwHtml, { recursive: true, force: true }).catch(() => {});

                let appRel = await readAppRootMarker(sandboxDir);
                if (appRel === null) {
                    appRel = discoverAppRootRelative(sandboxDir);
                    await writeAppRootMarker(sandboxDir, appRel);
                }
                const appAbs = appDirAbs(sandboxDir, appRel);
                const appWorkdir = dockerAppWorkdir(appRel);
                const pkg = await loadPackageJsonAt(appAbs);
                const { devShellCmd, targetUrl } = await resolveDevCommandAndTargetUrl(appAbs, pkg);
                if (!devShellCmd) {
                    throw new Error('Dev server failed to start: missing scripts.dev or scripts.start in package.json');
                }

                let didStartDevServer = false;
                try {
                    const startCmd =
                        '(' + devShellCmd + ') > /tmp/autoqa-dev.log 2>&1 & echo $! > /tmp/autoqa-dev.pid';
                    await execFilePromise(
                        'docker',
                        ['exec', '-d', '-w', appWorkdir, containerName, 'sh', '-c', startCmd],
                        { timeout: testTimeout }
                    );
                    didStartDevServer = true;

                    try {
                        await execFilePromise(
                            'docker',
                            [
                                'exec', containerName,
                                'npx', 'wait-on', targetUrl,
                                '-t', String(PLAYWRIGHT_WAIT_ON_MS)
                            ],
                            { timeout: PLAYWRIGHT_WAIT_ON_MS + 10000 }
                        );
                    } catch (waitErr) {
                        console.warn(`[Sandbox] wait-on timeout for ${targetUrl} in ${containerName} (assuming dev server booted but didn't open expected port). Ignoring warning and attempting test...`);
                    }

                    const execEnvArgs = ['exec', '-w', '/app'];
                    const forwardKeys = [
                        'AUTOQA_PLAYWRIGHT_TRACE',
                        'AUTOQA_PLAYWRIGHT_HEADED',
                        'AUTOQA_PLAYWRIGHT_SLOWMO_MS',
                        'AUTOQA_PLAYWRIGHT_HTML_REPORT',
                        'AUTOQA_PLAYWRIGHT_TEST_TIMEOUT_MS',
                        'AUTOQA_PLAYWRIGHT_EXPECT_TIMEOUT_MS',
                        'AUTOQA_PLAYWRIGHT_ACTION_TIMEOUT_MS',
                        'AUTOQA_PLAYWRIGHT_RETRIES',
                        'AUTOQA_E2E_BASE_URL',
                        'AUTOQA_LIVE_BROWSER',
                        'AUTOQA_LIVE_SLOWMO_MS',
                        'AUTOQA_PLAYWRIGHT_VIDEO'
                    ];
                    for (const key of forwardKeys) {
                        if (process.env[key] !== undefined && process.env[key] !== '') {
                            execEnvArgs.push('-e', `${key}=${process.env[key]}`);
                        }
                    }
                    // Forward DISPLAY for headed VNC mode
                    if (isLiveBrowserEnabled()) {
                        execEnvArgs.push('-e', 'DISPLAY=:99');
                    }
                    const runCmd = 'npx playwright test autoqa.spec.js --workers=1 --config=playwright.autoqa.config.cjs 2>&1';
                    execEnvArgs.push(containerName, 'sh', '-c', runCmd);

                    /** @type {{ url: string, fileName: string }[]} */
                    let failureScreenshots = [];
                    /** @type {{ url: string, fileName: string }[]} */
                    let traces = [];
                    /** @type {{ url: string, fileName: string }[]} */
                    let videos = [];

                    const mergeArtifacts = async () => {
                        if (!artifactContext) return { failureScreenshots: [], traces: [], videos: [] };
                        return persistPlaywrightArtifacts(sandboxDir, artifactContext);
                    };

                    try {
                        const { stdout, stderr } = await spawnCapture(
                            'docker', execEnvArgs,
                            { timeout: testTimeout }
                        );
                        const merged = await mergeArtifacts();
                        failureScreenshots = merged.failureScreenshots;
                        traces = merged.traces;
                        videos = merged.videos || [];
                        return {
                            success: true,
                            output: (stdout + '\n' + stderr).trim(),
                            failureScreenshots,
                            traces,
                            videos
                        };
                    } catch (spawnErr) {
                        const mergedArt = await mergeArtifacts();
                        failureScreenshots = mergedArt.failureScreenshots;
                        traces = mergedArt.traces;
                        videos = mergedArt.videos || [];
                        const stdout = spawnErr.stdout || '';
                        const stderr = spawnErr.stderr || '';
                        const combined = (stdout + '\n' + stderr).trim();
                        const output = combined || spawnErr.message;
                        return {
                            success: false,
                            output,
                            error: spawnErr.message,
                            failureScreenshots,
                            traces,
                            videos
                        };
                    }
                } finally {
                    if (didStartDevServer) {
                        await killPlaywrightBackgroundProcesses(containerName);
                    }
                }
            }

            // Use spawnCapture — reliably captures stdout+stderr on Windows even
            // when the process exits non-zero (unlike execFilePromise which drops them).
            // Merge stderr into stdout via sh -c "... 2>&1" so all output is in one stream.
            const runCmd = `./node_modules/.bin/jest ${testFilename} --no-coverage --forceExit --runInBand --testEnvironment=node --testTimeout=30000 2>&1`;
            const { stdout, stderr } = await spawnCapture(
                'docker', ['exec', containerName, 'sh', '-c', runCmd],
                { timeout: testTimeout }
            );
            return { success: true, output: (stdout + '\n' + stderr).trim(), failureScreenshots: [], traces: [] };

        } else if (testLanguage === 'python') {
            const PYTHON_BUILTINS = new Set(['json', 'os', 'sys', 'math', 're', 'datetime', 'time', 'random']);
            const depsToInstall = ['pytest', 'flask', 'requests', 'pytest-cov', ...dependencies]
                .filter(d => !PYTHON_BUILTINS.has(d.toLowerCase()));

            await execFilePromise(
                'docker',
                ['exec', containerName, 'pip', 'install', ...depsToInstall],
                { timeout: testTimeout }
            );

            const pytestCmd = `pytest ${testFilename} 2>&1`;
            const { stdout, stderr } = await spawnCapture(
                'docker', ['exec', containerName, 'sh', '-c', pytestCmd],
                { timeout: testTimeout }
            );
            return { success: true, output: (stdout + '\n' + stderr).trim(), failureScreenshots: [], traces: [] };

        } else {
            throw new Error(`Language ${testLanguage} not supported by Sandbox.`);
        }

    } catch (error) {
        // spawnCapture attaches .stdout and .stderr to the error even on non-zero exit.
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';
        const combined = (stdout + '\n' + stderr).trim();
        const output = combined || error.message;
        return { success: false, output, error: error.message, failureScreenshots: [], traces: [] };
    }
}

const PYTHON_AST_PARSE_SCRIPT = 'import sys, ast; ast.parse(sys.stdin.read())';

/**
 * In-memory syntax check before Docker. Does not execute the test body.
 * @param {string} testScript
 * @param {string} language - "javascript" | "python" | other (returns valid for unknown)
 * @returns {{ valid: true } | { valid: false, error: string }}
 */
function validateSyntaxLocal(testScript, language) {
    const script = testScript == null ? '' : String(testScript);
    const lang = String(language || '').toLowerCase();

    if (lang === 'javascript') {
        try {
            // eslint-disable-next-line no-new-func
            new Function(script);
            return { valid: true };
        } catch (e) {
            return { valid: false, error: e.message || String(e) };
        }
    }

    if (lang === 'python') {
        return validatePythonSyntaxAst(script);
    }

    return { valid: true };
}

function validatePythonSyntaxAst(script) {
    const inputBuf = Buffer.from(script, 'utf8');
    const maxBuffer = Math.max(2 * 1024 * 1024, (inputBuf.length || 1) * 4);

    /** @type {Array<string[]>} exe plus optional argv prefix (e.g. py -3) */
    const attempts = [];
    if (process.env.PYTHON_SYNTAX_BIN && String(process.env.PYTHON_SYNTAX_BIN).trim()) {
        attempts.push(process.env.PYTHON_SYNTAX_BIN.trim().split(/\s+/));
    }
    attempts.push(['python3'], ['python'], ['py', '-3']);

    let lastENOENT = false;
    const seen = new Set();

    for (const parts of attempts) {
        const key = parts.join(' ');
        if (seen.has(key)) continue;
        seen.add(key);
        const exe = parts[0];
        const suffix = [...parts.slice(1), '-c', PYTHON_AST_PARSE_SCRIPT];
        try {
            execFileSync(exe, suffix, {
                input: inputBuf,
                maxBuffer,
                windowsHide: true
            });
            return { valid: true };
        } catch (e) {
            if (e.code === 'ENOENT') {
                lastENOENT = true;
                continue;
            }
            const stderrRaw = e.stderr != null ? e.stderr : '';
            const stderr = Buffer.isBuffer(stderrRaw)
                ? stderrRaw.toString('utf8')
                : String(stderrRaw);
            const msg = stderr.trim() || e.message || String(e);
            return { valid: false, error: msg };
        }
    }

    const tail = lastENOENT
        ? ' (no python3/python/py on PATH; set PYTHON_SYNTAX_BIN or install Python)'
        : '';
    return {
        valid: false,
        error: `Python syntax check failed: no interpreter succeeded${tail}`
    };
}

/**
 * Stops and removes the persistent containers, then deletes the sandbox directories.
 * The container must be stopped BEFORE deleting the directory on Windows —
 * Docker Desktop holds file locks on the volume mount while the container is live.
 */
function cleanupSandboxPool(runId, pool) {
    if (!pool || !Array.isArray(pool)) return;

    for (const { sandboxDir, containerName } of pool) {
        const removeDir = () => {
            fs.rm(sandboxDir, { recursive: true, force: true })
                .catch(err => console.warn(`[Sandbox] Sandbox dir cleanup warning: ${err.message}`));
        };

        if (containerName) {
            // Stop the container first (releases volume file locks on Windows),
            // then remove it, then delete the directory.
            execFilePromise('docker', ['stop', containerName])
                .then(() => execFilePromise('docker', ['rm', containerName]))
                .then(() => removeDir())
                .catch(err => {
                    console.warn(`[Sandbox] Container cleanup warning: ${err.message}`);
                    // Still try to remove the directory even if docker stop/rm failed
                    removeDir();
                });
        } else {
            removeDir();
        }
    }
}

module.exports = {
    createSandboxPool,
    executeTest,
    validateSyntaxLocal,
    cleanupSandboxPool,
    sanitizeArtifactSegment
};
