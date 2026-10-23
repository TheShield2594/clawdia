'use strict';

// The leaderboard picture card. How it looks is judged by eye; what is
// testable is that every shape of board draws a PNG of the height its layout
// promises, that nothing a canvas cannot draw reaches it, that the alt text
// says the board again, and that sending one degrades to the text embed alone
// when the card cannot be drawn.

const {
    createLeaderboardCard, altText, sendBoard, replyBoard, avatarUrlOf, displayNameOf, CARD_FILE, __test__,
} = require('../src/utils/leaderboardCard');
const { _resetCardRenderQueue } = require('../src/utils/cardRenderQueue');
const { plain, cardHeight, initial } = __test__;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const size = png => ({ width: png.readUInt32BE(16), height: png.readUInt32BE(20) });

const entries = n => Array.from({ length: n }, (_, i) => ({
    rank: i + 1, name: `Member ${i + 1}`, value: `${100 - i * 7} achievements`, score: 100 - i * 7,
}));

const base = (over = {}) => ({
    theme: 'achievements', kicker: 'Test Guild', title: 'Achievements',
    subtitle: 'Top 10 by total achievements earned', entries: entries(10), ...over,
});

beforeEach(() => _resetCardRenderQueue());

describe('createLeaderboardCard', () => {
    test('draws a full board at the height its layout promises', async () => {
        const png = await createLeaderboardCard(base());
        expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        expect(size(png)).toEqual({ width: 1000, height: cardHeight(7, false, false) });
    });

    test('grows for the caller\'s own row and a footer', async () => {
        const plainH = size(await createLeaderboardCard(base())).height;
        const withYou = size(await createLeaderboardCard(base({
            you: { rank: 42, name: 'Me', value: '3 achievements', score: 3 },
        }))).height;
        const withFooter = size(await createLeaderboardCard(base({
            you: { rank: 42, name: 'Me', value: '3 achievements', score: 3 }, footer: 'Most achievements earned',
        }))).height;
        expect(withYou).toBeGreaterThan(plainH);
        expect(withFooter).toBeGreaterThan(withYou);
    });

    test('a caller already on the board gets no second row', async () => {
        const list = entries(10);
        list[4].you = true;
        const png = await createLeaderboardCard(base({ entries: list, you: { rank: 5, name: 'Me', value: 'x' } }));
        expect(size(png).height).toBe(cardHeight(7, false, false));
    });

    test('draws a board of one, two or three — the podium alone', async () => {
        for (const n of [1, 2, 3]) {
            const png = await createLeaderboardCard(base({ entries: entries(n) }));
            expect(size(png).height).toBe(cardHeight(0, false, false));
        }
    });

    test('every palette, pet art, emoji names, no scores and a failed avatar all draw', async () => {
        for (const theme of ['board', 'achievements', 'streak', 'duel', 'syndicate', 'pets', 'hunt', 'fish', 'mine', 'explore', 'nope']) {
            const png = await createLeaderboardCard(base({
                theme,
                entries: [
                    { rank: 1, name: '🔥 Fire 🔥', value: '12 days', iconId: 'pet:cat' },
                    { rank: 2, name: '', value: '<:coin:123456789012345678> 5' },
                    { rank: 3, name: 'A name far too long to ever fit on the podium panel at all', value: '9,999,999,999 coins', detail: 'Level 30' },
                    { rank: 4, name: 'Row', value: '1', avatarUrl: 'file:///does/not/exist.png' },
                ],
            }));
            expect(png.subarray(0, 4)).toEqual(PNG_MAGIC);
        }
    });
});

describe('plain', () => {
    test('strips emoji and custom Discord emoji a canvas cannot draw', () => {
        expect(plain('🔥 Fire 🔥')).toBe('Fire');
        expect(plain('<:coin:123456789012345678> 5')).toBe('5');
        expect(plain('<a:spin:123456789012345678>Spin')).toBe('Spin');
        expect(plain(null)).toBe('');
    });

    test('initial reads the first letter or digit, past any emoji', () => {
        expect(initial('🔥alice')).toBe('A');
        expect(initial('')).toBe('?');
    });
});

