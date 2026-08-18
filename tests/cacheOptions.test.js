const { Client, GatewayIntentBits, Options } = require('discord.js');
const { makeCache, sweepers, keepMemberCached } = require('../src/utils/cacheOptions');

/** Build the cache a manager would get, without needing a live client. */
function cacheFor(managerName) {
    return makeCache({ name: managerName }, null, { name: managerName });
}

describe('discord.js cache options', () => {
    it('bounds the managers that otherwise grow for the life of the process', () => {
        expect(cacheFor('GuildMemberManager').maxSize).toBe(200);
        expect(cacheFor('UserManager').maxSize).toBe(500);
        expect(cacheFor('MessageManager').maxSize).toBe(50);
        expect(cacheFor('GuildBanManager').maxSize).toBe(0);
        expect(cacheFor('PresenceManager').maxSize).toBe(0);
    });

    it('leaves the managers discord.js refuses to limit unbounded', () => {
        for (const name of ['GuildManager', 'ChannelManager', 'GuildChannelManager', 'RoleManager', 'PermissionOverwriteManager']) {
            expect(cacheFor(name).maxSize).toBeUndefined();
        }
    });

    it('evicts an ordinary member once the limit is reached but keeps the bot and timed-out members', () => {
        const cache = cacheFor('GuildMemberManager');
        const client = { user: { id: 'bot' } };
        const member = (id, disabledUntil = 0) => ({
            id, client, communicationDisabledUntilTimestamp: disabledUntil,
        });

        cache.set('bot', member('bot'));
        cache.set('muted', member('muted', Date.now() + 60_000));
        for (let i = 0; i < 300; i++) cache.set(`u${i}`, member(`u${i}`));

        expect(cache.size).toBe(200);
        expect(cache.has('bot')).toBe(true);
        expect(cache.has('muted')).toBe(true);
        expect(cache.has('u0')).toBe(false);
        expect(cache.has('u299')).toBe(true);
    });

    it('keeps the thread sweeper discord.js ships with, and adds message/member/user sweeping', () => {
        expect(sweepers.threads).toEqual(Options.DefaultSweeperSettings.threads);
        expect(sweepers.messages).toEqual({ interval: 600, lifetime: 900 });
        expect(sweepers.guildMembers.interval).toBe(3600);
        expect(sweepers.users.interval).toBe(3600);
    });

    it('never sweeps the bot itself out of the member or user caches', () => {
        const client = { user: { id: 'bot' } };
        const memberFilter = sweepers.guildMembers.filter();
        const userFilter = sweepers.users.filter();

        expect(memberFilter({ id: 'bot', client, communicationDisabledUntilTimestamp: null })).toBe(false);
        expect(memberFilter({ id: 'someone', client, communicationDisabledUntilTimestamp: null })).toBe(true);
        expect(memberFilter({ id: 'muted', client, communicationDisabledUntilTimestamp: Date.now() + 60_000 })).toBe(false);
        expect(userFilter({ id: 'bot', client })).toBe(false);
        expect(userFilter({ id: 'someone', client })).toBe(true);
    });

    it('is accepted by the Client constructor', () => {
        const client = new Client({ intents: [GatewayIntentBits.Guilds], makeCache, sweepers });
        expect(client.options.makeCache).toBe(makeCache);
        client.destroy();
    });
});

describe('keepMemberCached', () => {
    it('treats an expired timeout as sweepable', () => {
        const client = { user: { id: 'bot' } };
        expect(keepMemberCached({ id: 'x', client, communicationDisabledUntilTimestamp: Date.now() - 1000 })).toBe(false);
    });
});
