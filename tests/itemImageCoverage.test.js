'use strict';

// docs/ITEM_IMAGE_COVERAGE.md is a checklist of 340 ids kept by hand across many
// sittings, which makes both halves of it fragile in different ways.
//
// The ids are the half a test can own: an item added to the game data has to
// show up here as an unticked line, or the person working through the list
// never learns it exists. That is the first check, and it is what `npm test`
// enforces.
//
// The ticks are the half a test must not touch — but it can prove they survive
// the rewrite that adds new ids, which is the failure that would cost real
// work: a regeneration that quietly reset a fortnight of them.

const fs = require('fs');

// The query behind `--from-db` is mocked to the model layer, so these tests run
// without a database and without mongoose installed. What is worth asserting is
// the shape of the two reads — one of them is a performance cliff, since a
// `find` over guild shops pulls every image body, at 512 KB apiece, to answer a
// question about ids.
const mockMongoose = { connect: jest.fn(), disconnect: jest.fn() };
const mockItemImage = { find: jest.fn() };
const mockGuild = { aggregate: jest.fn() };

// dotenv and the secret loader are the CLI's own startup, not the behaviour
// under test — mocked so the suite does not depend on a .env being present.
jest.mock('dotenv', () => ({ config: () => ({}) }), { virtual: true });
jest.mock('mongoose', () => mockMongoose, { virtual: true });
jest.mock('../src/models/ItemImage', () => mockItemImage, { virtual: true });
jest.mock('../src/models/Guild', () => mockGuild, { virtual: true });

const {
    buildDoc,
    readState,
    applyTicks,
    applyUploaded,
    catalogue,
    matcher,
    isUploaded,
    withUploaded,
    withoutUploaded,
    DOC_PATH,
    BANNER,
} = require('../scripts/item-image-coverage');

const { ACTIVITY_ITEM_IDS } = require('../src/data/activityItems');
const { DEFAULT_SHOP_ITEMS } = require('../src/data/defaultShopItems');

