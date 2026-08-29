const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const DmSession = require('../models/DmSession');
const { getCompletion, resolveProviderConfig } = require('./aiService');
const Guild = require('../models/Guild');
const COLORS = require('../utils/embedColors');
const { extractEffects, applyEffects, effectsInstruction } = require('./dm/effects');
const { proseEffects } = require('./dm/prose');
const { diceTool, describe: describeRoll } = require('./dm/dice');
const { withTurn } = require('./dm/turnLock');

const MAX_PLAYERS = 6;
const MAX_STORY_LOG = 20;

// Discord's own ceiling on an embed field. The rolls and the effect log are
// both lists of unknown length, so both are cut to fit rather than trusted.
const MAX_FIELD_CHARS = 1024;

/**
 * The AI Dungeon Master: one persistent D&D session per channel, backed by the
 * `DmSession` document rather than by memory, so a restart mid-adventure loses
 * nothing.
 *
 * The `/dm` subcommand handlers — `startSession`, `joinSession`,
 * `beginSession`, `takeAction`, `partyStatus` and `stopSession` — each own
 * their interaction end to end: they reply or defer themselves, so a caller
 * must not have replied first, and they resolve to whatever the reply resolved
 * to rather than to anything worth reading.
 *
 * `handleDmButton` is the exception, and is not a subcommand handler at all: it
 * is a button router entry, and its boolean result is the whole point — see its
 * own note below.
 *
 * A session is keyed on `guildId:channelId`, so two channels can run their own
 * adventures and one channel cannot run two.
 *
 * ## How a turn resolves (#837)
 *
 * The two turns that cost an AI call — `/dm begin` and `/dm action` — run under
 * this session's turn lease (`./dm/turnLock.js`), and re-read the session
 * *inside* it. Everything before the lease is a cheap refusal: whether there is
 * a session at all, whether the caller is in it. Everything the outcome depends
 * on is read after it, because between the two reads another player's turn may
 * have moved the whole party.
 *
 * What the narration did is carried by the structured `EFFECTS:` block the
 * model appends (`./dm/effects.js`), not inferred from the prose — so damage
 * lands on whoever it hit rather than on whoever typed, items are real, and the
 * party can actually be wiped out. A turn whose model ignored the format falls
 * back to reading the sentence (`./dm/prose.js`), which is the old behaviour and
 * its old limits.
 *
 * Skill checks go through the `dice_roll` tool, so an outcome is a number the
 * party can see rather than the model's mood.
 */

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

/** A character's HP ceiling, which is their class's. */
function maxHpFor(player) {
    return CLASS_HP[player?.characterClass] || 100;
}

function makeSessionId(guildId, channelId) {
    return `${guildId}:${channelId}`;
}

async function getActiveSession(guildId, channelId) {
    return DmSession.findOne({ guildId, channelId, active: true });
}

/**
 * The guild's provider config for a DM call, or an error string to show.
 *
 * `mcpServers` is deliberately dropped on the floor here rather than spread
 * through: the guild's connected servers have no business being reachable from
 * inside a story, and a narrator that can read somebody's issue tracker
 * mid-scene is a prompt injection surface with a dragon on it. The dice tool
 * below is the only tool a DM turn is given, and it is the bot's own.
 */
async function dmProviderConfig(guildId) {
    const gs = await Guild.findOne({ guildId });
    const { provider, model, apiKey, baseUrl, rateLimit } = resolveProviderConfig(gs?.ai || {});
    if (provider !== 'ollama' && !apiKey) {
        return { error: 'AI is not configured for this server. An admin must add an API key.' };
    }
    return { config: { provider, model, apiKey, baseUrl, rateLimit } };
}

/**
 * Ask the model to narrate, with the dice in its hands and none of the guild's
 * MCP servers.
 *
 * Returns the prose with the effects block stripped, the effects it carried,
 * and every roll the model made on the way — which the caller prints, because a
 * roll nobody sees is not an audit trail.
 */
