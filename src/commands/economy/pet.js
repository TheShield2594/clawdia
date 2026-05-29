const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    PET_DEFINITIONS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    applyHungerDecay,
    checkRunaway,
    feedPet
} = require('../../services/petService');

const HUNGER_BAR_LENGTH = 10;

function hungerBar(hunger) {
    const filled = Math.round((hunger / 100) * HUNGER_BAR_LENGTH);
    const color = hunger >= STARVING_THRESHOLD ? '🟩' : '🟥';
    return color.repeat(filled) + '⬛'.repeat(HUNGER_BAR_LENGTH - filled) + ` ${hunger}%`;
}

function getMaterialSource(user, materialId) {
    const huntMat  = user.hunt?.materials?.[materialId] ?? 0;
    const fishMat  = user.fishing?.materials?.[materialId] ?? 0;
    const mineMat  = user.mining?.materials?.[materialId] ?? 0;
    return { huntMat, fishMat, mineMat, total: huntMat + fishMat + mineMat };
}

function decrementMaterial(user, materialId) {
    if ((user.hunt?.materials?.[materialId] ?? 0) > 0) {
        user.hunt.materials[materialId]--;
        user.markModified('hunt.materials');
        return true;
    }
    if ((user.fishing?.materials?.[materialId] ?? 0) > 0) {
        user.fishing.materials[materialId]--;
        user.markModified('fishing.materials');
        return true;
    }
    if ((user.mining?.materials?.[materialId] ?? 0) > 0) {
        user.mining.materials[materialId]--;
        user.markModified('mining.materials');
        return true;
    }
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
        user.pets[i].hunger = d.hunger;
        user.pets[i].lastFed = d.lastFed;   // persist advanced decay cursor
        user.pets[i].starving = d.starving;
        if (d.starvingStartAt) user.pets[i].starvingStartAt = d.starvingStartAt;
    }
    user.markModified('pets');

    if (ranAwayPets.length > 0) {
        const names = ranAwayPets.map(p => {
            const def = PET_DEFINITIONS[p.petId];
            const displayName = p.name || def?.name || p.petId;
            return `${def?.emoji ?? '🐾'} **${displayName}**`;
        });
        await interaction.followUp({
            content: `💔 Your pet${ranAwayPets.length > 1 ? 's' : ''} ran away from starvation: ${names.join(', ')}`,
            ephemeral: true
        }).catch(() => {});
    }
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeAdopt(interaction) {
    const petId = interaction.options.getString('type');
    const def = PET_DEFINITIONS[petId];

    if (!def) {
        return interaction.reply({ content: 'Unknown pet type.', ephemeral: true });
    }
    if (!def.purchasable) {
        return interaction.reply({
            content: `${def.emoji} **${def.name}** can only be obtained as a legendary drop — it's not sold in any shop!`,
            ephemeral: true
        });
    }

    const [user, guildSettings] = await Promise.all([
        resolveUser(interaction),
        Guild.findOne({ guildId: interaction.guild.id })
    ]);

    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled in this server.', ephemeral: true });
    }

    if ((user.pets ?? []).some(p => p.petId === petId)) {
        return interaction.reply({ content: `You already own a ${def.emoji} **${def.name}**!`, ephemeral: true });
    }

    if (user.balance < def.cost) {
        const currency = guildSettings?.economy?.currency ?? '💰';
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

    const currency = guildSettings?.economy?.currency ?? '💰';
    const embed = new EmbedBuilder()
        .setColor('#4caf50')
        .setTitle(`${def.emoji} New Pet Adopted!`)
        .setDescription(`Welcome your new **${def.name}**! Take good care of it.`)
        .addFields(
            { name: 'Passive Bonus', value: `+${def.bonusPct}% ${def.bonusType.replace(/_/g, ' ')} (active when hunger ≥ 30%)`, inline: true },
            { name: 'Favorite Food', value: `\`${def.favoriteMaterial}\` (restores 25 hunger)`, inline: true },
            { name: 'Cost', value: `${def.cost.toLocaleString()} ${currency}`, inline: true }
        )
        .setFooter({ text: 'Use /pet feed to keep it happy!' })
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

    const fields = user.pets.map(pet => {
        const def = PET_DEFINITIONS[pet.petId];
        const displayName = pet.name || def?.name || pet.petId;
        const bonusActive = pet.hunger >= STARVING_THRESHOLD;
        const daysOwned = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
        const starvingDays = (pet.hunger === 0 && pet.starvingStartAt)
            ? Math.floor((Date.now() - new Date(pet.starvingStartAt).getTime()) / 86400000)
            : 0;
        const runawayWarning = starvingDays > 0
            ? `\n⚠️ Starving for ${starvingDays}/${RUNAWAY_DAYS} days — feed it!`
            : '';

        return {
            name: `${def?.emoji ?? '🐾'} ${displayName}`,
            value: [
                `Hunger: ${hungerBar(pet.hunger)}`,
                `Bonus: +${def?.bonusPct ?? 0}% ${(def?.bonusType ?? '').replace(/_/g, ' ')} — ${bonusActive ? '✅ Active' : '❌ Inactive (feed me!)'}`,
                `Days owned: ${daysOwned}${runawayWarning}`
            ].join('\n'),
            inline: false
        };
    });

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Your Pets')
        .addFields(fields)
        .setFooter({ text: 'Feed pets with /pet feed to keep bonuses active' })
        .setTimestamp();

    await user.save().catch(() => {});
    return interaction.editReply({ embeds: [embed] });
}

