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

let registered = false;

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

function ensureFontsRegistered() {
    // registerFont must run before any canvas context is created, and
    // re-registering the same family is wasteful, so do it exactly once.
    if (registered) return;
    registered = true;

    for (const font of resolveFonts()) {
        const found = font.path;

        if (!found) {
            const label = `${font.family}${font.weight === 'bold' ? ' (bold)' : ''}`;
            if (font.optional) {
                console.warn(`[FONTS] ${label} not found — emoji will render as fallback glyphs.`);
            } else {
                console.warn(`[FONTS] ${label} not found in any known location — generated images will use canvas's default font.`);
            }
            continue;
        }

        try {
            registerFont(found, { family: font.family, weight: font.weight });
        } catch (err) {
            console.warn(`[FONTS] Failed to register ${font.family} from ${found}: ${err.message}`);
        }
    }
}

module.exports = { ensureFontsRegistered, resolveFonts, FONTS };
