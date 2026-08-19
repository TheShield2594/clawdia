'use strict';

const {
    SlashCommandBuilder, EmbedBuilder,
    ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, MessageFlags
} = require('discord.js');
const User  = require('../../models/User');
const { DECEASED_PET_LIMIT } = User;
const { attachGrind } = require('../../utils/grindProfile');
const { isVersionError, withVersionRetry } = require('../../utils/versionRetry');
const Guild = require('../../models/Guild');
const {
    PET_DEFINITIONS,
    PERSONALITY_TRAITS,
    STARVING_THRESHOLD,
    RUNAWAY_DAYS,
    applyHungerDecay,
    effectiveHunger,
    isPetActive,
    pickDefenderPet,
    REST_DURATION_MS,
    checkRunaway,
    feedPet,
    getMoodLine,
    getMoodColor,
    heartBar,
    PET_MAX_LEVEL,
    XP_FEED_FAVORITE,
    XP_FEED_OTHER,
    XP_BATTLE_WIN,
    XP_BATTLE_LOSS,
    XP_WILD_WIN,
    XP_WILD_LOSS,
    xpForLevel,
    getPetDisplay,
    getEffectiveBonusPct,
    applyPetXp,
    getPetStats,
    simulateBattle,
    makeWildPet,
    createPet,
    resolvePetRef,
    hasFreePetSlot,
    petCapacity,
    countSlotPets,
    RARE_PET_DROP_CHANCE,
} = require('../../services/petService');
const { generatePetSprite } = require('../../utils/cardGenerator');
const { applyXpGain, announceLevelUp } = require('../../utils/applyXpGain');
const { logTransaction } = require('../../utils/logTransaction');
const { saveWithBalanceDelta } = require('../../utils/balanceDelta');
const { MATERIAL_RARITY } = require('../../data/materialRarity');
const { checkAndAward, announceAchievements } = require('../../services/achievementService');
const { onPetCare, notifyQuestComplete } = require('../../services/questService');

const NO_SUCH_PET = "Couldn't find that pet — pick one from the list `/pet status` shows, or start typing to choose from your pets.";
const HUNGER_BAR_LENGTH = 10;
const BATTLE_COOLDOWN_MS  = 10 * 60 * 1000;    // per-pet battle cooldown
const BATTLE_MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000; // wagered battles only
const BATTLE_RAKE = 0.05;
// Wagered battles only: pet stats scale hard with level, so an unbounded
// matchup let a maxed pet farm newcomers for coins on a near-certain win.
const BATTLE_MAX_LEVEL_GAP = 5;
const _delay = ms => new Promise(r => setTimeout(r, ms));

function hpBar(current, max, length = 10) {
    const filled = Math.max(0, Math.round((current / Math.max(1, max)) * length));
    return '🟩'.repeat(Math.min(filled, length)) + '⬛'.repeat(Math.max(0, length - filled));
}

// Compact battle log: highlight up to the last few exchanges of the fight.
function battleLogLines(rounds, nameA, nameB) {
    return rounds.slice(-6).map(rd => {
        const who = rd.attacker === 'a' ? nameA : nameB;
        const tgt = rd.attacker === 'a' ? nameB : nameA;
        const crit = rd.crit ? ' 💥' : '';
        return `• **${who}** hits **${tgt}** for **${rd.damage}**${crit}`;
    });
}

// Hunger is stored at full precision (decay is continuous), so round for display —
// otherwise the bar reads "80.41666666666666%".
function hungerBar(hunger) {
    const pct    = Math.round(Math.min(100, Math.max(0, Number(hunger) || 0)));
    const filled = Math.round((pct / 100) * HUNGER_BAR_LENGTH);
    const color  = pct >= STARVING_THRESHOLD ? '🟩' : '🟥';
    return color.repeat(filled) + '⬛'.repeat(HUNGER_BAR_LENGTH - filled) + ` ${pct}%`;
}

// What a pet will actually eat: any known grind material, plus shop pet food.
function isEdible(materialId) {
    return Boolean(MATERIAL_RARITY[materialId]) || materialId === 'pet_food';
}

function getInventoryQuantity(user, itemId) {
    return user.inventory?.find(i => i.itemId === itemId)?.quantity ?? 0;
}

function getMaterialSource(user, materialId) {
    const huntMat = user.hunt?.materials?.[materialId]   ?? 0;
    const fishMat = user.fishing?.materials?.[materialId] ?? 0;
    const mineMat = user.mining?.materials?.[materialId]  ?? 0;
    const invMat  = getInventoryQuantity(user, materialId);
    return { huntMat, fishMat, mineMat, invMat, total: huntMat + fishMat + mineMat + invMat };
}

function decrementMaterial(user, materialId) {
    if ((user.hunt?.materials?.[materialId]    ?? 0) > 0) { user.hunt.materials[materialId]--;    user.markModified('hunt.materials');    return true; }
    if ((user.fishing?.materials?.[materialId] ?? 0) > 0) { user.fishing.materials[materialId]--; user.markModified('fishing.materials'); return true; }
    if ((user.mining?.materials?.[materialId]  ?? 0) > 0) { user.mining.materials[materialId]--;  user.markModified('mining.materials');  return true; }
    const slot = user.inventory?.find(i => i.itemId === materialId);
    if (slot && slot.quantity > 0) {
        slot.quantity--;
        if (slot.quantity <= 0) user.inventory = user.inventory.filter(i => i !== slot);
        user.markModified('inventory');
        return true;
    }
    return false;
}

/**
 * Read the `slot` option without asserting its type.
 *
 * It changed from an integer to an autocompleted string; global command updates
 * take a while to reach every client, so during that window a stale client can
 * still send an integer — which getString() would throw on. resolvePetRef()
 * accepts both forms, so normalise to a string here and let it decide.
 */
function readSlotOption(interaction) {
    const raw = interaction.options.get('slot');
    return raw?.value == null ? null : String(raw.value);
}

/** Short label for a pet in an autocomplete list. Discord caps choice names at 100. */
function petChoiceLabel(pet) {
    const def    = PET_DEFINITIONS[pet.petId];
    const name   = pet.name || def?.name || pet.petId;
    const hunger = Math.round(effectiveHunger(pet));
    const fed    = hunger >= STARVING_THRESHOLD ? '' : ' · hungry!';
    return `${name} — ${def?.name ?? pet.petId} Lv${pet.level ?? 1} · ${hunger}% fed${fed}`.slice(0, 100);
}

/**
 * Evaluate achievements against the freshly mutated user. Pet achievements would
 * otherwise only fire the next time the player happened to hunt, fish or mine,
 * since those were the only commands running this check.
 *
 * Call before saving so one write persists the pet change and the unlock.
 */
/** Advance pet-care quest progress and surface any completions. */
async function creditPetCare(interaction, user, guildSettings) {
    const { completed } = await onPetCare(user, guildSettings).catch(err => {
        console.error('[pet] quest progress failed:', err);
        return { completed: [] };
    });
    if (completed.length) {
        notifyQuestComplete(guildSettings, interaction.member, completed, interaction.channel, user).catch(() => {});
    }
}

function collectPetAchievements(user, guildSettings) {
    return checkAndAward(user, guildSettings).catch(err => {
        console.error('[pet] achievement check failed:', err);
        return [];
    });
}

function announcePetAchievements(interaction, user, guildSettings, earned) {
    if (!earned?.length) return;
    announceAchievements(interaction.client, guildSettings, user, interaction.member, earned).catch(() => {});
}

