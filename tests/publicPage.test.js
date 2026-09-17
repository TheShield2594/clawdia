'use strict';

// #1018. The public page and player card are off by default, and the two schema
// defaults below are what "off by default" means in the database — a guild and a
// member that were written before this feature existed read as private. The
// validator half keeps the dashboard from storing a slug the route that serves
// it would never resolve.

const Guild = require('../src/models/Guild');
const User = require('../src/models/User');
const { validatePublicPageUpdate, isAllowedSettingKey } = require('../src/dashboard/routes/api/settings');

describe('the public page is off by default', () => {
    test('a fresh guild has its public page disabled and every board unticked', () => {
        const guild = new Guild({ guildId: '1', name: 'Test' });
        expect(guild.publicPage.enabled).toBe(false);
        expect(guild.publicPage.slug).toBeNull();
        expect(guild.publicPage.leaderboards.level).toBe(false);
        expect(guild.publicPage.leaderboards.wealth).toBe(false);
        expect(guild.publicPage.leaderboards.streak).toBe(false);
        expect(guild.publicPage.leaderboards.achievements).toBe(false);
        // The server-wide sections default on — none of them names an opted-out
        // member — but only ever show once the page itself is enabled.
        expect(guild.publicPage.showChampions).toBe(true);
        expect(guild.publicPage.showEvent).toBe(true);
        expect(guild.publicPage.showDistricts).toBe(true);
    });

    test('a fresh member has their public profile disabled', () => {
        const user = new User({ userId: '1', guildId: '1' });
        expect(user.publicProfile.enabled).toBe(false);
    });
});

describe('the settings endpoint accepts the publicPage keys the panel sends', () => {
    test.each([
        'publicPage.enabled',
        'publicPage.slug',
        'publicPage.leaderboards.level',
        'publicPage.leaderboards.wealth',
        'publicPage.leaderboards.streak',
        'publicPage.leaderboards.achievements',
        'publicPage.showChampions',
        'publicPage.showEvent',
        'publicPage.showDistricts',
    ])('%s is on the allow-list', (key) => {
        expect(isAllowedSettingKey(key)).toBe(true);
    });
});

describe('validatePublicPageUpdate', () => {
    test('accepts a well-formed patch', () => {
        expect(validatePublicPageUpdate({
            'publicPage.enabled': true,
            'publicPage.slug': 'my-server',
            'publicPage.leaderboards.level': true,
            'publicPage.showChampions': false,
        })).toBeNull();
    });

    test('accepts a whole-object patch', () => {
        expect(validatePublicPageUpdate({ publicPage: { enabled: true, slug: 'abc', leaderboards: { wealth: true } } })).toBeNull();
    });

    test('rejects a non-boolean toggle', () => {
        expect(validatePublicPageUpdate({ 'publicPage.enabled': 'yes' })).toMatch(/must be a boolean/);
        expect(validatePublicPageUpdate({ 'publicPage.leaderboards.level': 1 })).toMatch(/must be a boolean/);
    });

    test('rejects a malformed slug but allows clearing it', () => {
        expect(validatePublicPageUpdate({ 'publicPage.slug': 'Bad Slug!' })).toMatch(/slug/);
        expect(validatePublicPageUpdate({ 'publicPage.slug': 'ab' })).toMatch(/slug/);
        expect(validatePublicPageUpdate({ 'publicPage.slug': '' })).toBeNull();
        expect(validatePublicPageUpdate({ 'publicPage.slug': null })).toBeNull();
    });

    test('ignores unrelated keys', () => {
        expect(validatePublicPageUpdate({ 'economy.enabled': true })).toBeNull();
    });
});
