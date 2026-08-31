'use strict';

// `api/reactionRoles.js` was at 14.8% lines and 0% branches (#787). The whole
// file is a validation funnel followed by a three-step write — post the embed,
// add the reactions, store the mappings — where a failure part-way through
// leaves a panel nobody can use. Neither the funnel nor the rollback had a test.

const express = require('express');
const request = require('supertest');

jest.mock('../src/models/Guild', () => ({ findOne: jest.fn() }));
jest.mock('../src/dashboard/lib/middleware', () => ({
    checkAuth: (req, _res, next) => { req.user = { id: 'admin-1', username: 'admin' }; next(); },
    checkGuildAccess: (_req, _res, next) => next(),
    checkWriteRateLimit: (_req, _res, next) => next(),
}));

const Guild = require('../src/models/Guild');
const reactionRoles = require('../src/dashboard/routes/api/reactionRoles');

const CHANNEL_ID = '111222333444555666';
const ROLE_ID = '222333444555666777';
const MESSAGE_ID = '333444555666777888';

const mapping = (emoji, roleId = ROLE_ID) => ({ emoji, roleId });

function makeDoc(reactionRoles_ = []) {
    return { guildId: 'g1', reactionRoles: reactionRoles_, save: jest.fn(async () => {}) };
}

let bot;
let app;
let doc;
let errors;

beforeEach(() => {
    jest.clearAllMocks();
    errors = jest.spyOn(console, 'error').mockImplementation(() => {});

    bot = {
        hasGuild: jest.fn(() => true),
        hasChannel: jest.fn(() => true),
        sendEmbed: jest.fn(async () => ({ messageId: MESSAGE_ID })),
        addReactions: jest.fn(async () => {}),
        deleteMessage: jest.fn(async () => {}),
    };
    doc = makeDoc();
    Guild.findOne.mockResolvedValue(doc);

    app = express();
    app.use(express.json());
    app.use((req, _res, next) => { req.bot = bot; next(); });
    app.use('/api/v1', reactionRoles);
});

afterEach(() => errors.mockRestore());

const createPanel = body => request(app).post('/api/v1/guild/g1/reactionrole/panel').send(body);