async function resolveUser(interaction) {
    const user = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
        { upsert: true, new: true }
    );
    // Feeding consumes hunt/fish/mine materials, which live on GrindProfile now
    return attachGrind(user);
}

async function syncHungerAndRunaway(user, interaction) {
    if (!user.pets || user.pets.length === 0) return;

    // Write the accrued decay back onto the live subdocuments, then evaluate
    // runaways against those updated values.
    const decayed = applyHungerDecay(user.pets);
    for (let i = 0; i < user.pets.length; i++) {
        const d = decayed[i];
        if (!d || d === user.pets[i]) continue; // no time elapsed for this pet
        user.pets[i].hunger          = d.hunger;
        user.pets[i].lastDecayAt     = d.lastDecayAt;
        user.pets[i].starving        = d.starving;
        user.pets[i].starvingStartAt = d.starvingStartAt ?? null;
    }

    const { ranAwayPets } = checkRunaway(user.pets);
    for (const gone of ranAwayPets) {
        // Keep a record so a Revive Scroll can bring the pet back with its
        // level, bond and battle record intact.
        const snapshot = gone.toObject ? gone.toObject() : { ...gone };
        delete snapshot._id;
        user.deceasedPets.unshift({ ...snapshot, diedAt: new Date() });
        if (gone._id) user.pets.pull(gone._id);
    }
    if (ranAwayPets.length > 0) {
        user.deceasedPets = user.deceasedPets.slice(0, DECEASED_PET_LIMIT);
        user.markModified('deceasedPets');
    }
    user.markModified('pets');

    if (ranAwayPets.length > 0) {
        const names = ranAwayPets.map(p => {
            const def = PET_DEFINITIONS[p.petId];
            return `${def?.emoji ?? '🐾'} **${p.name || def?.name || p.petId}**`;
        });
        const deathMsg = ranAwayPets.length === 1
            ? `💀 **${interaction.user.username}**'s pet ${names[0]} passed away from starvation...`
            : `💀 **${interaction.user.username}**'s pets ${names.join(', ')} passed away from starvation...`;
        interaction.channel?.send({ content: deathMsg }).catch(() => {});
        // followUp only works once the interaction has been answered. /pet battle
        // syncs before it replies, so on that path the public channel message
        // above is the only notice the owner gets — which is why it names them.
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({
                content: `💔 Your pet${ranAwayPets.length > 1 ? 's' : ''} died from starvation: ${names.join(', ')}\n*Use \`/pet adopt\` for a new companion, or a Revive Scroll from \`/shop\` to bring one back with its level and bond intact.*`,
                flags: MessageFlags.Ephemeral
            }).catch(() => {});
        }
    }
}

// ── Pet status card helpers ───────────────────────────────────────────────────

