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

// The two required faces, at the Alpine path the ttf-dejavu package uses. A
// missing file here is the silent downgrade described above, so it is checked
// by existence rather than by asking canvas whether text rendered — it renders
// either way, just in the wrong font.
const REQUIRED_FONTS = [
    '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
];

check('the DejaVu faces the card generators register are installed', () => {
    const missing = REQUIRED_FONTS.filter(p => !fs.existsSync(p));
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`);
});

// Emoji are optional to utils/registerFonts.js — a missing family warns and
// carries on — so a missing one is reported here and does not fail the image.
check('font-noto-emoji is installed (optional)', () => {
    if (!fs.existsSync('/usr/share/fonts/noto/NotoColorEmoji.ttf')) {
        console.warn('  note  emoji will render as fallback glyphs');
    }
});

// The native binding, end to end: load it, register the fonts through the same
// module the bot uses, draw, and encode. A build stage that compiled against
// headers the runtime stage does not ship fails on the require; a broken cairo
// or pixman fails on the encode.
check('canvas loads, registers fonts and encodes a PNG', () => {
    const { createCanvas } = require('canvas');
    require(path.join(__dirname, '..', 'src', 'utils', 'registerFonts')).ensureFontsRegistered();

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
