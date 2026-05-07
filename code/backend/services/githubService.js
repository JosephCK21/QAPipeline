const { Octokit } = require('@octokit/rest');
const path = require('path');
require('dotenv').config();

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN || undefined,
});

/** Max parallel raw content fetches per PR (avoids thousands of sockets at once). */
const PR_RAW_FETCH_CONCURRENCY = 10;

/**
 * GitHub paginates pull file lists (default page size 30). Fetch all pages.
 * @returns {{ files: object[], pagesFetched: number }}
 */
async function listAllPullFiles({ owner, repo, pull_number }) {
    const files = [];
    const per_page = 100;
    let page = 1;
    while (true) {
        const { data } = await octokit.rest.pulls.listFiles({
            owner,
            repo,
            pull_number,
            page,
            per_page,
        });
        files.push(...data);
        if (data.length < per_page) {
            return { files, pagesFetched: page };
        }
        page += 1;
    }
}

async function enrichPullFileFromRaw(file) {
    if (file.status === 'removed') return null;
    try {
        const response = await fetch(file.raw_url);
        const content = await response.text();
        return {
            filename: file.filename,
            status: file.status,
            content,
            patch: file.patch || 'No patch available',
        };
    } catch {
        return {
            filename: file.filename,
            status: file.status,
            content: '// Could not fetch content',
            patch: file.patch || 'No patch available',
        };
    }
}

// Parse GitHub URL: https://github.com/owner/repo/pull/123
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
    } catch (error) {
        throw new Error('Could not parse GitHub URL');
    }
}

async function fetchPRDetails(url) {
    const { owner, repo, pull_number } = parsePRUrl(url);

    // Fetch PR data
    const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
    });

    const { files, pagesFetched } = await listAllPullFiles({ owner, repo, pull_number });
    console.log(
        `[GitHub] PR ${owner}/${repo}#${pull_number}: ${files.length} changed file(s) across ${pagesFetched} listFiles page(s)`
    );

    const changedFiles = [];
    for (let i = 0; i < files.length; i += PR_RAW_FETCH_CONCURRENCY) {
        const slice = files.slice(i, i + PR_RAW_FETCH_CONCURRENCY);
        const batch = await Promise.all(slice.map((file) => enrichPullFileFromRaw(file)));
        for (const entry of batch) {
            if (entry !== null) changedFiles.push(entry);
        }
    }

    return {
        title: pr.title,
        body: pr.body || '',
        author: pr.user.login,
        branch: `${pr.head.ref} -> ${pr.base.ref}`,
        headRef: pr.head.ref,
        headRepoFullName: pr.head.repo.full_name,
        files: changedFiles,
    };
}

async function fetchPRDependencies(url) {
    const { owner, repo, pull_number } = parsePRUrl(url);

    // Get PR details (for head and base branch)
    const { data: pr } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
    });

    // Get default branch
    let defaultBranch = 'main';
    try {
        const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
        defaultBranch = repoInfo.default_branch;
    } catch (e) {
        console.warn(`Could not fetch repo info for ${owner}/${repo}, defaulting to main`);
    }

    const branchesToCheck = [pr.head.ref, pr.base.ref, defaultBranch];
    const filesToLookFor = ['requirements.txt', 'package.json'];
    let dependenciesContent = '';

    for (const branch of branchesToCheck) {
        let branchHasDeps = false;
        for (const filename of filesToLookFor) {
            try {
                const { data } = await octokit.rest.repos.getContent({
                    owner,
                    repo,
                    path: filename,
                    ref: branch
                });
                const content = Buffer.from(data.content, 'base64').toString('utf8');
                dependenciesContent += `\n--- [${filename} from branch ${branch}] ---\n${content}\n`;
                branchHasDeps = true;
            } catch (err) {
                // Not found, ignore
            }
        }
        if (branchHasDeps) {
            return dependenciesContent; // Found dependencies in this branch, return them.
        }
    }

    return 'No dependency files (requirements.txt or package.json) found in head, base, or default branches.';
}

async function fetchUserRepositories() {
    try {
        const { data } = await octokit.rest.repos.listForAuthenticatedUser({
            sort: 'updated',
            per_page: 50
        });
        return data.map(repo => ({
            id: repo.id,
            name: repo.name,
            full_name: repo.full_name, // e.g., Solutions21/AutoQA
            url: repo.html_url,
            language: repo.language,
            updated_at: repo.updated_at,
            private: repo.private,
            // Add our automation placeholders
            autoExecute: false,
            autoApprove: false,
        }));
    } catch (error) {
        console.error("Error fetching repositories:", error);
        if (error.status === 401) {
            console.warn("GitHub Token is invalid or missing. Returning empty array.");
            return [];
        }
        throw new Error('Could not fetch user repositories. Make sure GITHUB_TOKEN is set.');
    }
}

