'use strict';

// The layout tools: reading a server's channels, and changing them as one
// approved plan.
//
// The approval buttons are answerable by whoever asked, so they are not the
// permission. What is pinned hardest here is that every step checks the asker
// again — a member with Manage Channels cannot use the bot to grant a
// permission they lack, post somewhere they cannot, or touch a role above them.

const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const {
    buildLayoutTools, applyLayout, reviewLayout, previewPlan, validatePlan, MAX_OPERATIONS
} = require('../src/services/ai/serverLayout');
const { buildBotTools } = require('../src/services/ai/botTools');

jest.mock('../src/models/User', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn(), updateOne: jest.fn() }));

const ALL = Object.keys(PermissionFlagsBits);

/** A permission set holding exactly these flags (names), or everything. */
function perms(names = ALL) {
    const set = new Set(names);
    return { has: flag => [...set].some(name => PermissionFlagsBits[name] === flag) };
}

function makeChannel(guild, { id, name, type = ChannelType.GuildText, parentId = null, position = 0, topic = null, memberPerms }) {
    const channel = {
        id, name, type, parentId, rawPosition: position, topic, nsfw: false, rateLimitPerUser: 0,
        isThread: () => false,
        permissionsFor: () => perms(memberPerms ?? guild.__memberPerms),
        permissionOverwrites: {
            cache: new Map(),
            edit: jest.fn(async () => {}),
            delete: jest.fn(async () => {})
        },
        edit: jest.fn(async function edit(changes) {
            if (changes.name) channel.name = changes.name;
            return channel;
        }),
        delete: jest.fn(async () => { guild.channels.cache.delete(id); }),
        send: type === ChannelType.GuildCategory ? undefined : jest.fn(async () => ({ id: 'msg1' }))
    };
    guild.channels.cache.set(id, channel);
    return channel;
}

function fakeGuild({ memberPerms = ALL, ownerId = 'owner', highestRole = 10 } = {}) {
    let nextId = 900000000000000000n;
    const guild = {
        id: '100000000000000000',
        name: 'Test Server',
        ownerId,
        systemChannelId: null,
        __memberPerms: memberPerms,
        channels: { cache: new Map() },
        roles: { cache: new Map() },
        members: { fetch: jest.fn(async () => null) },
        edit: jest.fn(async () => {})
    };
    guild.channels.create = jest.fn(async options => {
        const id = String(nextId++);
        return makeChannel(guild, { id, name: options.name, type: options.type, parentId: options.parent ?? null });
    });
    guild.roles.everyone = { id: guild.id, name: '@everyone', position: 0 };
    guild.roles.cache.set(guild.id, guild.roles.everyone);
    guild.roles.create = jest.fn(async options => ({ id: String(nextId++), name: options.name }));

    const role = (id, name, position, extra = {}) => {
        const r = { id, name, position, managed: false, edit: jest.fn(async () => {}), ...extra };
        guild.roles.cache.set(id, r);
        return r;
    };
    guild.__roles = {
        mod: role('200000000000000001', 'Mod', 5),
        admin: role('200000000000000002', 'Admin', 20),
        bot: role('200000000000000003', 'Bot', 3, { managed: true })
    };

    const member = {
        id: 'asker',
        guild,
        permissions: perms(memberPerms),
        roles: { highest: { position: highestRole } }
    };

    const general = makeChannel(guild, { id: '300000000000000001', name: 'general', position: 0, topic: 'chat' });
    const lounge = makeChannel(guild, { id: '300000000000000002', name: 'Lounge', type: ChannelType.GuildCategory, position: 1 });
    const voice = makeChannel(guild, { id: '300000000000000003', name: 'hangout', type: ChannelType.GuildVoice, parentId: lounge.id });
    const memes = makeChannel(guild, { id: '300000000000000004', name: 'memes', parentId: lounge.id });

    const message = {
        author: { id: 'asker', username: 'asker' },
        member,
        guild,
        channel: general
    };
    return { guild, member, message, channels: { general, lounge, voice, memes } };
}

