#!/usr/bin/env node
'use strict';

/**
 * Boot smoke for the container image (#646).
 *
 * The Dockerfile used to be built only by the publish job, which runs on `main`
 * after a merge — so a broken layer was found by the deploy rather than by the
 * pull request that broke it. CI now builds the image on every event and runs
 * this inside it.
 *
 * What it checks is the half a unit test cannot see: the things that are true
 * of the *image* rather than of the source tree. `canvas` compiles from source
 * against Alpine's cairo/pango in the build stage and links against a
 * separately-installed set of runtime libraries in the final one, so the two
 * apk lists can drift apart and produce an image that installs cleanly and
 * throws on the first generated card. The fonts are the same shape of problem:
 * a dropped package or a renamed path downgrades every image to canvas's
 * built-in font, which utils/registerFonts.js reports as a warning and nothing
 * else — invisible unless something looks.
 *
 * Deliberately not checked here: that the bot starts. That needs a token and a
 * database, and the require graph is covered by the workflow step next to this
 * one, which runs the image's real entrypoint with no configuration and expects
 * it to be rejected by config/validateEnv.js — reaching that rejection means
 * every module below src/index.js loaded.
 *
 * Runs against whatever it is executed inside, so it is equally usable against
 * a running deployment:
 *
 *   docker run --rm --entrypoint node ghcr.io/theshield2594/clawdia:latest \
 *       scripts/image-smoke.js
 */

const fs = require('fs');
const path = require('path');

const failures = [];
const check = (what, fn) => {
    try {
        fn();
        console.log(`  ok    ${what}`);
    } catch (err) {
        // First line only: a require failure carries its whole stack in the
        // message, and the log is easier to read with one line per check.
        const why = String(err.message).split('\n')[0];
        failures.push(`${what}: ${why}`);
        console.log(`  FAIL  ${what}: ${why}`);
    }
};

console.log('image smoke:');

// The runtime stage must be the same Node major the tests ran on. The Dockerfile,
// .nvmrc and package.json `engines` are held together by
// tests/nodeVersionAlignment.test.js; this is the other end of that — what the
// built image actually resolved the digest-pinned base to.
check('node satisfies package.json engines', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const wanted = Number((pkg.engines.node.match(/(\d+)/) || [])[1]);
    const actual = Number(process.versions.node.split('.')[0]);
    if (actual < wanted) throw new Error(`image runs node ${process.versions.node}, engines wants >=${wanted}`);
});

// `USER node` in the Dockerfile. A base-image bump that reorders the stages, or
// a COPY added after the USER line, is how an image quietly goes back to root.
check('the process is not root', () => {
    if (typeof process.getuid !== 'function') throw new Error('no getuid on this platform');
    if (process.getuid() === 0) throw new Error('running as uid 0');
});

check('NODE_ENV is production', () => {
    if (process.env.NODE_ENV !== 'production') {
        throw new Error(`NODE_ENV=${process.env.NODE_ENV || '<unset>'}`);
    }
});

// Whether every family utils/registerFonts.js asks for is present, checked by
// asking that module rather than by keeping a second copy of the paths here.
// The first version of this file did keep its own copy, hardcoded to the Alpine
// path the package *name* implies — /usr/share/fonts/ttf-dejavu/ — and failed a
// perfectly good image on its first run: `apk add ttf-dejavu` installs into
// /usr/share/fonts/dejavu/, and the bot was resolving it there all along
// through a candidate the table had labelled Fedora/RHEL.
//
// Checked by resolution rather than by asking canvas whether text rendered,
// because it renders either way — just in the wrong font, which is the silent
// downgrade registerFonts.js exists to make visible.
const fonts = require(path.join(__dirname, '..', 'src', 'utils', 'registerFonts'));

check('every font the card generators register resolves', () => {
    const resolved = fonts.resolveFonts();
    const label = f => `${f.family}${f.weight === 'bold' ? ' (bold)' : ''}`;

    // Optional families — emoji — warn in the bot rather than failing it, so
    // they are reported here and do not fail the image either.
    for (const font of resolved.filter(f => f.optional && !f.path)) {
        console.warn(`  note  ${label(font)} is not installed; it will render as fallback glyphs`);
    }

    const missing = resolved.filter(f => !f.optional && !f.path);
    if (missing.length) {
        throw new Error(`${missing.map(label).join(', ')} resolved to none of their candidate paths`);
    }

    // The path each one resolved to, so a move within the image is visible in
    // the log before it becomes a failure.
    for (const font of resolved.filter(f => f.path)) {
        console.log(`        ${label(font)} -> ${font.path}`);
    }
});

// Resolving is not registering. A file can sit at the expected path and still
// fail registerFont() — truncated by a bad layer copy, or a format this build of
// canvas was not compiled to read — and the bot deliberately swallows that:
// warn, carry on in the fallback face, because refusing to start over a font is
// worse. Which leaves the same silent downgrade the check above exists to catch,
// one step further along, so the smoke asserts on the registration itself.
check('every required font actually registers, not just resolves', () => {
    const failed = fonts.ensureFontsRegistered()
        .filter(f => !f.optional && !f.registered)
        .map(f => `${f.family}${f.weight === 'bold' ? ' (bold)' : ''}: ${f.error}`);

    if (failed.length) throw new Error(failed.join('; '));
});

// The native binding, end to end: load it, draw with the fonts registered
// above, and encode. A build stage that compiled against headers the runtime
// stage does not ship fails on the require; a broken cairo or pixman fails on
// the encode.
check('canvas loads and encodes a PNG', () => {
    const { createCanvas } = require('canvas');

    const canvas = createCanvas(160, 48);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#101014';
    ctx.fillRect(0, 0, 160, 48);
    ctx.fillStyle = '#ffffff';
    ctx.font = '20px "DejaVu Sans"';
    ctx.fillText('clawdia', 8, 32);

    const png = canvas.toBuffer('image/png');
    if (png.length < 100) throw new Error(`encoded ${png.length} bytes`);
    // PNG magic, so a zero-filled buffer cannot pass on length alone.
    if (png.subarray(0, 4).toString('hex') !== '89504e47') throw new Error('not a PNG');
});

if (failures.length) {
    console.error(`\nimage smoke failed (${failures.length}):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
}

console.log('\nimage smoke passed.');
