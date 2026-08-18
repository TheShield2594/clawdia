const { Client, GatewayIntentBits, Options } = require('discord.js');
const { makeCache, sweepers, keepMemberCached } = require('../src/utils/cacheOptions');

const client = { user: { id: 'bot' } };
const member = (id, disabledUntil = 0) => ({ id, client, communicationDisabledUntilTimestamp: disabledUntil });
const timedOut = id => member(id, Date.now() + 60_000);

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

    it('evicts ordinary members once the limit is reached but keeps the bot', () => {
        const cache = cacheFor('GuildMemberManager');

        cache.set('bot', member('bot'));
        for (let i = 0; i < 300; i++) cache.set(`u${i}`, member(`u${i}`));

        expect(cache.size).toBe(200);
        expect(cache.has('bot')).toBe(true);
        expect(cache.has('u0')).toBe(false);
        expect(cache.has('u299')).toBe(true);
    });

    it('holds the member limit even when every member is serving a timeout', () => {
        // A keepOverLimit that can spare an unbounded number of members turns
        // the limit into a suggestion: LimitedCollection inserts whether or not
        // its scan found something to drop, so a guild timing out more members
        // than the cache holds would grow past it without this.
        const cache = cacheFor('GuildMemberManager');

        cache.set('bot', member('bot'));
        for (let i = 0; i < 300; i++) cache.set(`u${i}`, timedOut(`u${i}`));

        expect(cache.size).toBe(200);
        expect(cache.has('bot')).toBe(true);
    });

    it('keeps the thread sweeper discord.js ships with, and adds message/member/user sweeping', () => {
        expect(sweepers.threads).toEqual(Options.DefaultSweeperSettings.threads);
        expect(sweepers.messages).toEqual({ interval: 600, lifetime: 900 });
        expect(sweepers.guildMembers.interval).toBe(3600);
        expect(sweepers.users.interval).toBe(3600);
    });

    it('sweeps ordinary members but not the bot or anyone serving a timeout', () => {
        const memberFilter = sweepers.guildMembers.filter();
        const userFilter = sweepers.users.filter();

        expect(memberFilter(member('bot'))).toBe(false);
        expect(memberFilter(member('someone'))).toBe(true);
        expect(memberFilter(timedOut('muted'))).toBe(false);
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
        expect(keepMemberCached(member('x', Date.now() - 1000))).toBe(false);
    });
});
