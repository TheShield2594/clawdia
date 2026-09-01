'use strict';

// #905. The dashboard's own JavaScript and CSS shipped exactly as authored —
// 256 KB of guild-settings.js, an 88 KB stylesheet, 32 KB of
// settings-payload.js — with comments, indentation and names written for a
// reader. `compression` gzips that on the way out, which shrinks the transfer
// and does nothing about the parse: the browser expands and compiles all of it
// on every first load, on whatever phone is being used to change one setting.
//
// scripts/build-assets.js writes a minified twin beside each source, and
// lib/assets.js serves the twin when there is one. Two things have to hold for
// that to be safe, and both are checked here:
//
//   * the minifier must not rename anything the page reaches by name. This page
//     is a classic script, not a module: the inline bootstrap block and the
//     EJS `onclick` attributes call its top-level functions off the global
//     object, so a renamed top-level binding is a dead button rather than a
//     failing build. esbuild only renames top-level identifiers when bundling,
//     which is exactly why the script does not bundle — asserted rather than
//     trusted, because it is one option away either way.
//
//   * the twins must stay optional. They are generated, not committed, so a
//     checkout run with `npm start` has none and has to behave as it did.

const fs = require('fs');
const path = require('path');
const os = require('os');
const espree = require('espree');
const { execFileSync } = require('child_process');

const { asset } = require('../src/dashboard/lib/assets');
const { PUBLIC, SOURCES, minifiedName, minify } = require('../scripts/build-assets');

const ROOT = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(PUBLIC, file), 'utf8');

const parse = source => espree.parse(source, { ecmaVersion: 2024, sourceType: 'script' });

/**
 * Every name a script declares at its top level — which on this page means
 * every name the inline handlers and the bootstrap block can reach.
 */
function topLevelNames(source) {
    const names = new Set();
    for (const node of parse(source).body) {
        if (node.type === 'FunctionDeclaration') names.add(node.id.name);
        if (node.type === 'ClassDeclaration') names.add(node.id.name);
        if (node.type === 'VariableDeclaration') {
            for (const d of node.declarations) {
                if (d.id.type === 'Identifier') names.add(d.id.name);
                // Destructured top-level bindings, should any appear later.
                if (d.id.type === 'ObjectPattern') {
                    for (const p of d.id.properties) if (p.value?.type === 'Identifier') names.add(p.value.name);
                }
            }
        }
    }
    return names;
}

describe('the minifier keeps every name the page reaches by name', () => {
    const scripts = SOURCES.filter(file => file.endsWith('.js'));

    test.each(scripts)('%s keeps all of its top-level bindings', async file => {
        const source = read(file);
        const minified = await minify(source, file);

        const before = topLevelNames(source);
        const after = topLevelNames(minified);

        expect(before.size).toBeGreaterThan(0);
        expect([...before].filter(name => !after.has(name))).toEqual([]);
    });

    test.each(scripts)('%s still parses as a classic script', async file => {
        const minified = await minify(read(file), file);
        expect(() => parse(minified)).not.toThrow();
    });

    // The named functions the views call from inline attributes are the ones a
    // rename breaks silently — nothing fails until someone clicks. Sampled from
    // the markup rather than listed by hand, so a handler added later is
    // covered without anyone remembering this file.
    test('every function an inline handler names survives minification', async () => {
        const views = path.join(ROOT, 'src', 'dashboard', 'views');
        const files = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.ejs')) files.push(full);
            }
        })(views);

        const called = new Set();
        for (const file of files) {
            const markup = fs.readFileSync(file, 'utf8');
            for (const [, name] of markup.matchAll(/\bon\w+="\s*([A-Za-z_$][\w$]*)\s*\(/g)) called.add(name);
        }

        const minified = await minify(read('guild-settings.js'), 'guild-settings.js');
        const after = topLevelNames(minified);
        const declared = topLevelNames(read('guild-settings.js'));

        // Only the ones this file actually owns; the rest come from the other
        // scripts or are browser built-ins.
        const owned = [...called].filter(name => declared.has(name));
        expect(owned.length).toBeGreaterThan(5);
        expect(owned.filter(name => !after.has(name))).toEqual([]);
    });
});

describe('it is worth doing', () => {
    test.each(SOURCES)('%s comes out meaningfully smaller', async file => {
        const source = read(file);
        const minified = await minify(source, file);
        expect(minified.length).toBeLessThan(source.length * 0.8);
        expect(minified.length).toBeGreaterThan(0);
    });

    test('the stylesheet still carries its rules', async () => {
        const minified = await minify(read('styles.css'), 'styles.css');
        expect(minified).toContain('.session-expired');
        expect(minified).toContain('.toast');
    });
});

