/**
 * AST/heuristic pruning of large files for LLM code context —
 * hides long function/class bodies behind stubs to save tokens while
 * keeping signatures visible.
 */

const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;
const t = require('@babel/types');

const LARGE_FILE_CHARS = 5000;

const PARSE_PLUGINS = ['typescript', 'jsx'];

/** Line span of a positioned node’s block body (including opening/closing braces for BlockStatement loc). */
function blockLineCount(block) {
    if (!block?.loc?.start?.line || !block?.loc?.end?.line) return 0;
    return block.loc.end.line - block.loc.start.line + 1;
}

/**
 * True if `expr` is JSX (or a common React wrapper) suitable for Playwright locator hints.
 * Block-level returns inside if/try are not considered here (v1: top-level return only).
 */
function unwrapJsxLike(expr) {
    if (!expr) return false;
    if (t.isJSXElement(expr) || t.isJSXFragment(expr)) return true;
    if (t.isParenthesizedExpression(expr)) return unwrapJsxLike(expr.expression);
    if (t.isConditionalExpression(expr)) {
        return unwrapJsxLike(expr.consequent) || unwrapJsxLike(expr.alternate);
    }
    if (t.isLogicalExpression(expr)) {
        return unwrapJsxLike(expr.left) || unwrapJsxLike(expr.right);
    }
    return false;
}

/** First index in `block.body` of a top-level ReturnStatement with a JSX-like argument, or -1. */
function findTopLevelJsxReturnIndex(blockNode) {
    if (!blockNode?.body?.length) return -1;
    for (let i = 0; i < blockNode.body.length; i += 1) {
        const stmt = blockNode.body[i];
        if (t.isReturnStatement(stmt) && unwrapJsxLike(stmt.argument)) return i;
    }
    return -1;
}

function replaceWithFullStub(bodyPath) {
    const stmt = t.expressionStatement(t.unaryExpression('void', t.numericLiteral(0)));
    stmt.leadingComments = [{
        type: 'CommentBlock',
        value: ' Implementation hidden to save tokens '
    }];
    bodyPath.replaceWith(t.blockStatement([stmt]));
}

function pruneBlockStatementBody(bodyPath) {
    if (!bodyPath.node || !bodyPath.isBlockStatement()) return;
    const lines = blockLineCount(bodyPath.node);
    if (lines <= 5) return;

    const jsxIdx = findTopLevelJsxReturnIndex(bodyPath.node);
    if (jsxIdx === -1) {
        replaceWithFullStub(bodyPath);
        return;
    }

    // Nothing to strip before the JSX return (e.g. only a multiline JSX return) — keep body for DOM structure.
    if (jsxIdx === 0) return;

    const placeholder = t.expressionStatement(t.unaryExpression('void', t.numericLiteral(0)));
    placeholder.leadingComments = [{
        type: 'CommentBlock',
        value: ' Component logic hidden '
    }];
    const tail = bodyPath.node.body.slice(jsxIdx).map(s => t.cloneNode(s, true));
    bodyPath.replaceWith(t.blockStatement([placeholder, ...tail]));
}

function pruneJavaScript(code) {
    try {
        if (!code || typeof code !== 'string') return code;
        const ast = parser.parse(code, {
            sourceType: 'unambiguous',
            plugins: PARSE_PLUGINS,
            errorRecovery: false
        });

        traverse(ast, {
            FunctionDeclaration(path) {
                pruneBlockStatementBody(path.get('body'));
            },
            FunctionExpression(path) {
                pruneBlockStatementBody(path.get('body'));
            },
            ArrowFunctionExpression(path) {
                const b = path.get('body');
                if (b.isBlockStatement()) pruneBlockStatementBody(b);
            },
            ClassMethod(path) {
                pruneBlockStatementBody(path.get('body'));
            },
            ClassPrivateMethod(path) {
                pruneBlockStatementBody(path.get('body'));
            }
        });

        const out = generate(ast, {
            retainLines: false,
            comments: true
        }, code);
        return typeof out.code === 'string' ? out.code : code;
    } catch (_err) {
        return code;
    }
}

function leadingIndentLen(line) {
    const m = /^(\s*)/.exec(line);
    if (!m) return 0;
    const s = m[1].replace(/\t/g, '    ');
    return s.length;
}

function isPyBlockHeader(trimmed) {
    if (!trimmed.endsWith(':')) return false;
    return /^(async\s+def\s+|def\s+|class\s+)/.test(trimmed);
}

/**
 * Heuristic strip of long indented blocks after `def` / `async def` / `class`.
 * Nested defs are treated as body lines until dedent — acceptable imperfections.
 */
function prunePython(code) {
    try {
        if (!code || typeof code !== 'string') return code;
        const lines = code.split('\n');
        const out = [];
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            if (isPyBlockHeader(trimmed)) {
                const baseIndent = leadingIndentLen(line);
                let j = i + 1;
                while (j < lines.length) {
                    const lj = lines[j];
                    if (lj.trim() === '') {
                        j += 1;
                        continue;
                    }
                    if (leadingIndentLen(lj) <= baseIndent) break;
                    j += 1;
                }
                const bodyLineCount = j - i - 1;
                if (bodyLineCount > 5) {
                    out.push(line);
                    let firstBodyIndentPrefix = '';
                    for (let k = i + 1; k < j; k += 1) {
                        if (lines[k].trim()) {
                            const m = /^(\s*)/.exec(lines[k]);
                            firstBodyIndentPrefix = m ? m[1] : '';
                            break;
                        }
                    }
                    const hdr = /^(\s*)/.exec(line);
                    const hdrIndent = hdr ? hdr[1] : '';
                    const passIndent = firstBodyIndentPrefix || hdrIndent + '    ';
                    out.push(`${passIndent}pass  # Implementation hidden to save tokens`);
                    i = j;
                    continue;
                }
            }
            out.push(line);
            i += 1;
        }
        return out.join('\n');
    } catch (_err) {
        return code;
    }
}

/**
 * Applies structural pruning only when `content` is longer than `LARGE_FILE_CHARS`.
 *
 * @param {string} filePath
 * @param {string} content
 * @param {{ onPrune?: (pathStr: string) => void }} [options]
 * @returns {string}
 */
function pruneFileContentForContext(filePath, content, options = {}) {
    const onPrune = typeof options.onPrune === 'function' ? options.onPrune : null;
    if (!content || content.length <= LARGE_FILE_CHARS) return content;

    const ext = path.extname(filePath).toLowerCase();
    let out = content;

    if (['.js', '.jsx', '.ts', '.tsx'].includes(ext)) {
        out = pruneJavaScript(content);
    } else if (ext === '.py') {
        out = prunePython(content);
    } else {
        return content;
    }

    if (onPrune && out !== content) {
        try {
            onPrune(filePath);
        } catch (_e) { /* noop */ }
    }
    return out;
}

module.exports = {
    LARGE_FILE_CHARS,
    pruneJavaScript,
    prunePython,
    pruneFileContentForContext
};
