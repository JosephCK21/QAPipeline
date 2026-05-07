/**
 * REST-sparing PR ingestion: one pulls.get (+ retry on rate limits), clone + git diff/read for files.
 */

const fs = require('fs/promises');
const fssync = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Octokit } = require('@octokit/rest');
require('dotenv').config();

const { discoverAppRootRelative } = require('./sandboxService');

function parsePRUrl(url) {
    try {
        const urlObj = new URL(url);
        const pathParts = urlObj.pathname.split('/').filter(Boolean);
        if (pathParts.length >= 4 && pathParts[2] === 'pull') {
            return {
                owner: pathParts[0],
                repo: pathParts[1],
                pull_number: parseInt(pathParts[3], 10),
            };
        }
        throw new Error('Invalid GitHub PR URL format');
    } catch {
        throw new Error('Could not parse GitHub URL');
    }
}

function getTmpRootForPR() {
    return process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
}

function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}

async function pullsGetWithRetry(octokit, { owner, repo, pull_number }) {
    let lastErr;
    for (let attempt = 0; attempt < 6; attempt++) {
        try {
            const res = await octokit.rest.pulls.get({
                owner,
                repo,
                pull_number,
            });
            return res.data;
        } catch (err) {
            lastErr = err;
            const status = err.status || err.response?.status;
            const resetRaw = err.response?.headers?.['x-ratelimit-reset'];
            const retryAfter = err.response?.headers?.['retry-after'];
            const isRateLimited = status === 403 && resetRaw !== undefined;
            const isTransient = status === 403 || status === 429 || status === 503;
            if (!isTransient || attempt === 5) break;
            let waitMs = 5000;
            if (retryAfter) waitMs = (parseInt(retryAfter, 10) || 60) * 1000;
            else if (isRateLimited && resetRaw) {
                const resetMs = Number(resetRaw) * 1000;
                waitMs = Math.min(Math.max(resetMs - Date.now(), 1500), 320_000);
            }
            console.warn(`[prGitWorkspace] pulls.get rate/wait (${status}), sleeping ${waitMs}ms attempt ${attempt + 1}`);
            await sleep(waitMs);
        }
    }
    throw lastErr;
}

function gitAuthBasicHeaderArgs() {
    const token = process.env.GITHUB_TOKEN;
    const b64 = Buffer.from(`x-access-token:${token || ''}`, 'utf8').toString('base64');
    return [`-c`, `http.extraHeader=AUTHORIZATION: basic ${b64}`];
}

/**
 * Spawn git with cwd set via `-C`; cwd must exist.
 * @returns {{ stdout: string, stderr: string }}
 */
function spawnGit(repoDir, extraGitArgs, timeoutMs = 600_000) {
    return new Promise((resolve, reject) => {
        const auth = gitAuthBasicHeaderArgs();
        const cd = path.resolve(repoDir).replace(/\\/g, '/');
        const args = [...auth, '-C', cd, ...extraGitArgs];
        const child = spawn('git', args, {
            detached: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const chunks = { stdout: [], stderr: [] };
        child.stdout.on('data', (d) => chunks.stdout.push(d));
        child.stderr.on('data', (d) => chunks.stderr.push(d));
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            reject(
                Object.assign(new Error(`git timed out after ${timeoutMs}ms`), {
                    cmd: `git ${extraGitArgs.join(' ')}`,
                    killed: true,
                })
            );
        }, timeoutMs);
        child.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            const stdout = Buffer.concat(chunks.stdout).toString();
            const stderr = Buffer.concat(chunks.stderr).toString();
            if (code === 0) resolve({ stdout, stderr });
            else {
                const err = new Error(stderr || stdout || `git exit ${code}`);
                err.code = code;
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });
    });
}

function mapStatusFromNameStatus(code) {
    const c = String(code || '').charAt(0).toUpperCase();
    if (c === 'A') return 'added';
    if (c === 'D') return 'removed';
    if (c === 'R' || c === 'C') return 'modified';
    return 'modified';
}