describe('altText', () => {
    test('says the board, every row, and the caller off it', () => {
        const text = altText(base({ entries: entries(2), you: { rank: 9, name: 'Me', value: '3 achievements' } }));
        expect(text).toContain('Achievements leaderboard for Test Guild.');
        expect(text).toContain('1. Member 1, 100 achievements');
        expect(text).toContain('2. Member 2, 93 achievements');
        expect(text).toContain('You: 9. Me, 3 achievements.');
    });
});

describe('avatarUrlOf / displayNameOf', () => {
    test('asks for a static PNG, and tolerates a missing user', () => {
        const user = { displayAvatarURL: jest.fn(() => 'https://cdn/a.png') };
        expect(avatarUrlOf(user)).toBe('https://cdn/a.png');
        expect(user.displayAvatarURL).toHaveBeenCalledWith({ extension: 'png', size: 128, forceStatic: true });
        expect(avatarUrlOf(null)).toBeNull();
        expect(displayNameOf({ globalName: 'Glob', username: 'user' })).toBe('Glob');
        expect(displayNameOf(null)).toBeNull();
    });
});

function makeInteraction() {
    const interaction = {
        guild: { id: 'g1' },
        deferred: false,
        replied: false,
        reply: jest.fn().mockResolvedValue(undefined),
        deferReply: jest.fn(async () => { interaction.deferred = true; }),
        editReply: jest.fn().mockResolvedValue(undefined),
    };
    return interaction;
}

const textEmbed = () => ({ data: { color: 0xF1C40F }, marker: 'text' });

describe('sendBoard', () => {
    test('defers, then leads with the card and keeps the text embed beneath it', async () => {
        const interaction = makeInteraction();
        await sendBoard(interaction, textEmbed(), base());
        expect(interaction.deferReply).toHaveBeenCalled();
        const payload = interaction.editReply.mock.calls[0][0];
        expect(payload.files).toHaveLength(1);
        expect(payload.files[0].name).toBe(CARD_FILE);
        expect(payload.files[0].description).toContain('Achievements leaderboard');
        expect(payload.embeds).toHaveLength(2);
        expect(payload.embeds[0].data.image.url).toBe(`attachment://${CARD_FILE}`);
        expect(payload.embeds[1].marker).toBe('text');
    });

    test('a board with no rows goes out as its text alone', async () => {
        const interaction = makeInteraction();
        await sendBoard(interaction, textEmbed(), base({ entries: [] }));
        const payload = interaction.editReply.mock.calls[0][0];
        expect(payload.files).toBeUndefined();
        expect(payload.embeds).toHaveLength(1);
    });

    test('an already-deferred interaction is not deferred twice', async () => {
        const interaction = makeInteraction();
        interaction.deferred = true;
        await sendBoard(interaction, textEmbed(), base({ entries: entries(1) }));
        expect(interaction.deferReply).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalled();
    });
});

describe('replyBoard', () => {
    test('an empty board\'s note is replied as it is', async () => {
        const interaction = makeInteraction();
        const note = { content: 'Nothing yet', flags: 64 };
        await replyBoard(interaction, note);
        expect(interaction.reply).toHaveBeenCalledWith(note);
        expect(interaction.deferReply).not.toHaveBeenCalled();
    });

    test('a board with a card is sent without the card field on the payload', async () => {
        const interaction = makeInteraction();
        await replyBoard(interaction, { embeds: [textEmbed()], card: base({ entries: entries(2) }) });
        const payload = interaction.editReply.mock.calls[0][0];
        expect(payload.card).toBeUndefined();
        expect(payload.embeds).toHaveLength(2);
    });
});
