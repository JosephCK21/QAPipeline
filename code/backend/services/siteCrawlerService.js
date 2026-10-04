const fs = require('fs/promises');
const path = require('path');
const { execFile, spawn } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);

const LIVE_SITE_MAX_PAGES = Math.max(1, parseInt(process.env.AUTOQA_LIVE_SITE_MAX_PAGES || '10', 10) || 10);
const CRAWL_TIMEOUT_MS = Math.max(15000, parseInt(process.env.AUTOQA_LIVE_SITE_CRAWL_TIMEOUT_MS || '60000', 10) || 60000);
const PLAYWRIGHT_VERSION = '1.59.1';

/**
 * Crawl a live website using Playwright in a Docker container.
 * Navigates to the home page and up to N internal pages, captures
 * accessibility snapshots and full-page screenshots for LLM context.
 *
 * @param {string} targetUrl - Full URL of the website to crawl
 * @param {object} [options]
 * @param {number} [options.maxPages] - Max pages to visit
 * @param {number} [options.timeoutMs] - Overall crawl timeout
 * @param {string} [options.runId] - Run ID for container naming
 * @returns {Promise<{ pages: Array<{ url: string, title: string, snapshot: string, screenshotPath: string }>, baseUrl: string }>}
 */
async function crawlSiteForContext(targetUrl, options = {}) {
    const maxPages = options.maxPages || LIVE_SITE_MAX_PAGES;
    const timeoutMs = options.timeoutMs || CRAWL_TIMEOUT_MS;
    const runId = options.runId || `crawl-${Date.now()}`;
    const containerName = `autoqa-crawler-${runId}`;
    const baseTmp = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
    const crawlDir = path.join(baseTmp, 'autoqa-crawl', runId);

    await fs.mkdir(crawlDir, { recursive: true });

    const crawlerScript = buildCrawlerScript(targetUrl, maxPages);
    await fs.writeFile(path.join(crawlDir, 'crawl.mjs'), crawlerScript, 'utf8');

    try {
        await execFilePromise('docker', ['rm', '-f', containerName]).catch(() => {});

        const volumeDir = crawlDir.replace(/\\/g, '/');
        await execFilePromise('docker', [
            'run', '-d',
            '--name', containerName,
            '-v', `${volumeDir}:/crawl`,
            '-w', '/crawl',
            `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-jammy`,
            'tail', '-f', '/dev/null'
        ], { timeout: 300000 });

        await execFilePromise('docker', [
            'exec', containerName,
            'npm', 'install', '--no-audit', '--no-fund', '--no-package-lock',
            `@playwright/test@${PLAYWRIGHT_VERSION}`
        ], { timeout: 120000 });

        const { stdout, stderr } = await spawnCapture('docker', [
            'exec', containerName,
            'node', '/crawl/crawl.mjs'
        ], { timeout: timeoutMs });

        let pages = [];
        try {
            const resultPath = path.join(crawlDir, 'crawl-result.json');
            const raw = await fs.readFile(resultPath, 'utf8');
            pages = JSON.parse(raw);
        } catch (e) {
            console.warn('[SiteCrawler] Failed to read crawl results, attempting stdout parse:', e.message);
            try {
                const jsonStart = stdout.indexOf('[');
                if (jsonStart !== -1) pages = JSON.parse(stdout.slice(jsonStart));
            } catch { /* empty result set */ }
        }

        const screenshotDir = path.join(crawlDir, 'screenshots');
        for (const page of pages) {
            if (page.screenshotFile) {
                page.screenshotPath = path.join(screenshotDir, page.screenshotFile);
            }
        }

        return { pages, baseUrl: targetUrl };
    } finally {
        try {
            await execFilePromise('docker', ['stop', containerName]);
            await execFilePromise('docker', ['rm', containerName]);
        } catch { /* container may already be gone */ }
        await fs.rm(crawlDir, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Read screenshot files as base64 for LLM context. Limits to prevent
 * enormous payloads: only the first N screenshots, each capped at 2MB.
 */
async function readScreenshotsAsBase64(pages, maxCount = 5) {
    const results = [];
    for (const page of (pages || []).slice(0, maxCount)) {
        if (!page.screenshotPath) continue;
        try {
            const buf = await fs.readFile(page.screenshotPath);
            if (buf.length > 2 * 1024 * 1024) continue;
            results.push({
                url: page.url,
                title: page.title,
                base64: buf.toString('base64'),
                mimeType: 'image/png'
            });
        } catch { /* skip missing files */ }
    }
    return results;
}

function buildCrawlerScript(targetUrl, maxPages) {
    return `
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const TARGET_URL = ${JSON.stringify(targetUrl)};
const MAX_PAGES = ${maxPages};
const SCREENSHOT_DIR = '/crawl/screenshots';

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

(async () => {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
    });
    const context = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        ignoreHTTPSErrors: true
    });

    const results = [];
    const visited = new Set();
    const queue = [TARGET_URL];
    let origin;
    try { origin = new URL(TARGET_URL).origin; } catch { origin = TARGET_URL; }

    while (queue.length > 0 && visited.size < MAX_PAGES) {
        const url = queue.shift();
        const normalized = url.split('#')[0].split('?')[0].replace(/\\/+$/, '');
        if (visited.has(normalized)) continue;
        visited.add(normalized);

        const page = await context.newPage();
        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.waitForTimeout(1500);

            const title = await page.title();

            let snapshot = '';
            try {
                snapshot = await page.accessibilitySnapshot() || {};
                snapshot = JSON.stringify(snapshot, null, 2);
            } catch {
                snapshot = await page.evaluate(() => document.body?.innerText?.slice(0, 8000) || '');
            }

            const idx = visited.size;
            const screenshotFile = 'page-' + idx + '.png';
            await page.screenshot({
                path: path.join(SCREENSHOT_DIR, screenshotFile),
                fullPage: false
            });

            results.push({ url, title, snapshot, screenshotFile });

            if (visited.size < MAX_PAGES) {
                const links = await page.evaluate((orig) => {
                    const anchors = [...document.querySelectorAll('a[href]')];
                    return anchors
                        .map(a => a.href)
                        .filter(h => h.startsWith(orig) && !h.match(/\\.(png|jpg|jpeg|gif|svg|css|js|pdf|zip|webm|mp4)$/i))
                        .slice(0, 30);
                }, origin);
                for (const link of links) {
                    const norm = link.split('#')[0].split('?')[0].replace(/\\/+$/, '');
                    if (!visited.has(norm)) queue.push(link);
                }
            }
        } catch (e) {
            results.push({ url, title: '(error)', snapshot: 'Navigation failed: ' + e.message, screenshotFile: null });
        } finally {
            await page.close();
        }
    }

    await browser.close();

    fs.writeFileSync('/crawl/crawl-result.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results));
})();
`;
}

function spawnCapture(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const timeout = options.timeout || 120000;
        const child = spawn(command, args, {
            detached: false,
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

module.exports = {
    crawlSiteForContext,
    readScreenshotsAsBase64
};
