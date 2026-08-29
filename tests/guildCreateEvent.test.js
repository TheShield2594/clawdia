'use strict';

// Joining a guild is the one moment the bot writes a Guild document from
// nothing. Everything downstream — every panel, every `getGuildSettings` read,
// the whole shop — assumes that document exists, so the handler that creates it
// had no test at all.

jest.mock('../src/models/Guild', () => ({ create: jest.fn() }));
jest.mock('../src/data/defaultShopItems', () => ({ ensureDefaultShopItems: jest.fn() }));

const Guild = require('../src/models/Guild');
const { ensureDefaultShopItems } = require('../src/data/defaultShopItems');

const guildCreate = require('../src/events/guildCreate');

const guild = { id: '111222333444555666', name: 'Cool Server' };

let logs;
let errors;

function makeDoc() {
    return { guildId: guild.id, name: guild.name, shop: [], save: jest.fn().mockResolvedValue(undefined) };
}

beforeEach(() => {
    jest.clearAllMocks();
    logs = jest.spyOn(console, 'log').mockImplementation(() => {});
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    logs.mockRestore();
    errors.mockRestore();
});

it('is registered for the gateway event it handles', () => {
    expect(guildCreate.name).toBe('guildCreate');
});

it('creates the guild document keyed by the Discord id', async () => {
    Guild.create.mockResolvedValue(makeDoc());
    ensureDefaultShopItems.mockReturnValue(false);

    await guildCreate.execute(guild, {});

    expect(Guild.create).toHaveBeenCalledWith({ guildId: guild.id, name: guild.name });
});

it('seeds the default shop and saves, when seeding changed anything', async () => {
    const doc = makeDoc();
    Guild.create.mockResolvedValue(doc);
    ensureDefaultShopItems.mockReturnValue(true);

    await guildCreate.execute(guild, {});

    expect(ensureDefaultShopItems).toHaveBeenCalledWith(doc);
    expect(doc.save).toHaveBeenCalled();
});

it('does not write a second time when seeding changed nothing', async () => {
    const doc = makeDoc();
    Guild.create.mockResolvedValue(doc);
    ensureDefaultShopItems.mockReturnValue(false);

    await guildCreate.execute(guild, {});

    expect(doc.save).not.toHaveBeenCalled();
});

it('logs a failed create rather than rejecting into the gateway', async () => {
    // A duplicate key from a re-join, or mongo being down. The bot is in the
    // guild either way, so throwing here would only turn a missing document
    // into a crash.
    Guild.create.mockRejectedValue(new Error('E11000 duplicate key'));

    await expect(guildCreate.execute(guild, {})).resolves.toBeUndefined();

    expect(errors).toHaveBeenCalledWith('Error in guildCreate:', expect.any(Error));
});
