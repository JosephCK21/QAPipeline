const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { exec, execFile, spawn } = require('child_process');
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

function dockerArgs(...args) {
    return args;
}

async function dockerRun(args, timeoutMs = 120000) {
    return execFilePromise('docker', args, { timeout: timeoutMs });
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
                    'node:20-slim',
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
                    'jest', 'supertest', 'jest-environment-node'
                ], installTimeoutMs);
                console.log(`[Sandbox] Pre-installed jest in ${containerName}.`);
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
 * reliably capturing the full Jest/pytest output even on failure — which is
 * critical for the healer to see what went wrong.
 */
async function executeTest(containerName, sandboxDir, testLanguage, testContent, testFilename, testData = {}) {
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

    const testPath = path.join(sandboxDir, testFilename);
    await fs.writeFile(testPath, scriptToRun, 'utf8');

    const dependencies = extractDependencies(testContent, testLanguage);
    const testTimeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);

    try {
        if (testLanguage === 'javascript') {
            const PREINSTALLED = new Set(['jest', 'supertest', 'jest-environment-node']);
            const extraDeps = dependencies.filter(d => !PREINSTALLED.has(d));

            if (extraDeps.length > 0) {
                await execFilePromise(
                    'docker',
                    ['exec', containerName, 'npm', 'install', ...extraDeps, '--no-audit', '--no-fund', '--no-package-lock'],
                    { timeout: testTimeout }
                );
            }

            // Use spawnCapture — reliably captures stdout+stderr on Windows even
            // when the process exits non-zero (unlike execFilePromise which drops them).
            // Merge stderr into stdout via sh -c "... 2>&1" so all output is in one stream.
            const jestCmd = `./node_modules/.bin/jest ${testFilename} --no-coverage --forceExit --runInBand --testEnvironment=node --testTimeout=30000 2>&1`;
            const { stdout, stderr } = await spawnCapture(
                'docker', ['exec', containerName, 'sh', '-c', jestCmd],
                { timeout: testTimeout }
            );
            return { success: true, output: (stdout + '\n' + stderr).trim() };

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
            return { success: true, output: (stdout + '\n' + stderr).trim() };

        } else {
            throw new Error(`Language ${testLanguage} not supported by Sandbox.`);
        }

    } catch (error) {
        // spawnCapture attaches .stdout and .stderr to the error even on non-zero exit.
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';
        const combined = (stdout + '\n' + stderr).trim();
        const output = combined || error.message;
        return { success: false, output, error: error.message };
    }
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
    cleanupSandboxPool,
};