async function narrate({ config, guildId, userId, channelId, systemPrompt, history, prompt, maxTokens }) {
    const rolls = [];
    const raw = await getCompletion({
        ...config,
        guildId, userId, channelId,
        // Not `mcp: false`. That switched off the toolkit entirely, which is
        // right for the guild's servers and wrong for the dice: `dice_roll` is
        // a bot-owned tool, and the toolkit is what carries it. No servers are
        // passed, so this builds a toolkit of exactly one tool.
        mcp: true,
        mcpServers: [],
        botTools: [diceTool(rolls)],
        systemPrompt, history, prompt, temperature: 0.9, maxTokens
    });

    const { cleanText, effects, hadBlock } = extractEffects(raw);
    return { text: cleanText, effects, hadBlock, rolls };
}

/** The rolls of a turn as an embed field, or null when nobody rolled. */
function rollsField(rolls) {
    if (!rolls.length) return null;
    const lines = rolls.map(roll => describeRoll(roll, roll.reason));
    return { name: '🎲 Rolls', value: fitLines(lines), inline: false };
}

/** The mechanical outcome as an embed field, or null when nothing changed. */
function changesField(changes) {
    if (!changes.length) return null;
    return { name: '📋 What changed', value: fitLines(changes), inline: false };
}

// Field values are capped at 1024 characters, and a party-wide effect can
// easily produce more lines than that. Dropping whole lines rather than cutting
// mid-word keeps every line that is shown readable.
function fitLines(lines) {
    const kept = [];
    let length = 0;
    for (const line of lines) {
        if (length + line.length + 1 > MAX_FIELD_CHARS - 20) {
            kept.push('…');
            break;
        }
        kept.push(line);
        length += line.length + 1;
    }
    return kept.join('\n');
}

/**
 * `/dm start` — open a session in this channel, with the caller as host.
 * Refuses if one is already active here.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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
            partyState: { scene: null, turns: 0, updatedAt: null },
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

/**
 * `/dm join` — add the caller to the party with a character name and class.
 * Capped at six players; a class sets starting HP and inventory.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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

// What a player is told when somebody else holds the turn. Not an error: the
// campaign is fine, it is just mid-sentence.
const BUSY_MESSAGE = 'Another turn in this channel is still being narrated — give it a few seconds and try again.';

/**
 * `/dm begin` — host only. Asks the model for an opening scene and pushes it as
 * the first entry in the story log, which is what `takeAction` counts back from.
 *
 * The "has the adventure already begun?" check is re-run under the turn lease,
 * because on its own it is a check-then-act: two hosts pressing together both
 * saw an empty log and both paid for an opening scene.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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

    const outcome = await withTurn(
        session.sessionId,
        () => openScene(interaction, session.sessionId),
        'the opening scene'
    );
    if (outcome === null) return interaction.editReply(BUSY_MESSAGE);
    return outcome;
}

async function openScene(interaction, sessionId) {
    const { channel, guild } = interaction;

    // `.lean()` on both turn reads: nothing here saves the document — every
    // write below is an explicit update — and a plain object is what the effect
    // application wants back (see ./dm/effects.js on spreading a subdocument).
    const session = await DmSession.findOne({ sessionId, active: true }).lean();
    if (!session) return interaction.editReply('The session has ended.');
    if (session.players.length === 0) return interaction.editReply('At least one player must join before beginning.');
    if (session.storyLog.length > 0) return interaction.editReply('The adventure has already begun!');

    const partyDesc = session.players
        .map(p => `- **${p.name}** the ${p.characterClass} (HP: ${p.hp}, Items: ${p.inventory.join(', ')})`)
        .join('\n');

    const systemPrompt = buildDMSystemPrompt(session.players);
    const openingPrompt = `The party consists of:\n${partyDesc}\n\nSet the opening scene for this adventure. Introduce the setting, hint at the first challenge or mystery, and end with a clear situation requiring the party to make a decision or take action. Keep it to 2-3 paragraphs.\n\nSet the party's location with a set_scene effect.`;

    try {
        const { config, error } = await dmProviderConfig(guild.id);
        if (error) return interaction.editReply(error);

        // guildId/userId/channelId are what tie this call to the guild's usage
        // ledger and to its configured AI limits; a DM campaign is otherwise an
        // unbounded provider bill behind a slash command.
        const { text: story, effects, rolls } = await narrate({
            config,
            guildId: guild.id, userId: interaction.user.id, channelId: interaction.channelId,
            systemPrompt, history: [], prompt: openingPrompt, maxTokens: 600
        });

        // The opening scene can hand out starting gear and set the location; it
        // has nobody to wound yet, but the same path applies whatever it did.
        const applied = applyEffects(session.players, effects, { maxHpFor });

        const update = {
            $push: { storyLog: story },
            $set: {
                ...playerWrites(session.players, applied.players),
                'partyState.updatedAt': new Date()
            }
        };
        if (applied.scene) update.$set['partyState.scene'] = applied.scene;

        // `new: true`: the document the write returns is the party as it now
        // stands, including anybody who joined while the scene was being
        // written — which the copy above cannot know about.
        const updatedSession = await DmSession.findOneAndUpdate(
            { sessionId, active: true },
            update,
            { new: true, ...updateOptions(session.players, applied.players) }
        );

        const embed = new EmbedBuilder()
            .setTitle('📖 The Adventure Begins...')
            .setColor('#8b4513')
            .setDescription(story)
            .setFooter({ text: 'Use /dm action to take an action!' });

        for (const field of [rollsField(rolls), changesField(applied.changes)]) {
            if (field) embed.addFields(field);
        }

        const storyRow = makeStoryButton(sessionId);
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

/**
 * The `$set` paths for the characters an effect list actually moved.
 *
 * Written per character through `arrayFilters` rather than as one `$set` of the
 * whole `players` array, because `/dm join` is a concurrent `$push` on that same
 * array: replacing it wholesale would drop an adventurer who joined while the
 * turn was being narrated. Only the fields that changed are written, so the
 * update is also the record of what the turn did.
 */
