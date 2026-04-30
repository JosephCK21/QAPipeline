/**
 * When `tokenUsage` JSON is stored as a string row, rehydrate for clients.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { rankPromptVariants } = require('../services/promptRankerService');

test('rankPromptVariants prefers higher explicit scores', () => {
    const r = rankPromptVariants(
        [
            { body: 'aaaa', score: 1 },
            { body: 'bbbbbbbb', score: 9 }
        ],
        { limit: 1 }
    );
    assert.equal(r[0].body, 'bbbbbbbb');
});

test('rankPromptVariants prefers non-empty bodies under default scorer', () => {
    const r = rankPromptVariants(
        [
            { body: '   ', score: NaN },
            { body: 'x', score: NaN }
        ],
        { limit: 1 }
    );
    assert.equal(r[0].body, 'x');
});