function buildPetEmbed(pet, index, total, ownerAvatarURL) {
    const def         = PET_DEFINITIONS[pet.petId];
    const displayName = pet.name || def?.name || pet.petId;
    const bondDays    = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
    const hunger      = effectiveHunger(pet);
    const moodLine    = getMoodLine(pet);
    const moodColor   = getMoodColor(hunger);
    const bonusActive = hunger >= STARVING_THRESHOLD;
    const bonusEmoji  = bonusActive ? '✅' : '❌';
    const effPct      = getEffectiveBonusPct(pet);
    const bonusLabel  = `+${effPct}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}${bonusActive ? '' : ' *(inactive)*'}`;

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

    const personalityDef = pet.personality ? PERSONALITY_TRAITS[pet.personality] : null;
    const personalityLine = personalityDef ? `\n${personalityDef.emoji} *${personalityDef.label}* — ${personalityDef.desc}` : '';

    const { emoji: dispEmoji } = getPetDisplay(pet);
    const level   = pet.level ?? 1;
    const stage   = pet.evolutionStage ?? 1;
    const stageStars = '⭐'.repeat(stage);
    const xpInLevel  = (pet.xp ?? 0) - xpForLevel(level);
    const xpToNext   = level >= PET_MAX_LEVEL ? 0 : xpForLevel(level + 1) - xpForLevel(level);
    const levelLine  = level >= PET_MAX_LEVEL
        ? `Lv. **${level}** (MAX) ${stageStars}`
        : `Lv. **${level}** ${stageStars} — ${xpInLevel}/${xpToNext} XP`;
    const record = `${pet.battleWins ?? 0}W / ${pet.battleLosses ?? 0}L`;

    // Where to actually get the +25 food — previously only /pet list mentioned it.
    const favMeta      = def ? MATERIAL_RARITY[def.favoriteMaterial] : null;
    const favouriteLine = def
        ? `${favMeta?.emoji ?? '🍖'} \`${def.favoriteMaterial}\` — from **/${def.materialSource}** *(+25 hunger, bonus XP)*`
        : '—';

    return new EmbedBuilder()
        .setColor(moodColor)
        .setAuthor({ name: `${getPetDisplay(pet).titledName} • ${def?.name ?? pet.petId}`, iconURL: ownerAvatarURL })
        .setDescription(`${dispEmoji} *${moodLine}*${personalityLine}${potwLine}${restLine}`)
        .addFields(
            { name: '📈 Level',             value: levelLine,                            inline: false },
            { name: '❤️ Bond',              value: `${heartBar(bondDays)} ${bondDays}d`, inline: false },
            { name: '🍖 Hunger',            value: hungerBar(hunger),                    inline: false },
            { name: `${bonusEmoji} Bonus`,  value: bonusLabel,                           inline: true  },
            { name: '⚔️ Battle Record',     value: record,                               inline: true  },
            { name: '🍗 Favourite Food',    value: favouriteLine,                        inline: false },
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

// ── Autocomplete ──────────────────────────────────────────────────────────────

/** Pets the player currently owns, keyed by their stable _id. */
async function slotAutocomplete(interaction, focused) {
    const user = await User.findOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        'pets'
    );
    const pets  = user?.pets ?? [];
    const query = focused.toLowerCase();

    const choices = pets
        .map(pet => ({ name: petChoiceLabel(pet), value: String(pet._id) }))
        .filter(c => !query || c.name.toLowerCase().includes(query));

    return interaction.respond(choices.slice(0, 25));
}

/**
 * Materials the player actually holds and could plausibly feed a pet, with the
 * selected pet's favourite pinned to the top. Without this the option required
 * typing exact snake_case ids like `rabbits_foot` from memory.
 */
async function materialAutocomplete(interaction, focused) {
    // Read-only and projected: resolveUser() upserts, and Discord fires an
    // autocomplete event per keystroke with a 3s budget.
    const found = await User.findOne(
        { userId: interaction.user.id, guildId: interaction.guild.id },
        'pets inventory guildId userId'
    );
    if (!found) return interaction.respond([]);
    const user = await attachGrind(found);

    // The slot option may already be filled in; if so, favour that pet's food.
    const selected  = resolvePetRef(user?.pets, readSlotOption(interaction));
    const favourite = selected ? PET_DEFINITIONS[selected.pet.petId]?.favoriteMaterial : null;

    const held = new Map(); // materialId -> quantity
    const add  = (id, qty) => {
        if (!id || !(qty > 0)) return;
        held.set(id, (held.get(id) ?? 0) + qty);
    };
    for (const system of ['hunt', 'fishing', 'mining']) {
        for (const [id, qty] of Object.entries(user?.[system]?.materials ?? {})) add(id, qty);
    }
    for (const entry of user?.inventory ?? []) add(entry.itemId, entry.quantity);

    const query = focused.toLowerCase();
    const choices = [...held.entries()]
        // Grind materials plus shop-bought pet food — not every stray inventory item.
        .filter(([id]) => isEdible(id))
        .filter(([id]) => !query || id.toLowerCase().includes(query))
        .map(([id, qty]) => {
            const meta  = MATERIAL_RARITY[id];
            const label = meta?.label ?? (id === 'pet_food' ? 'Pet Food' : id);
            const isFav = id === favourite;
            return {
                id, qty, isFav,
                name: `${meta?.emoji ?? '🍖'} ${label} — ${qty}x${isFav ? ' ⭐ favourite (+25)' : ' (+10)'}`.slice(0, 100),
            };
        })
        .sort((a, b) => (b.isFav - a.isFav) || (b.qty - a.qty) || a.name.localeCompare(b.name))
        .slice(0, 25)
        .map(c => ({ name: c.name, value: c.id }));

    return interaction.respond(choices);
}

// ── Subcommand handlers ───────────────────────────────────────────────────────

async function executeAdopt(interaction) {
    const petId = interaction.options.getString('type');
    const petName = interaction.options.getString('name')?.trim().slice(0, 32) ?? null;
    const def   = PET_DEFINITIONS[petId];

    if (!def) return interaction.reply({ content: 'Unknown pet type.', flags: MessageFlags.Ephemeral });
    if (!def.purchasable) {
        return interaction.reply({
            content: `${def.emoji} **${def.name}** can only be obtained as a legendary drop — it's not sold in any shop!`,
            flags: MessageFlags.Ephemeral
        });
    }

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), Guild.findOne({ guildId: interaction.guild.id })]);

    if (guildSettings?.economy?.enabled === false) return interaction.reply({ content: 'The economy is disabled in this server.', flags: MessageFlags.Ephemeral });
    if ((user.pets ?? []).some(p => p.petId === petId)) return interaction.reply({ content: `You already own a ${def.emoji} **${def.name}**!`, flags: MessageFlags.Ephemeral });
    if (!hasFreePetSlot(user)) {
        return interaction.reply({
            content: `🐾 You're caring for **${countSlotPets(user.pets)}** pets and have room for **${petCapacity(user)}**. `
                   + `Release one with \`/pet release\`, or buy a **Pet Slot Expansion** from \`/shop\` for another slot.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const currency = guildSettings?.economy?.currency ?? '💰';
    if (user.balance < def.cost) {
        return interaction.reply({
            content: `You need **${def.cost.toLocaleString()}** ${currency} to adopt this pet but only have **${user.balance.toLocaleString()}**.`,
            flags: MessageFlags.Ephemeral
        });
    }

    // The adoption fee is a conditional update, not `balance -= cost` followed by
    // a save: the balance read above goes stale the moment anything else pays or
    // charges this player, and saving it back would erase that write.
    const charged = await User.findOneAndUpdate(
        { userId: interaction.user.id, guildId: interaction.guild.id, balance: { $gte: def.cost } },
        { $inc: { balance: -def.cost } },
        { new: true, projection: { balance: 1 } },
    );
    if (!charged) {
        return interaction.reply({
            content: `Adopting this pet costs **${def.cost.toLocaleString()}** ${currency} — you no longer have enough. Check \`/balance\` and try again.`,
            flags: MessageFlags.Ephemeral,
        });
    }
    // Take the authoritative balance and keep the save off that path.
    user.balance = charged.balance;
    user.unmarkModified('balance');

    const newPet = createPet(petId, { name: petName });
    user.pets.push(newPet);
    user.markModified('pets');
    const personality = newPet.personality;

    const earned = await collectPetAchievements(user, guildSettings);

    try {
        await user.save();
    } catch (err) {
        // The fee is already gone; hand it back rather than charging for a pet
        // that was never adopted.
        await User.updateOne(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $inc: { balance: def.cost } },
        ).catch(refundErr => console.error('[pet adopt] refund after failed save:', refundErr));
        if (isVersionError(err)) return interaction.reply({ content: 'Edit conflict — your coins were refunded. Please try again.', flags: MessageFlags.Ephemeral });
        throw err;
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    const personalityDef = PERSONALITY_TRAITS[personality];
    const displayName = petName || def.name;
    const embed = new EmbedBuilder()
        .setColor('#4caf50')
        .setTitle(`${def.emoji} New Pet Adopted!`)
        .setDescription(
            `Welcome **${displayName}** to your family! Take good care of them.\n\n` +
            `${personalityDef.emoji} **Personality: ${personalityDef.label}** — *${personalityDef.desc}*`
        )
        .addFields(
            { name: 'Passive Bonus',  value: `+${def.bonusPct}% ${def.bonusType.replace(/_/g, ' ')} (active when hunger ≥ ${STARVING_THRESHOLD}%)`, inline: true },
            { name: 'Favorite Food',  value: `\`${def.favoriteMaterial}\` (restores 25 hunger)`,                                  inline: true },
            { name: 'Cost',           value: `${def.cost.toLocaleString()} ${currency}`,                                           inline: true },
        )
        .setFooter({ text: 'Use /pet status to see your pet\'s mood, or /pet feed to keep it happy!' })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeStatus(interaction) {
    await interaction.deferReply();

    const [user, guildSettings] = await Promise.all([
        resolveUser(interaction),
        Guild.findOne({ guildId: interaction.guild.id }),
    ]);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) {
        return interaction.editReply('You have no pets. Use `/pet adopt` to get one!');
    }

    try {
        await user.save();
    } catch (err) {
        // Swallowing this meant a runaway could be announced, fail to persist, and
        // then be announced again on the next /pet status.
        console.error('[pet] status save error:', err);
        return interaction.editReply('Something went wrong updating your pets. Please try again.');
    }

    let currentIndex = 0;
    const ownerAvatarURL = interaction.user.displayAvatarURL();

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
            return btn.reply({ content: 'Pet not found.', flags: MessageFlags.Ephemeral });
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
                return btn.reply({ content: `🎾 **${name}** is tired from playing! Try again in **${remaining}m**.`, flags: MessageFlags.Ephemeral });
            }

            const rolledXp = 15 + Math.floor(Math.random() * 11); // 15–25 XP
            const { leveled, gained: xpGain } = applyXpGain(freshUser, rolledXp);
            const petXpResult = applyPetXp(freshUser.pets[idx], 10);
            freshUser.pets[idx].lastPlay           = new Date();
            freshUser.pets[idx].weeklyInteractions = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');
            // A completed pet-care quest pays coins. `save()` writes `balance` as an
            // absolute `$set`, so the credit is folded out of the save and applied as
            // its own `$inc` — otherwise this write erases anything the player spent
            // between loading the document and here.
            const balanceBeforeCare = freshUser.balance ?? 0;
            await creditPetCare(interaction, freshUser, guildSettings);

            try {
                await saveWithBalanceDelta(User, freshUser, balanceBeforeCare, {
                    service: 'pet',
                    jobName: 'playQuestReward',
                    guildId: interaction.guild.id,
                });
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] play save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            if (leveled) {
                announceLevelUp(freshUser, guildSettings, btn.member, btn.guild, interaction.channel).catch(() => {});
            }

            const levelNote = leveled ? `\n🎉 **Level up! You're now level ${freshUser.level}!**` : '';
            const petNote = petXpResult.evolved
                ? `\n🌟 **${name} evolved to ${getPetDisplay(freshUser.pets[idx]).titledName}!**`
                : petXpResult.leveledUp
                ? `\n📈 **${name} reached pet Level ${petXpResult.toLevel}!**`
                : '';
            await btn.reply({ content: `🎾 You played with **${name}**! They loved it.\n✨ **+${xpGain} XP** for you, **+${petXpResult.gained} XP** for ${name}!${levelNote}${petNote}`, flags: MessageFlags.Ephemeral });
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
                return btn.reply({ content: `🛏️ **${name}** is already resting! ${remaining}m remaining.`, flags: MessageFlags.Ephemeral });
            }

            freshUser.pets[idx].restUntil           = new Date(Date.now() + REST_DURATION_MS);
            freshUser.pets[idx].weeklyInteractions  = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');
            // A completed pet-care quest pays coins. `save()` writes `balance` as an
            // absolute `$set`, so the credit is folded out of the save and applied as
            // its own `$inc` — otherwise this write erases anything the player spent
            // between loading the document and here.
            const balanceBeforeCare = freshUser.balance ?? 0;
            await creditPetCare(interaction, freshUser, guildSettings);

            try {
                await saveWithBalanceDelta(User, freshUser, balanceBeforeCare, {
                    service: 'pet',
                    jobName: 'restQuestReward',
                    guildId: interaction.guild.id,
                });
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] rest save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            await btn.reply({ content: `🛏️ **${name}** is now resting! Hunger will decay at half speed for **2 hours**.`, flags: MessageFlags.Ephemeral });
            await interaction.editReply({
                embeds:     [buildPetEmbed(freshUser.pets[idx], idx, freshUser.pets.length, ownerAvatarURL)],
                components: buildNavComponents(interaction.user.id, idx, freshUser.pets.length),
            }).catch(() => {});

        } else if (action === 'pet_showcase') {
            const pet      = freshUser.pets[idx];
            const def      = PET_DEFINITIONS[pet.petId];
            const name     = pet.name || def?.name || pet.petId;
            const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);
            const hunger   = effectiveHunger(pet);

            freshUser.pets[idx].weeklyInteractions = (freshUser.pets[idx].weeklyInteractions || 0) + 1;
            freshUser.markModified('pets');

            try {
                await freshUser.save();
            } catch (err) {
                if (isVersionError(err)) {
                    return btn.reply({ content: '⚠️ Action conflict — please try again.', flags: MessageFlags.Ephemeral });
                }
                console.error('[pet] showcase save error:', err);
                return btn.reply({ content: '❌ Failed to save. Please try again.', flags: MessageFlags.Ephemeral });
            }

            const showcaseEmbed = new EmbedBuilder()
                .setColor(getMoodColor(hunger))
                .setTitle(`${def?.emoji ?? '🐾'} ${name}`)
                .setAuthor({ name: `Owned by ${interaction.user.username}`, iconURL: ownerAvatarURL })
                .setDescription(`*${getMoodLine(pet)}*${pet.potw ? '\n🌟 **Pet of the Week**' : ''}`)
                .addFields(
                    { name: '❤️ Bond',    value: `${heartBar(bondDays)} ${bondDays}d`,               inline: true },
                    { name: '🍖 Hunger', value: hungerBar(hunger),                                    inline: true },
                    { name: `${hunger >= STARVING_THRESHOLD ? '✅' : '❌'} Bonus`,
                      value: `+${getEffectiveBonusPct(pet)}% ${(def?.bonusType ?? '').replace(/_/g, ' ')}`, inline: false },
                )
                .setFooter({ text: `${def?.name ?? pet.petId} • Use /pet status to check on yours!` })
                .setTimestamp();

            // Try to attach a pet sprite
            let files = [];
            try {
                const spriteBuf = await generatePetSprite(pet.petId, 80, pet.evolutionStage ?? 1);
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
    const petRef     = readSlotOption(interaction);

    await interaction.deferReply();

    const [user, guildSettings] = await Promise.all([resolveUser(interaction), Guild.findOne({ guildId: interaction.guild.id })]);
    await syncHungerAndRunaway(user, interaction);

    if (!user.pets || user.pets.length === 0) return interaction.editReply('You have no pets to feed!');
    const target = resolvePetRef(user?.pets, petRef);
    if (!target) return interaction.editReply(NO_SUCH_PET);
    const petIndex = target.index;

    // Only grind materials and shop pet food are edible. Without this any
    // inventory item counted, so `/pet feed material:tier_skip_token` would
    // destroy a 50,000-coin item for 10 hunger.
    if (!isEdible(materialId)) {
        return interaction.editReply(
            `\`${materialId}\` isn't something a pet will eat. Feed a hunt/fish/mine material or \`pet_food\` — ` +
            `start typing in the **material** option to see what you have.`
        );
    }

    const { total } = getMaterialSource(user, materialId);
    if (total < 1) return interaction.editReply(`You don't have any \`${materialId}\` to feed your pet with.`);

    const pet    = user.pets[petIndex];
    const def    = PET_DEFINITIONS[pet.petId];

    // Refuse rather than consume the material for nothing.
    if (effectiveHunger(pet) >= 100) {
        const fullName = pet.name || def?.name || pet.petId;
        return interaction.editReply(`${getPetDisplay(pet).emoji} **${fullName}** is completely full — save that \`${materialId}\` for later.`);
    }

    const result = feedPet(pet, materialId);
    if (!result) return interaction.editReply('Could not feed that pet.');

    decrementMaterial(user, materialId);
    user.pets[petIndex].hunger          = result.hunger;
    user.pets[petIndex].lastFed         = new Date();
    // Decay was brought up to date by syncHungerAndRunaway above; re-anchor the
    // cursor so the restored hunger isn't immediately docked again.
    user.pets[petIndex].lastDecayAt     = new Date();
    user.pets[petIndex].starving        = result.hunger < STARVING_THRESHOLD;
    user.pets[petIndex].weeklyInteractions = (user.pets[petIndex].weeklyInteractions || 0) + 1;
    if (result.hunger > 0) user.pets[petIndex].starvingStartAt = null;
    const feedXp = applyPetXp(user.pets[petIndex], result.isFavorite ? XP_FEED_FAVORITE : XP_FEED_OTHER);
    user.markModified('pets');

    // A completed pet-care quest pays coins. `save()` writes `balance` as an
    // absolute `$set`, so the credit is folded out of the save and applied as its
    // own `$inc` — otherwise this write erases anything the player spent between
    // loading the document and here.
    const balanceBeforeCare = user.balance ?? 0;
    await creditPetCare(interaction, user, guildSettings);
    const earned = await collectPetAchievements(user, guildSettings);

    try {
        await saveWithBalanceDelta(User, user, balanceBeforeCare, {
            service: 'pet',
            jobName: 'feedQuestReward',
            guildId: interaction.guild.id,
        });
    } catch (err) {
        if (isVersionError(err)) return interaction.editReply('Edit conflict — please try again.');
        throw err;
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    const displayName  = pet.name || def?.name || pet.petId;
    const favoriteNote = result.isFavorite ? ' *(favorite food — +25 hunger!)*' : ' *(not favorite — +10 hunger)*';
    const progressNote = feedXp.evolved
        ? `\n🌟 **${displayName} evolved!** Now an **${getPetDisplay(user.pets[petIndex]).titledName}** (Stage ${feedXp.toStage})!`
        : feedXp.leveledUp
        ? `\n🎉 **${displayName} reached Level ${feedXp.toLevel}!**`
        : '';

    const embed = new EmbedBuilder()
        .setColor(result.hunger >= STARVING_THRESHOLD ? '#4caf50' : '#ff5722')
        .setTitle(`${getPetDisplay(user.pets[petIndex]).emoji} ${displayName} fed!`)
        .setDescription(`✨ **+${feedXp.gained} pet XP**${progressNote}`)
        .addFields(
            { name: 'Food',   value: `\`${materialId}\`${favoriteNote}`,   inline: true  },
            { name: 'Hunger', value: hungerBar(result.hunger),              inline: false },
            { name: 'Bonus',  value: result.hunger >= STARVING_THRESHOLD ? '✅ Active' : `❌ Still inactive (need ≥ ${STARVING_THRESHOLD}%)`, inline: true },
        )
        .setTimestamp();

    return interaction.editReply({ embeds: [embed] });
}

async function executeRelease(interaction) {
    const user   = await resolveUser(interaction);
    const target = resolvePetRef(user?.pets, readSlotOption(interaction));
    if (!target) return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });

    const { pet } = target;
    const def     = PET_DEFINITIONS[pet.petId];
    const name    = pet.name || def?.name || pet.petId;
    const petId   = String(pet._id);
    const level   = pet.level ?? 1;
    const bondDays = Math.floor((Date.now() - new Date(pet.adoptedAt).getTime()) / 86400000);

    // Releasing is permanent and unrevivable — a Revive Scroll only brings back
    // pets lost to starvation — so a level 30 pet was one mistyped slot away
    // from being gone with no confirmation at all.
    const confirmId = `pet_release_yes:${interaction.id}`;
    const cancelId  = `pet_release_no:${interaction.id}`;
    const confirm = await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor('#e74c3c')
            .setTitle(`Release ${name}?`)
            .setDescription(
                `${getPetDisplay(pet).emoji} **${getPetDisplay(pet).titledName}** — Lv.${level}, ` +
                `${bondDays} day${bondDays === 1 ? '' : 's'} of bond, ${pet.battleWins ?? 0}W / ${pet.battleLosses ?? 0}L.\n\n` +
                `**This cannot be undone.** A Revive Scroll only restores pets lost to starvation, not released ones.`
            )],
        components: [new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(confirmId).setLabel('Release').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId(cancelId).setLabel('Keep them').setStyle(ButtonStyle.Secondary),
        )],
        flags: MessageFlags.Ephemeral,
        withResponse: true,
    }).catch(() => null);

    const message = confirm?.resource?.message ?? await interaction.fetchReply().catch(() => null);
    if (!message) return;

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: i => i.user.id === interaction.user.id && [confirmId, cancelId].includes(i.customId),
            time: 30_000,
        });
    } catch {
        return interaction.editReply({ content: `Release cancelled — **${name}** stays with you.`, embeds: [], components: [] }).catch(() => {});
    }

    if (choice.customId === cancelId) {
        return choice.update({ content: `**${name}** stays with you.`, embeds: [], components: [] }).catch(() => {});
    }

    // Re-resolve by id: the roster may have changed while the prompt was open.
    // Dropping a pet by id is a pure function of the freshly read roster, so a
    // lost version race can simply replay instead of bouncing back to the user.
    let saved = null;
    let conflict = false;
    try {
        saved = await withVersionRetry(
            () => resolveUser(interaction),
            (fresh) => {
                const still = resolvePetRef(fresh?.pets, petId);
                if (!still) return false;
                fresh.pets.splice(still.index, 1);
                fresh.markModified('pets');
            },
            { label: 'pet release' }
        );
    } catch (err) {
        if (!isVersionError(err)) throw err;
        conflict = true;
    }

    if (conflict) {
        return choice.update({ content: 'Edit conflict — try again.', embeds: [], components: [] }).catch(() => {});
    }
    if (!saved) {
        return choice.update({ content: `**${name}** is no longer in your roster.`, embeds: [], components: [] }).catch(() => {});
    }

    return choice.update({
        content: `${def?.emoji ?? '🐾'} **${name}** has been released. Goodbye, friend!`,
        embeds: [], components: [],
    }).catch(() => {});
}

