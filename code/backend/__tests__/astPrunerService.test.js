'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pruneFileContentForContext } = require('../services/astPrunerService');

test('pruneFileContentForContext short file unchanged', () => {
    const src = 'export const x = 1;\n';
    const out = pruneFileContentForContext('tiny.js', src, { onPrune: () => {} });
    assert.equal(out.trim(), src.trim());
});

test('pruneFileContentForContext large JS is shortened', () => {
    const inner = '  console.log(1);\n'.repeat(1200);
    const pad = `function z() {\n${inner}return 42;\n}\n`;
    assert.ok(pad.length > 5000, 'fixture should exceed LARGE_FILE_CHARS');
    const out = pruneFileContentForContext('big.js', pad, { onPrune: () => {} });
    assert.ok(out.length < pad.length, 'pruner should drop material from oversized JS');
});
