const fs = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const babelParser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

// Helper to extract basic dependencies from the test code using AST
function extractDependencies(code, language) {
    let deps = new Set();
    if (language === 'javascript') {
        try {
            const ast = babelParser.parse(code, {
                sourceType: 'module',
                plugins: ['jsx', 'typescript'] // handle most variants
            });
            traverse(ast, {
                ImportDeclaration(path) {
                    const source = path.node.source.value;
                    if (!source.startsWith('.') && !source.startsWith('/')) {
                        deps.add(source.split('/')[0]); // get base package
                    }
                },
                CallExpression(path) {
                    if (path.node.callee.name === 'require') {
                        const args = path.node.arguments;
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
    return Array.from(deps);
}

async function createSandbox(runId, prDetails) {
    const baseTmp = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
    const sandboxDir = path.join(baseTmp, 'autoqa-sandbox', runId);

    // Create dir if not exists
    await fs.mkdir(sandboxDir, { recursive: true });

    try {
        if (prDetails.headRepoFullName && prDetails.headRef) {
            // Full repository clone using git
            let repoUrl = `https://github.com/${prDetails.headRepoFullName}.git`;
            if (process.env.GITHUB_TOKEN) {
                repoUrl = `https://${process.env.GITHUB_TOKEN}@github.com/${prDetails.headRepoFullName}.git`;
            }
            // Clone only the exact branch
            const cloneCmd = `git clone --depth 1 -b ${prDetails.headRef} ${repoUrl} "${sandboxDir}"`;
            const timeoutMs = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
            await execPromise(cloneCmd, { timeout: timeoutMs });
            console.log(`[Sandbox] Cloned repo: ${prDetails.headRepoFullName} @ ${prDetails.headRef}`);
            
            // Still overlay the mock data or other AI-generated flat files directly
            // prDetails.files usually contains 'mock_data.json' because we inject it in pipeline.js
            await Promise.all(prDetails.files.map(async file => {
               if (file.filename === 'mock_data.json') {
                   const filePath = path.join(sandboxDir, 'mock_data.json');
                   await fs.writeFile(filePath, file.content, 'utf8');
               }
            }));
        } else {
            // Fallback for flat structure if repo info is missing
            await Promise.all(
                prDetails.files.map(async file => {
                    const filePath = path.join(sandboxDir, path.basename(file.filename));
                    await fs.writeFile(filePath, file.content, 'utf8');
                })
            );
        }
    } catch (err) {
        console.error('[Sandbox] Failed to clone repo, falling back to flat file drop', err);
        // Fallback
        await Promise.all(
            prDetails.files.map(async file => {
                const filePath = path.join(sandboxDir, path.basename(file.filename));
                await fs.writeFile(filePath, file.content, 'utf8');
            })
        );
    }

    return sandboxDir;
}

async function executeTest(sandboxDir, testLanguage, testContent, testFilename) {
    // Write test file
    const testPath = path.join(sandboxDir, testFilename);
    await fs.writeFile(testPath, testContent, 'utf8');

    // Automatically detect what packages the AI imported
    const dependencies = extractDependencies(testContent, testLanguage);

    try {
        let executeCmd = '';
        const isWin = process.platform === 'win32';
        
        // Ensure path formatting for Docker volumes on Windows
        // In PowerShell/GitBash, absolute paths like C:\tmp... usually work fine with Docker Desktop.
        let volumeDir = sandboxDir;
        if (isWin) {
            volumeDir = sandboxDir.replace(/\\/g, '/');
        }

        if (testLanguage === 'javascript') {
            const depsStr = ['jest', ...dependencies].join(' ');
            
            // Build the shell command that runs inside the container
            const containerScript = `npm init -y && npm install ${depsStr} --no-audit --no-fund && npx jest ${testFilename}`;
            
            // Run Node.js container, mount sandbox directory, execute script
            executeCmd = `docker run --rm -v "${volumeDir}:/app" -w /app node:20-slim sh -c "${containerScript}"`;
        } 
        else if (testLanguage === 'python') {
            const depsStr = ['pytest', 'flask', 'requests', 'pytest-cov', ...dependencies]
                // Prevent standard library modules from breaking pip install
                .filter(d => !['json', 'os', 'sys', 'math', 're', 'datetime', 'time', 'random'].includes(d.toLowerCase()))
                .join(' ');
            
            // Build the shell command that runs inside the container
            const containerScript = `pip install ${depsStr} && pytest ${testFilename}`;
            
            // Run Python container, mount sandbox directory, execute script
            executeCmd = `docker run --rm -v "${volumeDir}:/app" -w /app python:3.12-slim sh -c "${containerScript}"`;
        } 
        else {
            throw new Error(`Language ${testLanguage} not supported by Sandbox.`);
        }

        // 4. Run the actual Test inside the isolated Docker container
        // Increase timeout heavily because npm install / pip install take time
        const testTimeout = parseInt(process.env.SANDBOX_TIMEOUT_MS || '120000', 10);
        const { stdout, stderr } = await execPromise(executeCmd, { timeout: testTimeout, shell: true });
        return { success: true, output: (stdout + '\n' + stderr).trim() };

    } catch (error) {
        let fullOutput = ((error.stdout || '') + '\n' + (error.stderr || '')).trim();
        if (fullOutput === '\n' || fullOutput === '') {
            fullOutput = error.message; 
        }
        return { success: false, output: fullOutput, error: error.message };
    }
}

function cleanupSandbox(runId) {
    const baseTmp = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
    const sandboxDir = path.join(baseTmp, 'autoqa-sandbox', runId);
    fs.rm(sandboxDir, { recursive: true, force: true }).catch(err => {
        console.error('Failed to cleanup sandbox', err);
    });
}

module.exports = {
    createSandbox,
    executeTest,
    cleanupSandbox,
};