function playerWrites(before, after) {
    const writes = {};
    after.forEach((player, i) => {
        const was = before[i];
        if (!was) return;
        if (player.hp !== was.hp) writes[`players.$[p${i}].hp`] = player.hp;
        if (!sameInventory(was.inventory, player.inventory)) {
            writes[`players.$[p${i}].inventory`] = player.inventory;
        }
    });
    return writes;
}

/**
 * The matching `arrayFilters`. Mongo rejects an update carrying a filter
 * identifier no path uses, so this has to name exactly the characters
 * `playerWrites` wrote — same index, same condition.
 */
function playerFilters(before, after) {
    const filters = [];
    after.forEach((player, i) => {
        const was = before[i];
        if (!was) return;
        if (player.hp === was.hp && sameInventory(was.inventory, player.inventory)) return;
        filters.push({ [`p${i}.userId`]: player.userId });
    });
    return filters;
}

/**
 * The update options for a turn's write.
 *
 * `arrayFilters` is omitted rather than passed empty when no character moved:
 * an update carrying filters it does not use is rejected, and a turn in which
 * nothing mechanical happened writes only the story log.
 */
function updateOptions(before, after) {
    const arrayFilters = playerFilters(before, after);
    return arrayFilters.length ? { arrayFilters } : {};
}

function sameInventory(a = [], b = []) {
    return a.length === b.length && a.every((item, i) => item === b[i]);
}

