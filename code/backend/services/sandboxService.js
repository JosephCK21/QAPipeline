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

const PLAYWRIGHT_WAIT_ON_MS = 30000;

/** Playwright traces allowed by env AUTOQA_PLAYWRIGHT_TRACE */
const PLAYWRIGHT_TRACE_MODES = new Set(['on', 'retain-on-failure', 'on-first-retry']);

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
const HEADED = process.env.AUTOQA_PLAYWRIGHT_HEADED === '1' || process.env.AUTOQA_PLAYWRIGHT_HEADED === 'true';
const SLOWMO = parseInt(process.env.AUTOQA_PLAYWRIGHT_SLOWMO_MS || '0', 10) || 0;
module.exports = defineConfig({
    testDir: '.',
    testMatch: /autoqa\\.spec\\.js$/,
    forbidOnly: true,
    fullyParallel: false,
    workers: 1,
    reporter: process.env.AUTOQA_PLAYWRIGHT_HTML_REPORT === '1'
        ? [['list'], ['html', { outputFolder: 'test-results/playwright-html', open: 'never' }]]
        : [['list']],
    outputDir: 'test-results/playwright-autoqa',
    use: {
        ...devices['Desktop Chrome'],
        headless: !HEADED,
        screenshot: 'only-on-failure',
        trace: TRACE_OK.has(TRACE) ? TRACE : 'off',
        ...(SLOWMO > 0 ? { launchOptions: { slowMo: SLOWMO } } : {})
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
    const empty = { failureScreenshots: [], traces: [] };
    if (!ctx?.runId || !ctx.testCaseId) return empty;

    const pwRoot = path.join(sandboxDir, 'test-results', 'playwright-autoqa');
    const acc = { ext: new Set(['.png', '.zip']), out: [] };
    await collectFilesByExtension(pwRoot, acc);

    /** @type {string[]} */
    const pngFiles = acc.out.filter(f => f.endsWith('.png')).sort();
    /** @type {string[]} */
    const zipFiles = acc.out.filter(f => f.endsWith('.zip')).sort();

    if (pngFiles.length === 0 && zipFiles.length === 0) return empty;

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

    return { failureScreenshots, traces };
}

/**
 * @param {string} sandboxDir
 * @returns {Promise<object|null>}
 */
async function loadPackageJsonForPlaywright(sandboxDir) {
    const p = path.join(sandboxDir, 'package.json');
    try {
        const raw = await fs.readFile(p, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/**
 * @param {object|null} pkg
 * @returns {{ devShellCmd: string | null, port: number, targetUrl: string }}
 */
function resolveDevCommandAndPort(pkg) {
    if (!pkg || typeof pkg !== 'object') {
        return { devShellCmd: null, port: 5173, targetUrl: 'http://localhost:5173' };
    }
    const scripts = pkg.scripts || {};
    let devShellCmd = null;
    if (scripts.dev) devShellCmd = 'npm run dev';
    else if (scripts.start) devShellCmd = 'npm run start';

    const merged = { ...pkg.dependencies, ...pkg.devDependencies };
    const keys = Object.keys(merged);
    const has = (name) => keys.includes(name);
    let port = 5173;
    if (has('vite')) {
        port = 5173;
    } else if (has('next') || has('@next/next') || has('react-scripts')) {
        port = 3000;
    }

    const targetUrl = `http://localhost:${port}`;
    return { devShellCmd, port, targetUrl };
}

async function killPlaywrightBackgroundProcesses(containerName) {
    try {
        await execFilePromise(
            'docker',
            ['exec', containerName, 'sh', '-c', 'pkill -f node || true'],
            { timeout: 30000 }
        );
    } catch (e) {
        console.warn(`[Sandbox] Playwright dev server cleanup warning: ${e.message}`);
    }
}

// ---------------------------------------------------------------------------
// SANDBOX LIFECYCLE
// ---------------------------------------------------------------------------

/**
 * Creates a pool of sandbox directories, clones the repo into each, starts
 * multiple persistent Docker containers for the run, and pre-installs dependencies.
 *
 * Returns an array of { sandboxDir, containerName } objects.
 */
async function createSandboxPool(runId, prDetails, concurrency = 2) {
    const createPromises = [];

    for (let i = 1; i <= concurrency; i++) {
        createPromises.push((async () => {
            const baseTmp = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
            const sandboxDir = path.join(baseTmp, 'autoqa-sandbox', `${runId}-${i}`);
            const containerName = `autoqa-sandbox-${runId}-${i}`;

            await fs.mkdir(sandboxDir, { recursive: true });

            // -- Clone or flat-drop ------------------------------------------------
            try {
                if (prDetails.headRepoFullName && prDetails.headRef) {
                    let repoUrl = `https://github.com/${prDetails.headRepoFullName}.git`;
                    if (process.env.GITHUB_TOKEN) {
                        repoUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${prDetails.headRepoFullName}.git`;
                    }
                    const timeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
                    await execPromise(
                        `git clone --depth 1 -b ${prDetails.headRef} "${repoUrl}" "${sandboxDir}"`,
                        { timeout: timeoutMs }
                    );
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

            // -- Start ONE persistent container ------------------------------------
            const volumeDir = sandboxDir.replace(/\\/g, '/');
            const runTimeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
            const installTimeoutMs = Math.max(runTimeoutMs, 300000);

            try {
                await execFilePromise('docker', ['rm', '-f', containerName]).catch(() => { });

                await dockerRun([
                    'run', '-d',
                    '--name', containerName,
                    '-v', `${volumeDir}:/app`,
                    '-w', '/app',
                    'mcr.microsoft.com/playwright:v1.44.0-jammy',
                    'tail', '-f', '/dev/null'
                ], runTimeoutMs);

                console.log(`[Sandbox] Container started: ${containerName}`);

                const pkgJsonPath = path.join(sandboxDir, 'package.json');
                if (fssync.existsSync(pkgJsonPath)) {
                    await dockerRun([
                        'exec', containerName,
                        'npm', 'install', '--no-audit', '--no-fund', '--no-package-lock'
                    ], installTimeoutMs);
                    console.log(`[Sandbox] Pre-installed app dependencies in ${containerName}.`);
                }

                await dockerRun([
                    'exec', containerName,
                    'npm', 'install', '--no-audit', '--no-fund', '--no-package-lock',
                    'jest', 'supertest', 'jest-environment-node', '@playwright/test@1.44.0', 'wait-on'
                ], installTimeoutMs);
                console.log(`[Sandbox] Pre-installed jest, @playwright/test, and wait-on in ${containerName}.`);
            } catch (err) {
                console.error(`[Sandbox] Container startup failed for ${containerName}:`, err.message);
                throw err;
            }

            return { sandboxDir, containerName };
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

                const pkg = await loadPackageJsonForPlaywright(sandboxDir);
                const { devShellCmd, targetUrl } = resolveDevCommandAndPort(pkg);
                if (!devShellCmd) {
                    throw new Error('Dev server failed to start: missing scripts.dev or scripts.start in package.json');
                }

                let didStartDevServer = false;
                try {
                    await execFilePromise(
                        'docker',
                        ['exec', '-d', '-w', '/app', containerName, 'sh', '-c', devShellCmd],
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
                        const stderr = waitErr.stderr != null
                            ? (Buffer.isBuffer(waitErr.stderr) ? waitErr.stderr.toString() : String(waitErr.stderr))
                            : '';
                        const detail = stderr.trim() || waitErr.message || String(waitErr);
                        throw new Error(`Dev server failed to start: ${detail}`);
                    }

                    const execEnvArgs = ['exec', '-w', '/app'];
                    const forwardKeys = ['AUTOQA_PLAYWRIGHT_TRACE', 'AUTOQA_PLAYWRIGHT_HEADED', 'AUTOQA_PLAYWRIGHT_SLOWMO_MS', 'AUTOQA_PLAYWRIGHT_HTML_REPORT'];
                    for (const key of forwardKeys) {
                        if (process.env[key] !== undefined && process.env[key] !== '') {
                            execEnvArgs.push('-e', `${key}=${process.env[key]}`);
                        }
                    }
                    const runCmd = 'npx playwright test autoqa.spec.js --workers=1 --config=playwright.autoqa.config.cjs 2>&1';
                    execEnvArgs.push(containerName, 'sh', '-c', runCmd);

                    /** @type {{ url: string, fileName: string }[]} */
                    let failureScreenshots = [];
                    /** @type {{ url: string, fileName: string }[]} */
                    let traces = [];

                    const mergeArtifacts = async () => {
                        if (!artifactContext) return { failureScreenshots: [], traces: [] };
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
                        return {
                            success: true,
                            output: (stdout + '\n' + stderr).trim(),
                            failureScreenshots,
                            traces
                        };
                    } catch (spawnErr) {
                        const mergedArt = await mergeArtifacts();
                        failureScreenshots = mergedArt.failureScreenshots;
                        traces = mergedArt.traces;
                        const stdout = spawnErr.stdout || '';
                        const stderr = spawnErr.stderr || '';
                        const combined = (stdout + '\n' + stderr).trim();
                        const output = combined || spawnErr.message;
                        return {
                            success: false,
                            output,
                            error: spawnErr.message,
                            failureScreenshots,
                            traces
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
