'use strict';

/**
 * #664. Sixty-one distinct hex literals across a hundred and twenty files that
 * build an EmbedBuilder inline, and no module holding any of them — so the same
 * event wore a different colour depending on which command produced it.
 * Success was `#2ecc71` in the economy, `#00ff00` in moderation, `#4caf50` when
 * a pet was adopted; failure was `#e74c3c`, `#ff0000`, `#ff3333`, `#ff6b6b`
 * and `#c0392b`.
 *
 * src/utils/embedColors.js holds the roles now. This is the line that keeps
 * them held: a retired spelling must not reappear, and a canonical value must
 * not be retyped as a literal by someone who did not know the module exists.
 *
 * A colour that belongs to one feature rather than to an outcome is not a role
 * and is deliberately left alone — see the module's own comment. Those are not
 * listed here, and nothing below should be read as a ban on them.
 */
const fs = require('fs');
const path = require('path');

const COLORS = require('../src/utils/embedColors');

const SRC = path.join(__dirname, '..', 'src');
// The dashboard is HTML and CSS with its own palette; these are Discord embeds.
const SKIP = path.join(SRC, 'dashboard');

/** Every hex or 0x literal handed to setColor(), with where it came from. */
function literalColorSites() {
    const found = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (full !== SKIP) walk(full);
            } else if (entry.name.endsWith('.js')) {
                fs.readFileSync(full, 'utf8').split('\n').forEach((line, i) => {
                    const m = /setColor\(\s*(?:['"](#[0-9a-fA-F]{6})['"]|(0[xX][0-9a-fA-F]{6}))/.exec(line);
                    if (m) found.push({
                        file: path.relative(SRC, full),
                        line: i + 1,
                        color: (m[1] ?? m[2]).toLowerCase().replace(/^0x/, '#'),
                    });
                });
            }
        }
    };
    walk(SRC);
    return found;
}

// The second, third and fourth spellings each role had picked up.
const RETIRED = {
    SUCCESS: ['#00ff00', '#4caf50', '#00cc55', '#00ff88'],
    ERROR:   ['#ff0000', '#ff3333', '#ff6b6b', '#c0392b', '#ed4245'],
    WARN:    ['#ff9900', '#ffa500', '#ff9800', '#ff6600', '#ffff00', '#cc3300'],
    INFO:    ['#3498db', '#0099ff', '#5dade2', '#6ab4f5', '#1565c0', '#4169e1'],
    NEUTRAL: ['#888888', '#9e9e9e', '#aaaaaa', '#808080', '#2f3136', '#78909c'],
    RARE:    ['#8e44ad', '#b39ddb', '#9c27b0'],
    PRIZE:   ['#ffdd00'],
};

describe('embedColors', () => {
    it('names every role the call sites need', () => {
        expect(Object.keys(COLORS).sort())
            .toEqual(['ERROR', 'INFO', 'NEUTRAL', 'PRIZE', 'RARE', 'SUCCESS', 'WARN']);
        for (const [role, value] of Object.entries(COLORS)) {
            expect([role, value]).toEqual([role, expect.stringMatching(/^#[0-9a-f]{6}$/)]);
        }
    });

    it('gives each role a colour of its own', () => {
        expect(new Set(Object.values(COLORS)).size).toBe(Object.keys(COLORS).length);
    });

    it('cannot be edited into a different palette at runtime', () => {
        expect(Object.isFrozen(COLORS)).toBe(true);
    });
});

describe('no embed retypes a colour the module already names', () => {
    const sites = literalColorSites();

    it('finds call sites at all', () => {
        // A sweep that derives its own input reports the same green for
        // "nothing was wrong" as for "nothing was looked at".
        expect(sites.length).toBeGreaterThan(0);
    });

    it.each(Object.entries(COLORS))('%s is imported, never written out again', (role, value) => {
        const offenders = sites.filter(s => s.color === value).map(s => `${s.file}:${s.line}`);
        expect(offenders).toEqual([]);
    });

    it.each(Object.entries(RETIRED))('no second spelling of %s comes back', (role, retired) => {
        const offenders = sites
            .filter(s => retired.includes(s.color))
            .map(s => `${s.file}:${s.line} (${s.color} — use COLORS.${role})`);
        expect(offenders).toEqual([]);
    });
});

describe('the roles the issue named are actually in use', () => {
    const source = () => {
        const out = [];
        const walk = dir => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (full !== SKIP) walk(full); }
                else if (entry.name.endsWith('.js')) out.push(fs.readFileSync(full, 'utf8'));
            }
        };
        walk(SRC);
        return out.join('\n');
    };

    it.each(Object.keys(COLORS))('%s reaches at least one embed', role => {
        // A constant nobody calls is the same as no constant: the migration has
        // to have happened, not just the module.
        expect(source()).toContain(`COLORS.${role}`);
    });
});
