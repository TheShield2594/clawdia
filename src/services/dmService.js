const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const DmSession = require('../models/DmSession');
const { getCompletion, resolveProviderConfig } = require('./aiService');
const Guild = require('../models/Guild');
const COLORS = require('../utils/embedColors');

const MAX_PLAYERS = 6;
const MAX_STORY_LOG = 20;

const CLASSES = ['Warrior', 'Mage', 'Rogue', 'Cleric', 'Ranger', 'Paladin'];
const CLASS_HP = { Warrior: 120, Mage: 70, Rogue: 90, Cleric: 100, Ranger: 95, Paladin: 110 };
const CLASS_INVENTORY = {
    Warrior: ['Longsword', 'Shield'],
    Mage: ['Staff', 'Spellbook', 'Mana Potion'],
    Rogue: ['Daggers', 'Lockpick', 'Smoke Bomb'],
    Cleric: ['Holy Symbol', 'Healing Potion x2'],
    Ranger: ['Longbow', 'Quiver', 'Hunting Knife'],
    Paladin: ['Holy Sword', 'Chainmail', 'Healing Potion']
};

function makeSessionId(guildId, channelId) {
    return `${guildId}:${channelId}`;
}

async function getActiveSession(guildId, channelId) {
    return DmSession.findOne({ guildId, channelId, active: true });
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Another creature entering the sentence. Two kinds: an article and the word
// after it ("the goblin", "a skeleton"), and — because a party member is named
// rather than introduced — the other characters in this session by name. Without
// the second kind, "Aric swings wide and Lyra takes 30 damage" charged Aric for
// Lyra's wound, since the only subject the sentence marked was his.
const ARTICLE_SUBJECT = '\\b(?:the|a|an|another|each|every)\\s+\\S+';

function otherSubjectPattern(otherNames = []) {
    const named = otherNames
        .filter(name => typeof name === 'string' && name.trim())
        .map(name => escapeRegex(name.trim()));
    return new RegExp([ARTICLE_SUBJECT, ...named].join('|'), 'gi');
}

/** The last index at which `pattern` matches before `limit`, or -1. */
function lastMatchBefore(pattern, text, limit) {
    let last = -1;
    for (const match of text.matchAll(pattern)) {
        if (match.index >= limit) break;
        last = match.index;
    }
    return last;
}

/**
 * A number the narration attributes to this character, or null.
 *
 * The scoping is what stops "your blow lands and the goblin takes 12 damage"
 * taking twelve HP off the player who swung: an unscoped regex reads any
 * "takes N damage" as theirs, and a scope that only asks whether the player is
 * mentioned somewhere earlier in the sentence reads that one as theirs too,
 * which is the same bug with more steps.
 *
 * So the subject nearest the verb wins. Whichever of "this character" and "some
 * other creature" appears last before "takes 12 damage" is who it happened to —
 * which is how the sentence reads to a person, and it holds for both orders
 * ("the goblin lunges and Aric takes 15 damage" is still Aric's).
 *
 * @param {string} narrative the model's prose
 * @param {string} namePattern the character's name, already regex-escaped
 * @param {string} verbs alternation of the verbs to look for, e.g. `takes?`
 * @param {string} unit what is being counted, e.g. `damage`
 * @param {string[]} [otherNames] the other characters in the session, who are
 *        subjects in their own right — what happens to them is not this
 *        character's, however early in the sentence this character is named
 */
function amountFor(narrative, namePattern, verbs, unit, otherNames = []) {
    const clause = new RegExp(`\\b(?:${verbs})\\s+(\\d+)\\s+${unit}\\b`, 'gi');
    // "you"/"your" as well as the name: the model writes to the acting player in
    // the second person about as often as it uses their character's name.
    const scope = new RegExp(`${namePattern}|\\byour?\\b`, 'gi');

    const others = otherSubjectPattern(otherNames);

    for (const match of narrative.matchAll(clause)) {
        const mine = lastMatchBefore(scope, narrative, match.index);
        if (mine === -1) continue;
        if (mine > lastMatchBefore(others, narrative, match.index)) {
            return parseInt(match[1], 10);
        }
    }
    return null;
}

async function startSession(interaction) {
    const { guild, channel, user } = interaction;

    const existing = await getActiveSession(guild.id, channel.id);
    if (existing) {
        return interaction.reply({ content: 'An active DM session is already running in this channel. Use `/dm stop` to end it first.', flags: MessageFlags.Ephemeral });
    }

    const sessionId = makeSessionId(guild.id, channel.id);
    await DmSession.findOneAndUpdate(
        { sessionId },
        {
            sessionId,
            guildId: guild.id,
            channelId: channel.id,
            hostId: user.id,
            players: [],
            storyLog: [],
            partyState: {},
            active: true
        },
        { upsert: true, new: true }
    );

    const embed = new EmbedBuilder()
        .setTitle('⚔️ Dungeon Master Session Started!')
        .setColor('#8b4513')
        .setDescription(
            `**${user.displayName || user.username}** has started a D&D session!\n\n` +
            `Up to **${MAX_PLAYERS} players** can join with \`/dm join\`.\n` +
            `Once ready, the host can begin the adventure with \`/dm begin\`.\n\n` +
            `Available classes: ${CLASSES.join(', ')}`
        )
        .setFooter({ text: 'Use /dm join to enter the party!' });

    return interaction.reply({ embeds: [embed] });
}

async function joinSession(interaction) {
    const { guild, channel, user } = interaction;
    const characterName = interaction.options.getString('name');
    const characterClass = interaction.options.getString('class');

    // Verify session exists first to give a useful error message
    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel. Use `/dm start` to begin one.', flags: MessageFlags.Ephemeral });
    }

    const hp = CLASS_HP[characterClass] || 100;
    const inventory = [...(CLASS_INVENTORY[characterClass] || [])];
    const newPlayer = { userId: user.id, name: characterName, characterClass, hp, inventory };

    // Atomic: only push if user not already in players AND party not full
    const updated = await DmSession.findOneAndUpdate(
        {
            sessionId: session.sessionId,
            active: true,
            'players.userId': { $ne: user.id },
            [`players.${MAX_PLAYERS - 1}`]: { $exists: false }
        },
        { $push: { players: newPlayer } },
        { new: true }
    );

    if (!updated) {
        // Re-read to give a precise error
        const current = await getActiveSession(guild.id, channel.id);
        if (!current) {
            return interaction.reply({ content: 'The session has ended.', flags: MessageFlags.Ephemeral });
        }
        if (current.players.some(p => p.userId === user.id)) {
            return interaction.reply({ content: 'You have already joined this session.', flags: MessageFlags.Ephemeral });
        }
        return interaction.reply({ content: `The party is full (${MAX_PLAYERS} players max).`, flags: MessageFlags.Ephemeral });
    }

    const embed = new EmbedBuilder()
        .setTitle('🧙 New Adventurer Joined!')
        .setColor(COLORS.INFO)
        .setDescription(
            `**${characterName}** (${characterClass}) has joined the party!\n` +
            `HP: **${hp}** | Inventory: ${inventory.join(', ')}\n\n` +
            `Party size: **${updated.players.length}/${MAX_PLAYERS}**`
        );

    return interaction.reply({ embeds: [embed] });
}

