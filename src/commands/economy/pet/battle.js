'use strict';

const { EmbedBuilder, MessageFlags } = require('discord.js');
const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const {
    getPetDisplay,
    simulateBattle,
    makeWildPet,
    applyPetXp,
    recordBondCare,
    resolvePetRef,
    XP_WILD_WIN,
    XP_WILD_LOSS,
} = require('../../../services/petService');
const { isVersionError } = require('../../../utils/versionRetry');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const COLORS = require('../../../utils/embedColors');
const { petArt } = require('../../../services/petStatusView');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const {
    NO_SUCH_PET, resolveUser, syncHungerAndRunaway, readSlotOption,
    creditPetCare, collectPetAchievements, announcePetAchievements,
} = require('./shared');
const { revealEvolution } = require('./evolution');
const {
    BATTLE_COOLDOWN_MS, petUsable, petSnapshot, moveTag, battleResultEmbed, petXpLine,
} = require('./battleShared');
const { pvpBattle } = require('./pvp');

const BATTLE_MIN_ACCOUNT_AGE_MS = 7 * 24 * 3_600_000; // wagered and rated battles only
const _delay = ms => new Promise(r => setTimeout(r, ms));

async function executeBattle(interaction) {
    const opponent = interaction.options.getUser('opponent');
    const petRef   = readSlotOption(interaction);
    const bet      = interaction.options.getInteger('bet') ?? 0;
    const rated    = interaction.options.getBoolean('rated') ?? false;

    const guildSettings = await getGuildSettings(interaction.guild.id);
    if (guildSettings?.economy?.enabled === false) {
        return interaction.reply({ content: 'The economy is disabled in this server.', flags: MessageFlags.Ephemeral });
    }
    const currency = guildSettings?.economy?.currency ?? '💰';

    const user = await resolveUser(interaction);
    const sync = await syncHungerAndRunaway(user, interaction);
    if (sync?.saveError) {
        if (isVersionError(sync.saveError)) {
            return interaction.reply({ content: 'Edit conflict — please try again.', flags: MessageFlags.Ephemeral });
        }
        throw sync.saveError;
    }
    // Persist the decay just applied. This used to swallow every error, which
    // hid a failed write behind a battle that then went ahead on stale state.
    try {
        await user.save();
    } catch (err) {
        if (isVersionError(err)) {
            return interaction.reply({ content: 'Edit conflict — please try again.', flags: MessageFlags.Ephemeral });
        }
        throw err;
    }

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
        if (rated) {
            return interaction.reply({ content: 'Rated battles are against members — challenge someone with `opponent`.', flags: MessageFlags.Ephemeral });
        }
        if (bet > 0) {
            return interaction.reply({ content: "You can't wager against a wild pet — challenge a member instead.", flags: MessageFlags.Ephemeral });
        }
        return wildBattle(interaction, user, myPetId, currency, guildSettings);
    }

    // ── PvP setup ──
    if (opponent.id === interaction.user.id || opponent.bot) {
        if (bet > 0 && opponent.id === interaction.user.id) return interaction.reply({ content: "You can't wager against yourself.", flags: MessageFlags.Ephemeral });
        if (bet > 0) return interaction.reply({ content: "Bots don't keep pets.", flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: 'Pick another member to battle.', flags: MessageFlags.Ephemeral });
    }
    if (bet > 0) {
        const maxBet = guildSettings?.economy?.duelMaxBet ?? 10_000;
        if (bet > maxBet) return interaction.reply({ content: `The maximum battle wager here is **${maxBet.toLocaleString()}** coins.`, flags: MessageFlags.Ephemeral });
    }
    // A wager moves coins and a rated battle moves the ladder: both are worth
    // an alt account, so both ask for two accounts that are not brand new.
    if ((bet > 0 || rated)
        && (Date.now() - interaction.user.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS
            || Date.now() - opponent.createdTimestamp < BATTLE_MIN_ACCOUNT_AGE_MS)) {
        return interaction.reply({
            content: `Both accounts must be at least 7 days old for ${bet > 0 ? 'wagered' : 'rated'} battles.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    const oppUser = await User.findOne({ userId: opponent.id, guildId: interaction.guild.id });
    return pvpBattle(interaction, { myPet, myPetId, opponent, oppUser, bet, rated, currency, guildSettings });
}

async function wildBattle(interaction, user, myPetId, currency, guildSettings) {
    await interaction.deferReply();
    const myPet  = resolvePetRef(user?.pets, myPetId).pet;
    const wild   = makeWildPet(myPet.level ?? 1);
    const mySnap = petSnapshot(myPet); // pre-XP snapshot for consistent result rendering
    const result = simulateBattle(myPet, wild);
    const won    = result.winner === 'a';

    const da = getPetDisplay(mySnap), db = getPetDisplay(wild);
    // The wild species ship portrait art (issue #1082); show it on both frames.
    const wildArt = await petArt(wild.petId, interaction.guild.id, db.name);
    const artFiles = wildArt ? [wildArt.attachment] : [];
    const intro = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('⚔️ A wild challenger appears!')
        .setDescription(
            `${da.emoji} **${da.titledName}**${moveTag(mySnap.petId)}\n`
            + `squares off against ${db.emoji} **${db.name}** (Lv.${wild.level})${moveTag(wild.petId)}…`
        );
    if (wildArt) intro.setThumbnail(wildArt.url);
    await interaction.editReply({ embeds: [intro], files: artFiles });
    await _delay(1500);

    const xpRes = applyPetXp(myPet, won ? XP_WILD_WIN : XP_WILD_LOSS);
    myPet.lastBattle  = new Date();
    // A fight is the pet's training, and counts as care toward its bond.
    recordBondCare(myPet, 'battle');
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
            // Keyed (#873, pass 11): a pet-care quest completing off this battle
            // pays coins exactly once and is replayable on failure.
            payoutKey: questRewardPayoutKey('pet', interaction.id),
        });
    } catch (err) {
        if (isVersionError(err)) return interaction.editReply({ content: 'Edit conflict — please try again.', embeds: [] });
        throw err;
    }
    announcePetAchievements(interaction, user, guildSettings, earned);

    const resultEmbed = battleResultEmbed({
        color: won ? '#2ecc71' : '#e74c3c',
        title: won ? `🏆 ${da.titledName} won the wild battle!` : `💀 ${da.titledName} was beaten back…`,
        petA: mySnap, petB: wild, result, currency,
        payoutLine: null,
        xpLineA: petXpLine(da.titledName, xpRes),
    });
    if (wildArt) resultEmbed.setThumbnail(wildArt.url);
    await interaction.editReply({ embeds: [resultEmbed], files: artFiles, attachments: [] });
    await revealEvolution(interaction, myPet, xpRes, {
        ownerId: interaction.user.id, ownerName: interaction.member?.displayName ?? interaction.user.username,
    });
}

module.exports = { executeBattle };
