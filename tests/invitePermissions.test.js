/**
 * #723. SETUP_GUIDE.md's invite URL granted Administrator (`permissions=8`)
 * while FEATURES.md documented a precise minimum permission set — and the URL
 * is the thing users actually click. The set now lives once, in
 * src/config/invitePermissions.js; this holds the two documents and the
 * dashboard's invite button to it.
 */
const fs = require('fs');
const path = require('path');
const { PermissionFlagsBits } = require('discord.js');
const { INVITE_PERMISSIONS, INVITE_PERMISSIONS_BITFIELD } = require('../src/config/invitePermissions');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

describe('invite permission set', () => {
    it('never asks for Administrator', () => {
        // Administrator subsumes everything, which is exactly what the invite
        // must not do — and what it did before this module existed.
        expect(INVITE_PERMISSIONS_BITFIELD & PermissionFlagsBits.Administrator).toBe(0n);
    });

    it('is more than the old Administrator shortcut decomposed', () => {
        // Every entry must be a real, distinct Discord permission flag.
        const flags = Object.values(INVITE_PERMISSIONS);
        expect(new Set(flags).size).toBe(flags.length);
        const known = new Set(Object.values(PermissionFlagsBits));
        for (const [name, flag] of Object.entries(INVITE_PERMISSIONS)) {
            expect([name, known.has(flag)]).toEqual([name, true]);
        }
    });

    it('is the bitfield SETUP_GUIDE.md tells users to click', () => {
        const guide = read('SETUP_GUIDE.md');
        expect(guide).toContain(`permissions=${INVITE_PERMISSIONS_BITFIELD}`);
        // The old URL must not survive anywhere in the guide.
        expect(guide).not.toContain('permissions=8&');
    });

    it('is the list FEATURES.md documents, name for name', () => {
        // The permissions section, not the whole file — a permission name
        // appearing in some feature description elsewhere must not satisfy
        // this.
        const features = read('FEATURES.md');
        const section = features.slice(
            features.indexOf('### Bot Permissions Required'),
            features.indexOf('### User Permissions')
        );
        expect(section.length).toBeGreaterThan(0);
        for (const name of Object.keys(INVITE_PERMISSIONS)) {
            expect([name, section.includes(`- ${name}`)]).toEqual([name, true]);
        }
        // And nothing undocumented: every bullet in the section is an entry.
        const bullets = section.split('\n')
            .filter(l => l.startsWith('- '))
            .map(l => l.replace(/^- /, '').replace(/\s*\(.*\)$/, ''));
        expect(bullets.sort()).toEqual(Object.keys(INVITE_PERMISSIONS).sort());
    });
});