async function executeRename(interaction) {
    const newName = interaction.options.getString('name').trim().slice(0, 32);
    const slotRef = readSlotOption(interaction);

    // Setting a name is a pure function of the freshly read roster, so a lost
    // version race replays rather than asking the user to retype the command.
    // The first attempt resolves the slot the user asked for; every retry then
    // looks the pet up by its stable _id, since a numeric slot ref would land on
    // a different pet if a concurrent write reordered the roster in between.
    let saved    = null;
    let conflict = false;
    let def      = null;
    let pinnedId = null;
    try {
        saved = await withVersionRetry(
            () => resolveUser(interaction),
            (user) => {
                const target = resolvePetRef(user?.pets, pinnedId ?? slotRef);
                if (!target) return false;
                if (target.pet?._id) pinnedId = String(target.pet._id);
                user.pets[target.index].name = newName;
                user.markModified('pets');
                def = PET_DEFINITIONS[user.pets[target.index].petId];
            },
            { label: 'pet rename' }
        );
    } catch (err) {
        if (!isVersionError(err)) throw err;
        conflict = true;
    }

    if (conflict) return interaction.reply({ content: 'Edit conflict — try again.', flags: MessageFlags.Ephemeral });
    if (!saved)   return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });

    return interaction.reply({ content: `${def?.emoji ?? '🐾'} Pet renamed to **${newName}**!`, flags: MessageFlags.Ephemeral });
}

