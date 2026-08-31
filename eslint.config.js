'use strict';

// Flat config. Three kinds of JavaScript live in this repo and they do not share
// an environment, so each gets its own block rather than one union of globals
// that would let a browser-only API through in bot code (#714).
//
// The rules are deliberately close to `js.configs.recommended`: this is a
// 63k-line codebase that has been written without a linter and is tidy anyway,
// so the job here is to stop drift — unused variables, undefined globals,
// accidental redeclarations — not to relitigate its style. Stylistic questions
// belong to Prettier (.prettierrc), and eslint-config-prettier is applied last
// so the two can never disagree about the same line.

const js = require('@eslint/js');
const globals = require('globals');
const prettier = require('eslint-config-prettier/flat');
const layers = require('./eslint-rules/layer-boundaries');
const commandSize = require('./eslint-rules/command-file-size');

// The direction dependencies are allowed to run in, lowest layer first (#614).
// A module may require its own layer and anything below it; requiring anything
// above is an error. See eslint-rules/layer-boundaries.js.
const LAYERS = [
    ['models', 'config', 'data', 'migrations'],
    ['utils'],
    ['views'],
    ['services', 'games'],
    ['commands', 'bot'],
    ['dashboard', 'events'],
];

// The one edge that has to run upward, and does so deliberately. Mongoose only
// honours middleware registered before model() compiles the schema, so the
// guild-settings cache invalidation has to be attached in the model file; the
// require is already lazy, inside the hook, for exactly this reason. See the
// comment at the hook and tests/guildCacheHooks.test.js.
const LAYER_EXCEPTIONS = [
    'models/Guild -> utils/guildSettingsCache',
];

// discord.js v14 deprecated the `ephemeral: true` reply option in favour of
// `flags: MessageFlags.Ephemeral`. Every one of the ~830 ephemeral replies here
// is written with the flag; the boolean still works, so a stray one does not
// fail anything at runtime, it just leaves the codebase with two ways of saying
// the same thing and a deprecation warning per call. One had already drifted
// back in (#706).
const DEPRECATED_EPHEMERAL = {
    selector: 'Property[key.name="ephemeral"][value.value=true]',
    message: 'Use `flags: MessageFlags.Ephemeral` — the `ephemeral` option is deprecated in discord.js v14.',
};

// See the command-file-size block below. Lower `max` as the tree comes down;
// an entry in GRANDFATHERED_COMMANDS may only ever be lowered or deleted.
const COMMAND_FILE_MAX_LINES = 900;
const GRANDFATHERED_COMMANDS = {
    'src/commands/economy/explore.js':   1655,
    'src/commands/economy/pet.js':       1490,
    'src/commands/economy/season.js':    1083,
    'src/commands/economy/syndicate.js': 1075,
};

const shared = {
    // `_`-prefixed arguments and catch bindings are the established way here of
    // saying "this is part of the signature and deliberately unused".
    'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        caughtErrors: 'all',
        caughtErrorsIgnorePattern: '^_',
        ignoreRestSiblings: true,
    }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-var': 'error',
    'prefer-const': ['error', { destructuring: 'all' }],
    'no-throw-literal': 'error',
    // `catch {}` — no binding, no body — is this codebase's way of writing "this
    // side effect was best-effort and the fallback below is the real path". A
    // bare empty block anywhere else is still an error.
    'no-empty': ['error', { allowEmptyCatch: true }],
    'no-new-func': 'error',
    'no-implied-eval': 'error',
    // Embeds are laid out with ideographic spaces — Discord collapses runs of
    // ASCII spaces, so U+3000 is the only way to centre a line. Those sit inside
    // template literals, which this rule looks into by default.
    'no-irregular-whitespace': ['error', { skipStrings: true, skipTemplates: true }],
    // An `await` inside a loop is how the sequential Discord and Mongo calls in
    // this codebase are written on purpose, and console logging is how the bot
    // reports for itself. Neither is a defect here.
    'no-console': 'off',
    'no-restricted-syntax': ['error', DEPRECATED_EPHEMERAL],
};

// The synchronous node-canvas encode, in both of its spellings:
// `canvas.toBuffer()` and `canvas.toBuffer('image/png')`. The callback form —
// `toBuffer(cb, mimeType)`, which is the one utils/canvasEncode.js wraps — has a
// function as its first argument and is not matched by either selector.
//
// This is a bot on one event loop. A PNG encode measured ~10 ms for the 800×300
// welcome card and grows with the surface, and every millisecond of it is a
// millisecond the gateway cannot read a heartbeat — which on a join raid is
// hundreds of them back to back (#592). The async form hands the encode to
// libuv's thread pool instead, so the rule is: in src/, encode through
// utils/canvasEncode.js.
//
// Scoped to `src/` deliberately. scripts/ is one-shot CLI work with no gateway
// to stall, and the one deliberate exception inside src/ carries a disable
// comment that says why.
const SYNC_CANVAS_ENCODE = [
    {
        selector: 'CallExpression[callee.property.name="toBuffer"][arguments.length=0]',
        message: 'Use `encodeCanvas(canvas)` from utils/canvasEncode.js — `canvas.toBuffer()` blocks the event loop (#592).',
    },
    {
        // A template literal is the same call written with backticks, and it is
        // the spelling a copy-paste out of a formatted string arrives in.
        selector: 'CallExpression[callee.property.name="toBuffer"]:matches([arguments.0.type="Literal"], [arguments.0.type="TemplateLiteral"])',
        message: 'Use `encodeCanvas(canvas, mimeType)` from utils/canvasEncode.js — the one-argument `toBuffer` blocks the event loop (#592).',
    },
];