async function beginSession(interaction) {
    const { guild, channel, user } = interaction;

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', flags: MessageFlags.Ephemeral });
    }

    if (session.hostId !== user.id) {
        return interaction.reply({ content: 'Only the session host can begin the adventure.', flags: MessageFlags.Ephemeral });
    }

    if (session.players.length === 0) {
        return interaction.reply({ content: 'At least one player must join before beginning.', flags: MessageFlags.Ephemeral });
    }

    if (session.storyLog.length > 0) {
        return interaction.reply({ content: 'The adventure has already begun!', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    const partyDesc = session.players
        .map(p => `- **${p.name}** the ${p.characterClass} (HP: ${p.hp}, Items: ${p.inventory.join(', ')})`)
        .join('\n');

    const systemPrompt = buildDMSystemPrompt();
    const openingPrompt = `The party consists of:\n${partyDesc}\n\nSet the opening scene for this adventure. Introduce the setting, hint at the first challenge or mystery, and end with a clear situation requiring the party to make a decision or take action. Keep it to 2-3 paragraphs.`;

    try {
        const gs = await Guild.findOne({ guildId: guild.id });
        const aiSettings = gs?.ai || {};
        const { provider, model, apiKey, baseUrl, mcpServers, rateLimit } = resolveProviderConfig(aiSettings);

        if (provider !== 'ollama' && !apiKey) {
            return interaction.editReply('AI is not configured for this server. An admin must add an API key.');
        }

        // guildId/userId/channelId are what tie this call to the guild's usage
        // ledger and to its configured AI limits; a DM campaign is otherwise an
        // unbounded provider bill behind a slash command.
        const story = await getCompletion({
            provider, model, apiKey, baseUrl, mcpServers, rateLimit,
            guildId: guild.id, userId: interaction.user.id, channelId: interaction.channelId,
            // A narrator has no business making tool calls mid-story.
            mcp: false,
            systemPrompt, history: [], prompt: openingPrompt, temperature: 0.9, maxTokens: 600
        });

        await DmSession.findOneAndUpdate(
            { sessionId: session.sessionId },
            { $push: { storyLog: story } }
        );

        const updatedSession = await DmSession.findOne({ sessionId: session.sessionId });

        const embed = new EmbedBuilder()
            .setTitle('📖 The Adventure Begins...')
            .setColor('#8b4513')
            .setDescription(story)
            .setFooter({ text: 'Use /dm action to take an action!' });

        const storyRow = makeStoryButton(session.sessionId);
        await interaction.editReply({ embeds: [embed], components: [storyRow] });

        if (updatedSession) {
            await postOrUpdateStatCard(channel, updatedSession).catch(console.error);
        }
        return;
    } catch (err) {
        if (err?.rateLimited) return interaction.editReply(aiLimitMessage(err));
        console.error('[DM] begin error:', err.message);
        return interaction.editReply('Failed to generate the opening scene. Please try again.');
    }
}

async function takeAction(interaction) {
    const { guild, channel, user } = interaction;
    const actionText = interaction.options.getString('action');

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', flags: MessageFlags.Ephemeral });
    }

    const player = session.players.find(p => p.userId === user.id);
    if (!player) {
        return interaction.reply({ content: 'You are not part of this session. Use `/dm join` first.', flags: MessageFlags.Ephemeral });
    }

    if (session.storyLog.length === 0) {
        return interaction.reply({ content: 'The adventure has not begun yet. The host must use `/dm begin`.', flags: MessageFlags.Ephemeral });
    }

    await interaction.deferReply();

    // Roles are counted back from the end of the log, never forward from its
    // start. The log is written in exactly two places — `/dm begin` pushes the
    // opening scene, and the action below pushes the player entry and the
    // narration together in one atomic `$push` — so its last entry is always
    // the DM's, whatever has been dropped off the front.
    //
    // Counting forward assumed index 0 was still the opening scene, and the
    // `$slice: -MAX_STORY_LOG` trim on that same write breaks that assumption
    // for good: the log grows 1, 3, 5, … entries, so the first trim (at 21)
    // drops exactly one and shifts every stored index by one. From the 11th
    // action on, every history message went to the model with the wrong role —
    // player actions as `assistant`, narration as `user` — in precisely the
    // long campaigns where the history matters most (#821).
    const recentLog = session.storyLog.slice(-8);
    const history = recentLog.map((entry, i) => ({
        role: (recentLog.length - 1 - i) % 2 === 0 ? 'assistant' : 'user',
        content: entry
    }));

    const systemPrompt = buildDMSystemPrompt();
    const partyStatusLine = session.players
        .map(p => `${p.name} (${p.characterClass}, HP: ${p.hp})`)
        .join(', ');

    const prompt = `Party status: ${partyStatusLine}\n\n**${player.name}** (${player.characterClass}) performs the following action: ${actionText}\n\nNarrate what happens next, including any consequences, NPC reactions, or changes to the environment. End with the current situation and what the party might do next. Keep it focused and 1-2 paragraphs.`;

    try {
        const gs = await Guild.findOne({ guildId: guild.id });
        const aiSettings = gs?.ai || {};
        const { provider, model, apiKey, baseUrl, mcpServers, rateLimit } = resolveProviderConfig(aiSettings);

        if (provider !== 'ollama' && !apiKey) {
            return interaction.editReply('AI is not configured for this server.');
        }

        const narrative = await getCompletion({
            provider, model, apiKey, baseUrl, mcpServers, rateLimit,
            guildId: guild.id, userId: user.id, channelId: interaction.channelId,
            // A narrator has no business making tool calls mid-story.
            mcp: false,
            systemPrompt, history, prompt, temperature: 0.9, maxTokens: 500
        });

        // Scope damage/heal detection to this player by name or "you/your", and
        // away from the rest of the party, who are subjects of their own.
        const namePattern = escapeRegex(player.name);
        const otherNames = session.players
            .filter(p => p.userId !== player.userId)
            .map(p => p.name);
        const damage = amountFor(narrative, namePattern, 'takes?|suffers?', 'damage', otherNames);
        const healed = amountFor(narrative, namePattern, 'heals?|recovers?|regains?', 'hp', otherNames);

        let newHp = player.hp;
        if (damage !== null) newHp = Math.max(0, newHp - damage);
        if (healed !== null) newHp = Math.min(CLASS_HP[player.characterClass] || 100, newHp + healed);

        const playerEntry = `${player.name}: ${actionText}`;

        // Atomic write: push both log entries (with trim) and update HP if changed
        const updateOps = {
            $push: { storyLog: { $each: [playerEntry, narrative], $slice: -MAX_STORY_LOG } }
        };
        const updateOptions = {};
        if (newHp !== player.hp) {
            updateOps.$set = { 'players.$[elem].hp': newHp };
            updateOptions.arrayFilters = [{ 'elem.userId': player.userId }];
        }

        await DmSession.findOneAndUpdate(
            { sessionId: session.sessionId, active: true },
            updateOps,
            updateOptions
        );

        // Compute wipe using updated HP for this player
        const wiped = session.players.every(p =>
            p.userId === player.userId ? newHp <= 0 : p.hp <= 0
        );

        if (wiped) {
            await DmSession.findOneAndUpdate(
                { sessionId: session.sessionId },
                { $set: { active: false } }
            );
        }

        const updatedSession = await DmSession.findOne({ sessionId: session.sessionId });

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ ${player.name} acts!`)
            .setColor(wiped ? '#ff0000' : '#4169e1')
            .setDescription(narrative)
            .setFooter({ text: wiped ? 'The party has fallen...' : 'Use /dm action to respond!' });

        if (wiped) {
            embed.addFields({ name: '💀 Session Ended', value: 'The entire party has fallen. The adventure is over.' });
        }

        const components = wiped ? [] : [makeStoryButton(session.sessionId)];
        await interaction.editReply({ embeds: [embed], components });

        if (updatedSession && !wiped) {
            await postOrUpdateStatCard(channel, updatedSession).catch(console.error);
        }
        return;
    } catch (err) {
        if (err?.rateLimited) return interaction.editReply(aiLimitMessage(err));
        console.error('[DM] action error:', err.message);
        return interaction.editReply('Failed to generate a response. Please try again.');
    }
}

async function partyStatus(interaction) {
    const { guild, channel } = interaction;

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', flags: MessageFlags.Ephemeral });
    }

    if (session.players.length === 0) {
        return interaction.reply({ content: 'No players have joined yet.', flags: MessageFlags.Ephemeral });
    }

    const fields = session.players.map(p => ({
        name: `${p.name} — ${p.characterClass}`,
        value: `❤️ HP: **${p.hp}** | 🎒 ${p.inventory.join(', ') || 'Empty'}`,
        inline: false
    }));

    const embed = new EmbedBuilder()
        .setTitle('🗡️ Party Status')
        .setColor('#8b4513')
        .addFields(fields)
        .setFooter({ text: `Story entries: ${session.storyLog.length}` });

    return interaction.reply({ embeds: [embed] });
}

async function stopSession(interaction) {
    const { guild, channel, user } = interaction;

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', flags: MessageFlags.Ephemeral });
    }

    const isHost = session.hostId === user.id;
    const hasPerms = interaction.member?.permissions?.has('ManageGuild') ?? false;

    if (!isHost && !hasPerms) {
        return interaction.reply({ content: 'Only the session host or a server admin can stop the session.', flags: MessageFlags.Ephemeral });
    }

    await DmSession.findOneAndUpdate(
        { sessionId: session.sessionId },
        { $set: { active: false } }
    );

    const embed = new EmbedBuilder()
        .setTitle('🏁 Session Ended')
        .setColor(COLORS.NEUTRAL)
        .setDescription(`The DM session has been ended by **${user.displayName || user.username}**.\n\nStory entries recorded: **${session.storyLog.length}**`)
        .setFooter({ text: 'Thanks for playing!' });

    return interaction.reply({ embeds: [embed] });
}

function makeStoryButton(sessionId) {
    const row = new ActionRowBuilder();
    row.addComponents(
        new ButtonBuilder()
            .setCustomId(`dm_storysofar_${sessionId}`)
            .setLabel('📖 Story So Far')
            .setStyle(ButtonStyle.Secondary)
    );
    return row;
}

function buildStatCardEmbed(session) {
    const MAX_BAR = 10;
    const fields = session.players.map(p => {
        const maxHp = CLASS_HP[p.characterClass] || 100;
        const filled = Math.min(MAX_BAR, Math.round((Math.max(0, p.hp) / maxHp) * MAX_BAR));
        const bar = '█'.repeat(filled) + '░'.repeat(MAX_BAR - filled);
        const invLine = p.inventory.length ? p.inventory.join(', ') : 'Empty';
        return {
            name: `${p.name} — ${p.characterClass}`,
            value: `❤️ \`${bar}\` ${p.hp}/${maxHp}\n🎒 ${invLine}`,
            inline: false
        };
    });

    return new EmbedBuilder()
        .setTitle('🗡️ Party Status')
        .setColor(COLORS.NEUTRAL)
        .addFields(fields)
        .setFooter({ text: 'Updated after each action' })
        .setTimestamp();
}