/**
 * `/dm action` — narrate one player's action and apply what the narration says
 * happened: damage to anyone it hit, healing, items gained or lost, a new scene.
 *
 * Defers first, because the model call will outrun Discord's three seconds, and
 * then takes the session's turn so two players acting together cannot both
 * narrate from the same history.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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

    const outcome = await withTurn(
        session.sessionId,
        () => resolveTurn(interaction, session.sessionId, actionText),
        `${player.name}'s turn`
    );
    if (outcome === null) return interaction.editReply(BUSY_MESSAGE);
    return outcome;
}

/**
 * One turn, holding the session's lease.
 *
 * Everything is re-read here: between `takeAction`'s cheap checks and this, the
 * party may have taken a fireball, gained a member, or been wiped out. A turn
 * narrated from the state the player saw when they typed is exactly the race
 * the lease exists to close, so the state it narrates from is read inside it.
 */
async function resolveTurn(interaction, sessionId, actionText) {
    const { channel, guild, user } = interaction;

    const session = await DmSession.findOne({ sessionId, active: true }).lean();
    if (!session) return interaction.editReply('The session has ended.');

    const player = session.players.find(p => p.userId === user.id);
    if (!player) return interaction.editReply('You are no longer part of this session.');
    if (session.storyLog.length === 0) {
        return interaction.editReply('The adventure has not begun yet. The host must use `/dm begin`.');
    }
    if (player.hp <= 0) {
        return interaction.editReply(`**${player.name}** has fallen and cannot act. The rest of the party fights on.`);
    }

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

    const systemPrompt = buildDMSystemPrompt(session.players);
    const partyStatusLine = session.players
        .map(p => `${p.name} (${p.characterClass}, ${p.hp <= 0 ? 'DOWN' : `HP: ${p.hp}/${maxHpFor(p)}`}, carrying: ${p.inventory.join(', ') || 'nothing'})`)
        .join('\n');

    const sceneLine = session.partyState?.scene
        ? `Current location: ${session.partyState.scene}\n\n`
        : '';

    const prompt = `${sceneLine}Party:\n${partyStatusLine}\n\n**${player.name}** (${player.characterClass}) performs the following action: ${actionText}\n\nNarrate what happens next, including any consequences, NPC reactions, or changes to the environment. End with the current situation and what the party might do next. Keep it focused and 1-2 paragraphs.`;

    try {
        const { config, error } = await dmProviderConfig(guild.id);
        if (error) return interaction.editReply(error);

        const { text: narrative, effects, hadBlock, rolls } = await narrate({
            config,
            guildId: guild.id, userId: user.id, channelId: interaction.channelId,
            systemPrompt, history, prompt, maxTokens: 700
        });

        // A model that used the block is believed completely, including when it
        // says nothing happened. A model that ignored it gets the old prose
        // reader, which can only ever wound the character who acted — see
        // ./dm/prose.js for why that fallback is still here.
        const turnEffects = hadBlock ? effects : proseEffects(narrative, player, session.players);
        const applied = applyEffects(session.players, turnEffects, { maxHpFor });

        const playerEntry = `${player.name}: ${actionText}`;

        const update = {
            $push: { storyLog: { $each: [playerEntry, narrative], $slice: -MAX_STORY_LOG } },
            $inc: { 'partyState.turns': 1 },
            $set: {
                ...playerWrites(session.players, applied.players),
                'partyState.updatedAt': new Date()
            }
        };
        if (applied.scene) update.$set['partyState.scene'] = applied.scene;

        // `new: true`, so what comes back is the party as it now stands rather
        // than the copy this turn worked from — which matters because `/dm
        // join` runs outside the turn lease, and somebody who joined mid-turn
        // is standing even if everyone this turn knew about has fallen.
        const updatedSession = await DmSession.findOneAndUpdate(
            { sessionId, active: true },
            update,
            { new: true, ...updateOptions(session.players, applied.players) }
        );

        // A wipe is now something that can actually happen: an effect may take
        // down a character who never typed anything, and a breath weapon
        // targeting "party" may take down all of them at once. Guarded on
        // length because `every` on an empty party is vacuously true, and an
        // empty party is a session nobody has joined, not a dead one.
        const finalParty = updatedSession?.players ?? applied.players;
        const wiped = finalParty.length > 0 && finalParty.every(p => p.hp <= 0);

        if (wiped) {
            await DmSession.findOneAndUpdate(
                { sessionId },
                { $set: { active: false } }
            );
        }

        const embed = new EmbedBuilder()
            .setTitle(`⚔️ ${player.name} acts!`)
            .setColor(wiped ? '#ff0000' : '#4169e1')
            .setDescription(narrative)
            .setFooter({ text: wiped ? 'The party has fallen...' : 'Use /dm action to respond!' });

        for (const field of [rollsField(rolls), changesField(applied.changes)]) {
            if (field) embed.addFields(field);
        }

        if (wiped) {
            embed.addFields({ name: '💀 Session Ended', value: 'The entire party has fallen. The adventure is over.' });
        }

        const components = wiped ? [] : [makeStoryButton(sessionId)];
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

/**
 * `/dm party` — each character's HP and inventory, and how long the log is.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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

    if (session.partyState?.scene) embed.setDescription(`📍 ${session.partyState.scene}`);

    return interaction.reply({ embeds: [embed] });
}

/**
 * `/dm stop` — end the session. The host may always stop their own; anyone else
 * needs Manage Server.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Promise<*>} the reply
 */
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
        const maxHp = maxHpFor(p);
        const filled = Math.min(MAX_BAR, Math.round((Math.max(0, p.hp) / maxHp) * MAX_BAR));
        const bar = '█'.repeat(filled) + '░'.repeat(MAX_BAR - filled);
        const invLine = p.inventory.length ? p.inventory.join(', ') : 'Empty';
        return {
            name: `${p.name} — ${p.characterClass}`,
            value: `❤️ \`${bar}\` ${p.hp}/${maxHp}\n🎒 ${invLine}`,
            inline: false
        };
    });

    const embed = new EmbedBuilder()
        .setTitle('🗡️ Party Status')
        .setColor(COLORS.NEUTRAL)
        .addFields(fields)
        .setFooter({ text: 'Updated after each action' })
        .setTimestamp();

    // Where they are, now that something actually writes it (#837).
    if (session.partyState?.scene) embed.setDescription(`📍 ${session.partyState.scene}`);

    return embed;
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

