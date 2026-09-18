'use strict';

// The /mydata command's two pure helpers — no database, no Discord, so they can
// be checked directly. The database-backed behaviour they sit on top of is
// covered by tests/userDataErasure.test.js against a real mongod.

const mydata = require('../src/commands/utility/mydata');

describe('buildExportFile', () => {
    test('names the file after the guild and member and holds the pretty-printed dump', () => {
        const dump = { generatedAt: 't', userId: 'u1', guildId: 'g1', collections: { profile: { records: [] } } };
        const file = mydata.buildExportFile(dump);

        expect(file.name).toBe('clawdia-data-g1-u1.json');
        const parsed = JSON.parse(file.attachment.toString('utf8'));
        expect(parsed).toEqual(dump);
    });
});

describe('formatDeletionSummary', () => {
    test('separates what was deleted from what was kept, and why', () => {
        const summary = mydata.formatDeletionSummary({
            coinsRemoved: 1500,
            results: [
                { key: 'profile', label: 'Economy profile', behavior: 'delete', changed: 1 },
                { key: 'reminders', label: 'Reminders', behavior: 'delete', changed: 0 },
                { key: 'cases', label: 'Moderation cases', behavior: 'pseudonymize', changed: 2 },
                { key: 'tempBans', label: 'Active temporary bans', behavior: 'retain', changed: 0 },
            ],
        });

        expect(summary).toContain('**Deleted**');
        expect(summary).toContain('Economy profile');
        // A delete that changed nothing is not worth a line.
        expect(summary).not.toContain('Reminders');
        // The coin line names the amount and explains the ledger entry.
        expect(summary).toContain('1,500 coins');
        expect(summary).toContain('**Kept, by necessity**');
        expect(summary).toContain('identity redacted');
        expect(summary).toContain('retained');
    });

    test('handles a member with nothing stored', () => {
        const summary = mydata.formatDeletionSummary({
            coinsRemoved: 0,
            results: [{ key: 'profile', label: 'Economy profile', behavior: 'delete', changed: 0 }],
        });
        expect(summary).toBe('');
    });
});