// ── Battle ──────────────────────────────────────────────────────────────────

function petUsable(pet) {
    if (!pet) return { ok: false, reason: 'no pet in that slot' };
    if (!isPetActive(pet)) return { ok: false, reason: 'too hungry to fight (feed it first)' };
    return { ok: true };
}

function onBattleCooldown(pet) {
    return pet?.lastBattle && Date.now() - new Date(pet.lastBattle).getTime() < BATTLE_COOLDOWN_MS;
}

// Snapshot the combat-relevant fields so result rendering reflects PRE-battle
// state even after applyPetXp mutates the live pet (level/stage/xp).
function petSnapshot(pet) {
    return { petId: pet.petId, name: pet.name, personality: pet.personality, level: pet.level ?? 1, evolutionStage: pet.evolutionStage ?? 1 };
}

// petA/petB must be PRE-battle snapshots: result.finalHpA/B and the HP-bar
// denominators (max HP) are computed from pre-battle stats, so rendering from
// post-XP pets would mismatch the bars and show the wrong level.
function battleResultEmbed({ color, title, petA, petB, result, currency, payoutLine, xpLineA, xpLineB }) {
    const da = getPetDisplay(petA), db = getPetDisplay(petB);
    const sa = getPetStats(petA),   sb = getPetStats(petB);
    return new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `${da.emoji} **${da.titledName}** (Lv.${petA.level ?? 1})  🆚  ${db.emoji} **${db.titledName}** (Lv.${petB.level ?? 1})\n\n` +
            `${da.emoji} ${hpBar(result.finalHpA, sa.hp)} ${Math.max(0, result.finalHpA)}/${sa.hp}\n` +
            `${db.emoji} ${hpBar(result.finalHpB, sb.hp)} ${Math.max(0, result.finalHpB)}/${sb.hp}\n\n` +
            battleLogLines(result.rounds, da.titledName, db.titledName).join('\n') +
            (payoutLine ? `\n\n${payoutLine}` : '') +
            (xpLineA ? `\n${xpLineA}` : '') +
            (xpLineB ? `\n${xpLineB}` : '')
        )
        .setTimestamp();
}