describe('docs/ITEM_IMAGE_COVERAGE.md', () => {
    const doc = fs.readFileSync(DOC_PATH, 'utf8');

    test('is in step with the catalog', () => {
        const { current, next } = buildDoc();

        // Not `toBe`: the diff on a 340-line checklist is unreadable and the fix
        // is one command either way.
        expect(current === next).toBe(true);
    });

    test('says which half of it is generated', () => {
        expect(doc.startsWith(BANNER)).toBe(true);
    });

    test('has a line for every id the upload route accepts', () => {
        for (const id of ACTIVITY_ITEM_IDS) {
            expect([id, doc.includes(`\`${id}\``)]).toEqual([id, true]);
        }
    });

    test('has a line for every default shop item', () => {
        for (const item of DEFAULT_SHOP_ITEMS) {
            expect([item.itemId, doc.includes(`\`${item.itemId}\``)]).toEqual([item.itemId, true]);
        }
    });

    test('lists nothing the image system cannot store', () => {
        const listed = [...doc.matchAll(/^- \[[ x]\] `([^`]+)`/gm)].map(match => match[1]);
        const storable = new Set([...ACTIVITY_ITEM_IDS, ...DEFAULT_SHOP_ITEMS.map(i => i.itemId)]);

        expect(listed.filter(id => !storable.has(id))).toEqual([]);
    });

    test('counts the same ids in its summary as it lists', () => {
        const listed = (doc.match(/^- \[[ x]\]/gm) || []).length;
        const total = catalogue().reduce((n, group) => n + group.items.length, 0);

        expect(listed).toBe(total);
        const withArt = (doc.match(/^- \[x\]/gm) || []).length;
        const uploaded = (doc.match(/^- \[x\][^\n]* · uploaded$/gm) || []).length;
        expect(doc).toContain(`**${withArt} of ${total} have art${uploaded ? `, ${uploaded} uploaded` : ''}.**`);
    });
});

describe('the ticks', () => {
    test('survive the rewrite that adds new ids', () => {
        const state = readState(fs.readFileSync(DOC_PATH, 'utf8'));
        const { next } = buildDoc(state);

        expect(readState(next)).toEqual(state);
    });

    test('carry their note across, so nobody re-derives where the art came from', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack' }]]);
        const { next } = buildDoc(state);

        expect(next).toContain('- [x] `fish:koi` — Koi · cozy fishing pack');
        expect(readState(next).get('fish:koi')).toEqual({ done: true, note: 'cozy fishing pack' });
    });

    test('read back the same whether or not a line carries a note', () => {
        const state = new Map([['fish:koi', { done: true, note: '' }]]);
        const { next } = buildDoc(state);

        expect(next).toContain('- [x] `fish:koi` — Koi\n');
        expect(readState(next).get('fish:koi')).toEqual({ done: true, note: '' });
    });
});

describe('--tick', () => {
    const freshState = () => new Map();

    test('marks one id and says it changed something', () => {
        const state = freshState();

        expect(applyTicks(state, ['fish:koi'], true)).toBe(1);
        expect(state.get('fish:koi')).toEqual({ done: true, note: '' });
    });

    test('takes a note after `=`', () => {
        const state = freshState();
        applyTicks(state, ['fish:koi=cozy fishing pack'], true);

        expect(state.get('fish:koi').note).toBe('cozy fishing pack');
    });

    // 59 fish from one pack is one command, not 59.
    test('accepts a wildcard, and only touches ids that exist', () => {
        const state = freshState();
        const changed = applyTicks(state, ['material:*'], true);

        expect(changed).toBe(69);
        expect(state.get('material:fish_scale')).toEqual({ done: true, note: '' });
        expect(state.has('material:not_a_material')).toBe(false);
    });

    test('reports nothing changed when the pattern matches no id', () => {
        expect(applyTicks(freshState(), ['fish:no_such_fish'], true)).toBe(0);
    });

    test('re-ticking with a new note replaces the old one', () => {
        const state = new Map([['fish:koi', { done: true, note: 'placeholder' }]]);
        applyTicks(state, ['fish:koi=final art'], true);

        expect(state.get('fish:koi').note).toBe('final art');
    });

    // Unticking is for art that was replaced or withdrawn, so the note goes with
    // it — a note beside an unticked box describes art that is not there.
    test('unticking clears the note as well as the box', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack' }]]);
        applyTicks(state, ['fish:koi'], false);

        expect(state.get('fish:koi')).toEqual({ done: false, note: '' });
    });

    test('matches a wildcard as a wildcard and a dot as a dot', () => {
        expect(matcher('fish:*').test('fish:koi')).toBe(true);
        expect(matcher('fish:*').test('hunt:rabbit')).toBe(false);
        expect(matcher('fish:koi').test('fish:koibbb')).toBe(false);
    });
});

// `--from-db` writes the second of the two facts a line carries: whether a
// server holds the image, as opposed to whether the art exists at all. The
// merge is where that distinction is either kept or lost, so it is tested
// apart from the query that feeds it.
describe('--from-db', () => {
    test('ticks a stored id and marks it uploaded', () => {
        const state = new Map();
        const counts = applyUploaded(state, ['fish:koi']);

        expect(state.get('fish:koi')).toEqual({ done: true, note: 'uploaded' });
        expect(counts).toEqual({ marked: 1, unmarked: 0, ticked: 1 });
    });

    test('keeps the provenance note a person wrote, and adds the marker after it', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack' }]]);
        applyUploaded(state, ['fish:koi']);

        expect(state.get('fish:koi').note).toBe('cozy fishing pack · uploaded');
    });

    test('does not count an id that was already ticked and marked', () => {
        const state = new Map([['fish:koi', { done: true, note: 'uploaded' }]]);

        expect(applyUploaded(state, ['fish:koi'])).toEqual({ marked: 0, unmarked: 0, ticked: 0 });
    });

    // The rule that keeps the file honest in both directions: a deleted image
    // is not deleted art.
    test('clears the marker for an image since deleted, without unticking it', () => {
        const state = new Map([['fish:koi', { done: true, note: 'cozy fishing pack · uploaded' }]]);
        const counts = applyUploaded(state, []);

        expect(state.get('fish:koi')).toEqual({ done: true, note: 'cozy fishing pack' });
        expect(counts.unmarked).toBe(1);
    });

    test('leaves an unticked, unmarked line entirely alone', () => {
        const state = new Map();
        applyUploaded(state, []);

        expect(state.has('fish:koi')).toBe(false);
    });

    test('ignores stored ids the catalog does not name', () => {
        const state = new Map();
        applyUploaded(state, ['fish:koi', 'legacy:whatever']);

        expect([...state.keys()]).toEqual(['fish:koi']);
    });

    test('round-trips the marker through the file', () => {
        const state = new Map();
        applyUploaded(state, ['fish:koi']);
        const { next } = buildDoc(state);

        expect(next).toContain('- [x] `fish:koi` — Koi · uploaded');
        expect(readState(next).get('fish:koi')).toEqual({ done: true, note: 'uploaded' });
    });

    test('counts the uploaded ones separately in the summary', () => {
        const state = new Map([
            ['fish:koi', { done: true, note: 'uploaded' }],
            ['fish:eel', { done: true, note: 'drawn, not uploaded yet' }],
        ]);
        const { next } = buildDoc(state);

        expect(next).toContain('**2 of 340 have art, 1 uploaded.**');
    });
});

describe('the uploaded marker', () => {
    test('is one entry in a `·`-separated note, not a second field', () => {
        expect(isUploaded('cozy fishing pack · uploaded')).toBe(true);
        expect(isUploaded('cozy fishing pack')).toBe(false);
        expect(isUploaded('')).toBe(false);
    });

    // "uploaded to Discord by hand" is a sentence, not the marker.
    test('is matched whole, never as a substring of a sentence', () => {
        expect(isUploaded('uploaded by hand')).toBe(false);
    });

    test('is added once however many times it is applied', () => {
        expect(withUploaded(withUploaded('pack'))).toBe('pack · uploaded');
    });

    test('comes off without taking the rest of the note with it', () => {
        expect(withoutUploaded('pack · near match · uploaded')).toBe('pack · near match');
        expect(withoutUploaded('uploaded')).toBe('');
    });
});

// The query behind `--from-db`. Mocked to the model layer: what is worth
// asserting is the shape of the two reads, and one of them is a performance
// cliff — a `find` over guild shops pulls every image body, at 512 KB apiece,
// to answer a question about ids.
describe('readUploadedIds', () => {
    const { readUploadedIds } = require('../scripts/item-image-coverage');

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
        mockItemImage.find.mockReturnValue({ lean: async () => [{ itemId: 'fish:koi' }] });
        mockGuild.aggregate.mockResolvedValue([{ itemIds: ['padlock'] }]);
    });

    test('collects ids from both places an image can live', async () => {
        const { ids } = await readUploadedIds();

        expect([...ids].sort()).toEqual(['fish:koi', 'padlock']);
        expect(mockMongoose.connect).toHaveBeenCalledWith(
            'mongodb://localhost:27017/test',
            expect.objectContaining({ serverSelectionTimeoutMS: expect.any(Number) }),
        );
        expect(mockMongoose.disconnect).toHaveBeenCalled();
    });

    test('reads guild shop ids without downloading the images themselves', async () => {
        await readUploadedIds();
        const [pipeline] = mockGuild.aggregate.mock.calls[0];

        expect(JSON.stringify(pipeline)).toContain('itemId');
        expect(mockGuild.find).toBeUndefined();
    });

    // #561: a guild reads its own images and falls back to the shared pre-#561
    // rows, so "what does this server show" has to include both.
    test('scopes to one guild plus the shared rows when asked', async () => {
        await readUploadedIds({ guildId: 'g1' });

        expect(mockItemImage.find).toHaveBeenCalledWith(
            { imageData: { $ne: null }, guildId: { $in: ['g1', null] } },
            { itemId: 1, _id: 0 },
        );
        expect(mockGuild.aggregate.mock.calls[0][0][0]).toEqual({ $match: { guildId: 'g1' } });
    });

    test('counts an image on any guild when none is named', async () => {
        await readUploadedIds();

        expect(mockItemImage.find).toHaveBeenCalledWith({ imageData: { $ne: null } }, { itemId: 1, _id: 0 });
    });

    test('reports stored ids the catalog no longer names', async () => {
        mockItemImage.find.mockReturnValue({ lean: async () => [{ itemId: 'hunt:retired_rifle' }] });

        const { unknown } = await readUploadedIds();

        expect(unknown).toEqual(['hunt:retired_rifle']);
    });

    test('disconnects even when the read throws', async () => {
        mockGuild.aggregate.mockRejectedValue(new Error('no primary'));

        await expect(readUploadedIds()).rejects.toThrow('no primary');
        expect(mockMongoose.disconnect).toHaveBeenCalled();
    });

    test('says what is missing rather than connecting to nothing', async () => {
        delete process.env.MONGODB_URI;

        await expect(readUploadedIds()).rejects.toThrow(/MONGODB_URI is not set/);
        expect(mockMongoose.connect).not.toHaveBeenCalled();
    });
});

// The wiring between the flags and the two halves above: `--from-db` has to
// reach the query, pass `--guild` through, and write what came back. Mocked all
// the way down, including the write — a test suite that rewrote the real
// checklist would be editing the thing it is meant to be checking.
describe('the --from-db command', () => {
    const { main } = require('../scripts/item-image-coverage');
    let written;

    beforeEach(() => {
        jest.clearAllMocks();
        process.env.MONGODB_URI = 'mongodb://localhost:27017/test';
        mockItemImage.find.mockReturnValue({ lean: async () => [{ itemId: 'fish:koi' }] });
        mockGuild.aggregate.mockResolvedValue([]);
        written = null;
        jest.spyOn(fs, 'writeFileSync').mockImplementation((_path, body) => { written = body; });
        jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => jest.restoreAllMocks());

    test('writes the marker for what the database holds', async () => {
        await main(['--from-db']);

        expect(written).toContain('- [x] `fish:koi` — Koi');
        expect(readState(written).get('fish:koi').note).toContain('uploaded');
    });

    test('passes --guild through to the query', async () => {
        await main(['--from-db', '--guild', '123456789012345678']);

        expect(mockGuild.aggregate.mock.calls[0][0][0]).toEqual({ $match: { guildId: '123456789012345678' } });
    });

    test('takes --tick in the same run, without either flag eating the other', async () => {
        await main(['--from-db', '--tick', 'fish:eel=hand drawn']);

        expect(readState(written).get('fish:eel')).toEqual({ done: true, note: 'hand drawn' });
        // Read from the real checklist, where koi already carries where its art
        // came from — the database run adds to that note rather than replacing it.
        expect(readState(written).get('fish:koi').note).toBe('cozy fishing pack · uploaded');
    });

    test('says so when the database holds an id nothing in the game names', async () => {
        mockItemImage.find.mockReturnValue({ lean: async () => [{ itemId: 'hunt:retired_rifle' }] });

        await main(['--from-db']);

        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('hunt:retired_rifle'));
    });
});
