'use strict';

/**
 * A local ESLint rule that caps how long a command file may be (#917).
 *
 * `src/commands` is where module-size debt collects: a slash command starts as
 * one file, grows a shop, then quests, then repairs, and ends up as the
 * forty-function god file that #721 split three of. `utils/embedColors` jokes
 * about "a nine-hundred-line command file"; several were past it.
 *
 * The cap is a lint rule rather than a test because that is where it is useful
 * — in the editor, on the line that broke it, while the file is being written
 * — and because a test that reads file sizes is one nobody thinks about until
 * CI is already red. tests/grindCommandLayout still pins the *shape* of the
 * three split folders; this pins the size of every command file there is.
 *
 * Two ways past it, and picking one is the point of the failure:
 *
 *   - split the file. A command too big for one file is
 *     `commands/<category>/<name>/index.js` plus siblings, and a group inside
 *     it that has outgrown one file is a folder of its own the same way
 *     (`hunt/shop/`). Only index.js registers as a command, so nothing in
 *     either folder becomes a command by accident.
 *   - move the logic to the service layer, where most of it belongs anyway.
 *
 * `grandfathered` is the third way, and it is not a way out: it is the list of
 * files that were already over the cap when the rule landed, each frozen at the
 * length it had that day. They may shrink and must not grow. An entry that has
 * fallen to the cap is itself an error — a stale exemption is permission to
 * grow back into it — so the fix there is to delete the line.
 */

const path = require('path');

function toPosix(p) {
    return p.split(path.sep).join('/');
}

const rule = {
    meta: {
        type: 'suggestion',
        docs: { description: 'Cap the length of a command file' },
        schema: [{
            type: 'object',
            properties: {
                // Lines. Not sacred — lower it as the tree comes down.
                max: { type: 'integer', minimum: 1 },
                // Repo-relative paths of the files already over `max`, each
                // mapped to the length it may not exceed.
                grandfathered: {
                    type: 'object',
                    additionalProperties: { type: 'integer', minimum: 1 },
                },
            },
            additionalProperties: false,
        }],
        messages: {
            tooLong: '{{file}} is {{lines}} lines; command files are capped at {{max}}. Split it into <name>/index.js plus siblings, or move the logic into the service layer.',
            grewPastCeiling: '{{file}} is {{lines}} lines, past the {{ceiling}} it was frozen at. It is on the grandfathered list because it was already over the {{max}}-line cap — it may shrink, never grow.',
            staleExemption: '{{file}} is {{lines}} lines, at or under the {{max}}-line cap. Remove its grandfathered entry in eslint.config.js — an exemption it no longer needs is permission to grow back over the cap.',
        },
    },

    create(context) {
        const { max = 900, grandfathered = {} } = context.options[0] || {};
        const filename = context.filename ?? context.getFilename();
        if (!filename || filename === '<input>') return {};

        const rel = toPosix(path.relative(context.cwd ?? process.cwd(), filename));
        // `sourceCode.lines` splits on newlines, so a file ending in one — every
        // file here — has an empty last entry. Dropping it makes this agree with
        // `wc -l`, which is the number anyone checking a ceiling will run.
        const source = context.sourceCode ?? context.getSourceCode();
        const split = source.lines;
        const lines = split.length - (split[split.length - 1] === '' ? 1 : 0);

        return {
            Program(node) {
                // The report lands on the first line past the ceiling, which is
                // the line that actually broke it, rather than on line 1.
                const ceiling = Object.prototype.hasOwnProperty.call(grandfathered, rel)
                    ? grandfathered[rel]
                    : max;
                const at = { line: Math.min(ceiling + 1, lines), column: 0 };
                const data = { file: rel, lines, max, ceiling };

                if (!Object.prototype.hasOwnProperty.call(grandfathered, rel)) {
                    if (lines > max) context.report({ node, loc: at, messageId: 'tooLong', data });
                    return;
                }

                if (lines <= max) {
                    context.report({ node, loc: { line: 1, column: 0 }, messageId: 'staleExemption', data });
                } else if (lines > ceiling) {
                    context.report({ node, loc: at, messageId: 'grewPastCeiling', data });
                }
            },
        };
    },
};

module.exports = { rules: { 'command-file-size': rule } };
