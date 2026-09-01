'use strict';

// #922. Two hot dashboard reads sort a guild's moderation cases newest-first —
// the paged case list, and the insights query that hydrates the most recent
// thousand to work out which channels generate incidents — and the Case schema
// declared no index that ends in createdAt. Neither sort was index-backed, so
// Mongo fetched every matching case for the guild and sorted it in memory on
// each page view. Nothing to notice on a server with fifty cases, and the kind
// of cost that arrives years later on a busy one.
//
// The index is declared in the schema rather than created in a migration (the
// #576 convention): nothing is being dropped, so autoIndex builds it. What is
// checked here is the pair — the index the schema declares, and that the
// queries are still shaped to use it. Either half alone is a fact about a file;
// together they are the fix.

const fs = require('fs');
const path = require('path');

// Compiled, not parsed: schema.indexes() is the list Mongoose hands the driver
// at autoIndex time, so this cannot pass on an index that is written down but
// malformed.
const caseSchema = require('../src/models/Case').schema;
const declared = caseSchema.indexes();

const SRC = path.join(__dirname, '..', 'src');
const read = rel => fs.readFileSync(path.join(SRC, rel), 'utf8');

/** True when some declared index answers `sort` for a query on `equalityKeys`. */
function coveredSort(equalityKeys, sortKey) {
    return declared.some(([keys]) => {
        const names = Object.keys(keys);
        // Equality-matched fields first, then the sort field: the prefix rule
        // Mongo actually applies. Anything after the sort field is irrelevant
        // to whether the sort is index-backed.
        const prefix = names.slice(0, equalityKeys.length);
        return equalityKeys.every(k => prefix.includes(k)) && names[equalityKeys.length] === sortKey;
    });
}

describe('the Case schema indexes the order the dashboard reads cases in', () => {
    test('declares { guildId: 1, createdAt: -1 }', () => {
        const entry = declared.find(([keys]) => JSON.stringify(keys) === '{"guildId":1,"createdAt":-1}');
        expect(entry).toBeDefined();
    });

    test('so a guild-scoped newest-first sort is index-backed', () => {
        expect(coveredSort(['guildId'], 'createdAt')).toBe(true);
    });

    // The three indexes that were already there stay: this adds a sort order,
    // it does not replace the lookups.
    test.each([
        ['{"guildId":1,"caseId":1}'],
        ['{"guildId":1,"targetUserId":1}'],
        ['{"guildId":1,"status":1,"slaDeadline":1}'],
    ])('keeps %s', spec => {
        expect(declared.some(([keys]) => JSON.stringify(keys) === spec)).toBe(true);
    });

    test('and case numbering is still unique per guild', () => {
        const entry = declared.find(([keys]) => JSON.stringify(keys) === '{"guildId":1,"caseId":1}');
        expect(entry[1].unique).toBe(true);
    });
});

// An index nobody queries is dead weight on every write, so the reason for this
// one is asserted where it lives: a sort that stopped being guild-scoped, or
// stopped being on createdAt, would leave the index unused and this failing.
describe('the reads it exists for are still shaped to use it', () => {
    test('the paged case list scopes to a guild and sorts newest-first', () => {
        const source = read(path.join('dashboard', 'routes', 'api', 'moderation.js'));
        expect(source).toMatch(/const query = \{ guildId \}/);
        expect(source).toMatch(/Case\.find\(query\)\.sort\(\{ createdAt: -1 \}\)/);
    });

    test('the insights query does the same for its thousand', () => {
        const source = read(path.join('dashboard', 'routes', 'api', 'stats.js'));
        expect(source).toMatch(/Case\.find\(\{ guildId \}\)[\s\S]{0,80}?\.sort\(\{ createdAt: -1 \}\)/);
    });

    // The bot's own read of a member's history sorts the same way and is
    // deliberately not covered: {guildId, targetUserId} narrows it to one
    // member's cases before the sort, which is a handful of documents rather
    // than the guild's whole history, and it takes ten of them. Pinned here so
    // that a future `{guildId, targetUserId, createdAt}` is added because
    // someone decided to, rather than by reflex.
    test('the per-member history sorts in memory over a set its index has already narrowed', () => {
        const source = read(path.join('services', 'caseService.js'));
        expect(source).toMatch(/Case\.find\(\{ guildId, targetUserId \}\)[\s\S]{0,40}?\.sort\(\{ createdAt: -1 \}\)/);
        expect(coveredSort(['guildId', 'targetUserId'], 'createdAt')).toBe(false);
    });
});
