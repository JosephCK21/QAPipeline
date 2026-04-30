'use strict';

const path = require('path');
const { defineConfig, devices } = require('@playwright/test');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const FRONTEND_URL = 'http://localhost:5173';

module.exports = defineConfig({
    testDir: './tests',
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 1 : 0,
    reporter: process.env.CI ? 'github' : [['list'], ['html', { open: 'never' }]],
    use: {
        baseURL: FRONTEND_URL,
        trace: 'on-first-retry',
        screenshot: 'only-on-failure',
        ...devices['Desktop Chrome']
    },
    webServer: {
        command: 'npm run dev',
        cwd: FRONTEND,
        url: FRONTEND_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 180000
    }
});
