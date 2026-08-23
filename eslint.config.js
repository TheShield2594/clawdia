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
};

module.exports = [
    {
        ignores: ['node_modules/**', 'coverage/**'],
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

    // ── The dashboard's browser scripts ─────────────────────────────────
    // These are <script> tags, not modules: their top-level functions are the
    // globals that the views' inline handlers call, which is why unused *global*
    // declarations are allowed here and nowhere else. `escHtml` comes from
    // esc-html.js, `Chart` from the CDN bundle the page loads.
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

    // guild-settings.js consumes two globals it does not declare: escHtml from
    // esc-html.js, loaded as its own <script>, and Chart from the CDN bundle
    // the page pulls in. Scoped to this file so esc-html.js is still checked
    // against its own declaration.
    {
        files: ['src/dashboard/public/guild-settings.js'],
        languageOptions: {
            globals: { escHtml: 'readonly', Chart: 'readonly' },
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
