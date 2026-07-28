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

const FONTS = [
    {
        family: 'DejaVu Sans',
        weight: 'normal',
        candidates: [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',   // Debian/Ubuntu
            '/usr/share/fonts/ttf-dejavu/DejaVuSans.ttf',        // Alpine
            '/usr/share/fonts/dejavu/DejaVuSans.ttf',            // Fedora/RHEL
            '/Library/Fonts/DejaVuSans.ttf',                     // macOS (manual install)
        ],
    },
    {
        family: 'DejaVu Sans',
        weight: 'bold',
        candidates: [
            '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/ttf-dejavu/DejaVuSans-Bold.ttf',
            '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
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

function ensureFontsRegistered() {
    // registerFont must run before any canvas context is created, and
    // re-registering the same family is wasteful, so do it exactly once.
    if (registered) return;
    registered = true;

    for (const font of FONTS) {
        const found = font.candidates.find(p => {
            try { return fs.existsSync(p); } catch { return false; }
        });

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

module.exports = { ensureFontsRegistered };