async function executeFeed(interaction) {
    const materialId = interaction.options.getString('material');
    const petIndex = interaction.options.getInteger('slot') ?? 0;

    await interaction.deferReply();

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) {
        return interaction.editReply('You have no pets to feed!');
    }

    if (petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.editReply(`Invalid pet slot. You have ${user.pets.length} pet(s) (slots 0–${user.pets.length - 1}).`);
    }

    const { total } = getMaterialSource(user, materialId);
    if (total < 1) {
        return interaction.editReply(`You don't have any \`${materialId}\` to feed your pet with.`);
    }

    const pet = user.pets[petIndex];
    const def = PET_DEFINITIONS[pet.petId];
    const result = feedPet(pet, materialId);

    if (!result) return interaction.editReply('Could not feed that pet.');

    decrementMaterial(user, materialId);
    user.pets[petIndex].hunger = result.hunger;
    user.pets[petIndex].lastFed = new Date();
    user.pets[petIndex].starving = result.hunger < STARVING_THRESHOLD;
    if (result.hunger >= STARVING_THRESHOLD) user.pets[petIndex].starvingStartAt = null;
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.editReply('Edit conflict — please try again.');
        throw err;
    }

    const displayName = pet.name || def?.name || pet.petId;
    const favoriteNote = result.isFavorite ? ' *(favorite food — +25 hunger!)*' : ' *(not favorite — +10 hunger)*';

    const embed = new EmbedBuilder()
        .setColor(result.hunger >= STARVING_THRESHOLD ? '#4caf50' : '#ff5722')
        .setTitle(`${def?.emoji ?? '🐾'} ${displayName} fed!`)
        .addFields(
            { name: 'Food', value: `\`${materialId}\`${favoriteNote}`, inline: true },
            { name: 'Hunger', value: hungerBar(result.hunger), inline: false },
            { name: 'Bonus', value: result.hunger >= STARVING_THRESHOLD ? '✅ Active' : '❌ Still inactive (need ≥ 30%)', inline: true }
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function executeRelease(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const user = await resolveUser(interaction);

    if (!user.pets || petIndex < 0 || petIndex >= user.pets.length) {
        return interaction.reply({ content: 'Invalid pet slot.', ephemeral: true });
    }

    const pet = user.pets[petIndex];
    const def = PET_DEFINITIONS[pet.petId];
    const displayName = pet.name || def?.name || pet.petId;

    user.pets.splice(petIndex, 1);
    user.markModified('pets');

    try {
        await user.save();
    } catch (err) {
        if (err.name === 'VersionError') return interaction.reply({ content: 'Edit conflict — try again.', ephemeral: true });
        throw err;
    }

    return interaction.reply({
        content: `${def?.emoji ?? '🐾'} **${displayName}** has been released. Goodbye, friend!`,
        ephemeral: true
    });
}

async function executeRename(interaction) {
    const petIndex = interaction.options.getInteger('slot');
    const newName = interaction.options.getString('name').trim().slice(0, 32);
    const user = await resolveUser(interaction);

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
    return interaction.reply({
        content: `${def?.emoji ?? '🐾'} Pet renamed to **${newName}**!`,
        ephemeral: true
    });
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
                    opt.setName('type')
                        .setDescription('Pet type to adopt')
                        .setRequired(true)
                        .addChoices(
                            { name: '🐶 Dog (2,000)', value: 'dog' },
                            { name: '🐱 Cat (2,000)', value: 'cat' },
                            { name: '🐦 Bird (3,000)', value: 'bird' },
                            { name: '🐠 Fish (3,000)', value: 'fish' },
                            { name: '🦊 Fox (5,000)', value: 'fox' },
                            { name: '🐺 Wolf (8,000)', value: 'wolf' }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('status')
                .setDescription('View your pets and their hunger levels.')
        )
        .addSubcommand(sub =>
            sub.setName('feed')
                .setDescription('Feed a pet using a hunt/fish/mine material.')
                .addStringOption(opt =>
                    opt.setName('material')
                        .setDescription('Material to feed (e.g. rabbits_foot, fish_scale)')
                        .setRequired(true)
                )
                .addIntegerOption(opt =>
                    opt.setName('slot')
                        .setDescription('Pet slot number (0 = first pet, default 0)')
                        .setRequired(false)
                        .setMinValue(0)
                        .setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('release')
                .setDescription('Release a pet permanently.')
                .addIntegerOption(opt =>
                    opt.setName('slot')
                        .setDescription('Pet slot number (0 = first pet)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(9)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Give your pet a custom name.')
                .addIntegerOption(opt =>
                    opt.setName('slot')
                        .setDescription('Pet slot number (0 = first pet)')
                        .setRequired(true)
                        .setMinValue(0)
                        .setMaxValue(9)
                )
                .addStringOption(opt =>
                    opt.setName('name')
                        .setDescription('New name (max 32 chars)')
                        .setRequired(true)
                        .setMaxLength(32)
                )
        )
        .addSubcommand(sub =>
            sub.setName('list')
                .setDescription('View all available pets in the shop.')
        ),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        try {
            if (sub === 'adopt')   return await executeAdopt(interaction);
            if (sub === 'status')  return await executeStatus(interaction);
            if (sub === 'feed')    return await executeFeed(interaction);
            if (sub === 'release') return await executeRelease(interaction);
            if (sub === 'rename')  return await executeRename(interaction);
            if (sub === 'list')    return await executeList(interaction);
        } catch (err) {
            console.error('[pet] error:', err);
            const msg = { content: 'Something went wrong with the pet command.', ephemeral: true };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
