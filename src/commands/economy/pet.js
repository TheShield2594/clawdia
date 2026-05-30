'use strict';

const {
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder
} = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    applyHungerDecay,
    checkRunaway,
    feedPet,
    getMoodLine,
    getMoodColor,
    heartBar,
} = require('../../services/petService');
const { generatePetSprite } = require('../../utils/cardGenerator');

const HUNGER_BAR_LENGTH = 10;

function hungerBar(hunger) {
    const filled = Math.round((hunger / 100) * HUNGER_BAR_LENGTH);
    const color  = hunger >= STARVING_THRESHOLD ? '🟩' : '🟥';
    return color.repeat(filled) + '⬛'.repeat(HUNGER_BAR_LENGTH - filled) + ` ${hunger}%`;
}

function getMaterialSource(user, materialId) {
    const huntMat = user.hunt?.materials?.[materialId]   ?? 0;
    const fishMat = user.fishing?.materials?.[materialId] ?? 0;
    const mineMat = user.mining?.materials?.[materialId]  ?? 0;
    return { huntMat, fishMat, mineMat, total: huntMat + fishMat + mineMat };
}

function decrementMaterial(user, materialId) {
    if ((user.hunt?.materials?.[materialId]    ?? 0) > 0) { user.hunt.materials[materialId]--;    user.markModified('hunt.materials');    return true; }
    if ((user.fishing?.materials?.[materialId] ?? 0) > 0) { user.fishing.materials[materialId]--; user.markModified('fishing.materials'); return true; }
    if ((user.mining?.materials?.[materialId]  ?? 0) > 0) { user.mining.materials[materialId]--;  user.markModified('mining.materials');  return true; }
    return false;
}

async function resolveUser(interaction) {
    return User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
}

async function syncHungerAndRunaway(user, interaction) {
    if (!user.pets || user.pets.length === 0) return;

    const decayed = applyHungerDecay(user.pets);
    const { keepPets, ranAwayPets } = checkRunaway(decayed);

    user.pets = keepPets;
    for (let i = 0; i < keepPets.length; i++) {
        const d = keepPets[i];
        user.pets[i].hunger         = d.hunger;
        user.pets[i].lastFed        = d.lastFed;
        user.pets[i].starving       = d.starving;
        if (d.starvingStartAt) user.pets[i].starvingStartAt = d.starvingStartAt;
    }
    user.markModified('pets');

    if (ranAwayPets.length > 0) {
        const names = ranAwayPets.map(p => {
            const def = PET_DEFINITIONS[p.petId];
            return `${def?.emoji ?? '🐾'} **${p.name || def?.name || p.petId}**`;
        });
        await interaction.followUp({
            content: `💔 Your pet${ranAwayPets.length > 1 ? 's' : ''} ran away from starvation: ${names.join(', ')}`,
            ephemeral: true
        }).catch(() => {});
    }
}

// ── Pet status card helpers ───────────────────────────────────────────────────

function buildPetEmbed(pet, index, total, ownerAvatarURL) {
    const def         = PET_DEFINITIONS[pet.petId];
    const displayName = pet.name || def?.name || pet.petId;
    const bondDays    = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
    const moodLine    = getMoodLine(pet);
    const moodColor   = getMoodColor(pet.hunger);
    const bonusActive = pet.hunger >= STARVING_THRESHOLD;
    const bonusEmoji  = bonusActive ? '✅' : '❌';
    const bonusLabel  = `+${def?.bonusPct ?? 0}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}${bonusActive ? '' : ' *(inactive)*'}`;

    const lastFedMs  = pet.lastFed ? Date.now() - new Date(pet.lastFed).getTime() : 0;
    const lastFedH   = Math.floor(lastFedMs / 3600000);
    const lastFedStr = lastFedH < 1
        ? 'just now'
        : lastFedH < 24
        ? `${lastFedH}h ago`
        : `${Math.floor(lastFedH / 24)}d ago`;

    const isResting  = pet.restUntil && new Date(pet.restUntil).getTime() > Date.now();
    const potwLine   = pet.potw     ? '\n🌟 **Pet of the Week**'               : '';
    const restLine   = isResting    ? '\n🛏️ *Resting — hunger decays slower*' : '';

    return new EmbedBuilder()
        .setColor(moodColor)
        .setAuthor({ name: `${displayName} • ${def?.name ?? pet.petId}`, iconURL: ownerAvatarURL })
        .setDescription(`*${moodLine}*${potwLine}${restLine}`)
        .addFields(
            { name: '❤️ Bond',              value: `${heartBar(bondDays)} ${bondDays}d`, inline: false },
            { name: '🍖 Hunger',            value: hungerBar(pet.hunger),                inline: false },
            { name: `${bonusEmoji} Bonus`,  value: bonusLabel,                           inline: true  },
            { name: '🐾 Species',           value: `${def?.emoji ?? ''} ${def?.name ?? pet.petId}`, inline: true },
        )
        .setFooter({ text: `Pet ${index + 1} of ${total} • Last fed ${lastFedStr}` })
        .setTimestamp();
}