function petXpLine(name, res) {
    if (res.evolved)   return `🌟 **${name}** evolved to Stage ${res.toStage}! (+${res.gained} XP)`;
    if (res.leveledUp) return `📈 **${name}** reached Level ${res.toLevel}! (+${res.gained} XP)`;
    return `✨ **${name}** +${res.gained} XP`;
}

async function executeBattle(interaction) {
    const opponent = interaction.options.getUser('opponent');
    const petRef   = readSlotOption(interaction);
    const bet      = interaction.options.getInteger('bet') ?? 0;

    const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled in this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await resolveUser(interaction);
    await syncHungerAndRunaway(user, interaction);
    await user.save().catch(() => {});

    const mine = resolvePetRef(user?.pets, petRef);
    if (!mine) return interaction.reply({ content: NO_SUCH_PET, flags: MessageFlags.Ephemeral });
    const { pet: myPet } = mine;
    // Carry the pet's stable id, not its index: a PvP challenge can sit unanswered
    // for a minute, and anything that shrinks the array would shift the index onto
    // a different pet before the fight resolves.
    const myPetId = String(myPet._id);
    const usable  = petUsable(myPet);
    if (!usable.ok) {
        return interaction.reply({ content: `${getPetDisplay(myPet).titledName} is ${usable.reason}.`, flags: MessageFlags.Ephemeral });
    }

    // Per-pet cooldown
    if (myPet.lastBattle && Date.now() - new Date(myPet.lastBattle).getTime() < BATTLE_COOLDOWN_MS) {
        const mins = Math.ceil((BATTLE_COOLDOWN_MS - (Date.now() - new Date(myPet.lastBattle).getTime())) / 60000);
        return interaction.reply({ content: `${getPetDisplay(myPet).emoji} **${getPetDisplay(myPet).titledName}** is recovering — ready to battle again in **${mins}m**.`, flags: MessageFlags.Ephemeral });
    }

    if (!opponent) {
        if (bet > 0) {
            return interaction.reply({ content: "You can't wager against a wild pet — challenge a member instead.", flags: MessageFlags.Ephemeral });
        }
        return wildBattle(interaction, user, myPetId, currency, guildSettings);
    }

    // ── PvP setup ──
    if (bet > 0) {
        if (opponent.id === interaction.user.id) return interaction.reply({ content: "You can't wager against yourself.", flags: MessageFlags.Ephemeral });
        if (opponent.bot) return interaction.reply({ content: "Bots don't keep pets.", flags: MessageFlags.Ephemeral });
        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) return interaction.reply({ content: `The maximum battle wager here is **${maxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
        if (Date.now() - interaction.user.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS
            || Date.now() - opponent.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS) {
            return interaction.reply({ content: 'Both accounts must be at least 7 days old for wagered battles.', flags: MessageFlags.Ephemeral });
        }
    } else if (opponent.id === interaction.user.id || opponent.bot) {
        return interaction.reply({ content: 'Pick another member to battle.', flags: MessageFlags.Ephemeral });
    }

    const oppUser = await User.findOne({ userId: opponent.id, guildId: interaction.guild.id });
    const oppPet  = pickDefenderPet(oppUser?.pets, myPet.level ?? 1);
    if (!oppPet) {
        return interaction.reply({ content: `${opponent.username} has no battle-ready pet (they need a fed pet).`, flags: MessageFlags.Ephemeral });
    }

    if (bet > 0) {
        const gap = Math.abs((myPet.level ?? 1) - (oppPet.level ?? 1));
        if (gap > BATTLE_MAX_LEVEL_GAP) {
            return interaction.reply({
                content: `⚖️ Wagered battles are limited to a **${BATTLE_MAX_LEVEL_GAP}-level** gap, and the closest match ${opponent.username} can field is `
                       + `**Lv.${oppPet.level ?? 1}** against your **Lv.${myPet.level ?? 1}** — too lopsided to bet on. `
                       + `You can still fight a friendly match by leaving out the wager.`,
                flags: MessageFlags.Ephemeral,
            });
        }
    }

    return pvpBattle(interaction, { user, myPet, myPetId, opponent, oppUser, oppPet, bet, currency, guildSettings });
}

async function wildBattle(interaction, user, myPetId, currency, guildSettings) {
    await interaction.deferReply();
    const myPet  = resolvePetRef(user?.pets, myPetId).pet;
    const wild   = makeWildPet(myPet.level ?? 1);
    const mySnap = petSnapshot(myPet); // pre-XP snapshot for consistent result rendering
    const result = simulateBattle(myPet, wild);
    const won    = result.winner === 'a';

    const da = getPetDisplay(mySnap), db = getPetDisplay(wild);
    const intro = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('⚔️ A wild challenger appears!')
        .setDescription(`${da.emoji} **${da.titledName}** squares off against ${db.emoji} **${db.name}** (Lv.${wild.level})…`);
    await interaction.editReply({ embeds: [intro] });
    await _delay(1500);

    const xpRes = applyPetXp(myPet, won ? XP_WILD_WIN : XP_WILD_LOSS);
    myPet.lastBattle  = new Date();
    if (won) myPet.battleWins   = (myPet.battleWins ?? 0) + 1;
    else     myPet.battleLosses = (myPet.battleLosses ?? 0) + 1;
    user.markModified('pets');
    // A completed pet-care quest pays coins. `save()` writes `balance` as an
    // absolute `$set`, so the credit is folded out of the save and applied as its
    // own `$inc` — otherwise this write erases anything the player spent between
    // loading the document and here.
    const balanceBeforeCare = user.balance ?? 0;
    await creditPetCare(interaction, user, guildSettings);
    const earned = await collectPetAchievements(user, guildSettings);
    try {
        await saveWithBalanceDelta(User, user, balanceBeforeCare, {
            service: 'pet',
            jobName: 'battleQuestReward',
            guildId: interaction.guild.id,
        });
    } catch (err) {
        if (isVersionError(err)) return interaction.editReply({ content: 'Edit conflict — please try again.', embeds: [] });
        throw err;
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    return interaction.editReply({
        embeds: [battleResultEmbed({
            color: won ? '#2ecc71' : '#e74c3c',
            title: won ? `🏆 ${da.titledName} won the wild battle!` : `💀 ${da.titledName} was beaten back…`,
            petA: mySnap, petB: wild, result, currency,
            payoutLine: null,
            xpLineA: petXpLine(da.titledName, xpRes),
        })],
    });
}

async function pvpBattle(interaction, ctx) {
    const { myPet, myPetId, opponent, oppPet, bet, currency, guildSettings } = ctx;
    const guildId = interaction.guild.id;
    const da = getPetDisplay(myPet);
    const db = oppPet ? getPetDisplay(oppPet) : null;

    const acceptId  = `petb_accept_${interaction.id}`;
    const declineId = `petb_decline_${interaction.id}`;
    const challengeEmbed = new EmbedBuilder()
        .setColor('#9b59b6')
        .setTitle('⚔️ Pet Battle Challenge!')
        .setDescription(
            `${da.emoji} **${interaction.member?.displayName ?? interaction.user.username}'s ${da.titledName}** (Lv.${myPet.level ?? 1}) ` +
            `challenges ${opponent} to a battle!` +
            // Name the defending pet up front — it is chosen automatically as the
            // closest level match, and accepting blind to which pet fights is unfair.
            (db ? `\n\n${db.emoji} **${db.titledName}** (Lv.${oppPet.level ?? 1}) will answer the call.` : '') +
            (bet > 0 ? `\n\n💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot.` : '\n\n*Friendly match — pet XP only.*')
        )
        .setFooter({ text: 'Accept within 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('⚔️ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('🏳️ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();

    const collector = msg.createMessageComponentCollector({
        filter: i => i.user.id === opponent.id && [acceptId, declineId].includes(i.customId),
        max: 1, time: 60_000,
    });

    collector.on('collect', async i => {
        if (i.customId === declineId) {
            return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} declined the battle.`)], components: [] }).catch(() => {});
        }

        // Escrow wagers atomically (challenger then opponent), refund on shortfall
        if (bet > 0) {
            const ch = await User.findOneAndUpdate({ userId: interaction.user.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!ch) return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${interaction.user.username} can no longer cover the wager.`)], components: [] }).catch(() => {});
            const op = await User.findOneAndUpdate({ userId: opponent.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!op) {
                await User.updateOne({ userId: interaction.user.id, guildId }, { $inc: { balance: bet } });
                return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${opponent.username} can't cover the wager.`)], components: [] }).catch(() => {});
            }
        }

        await i.deferUpdate().catch(() => {});

        // Re-fetch both fighters fresh so concurrent feeds/battles are reflected
        const [chUser, opUser] = await Promise.all([
            User.findOne({ userId: interaction.user.id, guildId }),
            User.findOne({ userId: opponent.id, guildId }),
        ]);
        const aPet = resolvePetRef(chUser?.pets, myPetId)?.pet;
        const bPet = pickDefenderPet(opUser?.pets, aPet?.level ?? 1);

        // If a fighter is gone, no longer battle-ready, or went on cooldown
        // between the challenge and acceptance, refund and abort.
        const refundAndCancel = async (reason) => {
            if (bet > 0) {
                const [rA, rB] = await Promise.allSettled([
                    User.updateOne({ userId: interaction.user.id, guildId }, { $inc: { balance: bet } }),
                    User.updateOne({ userId: opponent.id, guildId }, { $inc: { balance: bet } }),
                ]);
                if (rA.status === 'rejected') console.error('[pet battle] refund failed for challenger:', rA.reason);
                if (rB.status === 'rejected') console.error('[pet battle] refund failed for opponent:', rB.reason);
            }
            return interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#e74c3c').setDescription(`${reason} — the battle was cancelled${bet > 0 ? ' and any wagers refunded' : ''}.`)], components: [] }).catch(() => {});
        };
        if (!aPet || !bPet) return refundAndCancel('A pet is no longer available');
        if (!petUsable(aPet).ok || !petUsable(bPet).ok) return refundAndCancel('A pet is no longer battle-ready');
        if (onBattleCooldown(aPet) || onBattleCooldown(bPet)) return refundAndCancel('A pet is now recovering from a recent battle');

        // Pre-battle snapshots for consistent result rendering (applyPetXp below mutates levels)
        const aSnap = petSnapshot(aPet), bSnap = petSnapshot(bPet);
        const result = simulateBattle(aPet, bPet);
        const aWon   = result.winner === 'a';

        const intro = new EmbedBuilder()
            .setColor('#9b59b6').setTitle('⚔️ Battle commencing…')
            .setDescription(`${getPetDisplay(aPet).emoji} **${getPetDisplay(aPet).titledName}**  🆚  ${getPetDisplay(bPet).emoji} **${getPetDisplay(bPet).titledName}**`);
        await interaction.editReply({ content: null, embeds: [intro], components: [] }).catch(() => {});
        await _delay(1800);

        // XP + records
        const aXp = applyPetXp(aPet, aWon ? XP_BATTLE_WIN : XP_BATTLE_LOSS);
        const bXp = applyPetXp(bPet, aWon ? XP_BATTLE_LOSS : XP_BATTLE_WIN);
        if (aWon) { aPet.battleWins = (aPet.battleWins ?? 0) + 1; bPet.battleLosses = (bPet.battleLosses ?? 0) + 1; }
        else      { bPet.battleWins = (bPet.battleWins ?? 0) + 1; aPet.battleLosses = (aPet.battleLosses ?? 0) + 1; }
        aPet.lastBattle = new Date(); bPet.lastBattle = new Date();
        chUser.markModified('pets'); opUser.markModified('pets');

        // Payout
        let payoutLine = null;
        if (bet > 0) {
            const pot      = bet * 2;
            const houseCut = guildSettings?.economy?.duelHouseCut ?? BATTLE_RAKE;
            const payout   = pot - Math.floor(pot * houseCut);
            const winnerId = aWon ? interaction.user.id : opponent.id;
            const loserId  = aWon ? opponent.id : interaction.user.id;
            // chUser/opUser balances are post-escrow; loser keeps theirs, winner gains the pot.
            const loserBalance  = (aWon ? opUser : chUser).balance ?? 0;
            const winnerBalance = ((aWon ? chUser : opUser).balance ?? 0) + payout;
            await User.updateOne({ userId: winnerId, guildId }, { $inc: { balance: payout } });
            logTransaction({ userId: winnerId, guildId, type: 'pet_battle', amount: payout - bet, balance: winnerBalance, relatedUserId: loserId, note: 'Pet battle win' });
            logTransaction({ userId: loserId,  guildId, type: 'pet_battle', amount: -bet, balance: loserBalance, relatedUserId: winnerId, note: 'Pet battle loss' });
            const winnerName = aWon ? interaction.user.username : opponent.username;
            payoutLine = `🏆 **${winnerName}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**` +
                (houseCut > 0 ? `  *(house kept ${Math.round(houseCut * 100)}%)*` : '');
        }

        // Both documents are post-escrow, and the winner's pot was just paid with
        // an `$inc`. Saving either one with a modified `balance` would write that
        // stale snapshot back over the payout, so quest coins go out as their own
        // `$inc` too and `balance` stays out of both saves.
        const chBalanceBeforeCare = chUser.balance ?? 0;
        const opBalanceBeforeCare = opUser.balance ?? 0;
        await creditPetCare(interaction, chUser, guildSettings);
        await creditPetCare(interaction, opUser, guildSettings);
        const [earnedA, earnedB] = await Promise.all([
            collectPetAchievements(chUser, guildSettings),
            collectPetAchievements(opUser, guildSettings),
        ]);
        // allSettled, not all: `all` rejects on the first failure and leaves the
        // second rejection unobserved, which Node reports as an unhandled
        // rejection. Both saves have to be waited on and both reported.
        const [chSaved, opSaved] = await Promise.allSettled([
            saveWithBalanceDelta(User, chUser, chBalanceBeforeCare, {
                service: 'pet', jobName: 'battleQuestReward', guildId,
            }),
            saveWithBalanceDelta(User, opUser, opBalanceBeforeCare, {
                service: 'pet', jobName: 'battleQuestReward', guildId,
            }),
        ]);
        if (chSaved.status === 'rejected') console.error('[pet battle] challenger save error:', chSaved.reason);
        if (opSaved.status === 'rejected') console.error('[pet battle] opponent save error:', opSaved.reason);

        // The wager is already settled — the stakes were escrowed and the pot
        // paid with `$inc`s above — so the result still stands and is still
        // reported. What a failed save costs is the pet XP, the win/loss record
        // and the battle cooldown, and that has to be said rather than shown as
        // a battle that was fully recorded.
        const saveFailed = chSaved.status === 'rejected' || opSaved.status === 'rejected';
        const saveNote = saveFailed
            ? '\n⚠️ *The battle result could not be saved — pet XP, records and cooldowns were not updated.*'
            : '';

        announcePetAchievements(interaction, chUser, guildSettings, earnedA);
        announcePetAchievements(interaction, opUser, guildSettings, earnedB);

        const da2 = getPetDisplay(aSnap), db2 = getPetDisplay(bSnap);
        const winnerDisp = aWon ? da2 : db2;
        return interaction.editReply({
            content: null,
            embeds: [battleResultEmbed({
                color: '#f1c40f',
                title: `🏆 ${winnerDisp.titledName} wins the battle!`,
                petA: aSnap, petB: bSnap, result, currency,
                payoutLine,
                xpLineA: petXpLine(da2.titledName, aXp),
                xpLineB: petXpLine(db2.titledName, bXp) + saveNote,
            })],
            components: [],
        }).catch(() => {});
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor('#95a5a6').setDescription(`${opponent.username} didn't respond in time.`)], components: [] }).catch(() => {});
        }
    });
}

