'use strict';

// The /explore go result — how it reads (embeds.js), the button that follows
// it (actions.js), and the two expedition-flow fixes in go.js that are
// cheaper to pin by source than to drive through a mocked Discord client.

const fs = require('fs');
const path = require('path');

const { ensureExploreData } = require('../src/services/exploreService');
const { LIMITS, REGIONS, FOOTER_LINES } = require('../src/data/exploreData');
const {
    PITY_SHOW_AFTER, buildResultEmbed, buildSecretPityField, summarizeResult,
} = require('../src/commands/economy/explore/embeds');
const { IDS, asExploreGo, buildResultActions, routeFromCustomId } = require('../src/commands/economy/explore/actions');
const { ROUTE_LIST } = require('../src/data/exploreData');

const region = REGIONS.whispering_forest;

function makeUser() {
    const user = { balance: 10_000, inventory: [], markModified: jest.fn() };
    ensureExploreData(user);
    user.exploration.lastExplore = new Date();
    return user;
}

function quietResult(overrides = {}) {
    return { type: 'quiet', quietLine: 'Nothing.', payout: 0, grossPayout: 0, xp: 8, secretsLeft: true, ...overrides };
}

const fieldNames = embed => (embed.data.fields ?? []).map(f => f.name);

describe('the result embed', () => {
    test('names the route beside the region', () => {
        const user = makeUser();
        const embed = buildResultEmbed(quietResult({ route: 'deep' }), region, user, { currency: '🪙' });
        expect(embed.data.author.name).toContain('Deep Wilds');
    });

    test('says when a streak ends, went cold, or maxed out', () => {
        const user = makeUser();
        const broken = buildResultEmbed(quietResult({ type: 'trap', trap: region.traps[0], penalty: 10, streakBroken: 6 }), region, user, { currency: '🪙' });
        expect(broken.data.description).toMatch(/Streak over.*6-run/);
        const cooled = buildResultEmbed(quietResult({ streakCooled: 3, streak: 1 }), region, user, { currency: '🪙' });
        expect(cooled.data.description).toMatch(/went cold.*3-run/);
        const maxed = buildResultEmbed(quietResult({ streak: LIMITS.STREAK_MAX }), region, user, { currency: '🪙' });
        expect(maxed.data.description).toMatch(/Trail sense maxed/);
        const plain = buildResultEmbed(quietResult({ streak: 3 }), region, user, { currency: '🪙' });
        expect(plain.data.description).not.toMatch(/Streak|Trail sense|went cold/);
    });

    test('the haul line credits the route and the streak on a paying run', () => {
        const user = makeUser();
        const embed = buildResultEmbed(quietResult({ type: 'treasure', payout: 300, grossPayout: 300, route: 'deep', streakBonus: 0.06,
            treasureTier: { tier: 'common', stars: '⭐' }, treasureLine: 'Coins.' }), region, user, { currency: '🪙' });
        const haul = embed.data.fields.find(f => f.name === '🎒 The Haul').value;
        expect(haul).toMatch(/deep wilds \+30%/);
        expect(haul).toMatch(/streak \+6%/);
    });

    test('stays quiet about the secret curve until a drought is worth mentioning', () => {
        const user = makeUser();
        user.exploration.sinceSecret = PITY_SHOW_AFTER - 1;
        expect(buildSecretPityField(user, region, null)).toBeNull();
        user.exploration.sinceSecret = PITY_SHOW_AFTER;
        expect(buildSecretPityField(user, region, null)?.name).toMatch(/Overdue/);
    });

    test('an anomaly is titled and summarised as one, not as a landmark', () => {
        const user = makeUser();
        const anomaly = region.anomalies[0];
        const result = { type: 'discovery', anomaly, payout: 500, grossPayout: 500, xp: 30 };
        const embed = buildResultEmbed(result, region, user, { currency: '🪙' });
        expect(embed.data.title).toContain(anomaly.name);
        expect(embed.data.title).toMatch(/Anomaly/);
        expect(summarizeResult(result, '🪙')).toBe(`Investigated ${anomaly.name}`);
    });

    test('a timed-out encounter says the ferns decided', () => {
        const user = makeUser();
        const enc = region.encounters[0];
        const result = { type: 'encounter', encounter: enc, outcome: 'safe', hesitated: true, payout: 100, grossPayout: 100, xp: 15 };
        expect(buildResultEmbed(result, region, user, { currency: '🪙' }).data.description).toMatch(/You hesitated/);
        result.hesitated = false;
        expect(buildResultEmbed(result, region, user, { currency: '🪙' }).data.description).not.toMatch(/You hesitated/);
    });

    test('names the injury in the configured duration', () => {
        const user = makeUser();
        const result = { type: 'trap', trap: region.traps[0], injured: true, penalty: 100, payout: 0, grossPayout: 0, xp: 10 };
        const minutes = Math.round(LIMITS.INJURY_PENALTY_MS / 60_000);
        expect(buildResultEmbed(result, region, user, { currency: '🪙' }).data.description).toContain(`(${minutes} min)`);
    });

    test('a find whose bookkeeping did not save says so', () => {
        const user = makeUser();
        const embed = buildResultEmbed(quietResult(), region, user, { currency: '🪙', unsaved: true });
        expect(fieldNames(embed)).toContain('⚠️ Not Everything Was Written Down');
    });

    test('a routine run carries its setting-out line, a staged one does not repeat it', () => {
        const user = makeUser();
        const withIntro = buildResultEmbed(quietResult(), region, user, { currency: '🪙', intro: 'Off we go.' });
        expect(withIntro.data.description.startsWith('-# Off we go.')).toBe(true);
        const without = buildResultEmbed(quietResult(), region, user, { currency: '🪙' });
        expect(without.data.description).not.toContain('-#');
    });

    test('the weekly leader shows only on a run that entered the race', () => {
        const user = makeUser();
        const weeklyLeader = { username: 'Rover', total: 5_000 };
        const paying = buildResultEmbed(quietResult({ type: 'treasure', payout: 300, grossPayout: 300,
            treasureTier: { tier: 'common', stars: '⭐' }, treasureLine: 'Coins.' }), region, user, { currency: '🪙', weeklyLeader });
        expect(paying.data.footer.text).toContain('Rover');

        const quiet = buildResultEmbed(quietResult(), region, user, { currency: '🪙', weeklyLeader });
        expect(quiet.data.footer.text).not.toContain('Rover');
        expect(FOOTER_LINES.some(line => quiet.data.footer.text.includes(line))).toBe(true);
    });

    test('standing bonuses ride the haul on a paying run and nowhere else', () => {
        const user = makeUser();
        const paying = buildResultEmbed(quietResult({ type: 'treasure', payout: 300, grossPayout: 300, featured: true,
            treasureTier: { tier: 'common', stars: '⭐' }, treasureLine: 'Coins.' }), region, user, { currency: '🪙' });
        const haul = paying.data.fields.find(f => f.name === '🎒 The Haul');
        expect(haul.value).toMatch(/featured \+25%/);
        expect(fieldNames(paying)).not.toContain('📈 Standing Bonuses');

        const quiet = buildResultEmbed(quietResult({ featured: true }), region, user, { currency: '🪙' });
        expect(quiet.data.fields.find(f => f.name === '🎒 The Haul').value).not.toMatch(/featured/);
    });
});

