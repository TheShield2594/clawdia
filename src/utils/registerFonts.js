'use strict';

/**
 * Registers the fonts the canvas-based image generators depend on.
 *
 * The font files live in different places depending on the distro: Debian and
 * Ubuntu use /usr/share/fonts/truetype/<family>/, Alpine (which the Dockerfile
 * builds on) uses /usr/share/fonts/<package>/. The previous call sites hardcoded
 * only the Debian paths inside a bare try/catch, so in the shipped Alpine image
 * every registration failed silently and every generated card rendered in
 * canvas's built-in fallback font — with no log line to explain why.
 *
 * Each family is resolved against a list of candidate paths and the first hit
 * wins. A family that resolves nowhere is reported once, so a missing font is
 * visible in the logs rather than being a silent downgrade.
 */

const fs = require('fs');
const { registerFont } = require('canvas');

// Ordered most-likely-first per family, which for this repo means Alpine's
// layout early: the Dockerfile builds on Alpine and installs `ttf-dejavu`,
// which puts its files in /usr/share/fonts/dejavu/ — *not* the
// /usr/share/fonts/ttf-dejavu/ the package name suggests, and which the
// comments here claimed for years. scripts/image-smoke.js checks the real
// image against this table on every build, which is how the mislabelling was
// finally noticed; the old path stays as a candidate for Alpine before 3.13.
const FONTS = [
    {
        family: 'DejaVu Sans',
        weight: 'normal',
        candidates: [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',   // Debian/Ubuntu
            '/usr/share/fonts/dejavu/DejaVuSans.ttf',            // Alpine ttf-dejavu, Fedora/RHEL
            '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',        // Alpine before 3.13
            '/Library/Fonts/DejaVuSans.ttf',                     // macOS (manual install)
        ],
    },
    {
        family: 'DejaVu Sans',
        weight: 'bold',
        candidates: [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
            '/Library/Fonts/DejaVuSans-Bold.ttf',
        ],
    },
    {
        family: 'Noto Color Emoji',
        weight: 'normal',
        optional: true,
        candidates: [
            '/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf',
            '/usr/share/fonts/noto/NotoColorEmoji.ttf',          // Alpine font-noto-emoji
            '/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf',
        ],
    },
];

// The outcome of the one registration pass, memoized alongside the flag that
// makes it happen once. Returning it is what lets a caller that wants to be
// strict — scripts/image-smoke.js — see a family that resolved to a file and
// then failed to register anyway, which warns here and is invisible to
// everything else.
let registered = false;
let registrationReport = null;

/**
 * Where each family resolved, without registering anything.
 *
 * Exported so scripts/image-smoke.js can assert the built container actually
 * carries the fonts *this table* asks for. It used to hardcode its own copy of
 * the Alpine paths, which is how it came to fail a perfectly good image over a
 * path the bot never needed.
 *
 * @returns {{ family: string, weight: string, optional: boolean, path: ?string }[]}
 */
function resolveFonts() {
    return FONTS.map(font => ({
        family: font.family,
        weight: font.weight,
        optional: Boolean(font.optional),
        path: font.candidates.find(p => {
            try { return fs.existsSync(p); } catch { return false; }
        }) || null,
    }));
}

/**
 * Registers every family in the table, once, and reports what happened.
 *
 * Nothing here throws: a bot that will not start because a font is missing is
 * worse than one whose cards render in the wrong face. The report is how a
 * caller that *does* want to fail — the image smoke test — can tell the two
 * apart, since a family that resolved to a file and then failed to register is
 * otherwise indistinguishable from a healthy one from the outside.
 *
 * @returns {{ family: string, weight: string, optional: boolean, path: ?string,
 *             registered: boolean, error: ?string }[]}
 */
function ensureFontsRegistered() {
    // registerFont must run before any canvas context is created, and
    // re-registering the same family is wasteful, so do it exactly once.
    if (registered) return registrationReport;
    registered = true;

    registrationReport = resolveFonts().map(font => {
        const label = `${font.family}${font.weight === 'bold' ? ' (bold)' : ''}`;
        const found = font.path;

        if (!found) {
            if (font.optional) {
                console.warn(`[FONTS] ${label} not found — emoji will render as fallback glyphs.`);
            } else {
                console.warn(`[FONTS] ${label} not found in any known location — generated images will use canvas's default font.`);
            }
            return { ...font, registered: false, error: 'not found' };
        }

        try {
            registerFont(found, { family: font.family, weight: font.weight });
            return { ...font, registered: true, error: null };
        } catch (err) {
            console.warn(`[FONTS] Failed to register ${font.family} from ${found}: ${err.message}`);
            return { ...font, registered: false, error: err.message };
        }
    });

    return registrationReport;
}

module.exports = { ensureFontsRegistered, resolveFonts, FONTS };
