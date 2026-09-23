'use strict';

// Built-in achievements get baked badge art under a bundle-only
// `achievement:<id>` key (assets/icons/STYLE.md). Three things have to hold:
// the catalogue only names real built-in achievements, the lookup never hands a
// built-in badge to a custom achievement that happens to reuse its id, and the
// unlock card draws the badge when one ships and the pixel trophy when not.

const { createCanvas } = require('canvas');
const { ACHIEVEMENTS } = require('../src/data/achievements');
const manifest = require('../assets/icons/manifest.json');
const iconMap = require('../assets/icons/icons.map.json');

const achievementKeys = (keys) => keys.filter(k => k.startsWith('achievement:'));

describe('the achievement badge catalogue', () => {
    const builtInIds = new Set(ACHIEVEMENTS.map(a => a.id));

    test('every manifest and map key names a built-in achievement', () => {
        const keys = [
            ...achievementKeys(manifest.map(m => m.key)),
            ...achievementKeys(Object.keys(iconMap.items)),
        ];
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) expect(builtInIds.has(key.slice('achievement:'.length))).toBe(true);
    });

    test('every generated badge has a manifest prompt, so it can be regenerated', () => {
        const prompted = new Set(achievementKeys(manifest.map(m => m.key)));
        for (const key of achievementKeys(Object.keys(iconMap.items))) expect(prompted.has(key)).toBe(true);
    });

    test('the rim is the shared tier scale the card label and embed colour use', () => {
        const { achievementTier } = require('../src/utils/achievementTier');
        for (const m of manifest.filter(e => e.key.startsWith('achievement:'))) {
            const def = ACHIEVEMENTS.find(a => `achievement:${a.id}` === m.key);
            const tier = achievementTier(def.xpReward);
            expect(m.rarity).toBe(tier.label);
            expect(m.rimHex.toUpperCase()).toBe(tier.color.toUpperCase());
        }
    });
});

describe('getAchievementArt', () => {
    let getAchievementArt, achievementArtId, getDefaultItemImage;
    const PNG = Buffer.from('badge');

    beforeEach(() => {
        jest.resetModules();
        jest.doMock('../src/utils/defaultItemImages', () => ({
            getDefaultItemImage: jest.fn(id => (id === 'achievement:level_100' ? { data: PNG, type: 'image/png' } : null)),
        }));
        ({ getDefaultItemImage } = require('../src/utils/defaultItemImages'));
        ({ getAchievementArt, achievementArtId } = require('../src/utils/achievementArt'));
    });

    afterEach(() => jest.dontMock('../src/utils/defaultItemImages'));

    test('serves the baked badge for a built-in definition', () => {
        const { ACHIEVEMENTS: defs } = require('../src/data/achievements');
        const def = defs.find(a => a.id === 'level_100');
        expect(achievementArtId('level_100')).toBe('achievement:level_100');
        expect(getAchievementArt(def)).toBe(PNG);
        expect(getDefaultItemImage).toHaveBeenCalledWith('achievement:level_100');
    });

    test('a custom achievement reusing a built-in id gets no art', () => {
        const custom = { id: 'level_100', name: 'Our Legend', description: 'x', emoji: '🏆' };
        expect(getAchievementArt(custom)).toBeNull();
        expect(getDefaultItemImage).not.toHaveBeenCalled();
    });

    test('a built-in with no badge baked yet, or no definition, returns null', () => {
        const { ACHIEVEMENTS: defs } = require('../src/data/achievements');
        expect(getAchievementArt(defs.find(a => a.id === 'chatty'))).toBeNull();
        expect(getAchievementArt(null)).toBeNull();
    });
});

describe('createAchievementCard icon slot', () => {
    const { createAchievementCard } = require('../src/utils/cardGenerator');
    const { loadImage } = require('canvas');

    // Centre of the 58px icon slot: x = 16 + 29, y = (110 - 58) / 2 + 29.
    const SLOT = { x: 45, y: 55 };

    async function slotPixel(png) {
        const img = await loadImage(png);
        const canvas = createCanvas(img.width, img.height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return [...ctx.getImageData(SLOT.x, SLOT.y, 1, 1).data];
    }

    function solidPng(rgb) {
        const c = createCanvas(32, 32);
        const ctx = c.getContext('2d');
        ctx.fillStyle = rgb;
        ctx.fillRect(0, 0, 32, 32);
        return c.toBuffer('image/png');
    }

    test('draws the badge art into the slot when given', async () => {
        const card = await createAchievementCard('Legend', 'Reach level 100', 1500, solidPng('#ff00ff'));
        expect(await slotPixel(card)).toEqual([255, 0, 255, 255]);
    });

    test('falls back to the pixel trophy with no art or unreadable art', async () => {
        const trophy = await slotPixel(await createAchievementCard('Legend', 'Reach level 100', 1500));
        expect(trophy).not.toEqual([255, 0, 255, 255]);
        const broken = await slotPixel(await createAchievementCard('Legend', 'Reach level 100', 1500, Buffer.from('not a png')));
        expect(broken).toEqual(trophy);
    });
});

describe('achievementTier', () => {
    const { achievementTier } = require('../src/utils/achievementTier');

    test('one Common→Legendary scale on the xpReward breakpoints', () => {
        const label = xp => achievementTier(xp).label;
        expect([undefined, 0, 50].map(label)).toEqual(['Common', 'Common', 'Common']);
        expect([51, 200].map(label)).toEqual(['Uncommon', 'Uncommon']);
        expect([201, 500].map(label)).toEqual(['Rare', 'Rare']);
        expect([501, 999].map(label)).toEqual(['Epic', 'Epic']);
        expect([1000, 2000].map(label)).toEqual(['Legendary', 'Legendary']);
    });
});
