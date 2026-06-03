const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const DmSession = require('../models/DmSession');
const { getCompletion, resolveProviderConfig } = require('./aiService');
const Guild = require('../models/Guild');

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

async function startSession(interaction) {
    const { guild, channel, user } = interaction;

    const existing = await getActiveSession(guild.id, channel.id);
    if (existing) {
        return interaction.reply({ content: 'An active DM session is already running in this channel. Use `/dm stop` to end it first.', ephemeral: true });
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

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel. Use `/dm start` to begin one.', ephemeral: true });
    }

    if (session.players.length >= MAX_PLAYERS) {
        return interaction.reply({ content: `The party is full (${MAX_PLAYERS} players max).`, ephemeral: true });
    }

    if (session.players.some(p => p.userId === user.id)) {
        return interaction.reply({ content: 'You have already joined this session.', ephemeral: true });
    }

    const hp = CLASS_HP[characterClass] || 100;
    const inventory = [...(CLASS_INVENTORY[characterClass] || [])];

    session.players.push({ userId: user.id, name: characterName, characterClass, hp, inventory });
    await session.save();

    const embed = new EmbedBuilder()
        .setTitle('🧙 New Adventurer Joined!')
        .setColor('#4169e1')
        .setDescription(
            `**${characterName}** (${characterClass}) has joined the party!\n` +
            `HP: **${hp}** | Inventory: ${inventory.join(', ')}\n\n` +
            `Party size: **${session.players.length}/${MAX_PLAYERS}**`
        );

    return interaction.reply({ embeds: [embed] });
}

async function beginSession(interaction) {
    const { guild, channel, user } = interaction;

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', ephemeral: true });
    }

    if (session.hostId !== user.id) {
        return interaction.reply({ content: 'Only the session host can begin the adventure.', ephemeral: true });
    }

    if (session.players.length === 0) {
        return interaction.reply({ content: 'At least one player must join before beginning.', ephemeral: true });
    }

    if (session.storyLog.length > 0) {
        return interaction.reply({ content: 'The adventure has already begun!', ephemeral: true });
    }

    await interaction.deferReply();

    const partyDesc = session.players
        .map(p => `- **${p.name}** the ${p.characterClass} (HP: ${p.hp}, Items: ${p.inventory.join(', ')})`)
        .join('\n');

    const systemPrompt = buildDMSystemPrompt(session);
    const openingPrompt = `The party consists of:\n${partyDesc}\n\nSet the opening scene for this adventure. Introduce the setting, hint at the first challenge or mystery, and end with a clear situation requiring the party to make a decision or take action. Keep it to 2-3 paragraphs.`;

    const gs = await Guild.findOne({ guildId: guild.id });
    const aiSettings = gs?.ai || {};
    const { provider, model, apiKey, baseUrl } = resolveProviderConfig(aiSettings);

    if (provider !== 'ollama' && !apiKey) {
        return interaction.editReply('AI is not configured for this server. An admin must add an API key.');
    }

    try {
        const story = await getCompletion({ provider, model, apiKey, baseUrl, systemPrompt, history: [], prompt: openingPrompt, temperature: 0.9, maxTokens: 600 });

        session.storyLog.push(story);
        await session.save();

        const embed = new EmbedBuilder()
            .setTitle('📖 The Adventure Begins...')
            .setColor('#8b4513')
            .setDescription(story)
            .setFooter({ text: 'Use /dm action to take an action!' });

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[DM] begin error:', err.message);
        return interaction.editReply('Failed to generate the opening scene. Please try again.');
    }
}