describe('the source list covers what the dashboard actually serves', () => {
    // A script added to public/ later and left off the list is silently not
    // minified, which is the state this change is fixing.
    test('names every first-party js and css file in public/', () => {
        const found = fs.readdirSync(PUBLIC, { withFileTypes: true })
            .filter(e => e.isFile() && /\.(js|css)$/.test(e.name) && !/\.min\.(js|css)$/.test(e.name))
            .map(e => e.name)
            .sort();

        expect(found).toEqual([...SOURCES].sort());
    });

    // vendor/ is Chart.js, copied in already-minified by scripts/vendor-chartjs.sh
    // and not ours to rebuild; fonts/fonts.css is generated by
    // scripts/fetch-fonts.sh and is a few hundred bytes of @font-face.
    test('and leaves the vendored and generated ones alone', () => {
        expect(SOURCES.some(file => file.includes('/'))).toBe(false);
    });

    test('names each twin beside its source', () => {
        expect(minifiedName('guild-settings.js')).toBe('guild-settings.min.js');
        expect(minifiedName('styles.css')).toBe('styles.min.css');
    });
});

describe('asset() serves the twin when there is one and the source when there is not', () => {
    let dir;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-assets-'));
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    test('falls back to the readable file, which is what a dev checkout has', () => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\n');

        expect(asset('/app.js', dir)).toMatch(/^\/app\.js\?v=[0-9a-f]{10}$/);
    });

    test('prefers the twin once the build has written one', () => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\n');
        fs.writeFileSync(path.join(dir, 'app.min.js'), 'const a=1;');

        expect(asset('/app.js', dir)).toMatch(/^\/app\.min\.js\?v=[0-9a-f]{10}$/);
    });

    // The hash is the cache key, so it has to describe the bytes that are
    // actually sent — the twin's, not the source's.
    test('hashes the file it decided to serve', () => {
        fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\n');
        fs.writeFileSync(path.join(dir, 'app.min.js'), 'const a=1;');

        const sourceOnly = asset('/other.js', dir);
        expect(sourceOnly).toBe('/other.js');

        const crypto = require('crypto');
        const expected = crypto.createHash('sha1')
            .update(fs.readFileSync(path.join(dir, 'app.min.js'))).digest('hex').slice(0, 10);
        expect(asset('/app.js', dir)).toBe(`/app.min.js?v=${expected}`);
    });

    test('leaves an extensionless path alone rather than inventing a twin', () => {
        expect(asset('/nothing-here', dir)).toBe('/nothing-here');
    });
});

describe('the twins are built rather than committed', () => {
    test('git ignores them', () => {
        const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
        expect(ignore).toMatch(/src\/dashboard\/public\/\*\.min\.js/);
        expect(ignore).toMatch(/src\/dashboard\/public\/\*\.min\.css/);
    });

    // Asked of git rather than of the directory: a developer who has run the
    // build has the twins on disk, and that must not fail the suite. What is
    // being asserted is that none of them is tracked.
    test('none is checked in', () => {
        const tracked = execFileSync('git', ['ls-files', 'src/dashboard/public'], { cwd: ROOT, encoding: 'utf8' })
            .split('\n')
            // vendor/chart.umd.min.js is upstream's own minified build, copied
            // in by scripts/vendor-chartjs.sh; it is meant to be committed.
            .filter(name => /\.min\.(js|css)$/.test(name) && !name.startsWith('src/dashboard/public/vendor/'));

        expect(tracked).toEqual([]);
    });

    test('npm run build:assets is what writes them', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        expect(pkg.scripts['build:assets']).toBe('node scripts/build-assets.js');
        // Exact-pinned for the reason chart.js is: it decides bytes that ship.
        expect(pkg.devDependencies.esbuild).toMatch(/^\d+\.\d+\.\d+$/);
    });

    // The minifier is a devDependency, so the image cannot run it in the stage
    // that installs with --omit=dev. It gets its own stage, and the result is
    // copied over the sources it was built from.
    test('the image builds them in a stage of their own and copies them in', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');

        expect(dockerfile).toMatch(/AS assets\b/);
        expect(dockerfile).toMatch(/RUN node scripts\/build-assets\.js/);
        expect(dockerfile).toMatch(/COPY --from=assets[^\n]*\/app\/src\/dashboard\/public \.\/src\/dashboard\/public/);
    });

    test('after the sources, so the twins are not overwritten by them', () => {
        const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
        expect(dockerfile.indexOf('COPY --chown=node:node . .'))
            .toBeLessThan(dockerfile.indexOf('COPY --from=assets'));
    });
});
