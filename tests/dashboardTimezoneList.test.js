'use strict';

/**
 * #942. The timezone picker's datalist is hand-maintained, which is how it came
 * to list `Asia/Kolkata` twice and three zones under names IANA superseded years
 * ago (`Europe/Kiev`, `Asia/Rangoon`, and `America/Honolulu`, which was never a
 * zone at all — the canonical name is `Pacific/Honolulu`, already in the list).
 *
 * Nothing broke: the old names survive as backward-compatibility links, so a
 * guild that saved one still resolves. The cost was cosmetic — a duplicate row
 * in the picker and names that read as dated to anyone living in those regions.
 *
 * These are the two failures a hand-maintained list drifts back into, so they
 * are checked rather than fixed once: no entry appears twice, and every entry
 * is a name Node's own tz database calls canonical.
 */

const fs = require('fs');
const path = require('path');

const VIEW = path.join(__dirname, '..', 'src', 'dashboard', 'views', 'guild-settings.ejs');

function datalistZones() {
    const source = fs.readFileSync(VIEW, 'utf8');
    const start = source.indexOf('<datalist id="tz-datalist">');
    const end = source.indexOf('</datalist>', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    return [...source.slice(start, end).matchAll(/<option value="([^"]+)">/g)].map(m => m[1]);
}

describe('the timezone datalist', () => {
    const zones = datalistZones();

    test('is not empty, so a broken parse cannot pass the checks below', () => {
        expect(zones.length).toBeGreaterThan(50);
    });

    test('lists no zone twice', () => {
        const seen = new Set();
        const duplicates = zones.filter(zone => (seen.has(zone) ? true : (seen.add(zone), false)));
        expect(duplicates).toEqual([]);
    });

    test('every entry is a zone the runtime accepts', () => {
        const rejected = zones.filter(zone => {
            try {
                new Intl.DateTimeFormat('en-US', { timeZone: zone });
                return false;
            } catch {
                return true;
            }
        });
        expect(rejected).toEqual([]);
    });

    test('no two entries are the same zone under different names', () => {
        // The check that actually caught #942, and the one that survives an ICU
        // bump: `America/Honolulu` and `Pacific/Honolulu` were both listed and
        // are one zone, as were `Europe/Kiev` and `Europe/Kyiv` had the rename
        // been added rather than applied.
        //
        // Deliberately not an assertion that each name IS its canonical form:
        // `resolvedOptions().timeZone` maps a name to whichever of the pair the
        // bundled tz database calls canonical, and which one that is has flipped
        // between ICU releases — Node resolves `Europe/Kyiv` to `Europe/Kiev`
        // here. Comparing entries to each other asks a question whose answer does
        // not depend on that.
        const byZone = new Map();
        for (const zone of zones) {
            const canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone;
            byZone.set(canonical, [...(byZone.get(canonical) ?? []), zone]);
        }
        const collisions = [...byZone.values()].filter(names => names.length > 1);
        expect(collisions).toEqual([]);
    });

    test('lists none of the superseded names #942 replaced', () => {
        // The renames themselves. Each still resolves — they are backward links,
        // not removals — so nothing above would fail if one came back on its own.
        for (const dated of ['Europe/Kiev', 'Asia/Rangoon', 'America/Honolulu']) {
            expect(zones).not.toContain(dated);
        }
        // ...and what each was replaced by is present, so a fix by deletion
        // would not pass either.
        for (const current of ['Europe/Kyiv', 'Asia/Yangon', 'Pacific/Honolulu']) {
            expect(zones).toContain(current);
        }
    });
});
