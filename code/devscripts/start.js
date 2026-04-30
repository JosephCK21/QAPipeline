const { spawn } = require('child_process');
const path = require('path');
const { backendRoot, frontendRoot } = require('./_paths');

console.log('Starting AutoQA Testing Environment...\n');

const backend = spawn('node', ['server.js'], {
    cwd: backendRoot,
    stdio: 'inherit'
});

const frontend = spawn('npm run dev', [], {
    cwd: frontendRoot,
    stdio: 'inherit',
    shell: true
});

process.on('SIGINT', () => {
    console.log('\nShutting down services...');
    backend.kill('SIGINT');
    frontend.kill('SIGINT');
    process.exit();
});

process.on('SIGTERM', () => {
    backend.kill('SIGTERM');
    frontend.kill('SIGTERM');
    process.exit();
});
