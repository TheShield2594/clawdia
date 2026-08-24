'use strict';

/**
 * #667. src/utils/embedFields.js existed to stop exactly one failure — a list
 * that grows with what a player owns or an admin types, joined into an embed
 * that Discord then rejects, because discord.js throws rather than truncating
 * and the whole command dies with it. The helper was applied to one section of
 * one command and not to the section immediately next to it.
 *
 * These are the worst cases at the sites where the input has no length cap of
 * its own: an inventory nobody ever cleared out, a moderator who writes essays
 * into `/warn`, and an event shop whose blurbs came from a dashboard textarea.
 */

jest.mock('../src/models/Case', () => ({ find: jest.fn() }));
jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/AiItem', () => ({ find: jest.fn() }));

const Case = require('../src/models/Case');
const { EMBED_LIMITS, packFieldsCapped } = require('../src/utils/embedFields');
const { __test__: inventoryTest } = require('../src/commands/economy/inventory');
const warn = require('../src/commands/moderation/warn');
const { RELIC_LIST } = require('../src/data/exploreData');

const MAX_FIELDS = 25;
const MAX_EMBED_TOTAL = 6_000;

/** What Discord actually measures: title, description and every field. */
function embedSize(data) {
    return (data.title?.length ?? 0)
        + (data.description?.length ?? 0)
        + (data.footer?.text?.length ?? 0)
        + (data.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

function expectWithinDiscordBudgets(embed) {
    const data = embed.data ?? embed;
    expect((data.fields ?? []).length).toBeLessThanOrEqual(MAX_FIELDS);
    for (const field of data.fields ?? []) {
        expect([field.name, field.value.length <= EMBED_LIMITS.FIELD_VALUE]).toEqual([field.name, true]);
    }
    expect((data.description ?? '').length).toBeLessThanOrEqual(EMBED_LIMITS.DESCRIPTION);
    expect(embedSize(data)).toBeLessThanOrEqual(MAX_EMBED_TOTAL);
}

describe('packFieldsCapped', () => {
    test('spends no more fields than it is given', () => {
        const lines = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(200)}${i}`);
        const { fields } = packFieldsCapped('Items', lines, { maxFields: 2 });
        expect(fields).toHaveLength(2);
        for (const field of fields) {
            expect(field.value.length).toBeLessThanOrEqual(EMBED_LIMITS.FIELD_VALUE);
        }
    });

    test('counts what did not fit, so the caller can say so', () => {
        const lines = Array.from({ length: 200 }, (_, i) => `${'x'.repeat(200)}${i}`);
        const { fields, omitted } = packFieldsCapped('Items', lines, { maxFields: 2 });
        const shown = fields.map(f => f.value).join('\n').split('\n').length;
        expect(shown + omitted).toBe(lines.length);
        expect(omitted).toBeGreaterThan(0);
    });

    test('counts lines, not separators — an entry may contain the separator itself', () => {
        // An item and its lore line are one entry joined by a newline. Deriving
        // the count afterwards by splitting the packed value would report twice
        // as many entries as there are.
        const lines = Array.from({ length: 40 }, (_, i) => `**Item ${i}** ×1\n*${'lore '.repeat(20)}*`);
        const { omitted } = packFieldsCapped('Items', lines, { maxFields: 1 });
        const perField = Math.floor(EMBED_LIMITS.FIELD_VALUE / (lines[0].length + 1));
        expect(omitted).toBe(lines.length - perField);
    });

    test('omits nothing when the cap is never reached', () => {
        expect(packFieldsCapped('Items', ['a', 'b'], { maxFields: 3 }).omitted).toBe(0);
        expect(packFieldsCapped('Items', [], { maxFields: 3 })).toEqual({ fields: [], omitted: 0 });
    });
});

describe('/inventory with an inventory nobody ever cleared out', () => {
    const LORE = 'A long and self-indulgent description of an item, kept for flavour.';

    /** Shop items, forged items and a full relic case, all at once. */
    function maximalInventory() {
        const relics = RELIC_LIST.map(r => ({ itemId: r.itemId, quantity: 3 }));
        const shop = Array.from({ length: 60 }, (_, i) => ({ itemId: `widget_${i}`, quantity: 99 }));
        const forged = Array.from({ length: 60 }, (_, i) => ({ itemId: `ai_forged_${i}`, quantity: 12 }));
        return [...relics, ...shop, ...forged];
    }

    function build() {
        const inventory = maximalInventory();
        const shopItems = inventory
            .filter(e => e.itemId.startsWith('widget_'))
            .map(e => ({ name: e.itemId, itemId: e.itemId, price: 12_345 }));
        const aiItemMap = Object.fromEntries(inventory
            .filter(e => e.itemId.startsWith('ai_'))
            .map(e => [e.itemId, { name: `Forged ${e.itemId}`, emoji: '✨', rarity: 'legendary', lore: LORE }]));
        const effects = Array.from({ length: 12 }, () => ({ type: 'coin_boost', charges: 5 }));

        return inventoryTest.buildItemsEmbed(
            inventory, shopItems, effects, '💰', '#2ecc71', 'footer',
            { username: 'collector' }, 'https://cdn.example/avatar.png', aiItemMap,
        );
    }

    test('the embed Discord is handed is one it will accept', () => {
        expectWithinDiscordBudgets(build());
    });

    test('every section is packed, not just the relics', () => {
        // The bug was that relics were packed and the two sections beside them
        // were joined raw, so the fix has to be visible on all three.
        const names = build().data.fields.map(f => f.name);
        expect(names).toEqual(expect.arrayContaining(['🛍️ Shop Items', '⚒️ Forged Items', '🏺 Relics']));
    });

    test('says how much it could not show rather than dropping it in silence', () => {
        const notes = build().data.fields.filter(f => /and more/.test(f.name));
        expect(notes.length).toBeGreaterThan(0);
        for (const note of notes) {
            expect(note.value).toMatch(/\d+ further .+ not shown/);
        }
    });

    test('still renders a small inventory as plain single fields', () => {
        const embed = inventoryTest.buildItemsEmbed(
            [{ itemId: 'rock', quantity: 2 }], [{ name: 'rock', price: 5 }], [], '💰', '#2ecc71',
            'footer', { username: 'novice' }, 'https://cdn.example/avatar.png', {},
        );
        expect(embed.data.fields.map(f => f.name)).toEqual(['🛍️ Shop Items']);
        expect(embed.data.fields[0].value).toContain('rock');
    });
});

describe('/warn list with reasons nobody capped', () => {
    // `reason` is a required string option with no setMaxLength, so Discord's
    // own 6,000-character ceiling is the only limit on one of these.
    const HUGE_REASON = 'because '.repeat(700);

    function interactionFor(warnings) {
        Case.find.mockReturnValue({
            sort: () => ({ limit: async () => warnings }),
        });
        const replies = [];
        return {
            replies,
            options: {
                getSubcommand: () => 'list',
                getUser: () => ({ id: '2', username: 'offender', globalName: null }),
            },
            guild: { id: '1' },
            replied: false,
            reply: async payload => { replies.push(payload); },
        };
    }

    const warningsOf = (count, reason) => Array.from({ length: count }, (_, i) => ({
        caseId: 1000 + i,
        createdAt: new Date('2026-01-01T00:00:00Z'),
        reason,
    }));

    beforeEach(() => jest.clearAllMocks());

    test('twenty essay-length warnings still produce a sendable embed', async () => {
        const interaction = interactionFor(warningsOf(20, HUGE_REASON));
        await warn.execute(interaction);

        const [{ embeds: [embed] }] = interaction.replies;
        expectWithinDiscordBudgets(embed);
    });

    test('says how many of them it managed to show', async () => {
        const interaction = interactionFor(warningsOf(20, HUGE_REASON));
        await warn.execute(interaction);

        const [{ embeds: [embed] }] = interaction.replies;
        const [, shown, total] = /(\d+) of (\d+) warning/.exec(embed.data.footer.text);
        expect(Number(total)).toBe(20);
        expect(Number(shown)).toBeGreaterThan(0);
        expect(Number(shown)).toBeLessThanOrEqual(20);
        // Whole lines only — never half a warning.
        expect(embed.data.description.split('\n')).toHaveLength(Number(shown));
    });

    test('shows all of them, and says so, when they are ordinary length', async () => {
        const interaction = interactionFor(warningsOf(20, 'spamming'));
        await warn.execute(interaction);

        const [{ embeds: [embed] }] = interaction.replies;
        expect(embed.data.footer.text).toMatch(/^20 of 20 warning/);
        expect(embed.data.description.split('\n')).toHaveLength(20);
    });
});
