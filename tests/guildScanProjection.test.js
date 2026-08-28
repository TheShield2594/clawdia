'use strict';

// A Guild document is an 813-line schema whose arrays are the expensive part: up
// to 3000 `analytics.commandUsage` subdocuments, and one image `Buffer` per shop
// item. A caller that scans the whole collection without a projection pulls all
// of that into the process for every guild the bot is in, to read two fields.
//
// The scan below is the part that keeps working. Whichever caller is added next
// will be a `Guild.find({})` written by someone who had no reason to know what
// the schema drags along, and a projection is invisible by omission.

const fs   = require('fs');
const path = require('path');
// Ships with jest (jest → babel-jest → @babel/core → @babel/parser), so it is
// always present when this suite runs and is not declared separately.
const { parse } = require('@babel/parser');

const SRC = path.join(__dirname, '..', 'src');

function jsFiles(dir) {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return jsFiles(full);
        return entry.isFile() && entry.name.endsWith('.js') ? [full] : [];
    });
}

function walk(node, visit) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const child of node) walk(child, visit); return; }
    if (typeof node.type === 'string') visit(node);
    for (const key of Object.keys(node)) {
        if (key === 'loc') continue;
        walk(node[key], visit);
    }
}

// `Guild.find({})` — an empty filter is the collection scan; anything narrower is
// the caller's own business.
function unprojectedScans(file) {
    const ast = parse(fs.readFileSync(file, 'utf8'), {
        sourceType: 'unambiguous',
        plugins: ['optionalChaining', 'nullishCoalescingOperator', 'classProperties'],
    });

    const found = [];
    walk(ast.program, node => {
        if (node.type !== 'CallExpression') return;
        const callee = node.callee;
        if (callee?.type !== 'MemberExpression') return;
        if (callee.object?.name !== 'Guild' || callee.property?.name !== 'find') return;

        const [filter, projection] = node.arguments;
        if (filter?.type !== 'ObjectExpression' || filter.properties.length > 0) return;
        if (!projection) found.push({ file: path.relative(SRC, file), line: node.loc.start.line });
    });
    return found;
}

describe('collection-wide Guild scans', () => {
    test('every Guild.find({}) names the fields it needs', () => {
        const offenders = jsFiles(SRC).flatMap(unprojectedScans);
        expect(offenders.map(o => `${o.file}:${o.line}`)).toEqual([]);
    });

    test('and none of them asks for analytics or the shop', () => {
        // The two arrays that make an unprojected scan expensive. A projection that
        // names either is a projection that did not help.
        const projections = jsFiles(SRC).flatMap(file => {
            const source = fs.readFileSync(file, 'utf8');
            return [...source.matchAll(/Guild\.find\(\{\},\s*'([^']*)'/g)].map(m => m[1]);
        });

        expect(projections.length).toBeGreaterThan(0);
        for (const fields of projections) {
            expect(fields.split(/\s+/)).not.toContain('analytics');
            expect(fields.split(/\s+/)).not.toContain('shop');
        }
    });
});

// The RSS feed check is not a `Guild.find({})` — it filters to guilds that have
// feeds — but it ran on the same hydrated documents, and its write was a
// `guild.save()` that rewrote the whole feed array to move one date. Those two
// facts are linked: a projected document is exactly the one `guild.save()` cannot
// be trusted with, so the write had to become a targeted one.
describe('the RSS feed check', () => {
    let Guild;
    let checkRssFeeds;

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('discord.js', () => ({
            EmbedBuilder: class {
                setColor() { return this; }
                setTitle() { return this; }
                setURL() { return this; }
                setDescription() { return this; }
                setTimestamp() { return this; }
                setThumbnail() { return this; }
            },
        }));
        jest.doMock('rss-parser', () => class {
            parseString() {
                return Promise.resolve({
                    items: [{ title: 'A post', link: 'https://example.com/a', pubDate: '2030-01-01T00:00:00Z' }],
                });
            }
        });
        // Feed URLs are operator-supplied, so the real fetch is the SSRF-safe one;
        // it has its own suite, and this one must not reach the network.
        jest.doMock('../src/utils/safeFeedFetch', () => ({ safeFetchFeed: jest.fn().mockResolvedValue('<rss/>') }));
        jest.doMock('../src/models/Guild', () => ({ find: jest.fn(), updateOne: jest.fn() }));
        jest.doMock('../src/utils/jobRunner', () => ({ runJob: jest.fn() }));

        Guild = require('../src/models/Guild');
        ({ checkRssFeeds } = require('../src/services/rssService'));
    });

    afterEach(() => jest.resetModules());

    function stubFind(guilds) {
        const seen = {};
        Guild.find.mockImplementation((filter, projection) => {
            seen.filter = filter;
            seen.projection = projection;
            return { lean: () => Promise.resolve(guilds) };
        });
        Guild.updateOne.mockResolvedValue({});
        return seen;
    }

    test('asks for only the feeds, and takes them lean', async () => {
        const seen = stubFind([]);

        await checkRssFeeds({});

        expect(seen.projection).toBe('guildId rssFeeds');
    });

    test('moves the published date with a targeted update, not a whole-document save', async () => {
        stubFind([{
            guildId: 'g1',
            rssFeeds: [{ _id: 'feed1', url: 'https://example.com/rss', channelId: 'chan1', lastPublished: null }],
        }]);

        // A real sendable channel: the cursor only moves for an item that was
        // actually delivered, so a null channel now writes nothing and would
        // say nothing about the shape of the write, which is what this asserts.
        const channel = { send: jest.fn().mockResolvedValue({}), isTextBased: () => true };
        await checkRssFeeds({ channels: { fetch: jest.fn().mockResolvedValue(channel) } });

        expect(Guild.updateOne).toHaveBeenCalledTimes(1);
        const [filter, update] = Guild.updateOne.mock.calls[0];
        expect(filter).toEqual({ guildId: 'g1', 'rssFeeds._id': 'feed1' });
        expect(update.$set['rssFeeds.$.lastPublished']).toEqual(new Date('2030-01-01T00:00:00Z'));
    });

    test('leaves the date alone when the feed has nothing newer', async () => {
        stubFind([{
            guildId: 'g1',
            rssFeeds: [{
                _id: 'feed1',
                url: 'https://example.com/rss',
                channelId: 'chan1',
                lastPublished: new Date('2031-01-01T00:00:00Z'),
            }],
        }]);

        await checkRssFeeds({ channels: { fetch: jest.fn().mockResolvedValue(null) } });

        expect(Guild.updateOne).not.toHaveBeenCalled();
    });
});
