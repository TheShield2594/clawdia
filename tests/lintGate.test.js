'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// #714: 63k lines across 278 files with no linter and no formatter config, and
// a CI that ran only the tests. The config is only half of the fix — a linter
// nobody runs is the same as no linter — so this pins the other half: the
// script exists, CI runs it, and the config still covers all three of the
// environments this repo's JavaScript lives in.

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ci = fs.readFileSync(path.join(root, '.github', 'workflows', 'ci.yml'), 'utf8');

describe('lint gate', () => {
    test('npm run lint exists and runs ESLint over the repo', () => {
        expect(pkg.scripts.lint).toMatch(/\beslint\b/);
        expect(pkg.scripts.lint).not.toMatch(/--fix/);
    });

    test('CI runs it, in the job the image publish depends on', () => {
        // Bounded at the next job rather than at `publish:`, which is no longer
        // the one after it — the image build and scan sit between them (#646).
        const testJob = ci.slice(ci.indexOf('\n  test:'), ci.indexOf('\n  image:'));
        expect(testJob).toMatch(/run: npm run lint/);
        // Read off the parsed workflow rather than matched as text. This was
        // `/needs: \[test, image\]/` until the arm64 scan job joined that list
        // (#941) and broke a test with no opinion about arm64. The claim is
        // that publishing waits for this job, and nothing about what else it
        // waits for.
        expect(yaml.load(ci).jobs.publish.needs).toContain('test');
    });

    // Without `if: always()` a failing test hides the lint result and vice
    // versa, and a reviewer has to push twice to see both.
    test('the lint step reports even when the tests failed', () => {
        expect(ci).toMatch(/if: always\(\)\n\s*run: npm run lint/);
    });

    test('ESLint and Prettier are pinned as devDependencies', () => {
        for (const dep of ['eslint', '@eslint/js', 'prettier', 'eslint-config-prettier', 'globals']) {
            expect([dep, dep in pkg.devDependencies]).toEqual([dep, true]);
        }
        expect(pkg.dependencies.eslint).toBeUndefined();
    });

    test('the flat config covers the bot, the browser scripts and the tests', () => {
        const config = require('../eslint.config.js');
        const covered = config.flatMap(block => block.files || []);

        expect(covered).toEqual(expect.arrayContaining([
            'src/**/*.js',
            'src/dashboard/public/**/*.js',
            'tests/**/*.js',
        ]));
    });

    test('Prettier is wired to defer to ESLint rather than fight it', () => {
        // eslint-config-prettier turns off every rule Prettier would restyle;
        // it only works if it is applied after the blocks that set them.
        const config = require('../eslint.config.js');
        const last = config[config.length - 1];
        expect(last.name || '').toMatch(/prettier/i);
    });
});