describe('who is offered the tools', () => {
    test('nobody without Manage Channels', () => {
        const { message } = fakeGuild({ memberPerms: ['ViewChannel', 'SendMessages'] });
        expect(buildLayoutTools(message, () => ({}))).toEqual([]);
        expect(buildBotTools(message).map(tool => tool.name)).not.toContain('apply_layout');
    });

    test('a member with Manage Channels gets the review and the plan', () => {
        const { message } = fakeGuild({ memberPerms: ['ManageChannels'] });
        const tools = buildBotTools(message);
        const review = tools.find(tool => tool.name === 'review_server_layout');
        const apply = tools.find(tool => tool.name === 'apply_layout');

        expect(review.confirm).toBe(false);
        expect(review.annotations.readOnlyHint).toBe(true);
        expect(apply.confirm).toBe(true);
        expect(apply.annotations.destructiveHint).toBe(true);
        expect(typeof apply.preview).toBe('function');
    });
});

describe('reviewing the layout', () => {
    test('lists categories, channels and roles with their ids', () => {
        const { message } = fakeGuild();
        const text = reviewLayout({}, message);

        expect(text).toMatch(/Server "Test Server"/);
        expect(text).toMatch(/#general \(text, 300000000000000001\).*chat/);
        expect(text).toMatch(/Category "Lounge" \(300000000000000002\)/);
        // Text before voice inside a category, the way the sidebar shows it.
        expect(text.indexOf('#memes')).toBeLessThan(text.indexOf('#hangout'));
        expect(text).toMatch(/@Admin.*@Mod/);
    });

    test('marks a channel @everyone cannot see as private', () => {
        const { message, guild, channels } = fakeGuild();
        channels.memes.permissionOverwrites.cache.set(guild.id, {
            id: guild.id,
            allow: 0n,
            deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel)
        });
        expect(reviewLayout({}, message)).toMatch(/#memes .*\[private\]/);
    });

    test('shows one channel\'s overwrites when asked for it', () => {
        const { message, guild, channels } = fakeGuild();
        channels.memes.permissionOverwrites.cache.set(guild.__roles.mod.id, {
            id: guild.__roles.mod.id,
            allow: PermissionFlagsBits.ManageMessages,
            deny: 0n
        });
        const text = reviewLayout({ channel: 'memes' }, message);
        expect(text).toMatch(/In category "Lounge"/);
        expect(text).toMatch(/@Mod: allow ManageMessages/);
    });
});

describe('the plan', () => {
    test('is refused whole when a step is malformed, before anything changes', async () => {
        const { message, guild } = fakeGuild();
        const text = await applyLayout({
            summary: 'x',
            operations: [
                { action: 'create_category', name: 'Info' },
                { action: 'set_permissions', channel: 'general', target: '@everyone', allow: ['FlyToTheMoon'] }
            ]
        }, message);

        expect(text).toMatch(/nothing was changed/);
        expect(text).toMatch(/FlyToTheMoon/);
        expect(guild.channels.create).not.toHaveBeenCalled();
    });

    test('has a ceiling', () => {
        const operations = Array.from({ length: MAX_OPERATIONS + 1 }, () => ({ action: 'create_category', name: 'x' }));
        expect(validatePlan({ operations })).toMatch(/Split it in two/);
    });

    test('creates a category and puts new channels in it by name', async () => {
        const { message, guild } = fakeGuild();
        const text = await applyLayout({
            summary: 'Info section',
            operations: [
                { action: 'create_category', name: 'Info' },
                { action: 'create_channel', name: 'rules', category: 'Info', topic: 'Read me' },
                { action: 'create_channel', name: 'Stage', type: 'stage', category: 'info' }
            ]
        }, message);

        expect(text).toMatch(/All 3 steps were applied/);
        const [category] = guild.channels.create.mock.calls[0];
        expect(category.type).toBe(ChannelType.GuildCategory);
        const created = [...guild.channels.cache.values()].find(channel => channel.name === 'Info');
        expect(guild.channels.create.mock.calls[1][0]).toEqual(expect.objectContaining({
            name: 'rules', type: ChannelType.GuildText, parent: created.id, topic: 'Read me'
        }));
        // A stage channel takes no topic, and gets none.
        expect(guild.channels.create.mock.calls[2][0]).toEqual(expect.objectContaining({ type: ChannelType.GuildStageVoice }));
    });

    test('moves, renames and reorders an existing channel', async () => {
        const { message, channels } = fakeGuild();
        const text = await applyLayout({
            summary: 'tidy',
            operations: [{ action: 'edit_channel', channel: '#general', name: 'chat', category: 'Lounge', position: 0, sync_permissions: true }]
        }, message);

        expect(text).toMatch(/✅/);
        expect(channels.general.edit).toHaveBeenCalledWith(expect.objectContaining({
            name: 'chat', parent: channels.lounge.id, position: 0, lockPermissions: true
        }));
    });

    test('carries on past a failed step and reports each one', async () => {
        const { message, guild } = fakeGuild();
        const text = await applyLayout({
            summary: 'mixed',
            operations: [
                { action: 'edit_channel', channel: 'does-not-exist', name: 'x' },
                { action: 'create_category', name: 'Info' }
            ]
        }, message);

        expect(text).toMatch(/1 of 2 steps were applied/);
        expect(text).toMatch(/1\. ❌ .*no channel named "does-not-exist"/);
        expect(text).toMatch(/2\. ✅ created category/);
        expect(guild.channels.create).toHaveBeenCalled();
    });

    test('refuses a name two channels share rather than guessing', async () => {
        const { message, guild } = fakeGuild();
        makeChannel(guild, { id: '300000000000000009', name: 'memes' });
        const text = await applyLayout({ summary: 'x', operations: [{ action: 'delete_channel', channel: 'memes' }] }, message);
        expect(text).toMatch(/2 channels are named "memes"/);
    });

    test('will not delete the channel the conversation is in', async () => {
        const { message, channels } = fakeGuild();
        const text = await applyLayout({ summary: 'x', operations: [{ action: 'delete_channel', channel: 'general' }] }, message);
        expect(text).toMatch(/will not delete it/);
        expect(channels.general.delete).not.toHaveBeenCalled();
    });

    test('says when Discord refused the bot, not the user', async () => {
        const { message, channels } = fakeGuild();
        channels.memes.edit.mockRejectedValueOnce(new Error('Missing Permissions'));
        const text = await applyLayout({ summary: 'x', operations: [{ action: 'edit_channel', channel: 'memes', topic: 'hi' }] }, message);
        expect(text).toMatch(/the bot is missing the Discord permission/);
    });
});

describe('every step answers to the person who asked', () => {
    test('they cannot grant a permission they do not hold', async () => {
        const { message, channels } = fakeGuild({ memberPerms: ['ManageChannels', 'ManageRoles', 'ViewChannel'] });
        const text = await applyLayout({
            summary: 'x',
            operations: [{ action: 'set_permissions', channel: 'memes', target: 'Mod', allow: ['ViewChannel', 'BanMembers'] }]
        }, message);

        expect(text).toMatch(/you do not have BanMembers there yourself/);
        expect(channels.memes.permissionOverwrites.edit).not.toHaveBeenCalled();
    });

    test('an overwrite they could set by hand goes through, loosely spelled', async () => {
        const { message, guild, channels } = fakeGuild();
        const text = await applyLayout({
            summary: 'private mod room',
            operations: [
                { action: 'set_permissions', channel: 'memes', target: '@everyone', deny: ['view channel'] },
                { action: 'set_permissions', channel: 'memes', target: 'Mod', allow: ['ViewChannel', 'send_messages'] }
            ]
        }, message);

        expect(text).toMatch(/All 2 steps/);
        expect(channels.memes.permissionOverwrites.edit).toHaveBeenNthCalledWith(1, guild.id, { ViewChannel: false }, expect.anything());
        expect(channels.memes.permissionOverwrites.edit).toHaveBeenNthCalledWith(
            2, guild.__roles.mod.id, { ViewChannel: true, SendMessages: true }, expect.anything()
        );
    });

    test('they cannot post somewhere they cannot post themselves', async () => {
        const { message, channels } = fakeGuild();
        channels.memes.permissionsFor = () => perms(['ManageChannels', 'ViewChannel']);
        const text = await applyLayout({ summary: 'x', operations: [{ action: 'post_message', channel: 'memes', content: 'hi' }] }, message);

        expect(text).toMatch(/you need Send Messages in #memes/);
        expect(channels.memes.send).not.toHaveBeenCalled();
    });

    test('a post pings only what they could have pinged', async () => {
        const { message, channels } = fakeGuild();
        channels.memes.permissionsFor = () => perms(['ViewChannel', 'SendMessages']);
        await applyLayout({ summary: 'x', operations: [{ action: 'post_message', channel: 'memes', content: '@everyone hello' }] }, message);
        expect(channels.memes.send).toHaveBeenCalledWith({ content: '@everyone hello', allowedMentions: { parse: ['users'] } });
    });

    test('server settings need Manage Server', async () => {
        const { message, guild } = fakeGuild({ memberPerms: ['ManageChannels'] });
        const text = await applyLayout({ summary: 'x', operations: [{ action: 'edit_server', name: 'New' }] }, message);
        expect(text).toMatch(/you need Manage Server/);
        expect(guild.edit).not.toHaveBeenCalled();
    });

    test('a role above them is out of reach, and a new role gets no permissions', async () => {
        const { message, guild } = fakeGuild({ highestRole: 10 });
        const text = await applyLayout({
            summary: 'roles',
            operations: [
                { action: 'edit_role', role: 'Admin', color: '#ff0000' },
                { action: 'edit_role', role: 'Mod', color: '#00ff00', hoist: true },
                { action: 'create_role', name: 'Artists', color: '5865F2' }
            ]
        }, message);

        expect(text).toMatch(/1\. ❌ .*@Admin is not below your highest role/);
        expect(guild.__roles.admin.edit).not.toHaveBeenCalled();
        expect(guild.__roles.mod.edit).toHaveBeenCalledWith(expect.objectContaining({ color: 0x00ff00, hoist: true }));
        expect(guild.roles.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Artists', permissions: [], color: 0x5865f2 }));
    });
});

describe('the approval preview', () => {
    test('says the plan in words, and warns about deletes', () => {
        const text = previewPlan({
            summary: 'Reorganise',
            operations: [
                { action: 'create_category', name: 'Info' },
                { action: 'delete_channel', channel: 'old-stuff' },
                { action: 'post_message', channel: 'announcements', content: 'New layout!\nEnjoy' }
            ]
        });
        expect(text).toMatch(/\*\*Plan:\*\* Reorganise/);
        expect(text).toMatch(/1\. ➕ Create category "Info"/);
        expect(text).toMatch(/2\. 🗑️ \*\*Delete\*\* "old-stuff"/);
        expect(text).toMatch(/3\. 💬 Post in "announcements": "New layout! Enjoy"/);
        expect(text).toMatch(/⚠️ 1 channel will be deleted/);
    });

    test('shows up in the approval prompt in place of the JSON', async () => {
        const { createToolConfirmer } = require('../src/services/ai/mcp/approval');
        const prompt = { awaitMessageComponent: jest.fn(async () => { throw new Error('time'); }), edit: jest.fn(async () => {}) };
        const send = jest.fn(async () => prompt);
        const confirm = createToolConfirmer({ author: { id: 'asker' }, channel: { send } }, { timeoutMs: 1 });

        await confirm({ server: 'clawdia', tool: 'apply_layout', args: { summary: 's', operations: [] }, preview: '1. ➕ Create category "Info"' });
        const { content } = send.mock.calls[0][0];
        expect(content).toMatch(/1\. ➕ Create category "Info"/);
        expect(content).not.toMatch(/```json/);
    });
});

describe('through the toolkit', () => {
    const { prepareMcpToolkit } = require('../src/services/ai/mcp/toolkit');

    test('the approval prompt is handed the plan in words, and a no changes nothing', async () => {
        const { message, guild } = fakeGuild();
        const confirmTool = jest.fn(async () => ({ approved: false }));
        const toolkit = await prepareMcpToolkit([], { botTools: buildBotTools(message), confirmTool, botToolsOnly: true });

        const result = await toolkit.call('apply_layout', {
            summary: 'Add info', operations: [{ action: 'create_category', name: 'Info' }]
        });

        expect(confirmTool).toHaveBeenCalledWith(expect.objectContaining({
            tool: 'apply_layout',
            preview: expect.stringMatching(/Create category "Info"/)
        }));
        expect(result).toMatch(/declined/);
        expect(guild.channels.create).not.toHaveBeenCalled();
    });

    test('the review runs without asking', async () => {
        const { message } = fakeGuild();
        const confirmTool = jest.fn();
        const toolkit = await prepareMcpToolkit([], { botTools: buildBotTools(message), confirmTool, botToolsOnly: true });

        expect(await toolkit.call('review_server_layout', {})).toMatch(/Server "Test Server"/);
        expect(confirmTool).not.toHaveBeenCalled();
    });
});
