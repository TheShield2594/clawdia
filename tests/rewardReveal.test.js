'use strict';

// The rewardReveal helpers are pure formatting functions — no Discord.js or DB needed.
// We mock discord.js only for the rewardReveal() async flow test.

jest.mock('discord.js', () => {
    const EmbedBuilder = jest.fn().mockImplementation(() => {
        const self = {
            setColor: jest.fn().mockReturnThis(),
            setTitle: jest.fn().mockReturnThis(),
            setDescription: jest.fn().mockReturnThis(),
            setTimestamp: jest.fn().mockReturnThis(),
            addFields: jest.fn().mockReturnThis(),
            setFooter: jest.fn().mockReturnThis(),
            data: {},
        };
        return self;
    });
    return { EmbedBuilder };
});

// Stub delay so tests don't actually wait
jest.mock('../src/utils/delay', () => ({ delay: jest.fn().mockResolvedValue(undefined) }));

const { rarityRibbon, stackBar, rewardReveal } = require('../src/utils/rewardReveal');

// ─── rarityRibbon ─────────────────────────────────────────────────────────────

describe('rarityRibbon', () => {
    test('highlights the correct tier and leaves others plain', () => {
        expect(rarityRibbon(1)).toBe('[🟢] ─ 🔵 ─ 🟣 ─ 🟡 ─ 🌌');
        expect(rarityRibbon(3)).toBe('🟢 ─ 🔵 ─ [🟣] ─ 🟡 ─ 🌌');
        expect(rarityRibbon(5)).toBe('🟢 ─ 🔵 ─ 🟣 ─ 🟡 ─ [🌌]');
    });

    test('contains exactly 5 segments separated by " ─ "', () => {
        for (let tier = 1; tier <= 5; tier++) {
            const segments = rarityRibbon(tier).split(' ─ ');
            expect(segments).toHaveLength(5);
        }
    });

    test('exactly one segment is wrapped in brackets per tier', () => {
        for (let tier = 1; tier <= 5; tier++) {
            const bracketed = rarityRibbon(tier).match(/\[.*?\]/g);
            expect(bracketed).toHaveLength(1);
        }
    });
});

// ─── stackBar ────────────────────────────────────────────────────────────────

describe('stackBar', () => {
    test('returns empty string for empty multipliers', () => {
        expect(stackBar([], 1.0, 500, '💰')).toBe('');
        expect(stackBar(null, 1.0, 500, '💰')).toBe('');
    });

    test('formats single multiplier correctly', () => {
        const result = stackBar([{ emoji: '🔥', label: '1.5x' }], 1.5, 150, '💰');
        expect(result).toBe('🔥 1.5x = **1.50x** → **+150 💰**');
    });

    test('joins multiple multipliers with ×', () => {
        const mults = [
            { emoji: '🔥', label: '7d' },
            { emoji: '🌐', label: '2x' },
            { emoji: '🐺', label: '+12%' },
        ];
        const result = stackBar(mults, 4.31, 12540, '💰');
        expect(result).toContain('🔥 7d × 🌐 2x × 🐺 +12%');
        expect(result).toContain('**4.31x**');
        expect(result).toContain('**+12,540 💰**');
    });

    test('renders emoji-only entry when label is omitted', () => {
        const mults = [{ emoji: '🍀' }, { emoji: '🌐', label: '2x' }];
        const result = stackBar(mults, 2.0, 200, '💰');
        expect(result).toContain('🍀 × 🌐 2x');
    });

    test('uses toLocaleString for large amounts', () => {
        const result = stackBar([{ emoji: '🔥', label: '3x' }], 3.0, 1000000, '💰');
        expect(result).toContain('1,000,000');
    });

    test('formats finalMult to 2 decimal places', () => {
        const result = stackBar([{ emoji: '🔥', label: '1.5x' }], 1.5, 100, '💰');
        expect(result).toContain('**1.50x**');
    });
});

// ─── rewardReveal (async flow) ────────────────────────────────────────────────

describe('rewardReveal', () => {
    let interaction;
    let resultEmbed;

    beforeEach(() => {
        interaction = {
            replied: false,
            deferred: false,
            reply: jest.fn().mockResolvedValue(undefined),
            editReply: jest.fn().mockResolvedValue(undefined),
        };
        resultEmbed = { data: { title: 'Result' } };
    });

    test('replies with suspense then edits with result', async () => {
        await rewardReveal({ interaction, resultEmbed, delayMs: 0 });

        expect(interaction.reply).toHaveBeenCalledTimes(1);
        expect(interaction.editReply).toHaveBeenCalledTimes(1);
        const editCall = interaction.editReply.mock.calls[0][0];
        expect(editCall.embeds[0]).toBe(resultEmbed);
    });

    test('uses editReply for suspense when already replied', async () => {
        interaction.replied = true;

        await rewardReveal({ interaction, resultEmbed, delayMs: 0 });

        expect(interaction.reply).not.toHaveBeenCalled();
        expect(interaction.editReply).toHaveBeenCalledTimes(2);
        const finalCall = interaction.editReply.mock.calls[1][0];
        expect(finalCall.embeds[0]).toBe(resultEmbed);
    });

    test('calls broadcast fire-and-forget after reveal', async () => {
        const broadcast = jest.fn().mockResolvedValue(undefined);

        await rewardReveal({ interaction, resultEmbed, delayMs: 0, broadcast });

        expect(broadcast).toHaveBeenCalledTimes(1);
    });
});