const MAX_PATCH_CHARS = 8000;
const MAX_FILE_BODY_FOR_ROW = 256_000;
const GIT_CMD_TIMEOUT_MS = Math.max(60_000, parseInt(process.env.AUTOQA_PR_GIT_CMD_TIMEOUT_MS || '600000', 10) || 600_000);
const DEFAULT_DEPTH = Math.max(20, parseInt(process.env.AUTOQA_PR_GIT_FETCH_DEPTH || '120', 10) || 120);
const MAX_DEEPEN_STEPS = Math.max(1, parseInt(process.env.AUTOQA_PR_GIT_MAX_DEEPEN || '8', 10) || 8);
const DEEPEN_BY = Math.max(50, parseInt(process.env.AUTOQA_PR_GIT_DEEPEN_BY || '150', 10) || 150);

function splitNameStatusLine(line) {
    const tab = line.indexOf('\t');
    if (tab < 0) return null;
    const code = line.slice(0, tab).trim();
    const rest = line.slice(tab + 1);
    if (code.startsWith('R') || code.startsWith('C')) {
        const parts = rest.split('\t');
        if (parts.length >= 2) return { code, path: parts[1].trim(), oldPath: parts[0].trim() };
        return { code, path: rest.trim(), oldPath: null };
    }
    return { code, path: rest.trim(), oldPath: null };
}

async function ensureObjectsForDiff(repoDir, baseSha, headSha) {
    let step = 0;
    while (step < MAX_DEEPEN_STEPS) {
        try {
            await spawnGit(repoDir, ['diff', '--name-status', baseSha, headSha], GIT_CMD_TIMEOUT_MS);
            return;
        } catch (e) {
            const msg = `${e.stderr || ''}\n${e.stdout || ''}\n${e.message || ''}`;
            const needsMore =
                /bad object|unknown revision|merge base|shallow|not a tree|did not send all necessary objects/i.test(msg);
            if (!needsMore) throw e;
            step += 1;
            console.warn(`[prGitWorkspace] Shallow history incomplete (step ${step}/${MAX_DEEPEN_STEPS}), deepening...`);
            try {
                await spawnGit(repoDir, ['fetch', '--deepen', String(DEEPEN_BY)], GIT_CMD_TIMEOUT_MS);
            } catch (fe) {
                console.warn(`[prGitWorkspace] deepen fetch failed: ${fe.message}`);
                throw e;
            }
        }
    }
    throw new Error(`[prGitWorkspace] Could not resolve diff between ${baseSha.slice(0, 7)} and ${headSha.slice(0, 7)} after deepening`);
}

async function readPatchForPath(repoDir, baseSha, headSha, relPath) {
    try {
        const { stdout } = await spawnGit(repoDir, ['diff', baseSha, headSha, '--', relPath], GIT_CMD_TIMEOUT_MS);
        const t = String(stdout || '');
        if (t.includes('Binary files') && t.length < 200) return '(binary diff omitted)';
        return t.length > MAX_PATCH_CHARS ? t.slice(0, MAX_PATCH_CHARS) + '\n// ... patch truncated' : t;
    } catch {
        return '(no patch)';
    }
}

async function readBlobAtHead(repoDir, headSha, relPath) {
    const spec = `${headSha}:${relPath.replace(/\\/g, '/')}`;
    try {
        const { stdout } = await spawnGit(repoDir, ['show', spec], GIT_CMD_TIMEOUT_MS);
        const t = String(stdout || '');
        if (t.length > MAX_FILE_BODY_FOR_ROW) return t.slice(0, MAX_FILE_BODY_FOR_ROW) + '\n// ... truncated';
        return t;
    } catch {
        return '// Could not read file at head';
    }
}

async function buildFilesFromDiff(repoDir, baseSha, headSha) {
    const { stdout } = await spawnGit(repoDir, ['diff', '--name-status', baseSha, headSha], GIT_CMD_TIMEOUT_MS);
    const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const entries = [];
    for (const line of lines) {
        const sp = splitNameStatusLine(line);
        if (!sp || !sp.path) continue;
        entries.push(sp);
    }

    const CONC = 25;
    const out = [];
    for (let i = 0; i < entries.length; i += CONC) {
        const slice = entries.slice(i, i + CONC);
        const batch = await Promise.all(
            slice.map(async (e) => {
                const status = mapStatusFromNameStatus(e.code);
                const patch = await readPatchForPath(repoDir, baseSha, headSha, e.path);
                let content = '';
                if (status !== 'removed') {
                    content = await readBlobAtHead(repoDir, headSha, e.path);
                }
                return {
                    filename: e.path,
                    status,
                    patch: patch || 'No patch available',
                    content,
                };
            })
        );
        out.push(...batch);
    }
    return out;
}

