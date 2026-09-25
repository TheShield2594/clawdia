'use strict';

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags,
} = require('discord.js');
const User = require('../../../models/User');
const { getGuildSettings } = require('../../../utils/guildSettingsCache');
const {
    isPetActive,
    isOnVacation,
    pickDefenderPet,
    getPetDisplay,
    getPetStats,
    getSpeciesMove,
    simulateBattle,
    makeWildPet,
    levelMatched,
    applyPetXp,
    recordBondCare,
    resolvePetRef,
    XP_BATTLE_WIN,
    XP_BATTLE_LOSS,
    XP_WILD_WIN,
    XP_WILD_LOSS,
} = require('../../../services/petService');
const { isVersionError } = require('../../../utils/versionRetry');
const { logTransaction } = require('../../../utils/logTransaction');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const COLORS = require('../../../utils/embedColors');
const { petArt } = require('../../../services/petStatusView');
const { ownedBy } = require('../../../utils/collectorOwner');
const {
    payBattleWinner, refundBattleStake, refundBothStakes, battleRefundNote, stakeRefundNote,
} = require('../../../utils/petEconomy');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const {
    NO_SUCH_PET, resolveUser, syncHungerAndRunaway, readSlotOption,
    creditPetCare, collectPetAchievements, announcePetAchievements,
} = require('./shared');
const { revealEvolution } = require('./evolution');

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

// Lines kept in the battle log, and how many of the last exchanges always show.
const BATTLE_LOG_MAX  = 8;
const BATTLE_LOG_TAIL = 4;

/**
 * Compact battle log, at most BATTLE_LOG_MAX lines: the last few exchanges of
 * the fight, plus earlier rounds where a signature move fired (#1183), so a
 * Pack Howl on round two is not cut off by the rounds after it. In a long
 * fight with many moves, the earliest move rounds are the ones dropped.
 */
function battleLogLines(rounds, nameA, nameB) {
    const nameOf = side => (side === 'a' ? nameA : nameB);
    const keep = rounds
        .map((rd, i) => ({ rd, i }))
        .filter(({ rd, i }) => i >= rounds.length - BATTLE_LOG_TAIL || rd.moves?.length)
        .slice(-BATTLE_LOG_MAX);
    return keep.map(({ rd }) => {
        const who = nameOf(rd.attacker);
        const tgt = nameOf(rd.attacker === 'a' ? 'b' : 'a');
        const hit = rd.missed
            ? `• **${who}** misses **${tgt}**`
            : `• **${who}** hits **${tgt}** for **${rd.damage}**${rd.crit ? ' 💥' : ''}`;
        // One mention per move per round, e.g. Crystal Ward soaking a double hit.
        const moves = [...new Map((rd.moves ?? []).map(m => [`${m.side}:${m.name}`, m])).values()]
            .map(m => ` · 🌀 ${nameOf(m.side)}'s *${m.name}*`);
        return hit + moves.join('');
    });
}

function petUsable(pet) {
    if (!pet) return { ok: false, reason: 'no pet in that slot' };
    if (isOnVacation(pet)) return { ok: false, reason: 'on vacation — end it with `/pet vacation off` to battle' };
    if (!isPetActive(pet)) return { ok: false, reason: 'too hungry to fight (feed it first)' };
    return { ok: true };
}

function onBattleCooldown(pet) {
    return pet?.lastBattle && Date.now() - new Date(pet.lastBattle).getTime() < BATTLE_COOLDOWN_MS;
}

// Snapshot the combat-relevant fields so result rendering reflects PRE-battle
// state even after applyPetXp mutates the live pet (level/stage/xp).
function petSnapshot(pet) {
    const training = pet.training ? { ...(pet.training.toObject ? pet.training.toObject() : pet.training) } : undefined;
    return { petId: pet.petId, name: pet.name, personality: pet.personality, level: pet.level ?? 1, evolutionStage: pet.evolutionStage ?? 1, training };
}