async function takeAction(interaction) {
    const { guild, channel, user } = interaction;
    const actionText = interaction.options.getString('action');

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', ephemeral: true });
    }

    const player = session.players.find(p => p.userId === user.id);
    if (!player) {
        return interaction.reply({ content: 'You are not part of this session. Use `/dm join` first.', ephemeral: true });
    }

    if (session.storyLog.length === 0) {
        return interaction.reply({ content: 'The adventure has not begun yet. The host must use `/dm begin`.', ephemeral: true });
    }

    await interaction.deferReply();

    const recentLog = session.storyLog.slice(-8);
    const history = recentLog.map((entry, i) => ({
        role: i % 2 === 0 ? 'assistant' : 'user',
        content: entry
    }));

    const systemPrompt = buildDMSystemPrompt(session);
    const partyStatus = session.players
        .map(p => `${p.name} (${p.characterClass}, HP: ${p.hp})`)
        .join(', ');

    const prompt = `Party status: ${partyStatus}\n\n**${player.name}** (${player.characterClass}) performs the following action: ${actionText}\n\nNarrate what happens next, including any consequences, NPC reactions, or changes to the environment. End with the current situation and what the party might do next. Keep it focused and 1-2 paragraphs.`;

    const gs = await Guild.findOne({ guildId: guild.id });
    const aiSettings = gs?.ai || {};
    const { provider, model, apiKey, baseUrl } = resolveProviderConfig(aiSettings);

    if (provider !== 'ollama' && !apiKey) {
        return interaction.editReply('AI is not configured for this server.');
    }

    try {
        const narrative = await getCompletion({ provider, model, apiKey, baseUrl, systemPrompt, history, prompt, temperature: 0.9, maxTokens: 500 });

        session.storyLog.push(`${player.name}: ${actionText}`);
        session.storyLog.push(narrative);
        if (session.storyLog.length > MAX_STORY_LOG) {
            session.storyLog = session.storyLog.slice(-MAX_STORY_LOG);
        }

        // Simple damage/heal detection for immersion
        const dmgMatch = narrative.match(/takes?\s+(\d+)\s+damage/i);
        const healMatch = narrative.match(/heals?\s+(\d+)\s+hp/i);
        if (dmgMatch) {
            player.hp = Math.max(0, player.hp - parseInt(dmgMatch[1]));
        }
        if (healMatch) {
            player.hp = Math.min(CLASS_HP[player.characterClass] || 100, player.hp + parseInt(healMatch[1]));
        }

        session.markModified('players');
        await session.save();

        // Check for party wipe
        const wiped = session.players.every(p => p.hp <= 0);

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ ${player.name} acts!`)
            .setColor(wiped ? '#ff0000' : '#4169e1')
            .setDescription(narrative)
            .setFooter({ text: wiped ? 'The party has fallen...' : `Use /dm action to respond | /dm status to check party` });

        if (wiped) {
            session.active = false;
            await session.save();
            embed.addFields({ name: '💀 Session Ended', value: 'The entire party has fallen. The adventure is over.' });
        }

        return interaction.editReply({ embeds: [embed] });
    } catch (err) {
        console.error('[DM] action error:', err.message);
        return interaction.editReply('Failed to generate a response. Please try again.');
    }
}

async function partyStatus(interaction) {
    const { guild, channel } = interaction;

    const session = await getActiveSession(guild.id, channel.id);
    if (!session) {
        return interaction.reply({ content: 'No active DM session in this channel.', ephemeral: true });
    }

    if (session.players.length === 0) {
        return interaction.reply({ content: 'No players have joined yet.', ephemeral: true });
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
        return interaction.reply({ content: 'No active DM session in this channel.', ephemeral: true });
    }

    const member = interaction.member;
    const isHost = session.hostId === user.id;
    const hasPerms = member.permissions.has('ManageGuild');

    if (!isHost && !hasPerms) {
        return interaction.reply({ content: 'Only the session host or a server admin can stop the session.', ephemeral: true });
    }

    session.active = false;
    await session.save();

    const embed = new EmbedBuilder()
        .setTitle('🏁 Session Ended')
        .setColor('#808080')
        .setDescription(`The DM session has been ended by **${user.displayName || user.username}**.\n\nStory entries recorded: **${session.storyLog.length}**`)
        .setFooter({ text: 'Thanks for playing!' });

    return interaction.reply({ embeds: [embed] });
}

function buildDMSystemPrompt(session) {
    return `You are an experienced, creative Dungeon Master running a text-based RPG on Discord. Your role is to:
- Narrate vivid, engaging story scenes
- React meaningfully to player actions
- Maintain internal consistency with the established story
- Keep descriptions concise (1-3 paragraphs) to fit Discord messages
- Track and reference party members by their character names
- Create tension, atmosphere, and opportunities for heroism
- Be fair but unpredictable — success is not guaranteed
- When characters take damage or heal, mention the amount explicitly (e.g., "takes 15 damage", "heals 20 HP")
The party is playing in a classic fantasy setting. Be creative, dramatic, and fun!`;
}

module.exports = { startSession, joinSession, beginSession, takeAction, partyStatus, stopSession, CLASSES };