describe('POST /guild/:guildId/reactionrole/panel', () => {
    const valid = { channelId: CHANNEL_ID, title: 'Roles', description: 'Pick one', mappings: [mapping('👍')] };

    it('posts the embed, adds the reactions and stores one mapping per row', async () => {
        const res = await createPanel(valid);

        expect(res.status).toBe(200);
        // The panel list comes back with the response so the page can redraw
        // its list in place instead of reloading (#689).
        expect(res.body).toEqual({
            success: true,
            messageId: MESSAGE_ID,
            panels: [{
                messageId: MESSAGE_ID,
                channelId: CHANNEL_ID,
                mappings: [{ emoji: '👍', roleId: ROLE_ID }],
            }],
        });

        const embed = bot.sendEmbed.mock.calls[0][2];
        expect(embed.title).toBe('Roles');
        expect(embed.description).toContain('Pick one');
        expect(embed.description).toContain(`👍 — <@&${ROLE_ID}>`);

        expect(bot.addReactions).toHaveBeenCalledWith('g1', CHANNEL_ID, MESSAGE_ID, ['👍']);
        expect(doc.reactionRoles).toEqual([
            { messageId: MESSAGE_ID, channelId: CHANNEL_ID, emoji: '👍', roleId: ROLE_ID },
        ]);
        expect(doc.save).toHaveBeenCalled();
    });

    it('falls back to a default title when none was given', async () => {
        await createPanel({ channelId: CHANNEL_ID, mappings: [mapping('👍')] });

        expect(bot.sendEmbed.mock.calls[0][2].title).toBe('React to get a role!');
    });

    it('sends a custom emoji in the name:id form the reaction API needs', async () => {
        // `<:name:id>` is how the emoji arrives from the form and how it renders
        // in the embed; the reaction endpoint takes `name:id` and nothing else.
        await createPanel({ channelId: CHANNEL_ID, mappings: [mapping('<a:party:987654321098765432>')] });

        expect(bot.addReactions).toHaveBeenCalledWith('g1', CHANNEL_ID, MESSAGE_ID, ['party:987654321098765432']);
        expect(doc.reactionRoles[0].emoji).toBe('<a:party:987654321098765432>');
    });

    it('refuses a missing channelId', async () => {
        const res = await createPanel({ mappings: [mapping('👍')] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('channelId is required');
    });

    it.each([
        ['missing', undefined],
        ['empty', []],
        ['not an array', { '👍': ROLE_ID }],
    ])('refuses mappings that are %s', async (_label, mappings) => {
        const res = await createPanel({ channelId: CHANNEL_ID, mappings });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('At least one emoji/role mapping is required');
    });

    it.each([
        ['null', null],
        ['no emoji', { roleId: ROLE_ID }],
        ['a blank emoji', mapping('   ')],
        ['a non-string emoji', mapping(42)],
        ['no roleId', { emoji: '👍' }],
        ['a blank roleId', mapping('👍', '   ')],
    ])('refuses a mapping with %s', async (_label, entry) => {
        const res = await createPanel({ channelId: CHANNEL_ID, mappings: [entry] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Each mapping must have a non-empty emoji and roleId');
    });

    it('refuses a roleId that is not a snowflake, naming it', async () => {
        const res = await createPanel({ channelId: CHANNEL_ID, mappings: [mapping('👍', 'admin')] });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid roleId: admin');
    });

    it('refuses a duplicate emoji within one panel', async () => {
        // One reaction cannot mean two roles, so the second mapping would be
        // stored and never reachable.
        const res = await createPanel({ channelId: CHANNEL_ID, mappings: [mapping('👍'), mapping(' 👍 ')] });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Duplicate emoji values are not allowed within the same panel');
    });

    it.each([
        ['a guild the bot is not in', () => bot.hasGuild.mockReturnValue(false), 'Guild not found'],
        ['a channel the bot cannot see', () => bot.hasChannel.mockReturnValue(false), 'Channel not found'],
        ['a guild with no settings document', () => Guild.findOne.mockResolvedValue(null), 'Guild settings not found'],
    ])('404s %s', async (_label, arrange, expected) => {
        arrange();

        const res = await createPanel(valid);

        expect(res.status).toBe(404);
        expect(res.body.error).toBe(expected);
        expect(bot.sendEmbed).not.toHaveBeenCalled();
    });

    it('404s when the message could not be sent', async () => {
        bot.sendEmbed.mockResolvedValue(null);

        const res = await createPanel(valid);

        expect(res.status).toBe(404);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('takes the message back down when the reactions could not be added', async () => {
        // A panel with no reactions on it is a message nobody can use, so it
        // does not get to stay up.
        bot.addReactions.mockRejectedValue(new Error('Unknown Emoji'));

        const res = await createPanel(valid);

        expect(res.status).toBe(500);
        expect(bot.deleteMessage).toHaveBeenCalledWith('g1', CHANNEL_ID, MESSAGE_ID);
        expect(doc.save).not.toHaveBeenCalled();
    });

    it('takes the message back down when the mappings could not be stored', async () => {
        doc.save.mockRejectedValue(new Error('mongo is down'));

        const res = await createPanel(valid);

        expect(res.status).toBe(500);
        expect(bot.deleteMessage).toHaveBeenCalledWith('g1', CHANNEL_ID, MESSAGE_ID);
    });
});

describe('DELETE /guild/:guildId/reactionrole/panel/:messageId', () => {
    const remove = messageId => request(app).delete(`/api/v1/guild/g1/reactionrole/panel/${messageId}`);

    it('deletes the message and every mapping that pointed at it', async () => {
        doc = makeDoc([
            { messageId: MESSAGE_ID, channelId: CHANNEL_ID, emoji: '👍', roleId: ROLE_ID },
            { messageId: MESSAGE_ID, channelId: CHANNEL_ID, emoji: '👎', roleId: ROLE_ID },
            { messageId: 'other', channelId: CHANNEL_ID, emoji: '⭐', roleId: ROLE_ID },
        ]);
        Guild.findOne.mockResolvedValue(doc);

        const res = await remove(MESSAGE_ID);

        expect(res.status).toBe(200);
        expect(bot.deleteMessage).toHaveBeenCalledWith('g1', CHANNEL_ID, MESSAGE_ID);
        expect(doc.reactionRoles.map(r => r.messageId)).toEqual(['other']);
        expect(doc.save).toHaveBeenCalled();
    });

    it('still clears the mappings when the message is already gone', async () => {
        const res = await remove(MESSAGE_ID);

        expect(res.status).toBe(200);
        expect(bot.deleteMessage).not.toHaveBeenCalled();
        expect(doc.save).toHaveBeenCalled();
    });

    it('404s a guild with no settings document', async () => {
        Guild.findOne.mockResolvedValue(null);

        expect((await remove(MESSAGE_ID)).status).toBe(404);
    });

    it('500s a failed save', async () => {
        doc.save.mockRejectedValue(new Error('mongo is down'));

        expect((await remove(MESSAGE_ID)).status).toBe(500);
    });
});