/** "Pack Howl" in italics after a name, for the intro lines, or ''. */
function moveTag(petId) {
    const move = getSpeciesMove(petId);
    return move ? ` · 🌀 *${move.name}*` : '';
}

// petA/petB must be PRE-battle snapshots: result.finalHpA/B and the HP-bar
// denominators (max HP) are computed from pre-battle stats, so rendering from
// post-XP pets would mismatch the bars and show the wrong level.
function battleResultEmbed({ color, title, petA, petB, result, _currency, payoutLine, xpLineA, xpLineB }) {
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

async function pvpBattle(interaction, ctx) {
    const { myPet, myPetId, opponent, oppPet, bet, currency, guildSettings } = ctx;
    const guildId = interaction.guild.id;
    // Names this battle for its escrow refunds and its winner payout — the one
    // identifier that survives the 60s challenge window and the collector
    // callback that settles the fight, so a live credit and its replay agree.
    const battleId = interaction.id;
    const da = getPetDisplay(myPet);
    const db = oppPet ? getPetDisplay(oppPet) : null;

    const acceptId  = `petb_accept_${interaction.id}`;
    const declineId = `petb_decline_${interaction.id}`;
    const challengeEmbed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle('⚔️ Pet Battle Challenge!')
        .setDescription(
            `${da.emoji} **${interaction.member?.displayName ?? interaction.user.username}'s ${da.titledName}** (Lv.${myPet.level ?? 1}) ` +
            `challenges ${opponent} to a battle!` +
            // Name the defending pet up front — it is chosen automatically as the
            // closest level match, and accepting blind to which pet fights is unfair.
            (db ? `\n\n${db.emoji} **${db.titledName}** (Lv.${oppPet.level ?? 1}) will answer the call.` : '') +
            (bet > 0
                ? `\n\n💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot.\n⚖️ *Wagered battles are level-matched: both pets fight at the lower pet's level.*`
                : '\n\n*Friendly match — pet XP only.*')
        )
        .setFooter({ text: 'Accept within 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('⚔️ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('🏳️ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();

    const collector = msg.createMessageComponentCollector({
        filter: ownedBy(opponent.id, i => [acceptId, declineId].includes(i.customId), "This isn't your pet."),
        max: 1, time: 60_000,
    });

    collector.on('collect', async i => {
        if (i.customId === declineId) {
            return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(COLORS.NEUTRAL).setDescription(`${opponent.username} declined the battle.`)], components: [] }).catch(() => {});
        }

        // Escrow wagers atomically (challenger then opponent), refund on shortfall.
        // Each debit is a guarded compare-and-set read back here, so by the time a
        // refund runs the debit is known to have landed — an unconditional keyed
        // credit is the right compensation, and the bare `$inc` that read nothing
        // back and announced the refund regardless is gone (#873, pass 10).
        if (bet > 0) {
            const ch = await User.findOneAndUpdate({ userId: interaction.user.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!ch) return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(COLORS.ERROR).setDescription(`${interaction.user.username} can no longer cover the wager.`)], components: [] }).catch(() => {});
            const op = await User.findOneAndUpdate({ userId: opponent.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
            if (!op) {
                const back = await refundBattleStake(interaction.user.id, guildId, bet, battleId);
                return i.update({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(COLORS.ERROR).setDescription(`${opponent.username} can't cover the wager.${stakeRefundNote(back)}`)], components: [] }).catch(() => {});
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
        // between the challenge and acceptance, refund and abort. Both stakes are
        // known to have landed above, so both come back through the keyed refund.
        const refundAndCancel = async (reason) => {
            let note = '';
            if (bet > 0) {
                const returned = await refundBothStakes(interaction.user.id, opponent.id, guildId, bet, battleId);
                note = battleRefundNote(returned);
            }
            return interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(COLORS.ERROR).setDescription(`${reason} — the battle was cancelled.${note}`)], components: [] }).catch(() => {});
        };
        if (!aPet || !bPet) return refundAndCancel('A pet is no longer available');
        if (!petUsable(aPet).ok || !petUsable(bPet).ok) return refundAndCancel('A pet is no longer battle-ready');
        if (onBattleCooldown(aPet) || onBattleCooldown(bPet)) return refundAndCancel('A pet is now recovering from a recent battle');
        // The wager's level-gap limit, asked again of the pets that will
        // actually fight. The defender is re-picked here — the one named in the
        // challenge may have gone hungry, or either pet levelled since — and the
        // limit used to be checked only at the challenge, so a wager could be
        // fought across any gap (#873).
        if (bet > 0 && Math.abs((aPet.level ?? 1) - (bPet.level ?? 1)) > BATTLE_MAX_LEVEL_GAP) {
            return refundAndCancel(`The pets that would fight are now more than ${BATTLE_MAX_LEVEL_GAP} levels apart, the limit for a wagered battle`);
        }

        // A wager fights both pets at the lower level, so the coins ride on the
        // matchup rather than on who has grinded further (see levelMatched).
        // The snapshots are what fought, so the HP bars and levels in the
        // result embed match the stats the simulation used.
        const [aFighter, bFighter] = bet > 0 ? levelMatched(aPet, bPet) : [aPet, bPet];
        const aSnap = petSnapshot(aFighter), bSnap = petSnapshot(bFighter);
        const result = simulateBattle(aFighter, bFighter);
        const aWon   = result.winner === 'a';

        const intro = new EmbedBuilder()
            .setColor(COLORS.RARE).setTitle('⚔️ Battle commencing…')
            .setDescription(
                `${getPetDisplay(aPet).emoji} **${getPetDisplay(aPet).titledName}**${moveTag(aPet.petId)}\n🆚\n`
                + `${getPetDisplay(bPet).emoji} **${getPetDisplay(bPet).titledName}**${moveTag(bPet.petId)}`
            );
        await interaction.editReply({ content: null, embeds: [intro], components: [] }).catch(() => {});
        await _delay(1800);

        // XP + records
        const aXp = applyPetXp(aPet, aWon ? XP_BATTLE_WIN : XP_BATTLE_LOSS);
        const bXp = applyPetXp(bPet, aWon ? XP_BATTLE_LOSS : XP_BATTLE_WIN);
        const [winPet, losePet] = aWon ? [aPet, bPet] : [bPet, aPet];
        winPet.battleWins  = (winPet.battleWins ?? 0) + 1;
        winPet.pvpWins     = (winPet.pvpWins ?? 0) + 1;
        losePet.battleLosses = (losePet.battleLosses ?? 0) + 1;
        losePet.pvpLosses    = (losePet.pvpLosses ?? 0) + 1;
        aPet.lastBattle = new Date(); bPet.lastBattle = new Date();
        // Only the challenger chose to train; the defender's owner did nothing.
        recordBondCare(aPet, 'battle');
        chUser.markModified('pets'); opUser.markModified('pets');

        // Payout — the pot moves on its own keyed write. It was a bare `$inc` that
        // read nothing back and announced the win regardless (#873, pass 10); the
        // embed is worded from what the credit did, and a pot that will not land
        // is recorded as owed for `payouts:replay` rather than lost.
        let payoutLine = null;
        if (bet > 0) {
            const pot      = bet * 2;
            const houseCut = guildSettings?.economy?.duelHouseCut ?? BATTLE_RAKE;
            const payout   = pot - Math.floor(pot * houseCut);
            const winnerId = aWon ? interaction.user.id : opponent.id;
            const loserId  = aWon ? opponent.id : interaction.user.id;
            const winnerName = aWon ? interaction.user.username : opponent.username;

            const paid = await payBattleWinner(winnerId, guildId, payout, battleId);

            // chUser/opUser balances are post-escrow; the loser keeps theirs.
            const loserBalance = (aWon ? opUser : chUser).balance ?? 0;
            logTransaction({ userId: loserId, guildId, type: 'pet_battle', amount: -bet, balance: loserBalance, relatedUserId: winnerId, note: 'Pet battle loss' });

            if (paid.credited) {
                const winnerBalance = paid.doc?.balance ?? (((aWon ? chUser : opUser).balance ?? 0) + payout);
                logTransaction({ userId: winnerId, guildId, type: 'pet_battle', amount: payout - bet, balance: winnerBalance, relatedUserId: loserId, note: 'Pet battle win' });
                payoutLine = `🏆 **${winnerName}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**` +
                    (houseCut > 0 ? `  *(house kept ${Math.round(houseCut * 100)}%)*` : '');
            } else {
                // The pot is both players' stakes and has nowhere else to be, so a
                // failed payout is not announced as a win — the honest wording is
                // where the coins went.
                payoutLine = `🏆 **${winnerName}** won, but the **${currency}${payout.toLocaleString()}** pot could not be paid out — ` +
                    (paid.owed ? 'it is recorded and an admin can restore it.' : 'please contact a server admin.');
            }
        }

        // Both documents are post-escrow, and the winner's pot was just paid on
        // its own keyed write. Saving either one with a modified `balance` would
        // write that stale snapshot back over the payout, so quest coins go out as
        // their own `$inc` too and `balance` stays out of both saves.
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
        // Keyed (#873, pass 11), one key per fighter. The two credits land on
        // two different documents, so the shared string cannot collide; the
        // battle settles once per interaction, so each fighter's care reward is
        // credited once and recorded as owed on failure.
        const chQuestKey = questRewardPayoutKey('pet', `${interaction.id}:${chUser.userId}`);
        const opQuestKey = questRewardPayoutKey('pet', `${interaction.id}:${opUser.userId}`);
        const [chSaved, opSaved] = await Promise.allSettled([
            saveWithBalanceDelta(User, chUser, chBalanceBeforeCare, {
                service: 'pet', jobName: 'battleQuestReward', guildId, payoutKey: chQuestKey,
            }),
            saveWithBalanceDelta(User, opUser, opBalanceBeforeCare, {
                service: 'pet', jobName: 'battleQuestReward', guildId, payoutKey: opQuestKey,
            }),
        ]);
        if (chSaved.status === 'rejected') console.error('[pet battle] challenger save error:', chSaved.reason);
        if (opSaved.status === 'rejected') console.error('[pet battle] opponent save error:', opSaved.reason);

        // The wager is already settled — the stakes were escrowed and the pot
        // paid above — so the result still stands and is still reported. What a
        // failed save costs is the pet XP, the win/loss record and the battle
        // cooldown, and that has to be said rather than shown as a battle that was
        // fully recorded.
        const saveFailed = chSaved.status === 'rejected' || opSaved.status === 'rejected';
        const saveNote = saveFailed
            ? '\n⚠️ *The battle result could not be saved — pet XP, records and cooldowns were not updated.*'
            : '';

        announcePetAchievements(interaction, chUser, guildSettings, earnedA);
        announcePetAchievements(interaction, opUser, guildSettings, earnedB);

        const da2 = getPetDisplay(aSnap), db2 = getPetDisplay(bSnap);
        const winnerDisp = aWon ? da2 : db2;
        await interaction.editReply({
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
        // Each side's reveal only once its evolution is actually saved.
        if (chSaved.status === 'fulfilled') {
            await revealEvolution(interaction, aPet, aXp, {
                ownerId: interaction.user.id, ownerName: interaction.member?.displayName ?? interaction.user.username,
            });
        }
        if (opSaved.status === 'fulfilled') {
            await revealEvolution(interaction, bPet, bXp, { ownerId: opponent.id, ownerName: opponent.globalName ?? opponent.username });
        }
    });

    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            interaction.editReply({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(COLORS.NEUTRAL).setDescription(`${opponent.username} didn't respond in time.`)], components: [] }).catch(() => {});
        }
    });
}

module.exports = { executeBattle };