function buildNavComponents(userId, index, total) {
    const rows = [];

    if (total > 1) {
        rows.push(
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`pet_prev:${userId}:${index}`)
                    .setLabel('◀ Prev')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === 0),
                new ButtonBuilder()
                    .setCustomId(`pet_next:${userId}:${index}`)
                    .setLabel('Next ▶')
                    .setStyle(ButtonStyle.Secondary)
                    .setDisabled(index === total - 1),
            )
        );
    }

    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`pet_play:${userId}:${index}`)     .setLabel('🎾 Play')     .setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId(`pet_rest:${userId}:${index}`)     .setLabel('🛏️ Rest')    .setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`pet_showcase:${userId}:${index}`) .setLabel('📷 Showcase') .setStyle(ButtonStyle.Secondary),
        )
    );

    return rows;
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeAdopt(interaction) {
    const petId = interaction.options.getString('type');
    const def   = PET_DEFINITIONS[petId];

    if (!def) return interaction.reply({ content: 'Unknown pet type.', ephemeral: true });
    if (!def.purchasable) {
        return interaction.reply({
            content: `${def.emoji} **${def.name}** can only be obtained as a legendary drop — it's not sold in any shop!`,
            ephemeral: true
        });
    }

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), Guild.findOne({ guildId: interaction.guild.id })]);

    if (guildSettings?.economy?.enabled === false) return interaction.reply({ content: 'The economy is disabled in this server.', ephemeral: true });
    if ((user.pets ?? []).some(p => p.petId === petId)) return interaction.reply({ content: `You already own a ${def.emoji} **${def.name}**!`, ephemeral: true });

    const currency = guildSettings?.economy?.currency ?? '💰';
    if (user.balance < def.cost) {
        return interaction.reply({
            content: `You need **${def.cost.toLocaleString()}** ${currency} to adopt this pet but only have **${user.balance.toLocaleString()}**.`,
            ephemeral: true
        });
    }

    user.balance -= def.cost;
    user.pets.push({ petId, hunger: 100, lastFed: new Date(), adoptedAt: new Date() });
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — please try again.', ephemeral: true });
        throw err;
    }

    const embed = new EmbedBuilder()
        .setColor('#4caf50')
        .setTitle(`${def.emoji} New Pet Adopted!`)
        .setDescription(`Welcome your new **${def.name}**! Take good care of it.`)
        .addFields(
            { name: 'Passive Bonus',  value: `+${def.bonusPct}% ${def.bonusType.replace(/_/g, ' ')} (active when hunger ≥ 30%)`, inline: true },
            { name: 'Favorite Food',  value: `\`${def.favoriteMaterial}\` (restores 25 hunger)`,                                  inline: true },
            { name: 'Cost',           value: `${def.cost.toLocaleString()} ${currency}`,                                           inline: true },
        )
        .setFooter({ text: 'Use /pet status to see your pet\'s mood, or /pet feed to keep it happy!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeStatus(interaction) {
    await interaction.deferReply();

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) {
        return interaction.editReply('You have no pets. Use `/pet adopt` to get one!');
    }

    await user.save().catch(() => {});

    let currentIndex = 0;
    const ownerAvatarURL = interaction.user.displayAvatarURL({ dynamic: true });

    const reply = await interaction.editReply({
        embeds:     [buildPetEmbed(user.pets[currentIndex], currentIndex, user.pets.length, ownerAvatarURL)],
        components: buildNavComponents(interaction.user.id, currentIndex, user.pets.length),
    });

    const collector = reply.createMessageComponentCollector({
        filter: i => i.user.id === interaction.user.id,
        time:   90_000,
    });

    collector.on('collect', async (btn) => {
        const parts  = btn.customId.split(':');
        const action = parts[0];
        const idx    = parseInt(parts[2], 10);

        // Re-fetch user so mutations from concurrent actions are reflected
        const freshUser = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!freshUser || !freshUser.pets[idx]) {
            return btn.reply({ content: 'Pet not found.', ephemeral: true });
        }

        if (action === 'pet_prev') {
            currentIndex = Math.max(0, idx - 1);
            await btn.update({
                embeds:     [buildPetEmbed(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, currentIndex, freshUser.pets.length),
            });

        } else if (action === 'pet_next') {
            currentIndex = Math.min(freshUser.pets.length - 1, idx + 1);
            await btn.update({
                embeds:     [buildPetEmbed(freshUser.pets[currentIndex], currentIndex, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, currentIndex, freshUser.pets.length),
            });

        } else if (action === 'pet_play') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;
            const now  = Date.now();
            const PLAY_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

            if (pet.lastPlay && (now - new Date(pet.lastPlay).getTime()) < PLAY_COOLDOWN_MS) {
                const remaining = Math.ceil((PLAY_COOLDOWN_MS - (now - new Date(pet.lastPlay).getTime())) / 60000);
                return btn.reply({ content: `🎾 **${name}** is tired from playing! Try again in **${remaining}m**.`, ephemeral: true });
            }

            const xpGain = 15 + Math.floor(Math.random() * 11); // 15–25 XP
            freshUser.xp = (freshUser.xp || 0) + xpGain;
            freshUser.pets[idx].lastPlay            = new Date();
            freshUser.pets[idx].weeklyInteractions  = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try { await freshUser.save(); } catch { /* best effort */ }

            await btn.reply({ content: `🎾 You played with **${name}**! They loved it.\n✨ **+${xpGain} XP** earned!`, ephemeral: true });
            await interaction.editReply({
                embeds:     [buildPetEmbed(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, idx, freshUser.pets.length),
            }).catch(() => {});

        } else if (action === 'pet_rest') {
            const pet  = freshUser.pets[idx];
            const def  = PET_DEFINITIONS[pet.petId];
            const name = pet.name || def?.name || pet.petId;

            if (pet.restUntil && new Date(pet.restUntil).getTime() > Date.now()) {
                const remaining = Math.ceil((new Date(pet.restUntil).getTime() - Date.now()) / 60000);
                return btn.reply({ content: `🛏️ **${name}** is already resting! ${remaining}m remaining.`, ephemeral: true });
            }

            freshUser.pets[idx].restUntil           = new Date(Date.now() + 2 * 60 * 60 * 1000);
            freshUser.pets[idx].weeklyInteractions  = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try { await freshUser.save(); } catch { /* best effort */ }

            await btn.reply({ content: `🛏️ **${name}** is now resting! Hunger will decay at half speed for **2 hours**.`, ephemeral: true });
            await interaction.editReply({
                embeds:     [buildPetEmbed(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, idx, freshUser.pets.length),
            }).catch(() => {});

        } else if (action === 'pet_showcase') {
            const pet      = freshUser.pets[idx];
            const def      = PET_DEFINITIONS[pet.petId];
            const name     = pet.name || def?.name || pet.petId;
            const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);

            freshUser.pets[idx].weeklyInteractions = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');
            await freshUser.save().catch(() => {});

            const showcaseEmbed = new EmbedBuilder()
                .setColor(getMoodColor(pet.hunger))
                .setTitle(`${def?.emoji ?? '🐾'} ${name}`)
                .setAuthor({ name: `Owned by ${interaction.user.username}`, iconURL: ownerAvatarURL })
                .setDescription(`*${getMoodLine(pet)}*${pet.potw ? '\n🌟 **Pet of the Week**' : ''}`)
                .addFields(
                    { name: '❤️ Bond',    value: `${heartBar(bondDays)} ${bondDays}d`,               inline: true },
                    { name: '🍖 Hunger', value: hungerBar(pet.hunger),                                inline: true },
                    { name: `${pet.hunger >= STARVING_THRESHOLD ? '✅' : '❌'} Bonus`,
                      value: `+${def?.bonusPct ?? 0}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}`, inline: false },
                )
                .setFooter({ text: `${def?.name ?? pet.petId} • Use /pet status to check on yours!` })
                .setTimestamp();

            // Try to attach a pet sprite
            let files = [];
            try {
                const spriteBuf = await generatePetSprite(pet.petId, 80);
                if (spriteBuf) {
                    showcaseEmbed.setThumbnail('attachment://pet_sprite.png');
                    files = [new AttachmentBuilder(spriteBuf, { name: 'pet_sprite.png' })];
                }
            } catch { /* non-critical */ }

            await btn.reply({ embeds: [showcaseEmbed], files });
        }
    });

    collector.on('end', async () => {
        try {
            const disabled = buildNavComponents(interaction.user.id, currentIndex, user.pets.length)
                .map(row => ActionRowBuilder.from(row).setComponents(
                    row.components.map(b => ButtonBuilder.from(b).setDisabled(true))
                ));
            await interaction.editReply({ components: disabled });
        } catch { /* non-critical */ }
    });
}

async function executeFeed(interaction) {
    const materialId = interaction.options.getString('material');
    const petIndex   = interaction.options.getInteger('slot') ?? 0;

    await interaction.deferReply();

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) return interaction.editReply('You have no pets to feed!');
    if (petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.editReply(`Invalid pet slot. You have ${user.pets.length} pet(s) (slots 0–${user.pets.length - 1}).`);
    }

    const { total } = getMaterialSource(user, materialId);
    if (total < 1) return interaction.editReply(`You don't have any \`${materialId}\` to feed your pet with.`);

    const pet    = user.pets[petIndex];
    const def    = PET_DEFINITIONS[pet.petId];
    const result = feedPet(pet, materialId);
    if (!result) return interaction.editReply('Could not feed that pet.');

    decrementMaterial(user, materialId);
    user.pets[petIndex].hunger          = result.hunger;
    user.pets[petIndex].lastFed         = new Date();
    user.pets[petIndex].starving        = result.hunger < STARVING_THRESHOLD;
    user.pets[petIndex].weeklyInteractions = (user.pets[petIndex].weeklyInteractions || 0) + 1;
    if (result.hunger >= STARVING_THRESHOLD) user.pets[petIndex].starvingStartAt = null;
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.editReply('Edit conflict — please try again.');
        throw err;
    }

    const displayName  = pet.name || def?.name || pet.petId;
    const favoriteNote = result.isFavorite ? ' *(favorite food — +25 hunger!)*' : ' *(not favorite — +10 hunger)*';

    const embed = new EmbedBuilder()
        .setColor(result.hunger >= STARVING_THRESHOLD ? '#4caf50' : '#ff5722')
        .setTitle(`${def?.emoji ?? '🐾'} ${displayName} fed!`)
        .addFields(
            { name: 'Food',   value: `\`${materialId}\`${favoriteNote}`,   inline: true  },
            { name: 'Hunger', value: hungerBar(result.hunger),              inline: false },
            { name: 'Bonus',  value: result.hunger >= STARVING_THRESHOLD ? '✅ Active' : '❌ Still inactive (need ≥ 30%)', inline: true },
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function executeRelease(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const user     = await resolveUser(interaction);

    if (!user.pets || petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.reply({ content: 'Invalid pet slot.', ephemeral: true });
    }

    const pet  = user.pets[petIndex];
    const def  = PET_DEFINITIONS[pet.petId];
    const name = pet.name || def?.name || pet.petId;

    user.pets.splice(petIndex, 1);
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    return interaction.reply({ content: `${def?.emoji ?? '🐾'} **${name}** has been released. Goodbye, friend!`, ephemeral: true });
}

async function executeRename(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const newName  = interaction.options.getString('name').trim().slice(0, 32);
    const user     = await resolveUser(interaction);

    if (!user.pets || petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.reply({ content: 'Invalid pet slot.', ephemeral: true });
    }

    user.pets[petIndex].name = newName;
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    const def = PET_DEFINITIONS[user.pets[petIndex].petId];
    return interaction.reply({ content: `${def?.emoji ?? '🐾'} Pet renamed to **${newName}**!`, ephemeral: true });
}

async function executeList(interaction) {
    const lines = Object.values(PET_DEFINITIONS)
        .filter(d => d.purchasable)
        .map(d => `${d.emoji} **${d.name}** — ${d.cost.toLocaleString()} coins\nBonus: +${d.bonusPct}% ${d.bonusType.replace(/_/g, ' ')}  |  Fave food: \`${d.favoriteMaterial}\``);

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Pet Shop')
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: 'Rare pets (Eagle, Shark, Crystal Fox) drop from legendary hunt/fish/mine' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeLeaderboard(interaction) {
    await interaction.deferReply();

    const users = await User.find(
        { guildId: interaction.guild.id, 'pets.0': { $exists: true } },
        'userId pets'
    ).lean();

    const entries = [];
    for (const u of users) {
        for (const pet of u.pets) {
            const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
            entries.push({ userId: u.userId, pet, bondDays });
        }
    }

    entries.sort((a, b) => b.bondDays - a.bondDays);
    const top = entries.slice(0, 10);

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = top.map((e, i) => {
        const def  = PET_DEFINITIONS[e.pet.petId];
        const name = e.pet.name || def?.name || e.pet.petId;
        const rank = medals[i] ?? `${i + 1}.`;
        const potw = e.pet.potw ? ' 🌟' : '';
        return `${rank} ${def?.emoji ?? '🐾'} **${name}**${potw} — ${heartBar(e.bondDays)} ${e.bondDays}d — <@${e.userId}>`;
    });

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Pet Leaderboard — Most Bonded Pets')
        .setDescription(lines.length > 0 ? lines.join('\n') : '*No pets in this server yet!*')
        .setFooter({ text: 'Pet of the Week is chosen weekly by most interactions • 🌟 = current POTW' })
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

// ── Module export ─────────────────────────────────────────────────────────────

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('pet')
        .setDescription('Manage your pets.')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('adopt')
                .setDescription('Adopt a pet from the shop.')
                .addStringOption(opt =>
                    opt.setName('type').setDescription('Pet type to adopt').setRequired(true)
                        .addChoices(
                            { name: '🐶 Dog (2,000)',    value: 'dog'  },
                            { name: '🐱 Cat (2,000)',    value: 'cat'  },
                            { name: '🐦 Bird (3,000)',   value: 'bird' },
                            { name: '🐠 Fish (3,000)',   value: 'fish' },
                            { name: '🦊 Fox (5,000)',    value: 'fox'  },
                            { name: '🐺 Wolf (8,000)',   value: 'wolf' },
                        )
                )
        )
        .addSubcommand(sub => sub.setName('status').setDescription('View your pets and their mood.'))
        .addSubcommand(sub =>
            sub.setName('feed')
                .setDescription('Feed a pet using a hunt/fish/mine material.')
                .addStringOption(opt =>
                    opt.setName('material').setDescription('Material to feed (e.g. rabbits_foot, fish_scale)').setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet, default 0)').setRequired(false).setMinValue(0).setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('release')
                .setDescription('Release a pet permanently.')
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet)').setRequired(true).setMinValue(0).setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Give your pet a custom name.')
                .addIntegerOption(opt =>
                    opt.setName('slot').setDescription('Pet slot number (0 = first pet)').setRequired(true).setMinValue(0).setMaxValue(9)
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('New name (max 32 chars)').setRequired(true).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('list').setDescription('View all available pets in the shop.'))
        .addSubcommand(sub => sub.setName('leaderboard').setDescription('View the top bonded pets in this server.')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'adopt')       return await executeAdopt(interaction);
            if (sub === 'status')      return await executeStatus(interaction);
            if (sub === 'feed')        return await executeFeed(interaction);
            if (sub === 'release')     return await executeRelease(interaction);
            if (sub === 'rename')      return await executeRename(interaction);
            if (sub === 'list')        return await executeList(interaction);
            if (sub === 'leaderboard') return await executeLeaderboard(interaction);
        } catch (err) {
            console.error('[pet] error:', err);
            const msg = { content: 'Something went wrong with the pet command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