async function postOrUpdateStatCard(channel, session) {
    const embed = buildStatCardEmbed(session);
    if (session.statCardMessageId) {
        try {
            const msg = await channel.messages.fetch(session.statCardMessageId);
            await msg.edit({ embeds: [embed] });
            return;
        } catch {
            // message deleted or inaccessible — post a new one
        }
    }
    const sent = await channel.send({ embeds: [embed] });
    await DmSession.findOneAndUpdate(
        { sessionId: session.sessionId },
        { $set: { statCardMessageId: sent.id } }
    );
}

async function handleDmButton(interaction, _client) {
    if (!interaction.customId.startsWith('dm_storysofar_')) return false;

    const sessionId = interaction.customId.slice('dm_storysofar_'.length);
    const session = await DmSession.findOne({ sessionId });
    if (!session || !session.active) {
        await interaction.reply({ content: 'This session is no longer active.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (session.storyLog.length === 0) {
        await interaction.reply({ content: 'The adventure has not begun yet.', flags: MessageFlags.Ephemeral });
        return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const gs = await Guild.findOne({ guildId: session.guildId });
        const aiSettings = gs?.ai || {};
        const { provider, model, apiKey, baseUrl, mcpServers, rateLimit } = resolveProviderConfig(aiSettings);

        if (provider !== 'ollama' && !apiKey) {
            return interaction.editReply('AI is not configured for this server.');
        }

        const logSnippet = session.storyLog.slice(-16).join('\n\n');
        const recap = await getCompletion({
            provider, model, apiKey, baseUrl, mcpServers, rateLimit,
            guildId: session.guildId, userId: interaction.user.id, channelId: interaction.channelId,
            // A narrator has no business making tool calls mid-story.
            mcp: false,
            systemPrompt: 'You are a dramatic fantasy narrator. Summarize the story concisely.',
            history: [],
            prompt: `Summarize the following campaign story so far as a dramatic narrator in 3-5 sentences:\n\n${logSnippet}`,
            temperature: 0.8,
            maxTokens: 300
        });

        const embed = new EmbedBuilder()
            .setTitle('📖 Story So Far...')
            .setColor('#8b4513')
            .setDescription(recap)
            .setFooter({ text: 'Only visible to you' });

        await interaction.editReply({ embeds: [embed] });
    } catch (err) {
        if (err?.rateLimited) { await interaction.editReply(aiLimitMessage(err)); return true; }
        console.error('[DM] story recap error:', err.message);
        await interaction.editReply('Failed to generate recap. Please try again.');
    }
    return true;
}

// A limit refusal is not a failure to narrate — telling the party to "try
// again" when the server's own AI budget is spent just walks them into it.
function aiLimitMessage(err) {
    return err.scope === 'channel'
        ? 'This channel has reached the server\'s AI request limit. Please wait a few minutes.'
        : `You have reached the server's AI request limit (${err.limit} per ${err.windowMin}m). Please wait a few minutes.`;
}

function buildDMSystemPrompt() {
    return `You are an experienced, creative Dungeon Master running a text-based RPG on Discord. Your role is to:
- Narrate vivid, engaging story scenes
- React meaningfully to player actions
- Maintain internal consistency with the established story
- Keep descriptions concise (1-3 paragraphs) to fit Discord messages
- Track and reference party members by their character names
- Create tension, atmosphere, and opportunities for heroism
- Be fair but unpredictable — success is not guaranteed
- When a character takes damage or heals, mention the amount explicitly with their name (e.g., "Aric takes 15 damage", "Lyra heals 20 HP")
The party is playing in a classic fantasy setting. Be creative, dramatic, and fun!`;
}

module.exports = { startSession, joinSession, beginSession, takeAction, partyStatus, stopSession, handleDmButton, CLASSES };