describe('the route buttons', () => {
    test('one per route, with the route just taken highlighted', () => {
        const [row] = buildResultActions('deep');
        expect(row.components).toHaveLength(ROUTE_LIST.length);
        for (const [i, route] of ROUTE_LIST.entries()) {
            const button = row.components[i];
            expect(button.data.custom_id).toBe(IDS[route.id]);
            expect(button.data.label).toContain(route.name);
            // ButtonStyle.Primary is 1, Secondary 2
            expect(button.data.style).toBe(route.id === 'deep' ? 1 : 2);
        }
    });

    test('a button id maps back to its route and nothing else does', () => {
        for (const route of ROUTE_LIST) expect(routeFromCustomId(IDS[route.id])).toBe(route.id);
        expect(routeFromCustomId('explore_act_route_nowhere')).toBeNull();
        expect(routeFromCustomId('explore_123_approach')).toBeNull();
        expect(routeFromCustomId(undefined)).toBeNull();
    });

    test('runs /explore go in the same region, by the pressed route, through the command\'s own options', () => {
        const button = { id: 'b1', user: { id: 'u1' }, reply: jest.fn(function () { return this.id; }) };
        const dressed = asExploreGo(button, { region: 'crystal_caves', route: 'offpath' });
        expect(dressed.commandName).toBe('explore');
        expect(dressed.options.getSubcommand()).toBe('go');
        expect(dressed.options.getString('region')).toBe('crystal_caves');
        expect(dressed.options.getString('route')).toBe('offpath');
        expect(dressed.options.getString('type')).toBeNull();
        // Everything else is the button's own, bound to it.
        expect(dressed.user.id).toBe('u1');
        expect(dressed.reply()).toBe('b1');
    });
});

describe('the expedition flow', () => {
    const go = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'economy', 'explore', 'go.js'), 'utf8');

    test('an encounter click resolves the choice before acknowledging it', () => {
        // Awaiting deferUpdate first hung the expedition — with the player's
        // economy lock held — whenever the acknowledgement threw: the collector
        // had already ended on 'limit', so nothing else resolved the promise.
        expect(go).not.toMatch(/await i\.deferUpdate\(\)/);
        const collect = go.slice(go.indexOf("col.on('collect'"));
        expect(collect.indexOf('resolve(')).toBeLessThan(collect.indexOf('i.deferUpdate()'));
        expect(collect).toMatch(/i\.deferUpdate\(\)\.catch\(/);
    });

    test('a failed second save keeps a paid find on screen instead of wiping it', () => {
        const failure = go.slice(go.indexOf("if (!isVersionError(err)) console.error('[explore] save error:'"));
        expect(failure).toMatch(/unsaved = true/);
        expect(go).not.toMatch(/Something went wrong writing your expedition down\. Try again\.', embeds: \[\]/);
    });

    test('the result carries the route buttons', () => {
        expect(go).toMatch(/components: buildResultActions\(result\.route\)/);
        expect(go).toMatch(/attachResultActions\(interaction, resultMessage/);
        expect(go).toMatch(/return \{ started: true \}/);
    });

    test('no roll reaches for Math.random', () => {
        expect(go).not.toMatch(/Math\.random/);
    });
});