/**
 * Clone head repo, fetch base commit if needed, diff base..head, materialize prDetails.files from disk.
 * @param {string} runId
 * @param {string} prUrl
 */
async function preparePrGitWorkspace(runId, prUrl) {
    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN || undefined });
    const { owner, repo, pull_number } = parsePRUrl(prUrl);
    const pr = await pullsGetWithRetry(octokit, { owner, repo, pull_number });

    const headSha = pr.head.sha;
    const baseSha = pr.base.sha;
    const headRef = pr.head.ref;
    const headCloneUrl = pr.head.repo.clone_url;
    if (!headCloneUrl) {
        throw new Error('[prGitWorkspace] head.repo.clone_url missing (GitHub API)');
    }

    const baseFull = pr.base.repo.full_name;
    const headFull = pr.head.repo.full_name;
    const isFork = String(baseFull || '') !== String(headFull || '');

    const baseRoot = getTmpRootForPR();
    const workspaceRoot = path.join(baseRoot, 'autoqa-pr-ws', String(runId), 'checkout');
    await fs.mkdir(path.dirname(workspaceRoot), { recursive: true });
    if (fssync.existsSync(workspaceRoot)) {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    }

    const depth = String(DEFAULT_DEPTH);
    const cloneTimeout = GIT_CMD_TIMEOUT_MS;

    const tryClone = async () => {
        try {
            const auth = gitAuthBasicHeaderArgs();
            const url = headCloneUrl.replace(/^https:\/\//, `https://x-access-token:${process.env.GITHUB_TOKEN}@`);
            await new Promise((resolve, reject) => {
                const args = [
                    ...auth,
                    'clone',
                    '--depth',
                    depth,
                    '-b',
                    headRef,
                    url,
                    workspaceRoot,
                ];
                const child = spawn('git', args, { stdio: 'inherit', windowsHide: true });
                const t = setTimeout(() => {
                    child.kill('SIGTERM');
                    reject(new Error('git clone timed out'));
                }, cloneTimeout);
                child.on('error', (e) => {
                    clearTimeout(t);
                    reject(e);
                });
                child.on('close', (code) => {
                    clearTimeout(t);
                    if (code === 0) resolve();
                    else reject(new Error(`git clone exit ${code}`));
                });
            });
        } catch (e) {
            console.warn(`[prGitWorkspace] clone -b ${headRef} failed, falling back to clone + fetch sha: ${e.message}`);
            const auth = gitAuthBasicHeaderArgs();
            const url = headCloneUrl.replace(/^https:\/\//, `https://x-access-token:${process.env.GITHUB_TOKEN}@`);
            await new Promise((resolve, reject) => {
                const args = [...auth, 'clone', '--depth', depth, url, workspaceRoot];
                const child = spawn('git', args, { stdio: 'inherit', windowsHide: true });
                const t = setTimeout(() => {
                    child.kill('SIGTERM');
                    reject(new Error('git clone fallback timed out'));
                }, cloneTimeout);
                child.on('error', (err) => {
                    clearTimeout(t);
                    reject(err);
                });
                child.on('close', (code) => {
                    clearTimeout(t);
                    if (code === 0) resolve();
                    else reject(new Error(`git clone fallback exit ${code}`));
                });
            });
            await spawnGit(workspaceRoot, ['fetch', '--depth', depth, 'origin', headSha], cloneTimeout);
            await spawnGit(workspaceRoot, ['checkout', '-f', headSha], cloneTimeout);
        }
    };

    await tryClone();

    if (!process.env.GITHUB_TOKEN) {
        console.warn('[prGitWorkspace] GITHUB_TOKEN empty — clone may fail for private repos');
    }

    if (isFork) {
        const cleanUpstream = String(pr.base.repo.clone_url || '').replace(/^https:\/\/[^@]+@/, 'https://');
        if (!cleanUpstream.startsWith('https://')) {
            throw new Error('[prGitWorkspace] fork PR requires base.repo.clone_url');
        }
        if (!process.env.GITHUB_TOKEN) {
            throw new Error('[prGitWorkspace] fork PR requires GITHUB_TOKEN for upstream fetch');
        }
        try {
            await spawnGit(workspaceRoot, ['remote', 'add', 'upstream', cleanUpstream], GIT_CMD_TIMEOUT_MS);
        } catch {
            await spawnGit(workspaceRoot, ['remote', 'set-url', 'upstream', cleanUpstream], GIT_CMD_TIMEOUT_MS);
        }
        await spawnGit(workspaceRoot, ['fetch', '--depth', depth, 'upstream', baseSha], GIT_CMD_TIMEOUT_MS);
    } else {
        await spawnGit(workspaceRoot, ['fetch', '--depth', depth, 'origin', baseSha], GIT_CMD_TIMEOUT_MS);
    }

    await ensureObjectsForDiff(workspaceRoot, baseSha, headSha);
    const files = await buildFilesFromDiff(workspaceRoot, baseSha, headSha);

    const prDetails = {
        title: pr.title,
        body: pr.body || '',
        author: pr.user.login,
        branch: `${pr.head.ref} -> ${pr.base.ref}`,
        headRef: pr.head.ref,
        headRepoFullName: pr.head.repo.full_name,
        files,
        _prUrl: prUrl,
        _workspaceRoot: workspaceRoot,
        _baseSha: baseSha,
        _headSha: headSha,
    };

    console.log(
        `[prGitWorkspace] Prepared workspace ${workspaceRoot} — ${files.length} changed file(s) via git diff (fork=${isFork})`
    );

    const cleanup = async () => {
        try {
            await fs.rm(path.join(baseRoot, 'autoqa-pr-ws', String(runId)), { recursive: true, force: true });
        } catch (e) {
            console.warn(`[prGitWorkspace] cleanup: ${e.message}`);
        }
    };

    return { prDetails, cleanup };
}

const WORKSPACE_READ_SKIP = new Set([
    'node_modules/',
    'dist/',
    'build/',
    '.next/',
    '__pycache__/',
]);

/**
 * Read files from a prepared PR workspace (same shape as fetchFullFileContents).
 * @param {string} workspaceRoot
 * @param {string[]} filePaths
 * @param {{ quiet?: boolean }} opts
 */
async function readFilesFromWorkspace(workspaceRoot, filePaths, opts = {}) {
    const MAX_FILE_CHARS = 12000;
    const quiet = Boolean(opts.quiet);
    const eligible = (filePaths || []).filter((fp) =>
        ![...WORKSPACE_READ_SKIP].some((d) => fp.includes(d))
    );
    const results = [];
    for (const filePath of eligible) {
        const rel = filePath.replace(/\\/g, '/');
        const abs = path.join(workspaceRoot, ...rel.split('/').filter(Boolean));
        try {
            const raw = await fs.readFile(abs, 'utf8');
            const content =
                raw.length > MAX_FILE_CHARS ? raw.slice(0, MAX_FILE_CHARS) + '\n// ... truncated' : raw;
            results.push({ path: filePath, content });
        } catch (err) {
            if (!quiet) results.push({ path: filePath, content: `// Could not fetch: ${err.message}` });
        }
    }
    if (quiet && results.length === 0 && eligible.length > 0) {
        console.log(`[prGitWorkspace] Probed ${eligible.length} candidate test file(s) — none on disk.`);
    }
    return results;
}

/**
 * Read package.json / requirements.txt from workspace (head tree on disk).
 * @param {string} workspaceRoot
 */
async function readDepsFromWorkspace(workspaceRoot) {
    const roots = new Set([workspaceRoot]);
    try {
        const appRel = discoverAppRootRelative(workspaceRoot);
        if (appRel) roots.add(path.join(workspaceRoot, ...appRel.split('/').filter(Boolean)));
    } catch {
        /* ignore */
    }
    const names = ['package.json', 'requirements.txt'];
    let out = '';
    for (const root of roots) {
        let any = false;
        for (const n of names) {
            const abs = path.join(root, n);
            try {
                const text = await fs.readFile(abs, 'utf8');
                out += `\n--- [${n} under ${path.relative(workspaceRoot, root) || '.'}] ---\n${text}\n`;
                any = true;
            } catch {
                /* missing */
            }
        }
        if (any) return out;
    }
    return 'No dependency files (package.json or requirements.txt) found in PR workspace checkout.';
}

module.exports = {
    parsePRUrl,
    preparePrGitWorkspace,
    readFilesFromWorkspace,
    readDepsFromWorkspace,
};
