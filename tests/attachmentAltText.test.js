'use strict';

/**
 * #672. Every image the bot sends is a canvas render — rank cards, welcome
 * cards, achievement popups, shop banners, pet sprites — and not one of the
 * fifteen `new AttachmentBuilder(buf, { name })` calls passed a `description`,
 * which is what Discord shows as the image's alt text. A screen reader
 * announced the filename.
 *
 * `/rank` was the sharp end of it. In the common branch — no boosters, no
 * prestige, no excluded channels — the reply was the card and nothing else, so
 * the level, XP and rank position the command exists to report existed nowhere
 * in text: not for a reader, not for a client that failed to fetch the image,
 * not for anyone searching the channel afterwards.
 *
 * The sweep runs over every call site rather than the list of the ones that
 * were wrong, because the next attachment added is the next one to forget.
 */

const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.name.endsWith('.js') ? [full] : [];
    });
}

/**
 * The source of each `new AttachmentBuilder(...)` call, brackets balanced —
 * the options object is on its own line in most of these, so a line-based match
 * would see the buffer argument and nothing else.
 */
function attachmentCalls(source) {
    const calls = [];
    const marker = 'new AttachmentBuilder(';
    for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
        let depth = 0;
        let end = at + marker.length - 1;
        for (; end < source.length; end++) {
            if (source[end] === '(') depth++;
            else if (source[end] === ')' && --depth === 0) break;
        }
        calls.push(source.slice(at, end + 1));
    }
    return calls;
}

describe('image attachments carry alt text', () => {
    const sites = jsFiles(SRC).flatMap(file =>
        attachmentCalls(fs.readFileSync(file, 'utf8'))
            .map(call => [path.relative(SRC, file), call]));

    it('finds the call sites it is meant to be checking', () => {
        // A sweep that discovers its own inputs reports the same green for
        // "all of them pass one" as for "there are none".
        expect(sites.length).toBeGreaterThan(10);
    });

    it('passes a description on every one', () => {
        const bare = sites
            // `description: x` or the shorthand `{ name, description }`.
            .filter(([, call]) => !/\bdescription\s*[:,}]/.test(call))
            .map(([file, call]) => `${file}: ${call.replace(/\s+/g, ' ').slice(0, 80)}`);
        expect(bare).toEqual([]);
    });

    it('describes the picture rather than repeating the filename', () => {
        const lazy = sites
            .map(([file, call]) => [file, /description\s*:\s*([^\n]*)/.exec(call)?.[1] ?? ''])
            .filter(([, description]) => /\.(png|jpe?g|gif|webp)/.test(description))
            .map(([file]) => file);
        expect(lazy).toEqual([]);
    });
});