module.exports = [
    {
        // public/vendor holds third-party bundles copied in verbatim by the
        // scripts/vendor-*.sh helpers (#685). Minified and not ours to fix.
        ignores: ['node_modules/**', 'coverage/**', 'src/dashboard/public/vendor/**'],
    },

    // ── The bot and the dashboard server: CommonJS on Node ──────────────
    {
        files: ['src/**/*.js', 'scripts/**/*.js', 'eslint-rules/**/*.js', '*.js'],
        ignores: ['src/dashboard/public/**'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node },
        },
        plugins: { layers },
        rules: {
            ...js.configs.recommended.rules,
            ...shared,
            'layers/no-upward-require': ['error', {
                root: 'src',
                layers: LAYERS,
                allow: LAYER_EXCEPTIONS,
            }],
        },
    },

    // ── Command file size ───────────────────────────────────────────────
    // #721 split /fish, /hunt and /mine out of three files of 3,476, 3,178 and
    // 2,806 lines, and #917 split their shop groups out of another 2,285. What
    // held them at that size afterwards was nothing: reviewer memory, and a
    // joke in utils/embedColors about "a nine-hundred-line command file".
    //
    // 900 is that joke's number, and it is where the cap starts rather than
    // where it should end — the three grind folders are all under 750 now, and
    // this should follow them down. GRANDFATHERED_COMMANDS is the four commands
    // that were already over it, each frozen at the length it had when the rule
    // landed: they may shrink, never grow, and the entry has to go when the
    // file reaches the cap. See eslint-rules/command-file-size.js.
    {
        files: ['src/commands/**/*.js'],
        plugins: { command: commandSize },
        rules: {
            'command/command-file-size': ['error', {
                max: COMMAND_FILE_MAX_LINES,
                grandfathered: GRANDFATHERED_COMMANDS,
            }],
        },
    },

    // ── Canvas encodes inside the bot ───────────────────────────────────
    // `no-restricted-syntax` takes one options array, and a later block replaces
    // rather than extends it, so the shared restriction is repeated here beside
    // the src-only one.
    {
        files: ['src/**/*.js'],
        ignores: ['src/dashboard/public/**'],
        rules: {
            'no-restricted-syntax': ['error', DEPRECATED_EPHEMERAL, ...SYNC_CANVAS_ENCODE],
        },
    },

    // ── The dashboard's browser scripts ─────────────────────────────────
    // These are <script> tags, not modules: their top-level functions are the
    // globals that the views' inline handlers call, which is why unused *global*
    // declarations are allowed here and nowhere else. `escHtml` comes from
    // esc-html.js, `Chart` from the vendored bundle loadChartJs() injects.
    {
        files: ['src/dashboard/public/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'script',
            // `module` because esc-html.js feature-detects CommonJS so the tests
            // can require it.
            globals: { ...globals.browser, module: 'readonly' },
        },
        rules: {
            ...js.configs.recommended.rules,
            ...shared,
            'no-unused-vars': ['error', { ...shared['no-unused-vars'][1], vars: 'local' }],
            // Top-level `var` in these files is deliberate: a classic script's
            // `var` is a property of the window, which is what the views' inline
            // `onclick` handlers resolve against (`_confirmResolve` in
            // guild-settings.ejs, among others). ESLint has no "top level only"
            // option here, and its own fixer already declines to convert them
            // for the same reason.
            'no-var': 'off',
        },
    },

    // guild-settings.js consumes three globals it does not declare: escHtml from
    // esc-html.js and buildSettingsPayload from settings-payload.js, each loaded
    // as its own <script>, and Chart from public/vendor/, which loadChartJs()
    // injects the first time a chart is drawn (#685). Scoped to this file so
    // those two are still checked against their own declarations.
    {
        files: ['src/dashboard/public/guild-settings.js'],
        languageOptions: {
            globals: { escHtml: 'readonly', buildSettingsPayload: 'readonly', Chart: 'readonly' },
        },
    },

    // ── Tests ───────────────────────────────────────────────────────────
    {
        files: ['tests/**/*.js'],
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'commonjs',
            globals: { ...globals.node, ...globals.jest, ...globals.browser },
        },
        rules: { ...js.configs.recommended.rules, ...shared },
    },

    prettier,
];
