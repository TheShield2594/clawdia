'use strict';

/**
 * The birthday embed's default artwork — a small celebration icon for the
 * author line and a wide banner for the image slot.
 *
 * Same shape as the item-icon set (assets/icons/STYLE.md): the PNGs are
 * *generated* on Higgsfield but committed by CI (a GitHub runner can reach the
 * Higgsfield CDN that a sandbox cannot), then served as Discord embed
 * attachments. The catch is that they may not be present yet — the code has to
 * ship and work the moment it lands, with the art following in a later bake.
 *
 * So this degrades gracefully: when a file is on disk it becomes an
 * `attachment://…` reference the embed can point at; when it is missing the
 * caller simply gets `null` and shows no icon/banner (an admin can still set an
 * explicit URL). Nothing here throws on a missing asset.
 *
 * The files live under `src/assets/birthday/` — under `src/` because the Docker
 * build context ships `src/` and drops the repo-root `assets/` (same reason the
 * item icons live at `src/assets/item-icons/`).
 *
 * @module utils/birthdayFlair
 */

const fs = require('fs');
const path = require('path');
const { AttachmentBuilder } = require('discord.js');

const ASSET_DIR = path.join(__dirname, '..', 'assets', 'birthday');

// filename on disk → the attachment name the embed references, plus the alt
// text screen readers announce for it (never the filename — a picture is
// described, not named).
const ICON_FILE = 'birthday-icon.png';
const BANNER_FILE = 'birthday-banner.png';
const ICON_ALT = 'A festive birthday cake with lit candles';
const BANNER_ALT = 'A colourful birthday celebration banner with balloons, confetti and streamers';

function attachmentFor(file, description) {
    const full = path.join(ASSET_DIR, file);
    try {
        if (!fs.existsSync(full)) return null;
    } catch {
        return null;
    }
    return {
        attachment: new AttachmentBuilder(full, { name: file, description }),
        url: `attachment://${file}`,
    };
}

/**
 * Resolve the bundled birthday artwork available on disk.
 *
 * @returns {{ files: import('discord.js').AttachmentBuilder[], iconUrl: string|null, bannerUrl: string|null }}
 *   `files` to hand to `channel.send`, and the `attachment://` URLs to point the
 *   embed's author icon and image at (either may be `null` when the art is not
 *   baked in yet).
 */
function getBirthdayFlair() {
    const icon = attachmentFor(ICON_FILE, ICON_ALT);
    const banner = attachmentFor(BANNER_FILE, BANNER_ALT);
    const files = [];
    if (icon) files.push(icon.attachment);
    if (banner) files.push(banner.attachment);
    return {
        files,
        iconUrl: icon?.url ?? null,
        bannerUrl: banner?.url ?? null,
    };
}

module.exports = { getBirthdayFlair, ICON_FILE, BANNER_FILE };