async function executeList(interaction) {
    const lines = Object.values(PET_DEFINITIONS)
        .filter(d => d.purchasable)
        .map(d => `${d.emoji} **${d.name}** — ${d.cost.toLocaleString()} coins\n`
                + `Bonus: +${d.bonusPct}% ${d.bonusType.replace(/_/g, ' ')} → **+${(d.bonusPct * 2.5).toFixed(1)}%** at Lv.${PET_MAX_LEVEL}  |  Fave food: \`${d.favoriteMaterial}\``);

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle('🐾 Pet Shop')
        .setDescription(`Pets level up from feeding and battling, and their passive grows with them.\n\n${lines.join('\n\n')}`)
        .setFooter({ text: `Eagle, Shark and Crystal Fox aren't sold — each has a ${Math.round(RARE_PET_DROP_CHANCE * 100)}% chance to appear on a legendary hunt / fish / mine` })
        .setTimestamp();

    return interaction.reply({ embeds: [embed] });
}

async function executeLeaderboard(interaction) {
    await interaction.deferReply();

    const sortType = interaction.options.getString('type') ?? 'bonds';

    let sortStage, addFieldsStage, titleLabel, lineBuilder;

    if (sortType === 'level') {
        addFieldsStage = { $addFields: { petLevel: '$pets.level' } };
        sortStage = { $sort: { petLevel: -1 } };
        titleLabel = 'Highest Level Pets';
        lineBuilder = (e, rank) => {
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const stage = e.pet.evolutionStage ?? 1;
            const stageEmoji = stage >= 3 ? '🌟' : stage >= 2 ? '✨' : '';
            return `${rank} ${def?.emoji ?? '🐾'} **${name}** ${stageEmoji} — Lv**${e.pet.level ?? 1}** — <@${e.userId}>`;
        };
    } else if (sortType === 'wins') {
        addFieldsStage = { $addFields: { petWins: '$pets.battleWins' } };
        sortStage = { $sort: { petWins: -1 } };
        titleLabel = 'Most Battle Wins';
        lineBuilder = (e, rank) => {
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const wins   = e.pet.battleWins   ?? 0;
            const losses = e.pet.battleLosses ?? 0;
            return `${rank} ${def?.emoji ?? '🐾'} **${name}** — ⚔️ ${wins}W / ${losses}L — <@${e.userId}>`;
        };
    } else {
        // Default: bond days
        addFieldsStage = { $addFields: { bondDays: { $toInt: { $divide: [{ $subtract: [new Date(), '$pets.adoptedAt'] }, 86400000] } } } };
        sortStage = { $sort: { bondDays: -1 } };
        titleLabel = 'Most Bonded Pets';
        lineBuilder = (e, rank) => {
            const def  = PET_DEFINITIONS[e.pet.petId];
            const name = e.pet.name || def?.name || e.pet.petId;
            const potw = e.pet.potw ? ' 🌟' : '';
            return `${rank} ${def?.emoji ?? '🐾'} **${name}**${potw} — ${heartBar(e.bondDays)} ${e.bondDays}d — <@${e.userId}>`;
        };
    }

    const top = await User.aggregate([
        { $match: { guildId: interaction.guild.id, 'pets.0': { $exists: true } } },
        { $unwind: '$pets' },
        addFieldsStage,
        sortStage,
        { $limit: 10 },
        { $project: { _id: 0, userId: 1, pet: '$pets', bondDays: 1, petLevel: 1, petWins: 1 } },
    ]);

    const medals = ['🥇', '🥈', '🥉'];
    const lines  = top.map((e, i) => lineBuilder(e, medals[i] ?? `${i + 1}.`));

    const embed = new EmbedBuilder()
        .setColor('#ff9800')
        .setTitle(`🐾 Pet Leaderboard — ${titleLabel}`)
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
                .addStringOption(opt =>
                    opt.setName('name').setDescription('Give your pet a name right away (optional, max 32 chars)').setRequired(false).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('status').setDescription('View your pets and their mood.'))
        .addSubcommand(sub =>
            sub.setName('feed')
                .setDescription('Feed a pet — favourite foods restore the most and grant bonus XP.')
                .addStringOption(opt =>
                    opt.setName('material').setDescription('Which food to use — start typing to see what you have').setRequired(true).setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to feed (defaults to your first)').setRequired(false).setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('release')
                .setDescription('Release a pet permanently.')
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to release').setRequired(true).setAutocomplete(true)
                )
        )
        .addSubcommand(sub =>
            sub.setName('rename')
                .setDescription('Give your pet a custom name.')
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which pet to rename').setRequired(true).setAutocomplete(true)
                )
                .addStringOption(opt =>
                    opt.setName('name').setDescription('New name (max 32 chars)').setRequired(true).setMaxLength(32)
                )
        )
        .addSubcommand(sub => sub.setName('list').setDescription('View all available pets in the shop.'))
        .addSubcommand(sub =>
            sub.setName('leaderboard')
                .setDescription('View the top pets in this server.')
                .addStringOption(opt =>
                    opt.setName('type')
                        .setDescription('Sort order (default: bond days)')
                        .setRequired(false)
                        .addChoices(
                            { name: 'Bond Days (Most Loyal)', value: 'bonds' },
                            { name: 'Level (Highest Level)', value: 'level' },
                            { name: 'Battle Wins',            value: 'wins'  }
                        )
                )
        )
        .addSubcommand(sub =>
            sub.setName('battle')
                .setDescription('Battle a wild pet for XP, or challenge another member (optionally for coins).')
                .addUserOption(opt =>
                    opt.setName('opponent').setDescription('Member to challenge (leave empty to fight a wild pet)').setRequired(false))
                .addStringOption(opt =>
                    opt.setName('slot').setDescription('Which of your pets fights (defaults to your first)').setRequired(false).setAutocomplete(true))
                .addIntegerOption(opt =>
                    opt.setName('bet').setDescription('Coins to wager (requires an opponent)').setRequired(false).setMinValue(1))),

    async autocomplete(interaction) {
        try {
            const focused = interaction.options.getFocused(true);
            if (focused.name === 'slot')     return await slotAutocomplete(interaction, focused.value ?? '');
            if (focused.name === 'material') return await materialAutocomplete(interaction, focused.value ?? '');
            return await interaction.respond([]);
        } catch (err) {
            console.error('[pet] autocomplete error:', err);
            return interaction.respond([]).catch(() => {});
        }
    },

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
            if (sub === 'battle')      return await executeBattle(interaction);
        } catch (err) {
            console.error('[pet] error:', err);
            const msg = { content: 'Something went wrong with the pet command.', flags: MessageFlags.Ephemeral };
            if (interaction.replied || interaction.deferred) return interaction.followUp(msg);
            return interaction.reply(msg);
        }
    }
};