/**
 * The "Story so far" button under the stat card: an ephemeral recap of the log.
 *
 * Routed from `interactionCreate` alongside the other button handlers, so it
 * has to say whether the click was one of its own.
 *
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('discord.js').Client} _client unused; the router's signature
 * @returns {Promise<boolean>} true if this handler owned the button and has
 *   answered it, false to let the router try the next handler
 */
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
        const { config, error } = await dmProviderConfig(session.guildId);
        if (error) return interaction.editReply(error);

        const logSnippet = session.storyLog.slice(-16).join('\n\n');
        const recap = await getCompletion({
            ...config,
            guildId: session.guildId, userId: interaction.user.id, channelId: interaction.channelId,
            // A recap is not a turn: nothing is rolled and nothing is applied,
            // so this one keeps the plain tool-less path.
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

function buildDMSystemPrompt(players = []) {
    return `You are an experienced, creative Dungeon Master running a text-based RPG on Discord. Your role is to:
- Narrate vivid, engaging story scenes
- React meaningfully to player actions
- Maintain internal consistency with the established story
- Keep descriptions concise (1-3 paragraphs) to fit Discord messages
- Track and reference party members by their character names
- Create tension, atmosphere, and opportunities for heroism
- Be fair but unpredictable — success is not guaranteed

When an action's outcome is genuinely uncertain — a lock picked, a leap made, a blow landed, a lie told — call the dice_roll tool and narrate the number it gives you. Do not decide for yourself whether an uncertain action succeeds, and do not invent a roll you did not make: the party is shown every roll, so an invented one will not be there.

The party is playing in a classic fantasy setting. Be creative, dramatic, and fun!
${effectsInstruction(players)}`;
}

module.exports = {
    startSession,
    joinSession,
    beginSession,
    takeAction,
    partyStatus,
    stopSession,
    handleDmButton,
    CLASSES,
    CLASS_HP
};
