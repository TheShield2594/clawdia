'use strict';

/**
 * A local ESLint rule that pins the direction dependencies are allowed to run
 * in (#614).
 *
 * `src/` has layers, and they were only a convention: `services/giveawayService`
 * required `commands/utility/giveaway` for `endGiveaway`, `services/scheduler`
 * required a command to pick up unclosed polls, `utils/logger` required
 * `services/caseService`, and `utils/applyXpGain` required `services/petService`.
 * Every one of those is a lower layer reaching up into a higher one, which is
 * how a require cycle gets in — and a cycle in CommonJS is not a lint warning,
 * it is a module object that is half-empty at require time.
 *
 * The layers, lowest first:
 *
 *   models, config, data, migrations   schema and static tables
 *   utils                              pure helpers
 *   views                              embeds and component rows
 *   services, games                    behaviour, scheduling, state
 *   commands, bot                      slash commands and the gateway facade
 *   dashboard, events                  the two entry points
 *   (src root)                         index.js, shard.js, health.js
 *
 * A module may require its own layer and anything below it. Requiring anything
 * above is the error. Requires of node builtins and packages are not the rule's
 * business and are ignored.
 *
 * This is a rule rather than a test because a lint error lands in the editor on
 * the line that caused it, and CI already runs `npm run lint`. It is written
 * here rather than pulled in as `eslint-plugin-boundaries` because core ESLint
 * dropped `no-restricted-modules` and nothing in core matches a `require()`
 * path — this is about forty lines, and it is the whole of what was needed.
 */

const path = require('path');

function toPosix(p) {
    return p.split(path.sep).join('/');
}

const rule = {
    meta: {
        type: 'problem',
        docs: { description: 'Forbid a module requiring one from a higher layer' },
        schema: [{
            type: 'object',
            properties: {
                root: { type: 'string' },
                layers: {
                    type: 'array',
                    items: { type: 'array', items: { type: 'string' } },
                },
                // Exceptions, as `<source> -> <target>` with both paths relative
                // to `root` and without the .js extension. Each one needs a
                // comment at the call site saying why it has to exist.
                allow: { type: 'array', items: { type: 'string' } },
            },
            additionalProperties: false,
        }],
        messages: {
            upward: "'{{source}}' ({{sourceLayer}}) must not require '{{target}}' ({{targetLayer}}) — that is a higher layer. Move the shared code down, or invert the dependency.",
        },
    },

    create(context) {
        const { root = 'src', layers = [], allow = [] } = context.options[0] ?? {};

        const rankOf = new Map();
        layers.forEach((group, index) => group.forEach(dir => rankOf.set(dir, index)));
        // Anything sitting directly in the root is an entry point, above every
        // named layer.
        const ROOT_RANK = layers.length;

        const allowed = new Set(allow.map(entry => entry.replace(/\s+/g, '')));

        const absRoot = path.resolve(context.cwd ?? process.cwd(), root);
        const filename = context.filename ?? context.getFilename();
        if (!filename.startsWith(absRoot + path.sep)) return {};

        const relative = toPosix(path.relative(absRoot, filename));
        const layerOf = rel => {
            const slash = rel.indexOf('/');
            return slash === -1 ? null : rel.slice(0, slash);
        };

        const sourceLayer = layerOf(relative);
        if (sourceLayer !== null && !rankOf.has(sourceLayer)) return {};
        const sourceRank = sourceLayer === null ? ROOT_RANK : rankOf.get(sourceLayer);

        const strip = rel => rel.replace(/\.js$/, '').replace(/\/index$/, '');

        return {
            CallExpression(node) {
                if (node.callee.type !== 'Identifier' || node.callee.name !== 'require') return;
                const arg = node.arguments[0];
                if (arg?.type !== 'Literal' || typeof arg.value !== 'string') return;
                if (!arg.value.startsWith('.')) return;

                const resolved = path.resolve(path.dirname(filename), arg.value);
                if (!resolved.startsWith(absRoot + path.sep)) return;

                const targetRel = toPosix(path.relative(absRoot, resolved));
                // `require('../services')` resolves to the directory itself, so
                // there is no slash to split on — the path *is* the layer name.
                // Reading that as "not a layer" let a bare directory import
                // (which node resolves through the directory's index.js) walk
                // straight past the rule.
                const targetLayer = layerOf(targetRel) ?? targetRel;
                if (!rankOf.has(targetLayer)) return;

                if (rankOf.get(targetLayer) <= sourceRank) return;
                if (allowed.has(`${strip(relative)}->${strip(targetRel)}`)) return;

                context.report({
                    node: arg,
                    messageId: 'upward',
                    data: {
                        source: strip(relative),
                        sourceLayer: sourceLayer ?? '(entry point)',
                        target: strip(targetRel),
                        targetLayer,
                    },
                });
            },
        };
    },
};

module.exports = {
    rules: { 'no-upward-require': rule },
};
