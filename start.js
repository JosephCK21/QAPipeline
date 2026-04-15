const { spawn } = require('child_process');
const path = require('path');

console.log('Starting AutoQA Testing Environment...\n');

// Start Backend
const backend = spawn('node', ['server.js'], {
    cwd: path.join(__dirname, 'code', 'backend'),
    stdio: 'inherit'
});

// Start Frontend
const frontend = spawn('npm run dev', [], {
    cwd: path.join(__dirname, 'code', 'frontend'),
    stdio: 'inherit',
    shell: true
});

// Cleanup on exit
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