async function fetchRepoBranchTree(owner, repo) {
    try {
        const [{ data: branches }, { data: pulls }] = await Promise.all([
            octokit.rest.repos.listBranches({
                owner,
                repo,
                per_page: 100
            }),
            octokit.rest.pulls.list({
                owner,
                repo,
                state: 'open',
                per_page: 100
            })
        ]);

        const prMap = {};
        for (const pr of pulls) {
            prMap[pr.head.ref] = {
                number: pr.number,
                title: pr.title,
                url: pr.html_url,
                user: pr.user.login
            };
        }

        return branches.map(branch => ({
            name: branch.name,
            commit: branch.commit.sha,
            protected: branch.protected,
            activePR: prMap[branch.name] || null
        }));
    } catch (error) {
        console.error(`Error fetching branch tree for ${owner}/${repo}:`, error);
        throw error;
    }
}

async function fetchStagingCodebase(owner, repo) {
    let branchData = null;
    
    try {
        const { data: repoInfo } = await octokit.rest.repos.get({ owner, repo });
        const defaultBranch = repoInfo.default_branch;
        
        const { data: branchRes } = await octokit.rest.repos.getBranch({ owner, repo, branch: defaultBranch });
        branchData = branchRes;
    } catch (error) {
        console.warn(`Could not fetch branch data for ${owner}/${repo}:`, error.message);
    }
    
    if (!branchData) {
        console.warn(`Could not find a valid default branch for ${owner}/${repo}`);
        return '';
    }
    
    const { data: treeData } = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: branchData.commit.sha,
        recursive: 'true'
    });
    
    const allowedExts = ['.js', '.jsx', '.ts', '.tsx', '.py'];
    const skipDirs = ['node_modules/', 'dist/', 'build/', '.git/'];
    
    const codeFiles = (treeData.tree || []).filter(item => {
        if (item.type !== 'blob') return false;
        
        for (const dir of skipDirs) {
            if (item.path.includes(dir)) return false;
        }
        
        const ext = path.extname(item.path);
        return allowedExts.includes(ext);
    }).slice(0, 100);
    
    let codebaseString = '';
    
    for (const file of codeFiles) {
        try {
            const { data: blob } = await octokit.rest.git.getBlob({
                owner,
                repo,
                file_sha: file.sha
            });
            const content = Buffer.from(blob.content, 'base64').toString('utf8');
            codebaseString += `Filename: ${file.path}\nContent:\n${content}\n---\n`;
        } catch (err) {
            console.warn(`Error fetching file content for ${file.path}: ${err.message}`);
        }
    }
    
    return codebaseString;
}

// Fetch the full content of specific files from a given branch (not just the diff patch).
// Used to give the LLM full context when generating test cases.
async function fetchFullFileContents(owner, repo, ref, filePaths, opts = {}) {
    const SKIP_DIRS = ['node_modules/', 'dist/', 'build/', '.next/', '__pycache__/'];
    const MAX_FILE_CHARS = 12000;
    const CONCURRENCY = 5;
    const quiet = Boolean(opts.quiet);

    const eligible = filePaths.filter(fp => !SKIP_DIRS.some(d => fp.includes(d)));

    const fetchOne = async (filePath) => {
        try {
            const { data } = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
            if (data.type !== 'file' || !data.content) return null;
            const content = Buffer.from(data.content, 'base64').toString('utf8');
            return {
                path: filePath,
                content: content.length > MAX_FILE_CHARS ? content.slice(0, MAX_FILE_CHARS) + '\n// ... truncated' : content
            };
        } catch (err) {
            return quiet ? null : { path: filePath, content: `// Could not fetch: ${err.message}` };
        }
    };

    // Fetch up to CONCURRENCY files simultaneously to stay within GitHub rate limits.
    const results = [];
    for (let i = 0; i < eligible.length; i += CONCURRENCY) {
        const batch = eligible.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(fetchOne));
        for (const r of batchResults) { if (r) results.push(r); }
    }

    if (quiet && results.length === 0 && filePaths.length > 0) {
        console.log(`[GitHub] Probed ${filePaths.length} candidate test file(s) — none found in repo.`);
    }
    return results;
}

// Given a list of changed file paths, derive a list of candidate test/spec files to also fetch.
function inferTestFilePaths(changedFilePaths) {
    const testPaths = [];
    for (const p of changedFilePaths) {
        const withoutExt = p.replace(/\.[^.]+$/, '');
        testPaths.push(
            `${withoutExt}.test.js`,
            `${withoutExt}.spec.js`,
            `${withoutExt}.test.ts`,
            `${withoutExt}.spec.ts`,
            `${withoutExt}_test.py`,
            `test_${path.basename(withoutExt)}.py`
        );
    }
    return [...new Set(testPaths)];
}

module.exports = {
    fetchPRDetails,
    fetchPRDependencies,
    fetchUserRepositories,
    fetchRepoBranchTree,
    fetchStagingCodebase,
    fetchFullFileContents,
    inferTestFilePaths
};
