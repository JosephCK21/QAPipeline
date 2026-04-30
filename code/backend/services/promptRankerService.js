/**
 * Ranks prompt / instruction variants for QA LLM calls by simple heuristics.
 * Callers can substitute a custom `scoreFn`; default prefers shorter, non-empty bodies.
 *
 * @param {Array<{ id?: string, label?: string, body: string, score?: number }>} variants
 * @param {{ limit?: number, scoreFn?: (v: { body: string }) => number }} [opts]
 */
function rankPromptVariants(variants, opts = {}) {
    const limit = Math.max(1, Math.min(Number(opts.limit) || 5, 20));
    const scoreFn =
        opts.scoreFn ||
        ((v) => {
            const b = String(v.body || '');
            let s = Number(v.score);
            if (!Number.isFinite(s)) {
                const len = b.length || 1;
                s = b.trim() ? 1000 / Math.sqrt(len) : 0;
            }
            return s;
        });

    const sorted = [...(variants || [])]
        .filter((v) => v && typeof v.body === 'string')
        .map((v) => ({ ...v, _score: scoreFn(v) }))
        .sort((a, b) => (b._score || 0) - (a._score || 0));

    return sorted.slice(0, limit).map(({ _score, ...rest }) => rest);
}

module.exports = { rankPromptVariants };
