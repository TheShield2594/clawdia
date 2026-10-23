'use strict';

// /pet battle against a member (#1184): the challenge, the defender choosing
// which pet answers it, the wager escrow, then up to STANCE_ROUNDS stance
// rounds — both owners pick Strike, Guard or Trick in secret, and the round is
// revealed with its exchanges — and the settlement: XP, records, the pot, and
// for a rated battle the ladder (#1185).
//
// Everything is on the one challenge message. The stance buttons are public,
// but a press is answered ephemerally, so neither owner sees the other's pick
// until the round is revealed.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, MessageFlags,
} = require('discord.js');
const User = require('../../../models/User');
const {
    isPetActive,
    pickDefenderPet,
    getPetDisplay,
    levelMatched,
    applyPetXp,
    recordBondCare,
    resolvePetRef,
    createBattle,
    battleOngoing,
    battleVerdict,
    fightStanceRound,
    randomStance,
    STANCES,
    STANCE_KEYS,
    STANCE_ROUNDS,
    XP_BATTLE_WIN,
    XP_BATTLE_LOSS,
} = require('../../../services/petService');
const {
    getLadder, entryOf, ratedPairAllowed, withinBand, ratedEligibility, recordRatedResult,
} = require('../../../services/petLadderService');
const { tierFor } = require('../../../utils/duelElo');
const { logTransaction } = require('../../../utils/logTransaction');
const { saveWithBalanceDelta } = require('../../../utils/balanceDelta');
const COLORS = require('../../../utils/embedColors');
const { petArt } = require('../../../services/petStatusView');
const { renderVersusBanner, BANNER_NAME } = require('../../../utils/petVersusBanner');
const { ownedBy } = require('../../../utils/collectorOwner');
const {
    payBattleWinner, refundBattleStake, refundBothStakes, battleRefundNote, stakeRefundNote,
} = require('../../../utils/petEconomy');
const { questRewardPayoutKey } = require('../../../utils/payoutKey');
const { notePetStake, clearPendingPetBattle } = require('../../../services/petBattleEscrowSweep');
const { creditPetCare, collectPetAchievements, announcePetAchievements } = require('./shared');
const { revealEvolution } = require('./evolution');
const {
    BATTLE_COOLDOWN_MS, petUsable, onBattleCooldown, petSnapshot, moveTag, exchangeLine, hpLines, matchupLine,
    battleResultEmbed, petXpLine,
} = require('./battleShared');

const BATTLE_RAKE      = 0.05;
const ACCEPT_MS        = 60_000;
const PICK_MS          = 30_000;  // the defender choosing a pet; the default fights after
const STANCE_MS        = 20_000;  // each stance pick; a random stance after
const INTRO_PAUSE_MS   = 1_800;
const REVEAL_PAUSE_MS  = 2_200;   // between edits, well inside Discord's edit rate limit
const PICK_MENU_LIMIT  = 25;      // a select menu's option cap
const _delay = ms => new Promise(r => setTimeout(r, ms));

const STANCE_RULE = `${STANCES.strike.emoji} Strike beats ${STANCES.trick.emoji} Trick · `
    + `${STANCES.trick.emoji} Trick beats ${STANCES.guard.emoji} Guard · `
    + `${STANCES.guard.emoji} Guard beats ${STANCES.strike.emoji} Strike`;

const stanceTag = key => `${STANCES[key].emoji} ${STANCES[key].label}`;

/**
 * The defender's pets that can answer this challenge: fed, off vacation, off
 * cooldown and, for a rated battle, within the rating band of the challenger's.
 */
function defenderChoices(pets, { rated, ladder, challengerPetRef }) {
    return (pets ?? []).filter(p => isPetActive(p) && !onBattleCooldown(p)
        && (!rated || withinBand(ladder, challengerPetRef, String(p._id))));
}

function ratingTag(ladder, petRef) {
    const r = entryOf(ladder, petRef).rating;
    return `${tierFor(r).icon} ${r}`;
}

/**
 * Claim a pet for this battle: stamp its battle cooldown now, but only if it is
 * off cooldown. A member battle runs for a minute or more, and the cooldown
 * used to be only read at the start, so one pet could be entered in two fights
 * at once and one fight's XP and record written over the other's. The claim is
 * the cooldown check, made atomic. Resolves to whether it was taken.
 */
async function claimPet(userId, guildId, petId, at) {
    const res = await User.updateOne(
        { userId, guildId, pets: { $elemMatch: { _id: petId, lastBattle: { $not: { $gt: new Date(at.getTime() - BATTLE_COOLDOWN_MS) } } } } },
        { $set: { 'pets.$.lastBattle': at } },
    );
    return (res?.matchedCount ?? 0) + (res?.modifiedCount ?? 0) > 0;
}

/** Hand a claim back when the battle does not happen: the pet was off cooldown before it. */
async function releasePet(userId, guildId, petId, at) {
    await User.updateOne(
        { userId, guildId, pets: { $elemMatch: { _id: petId, lastBattle: at } } },
        { $set: { 'pets.$.lastBattle': null } },
    ).catch(err => console.error('[pet battle] could not release a pet claim:', err.message));
}

/**
 * Wait for one press on `message` that `filter` accepts. Resolves to the
 * press, or null when the window closes first.
 */
function awaitPress(message, filter, time) {
    return new Promise(resolve => {
        const collector = message.createMessageComponentCollector({ filter, max: 1, time });
        let done = false;
        collector.on('collect', i => {
            if (done) return;
            done = true;
            collector.stop('picked');
            resolve(i);
        });
        collector.on('end', () => { if (!done) { done = true; resolve(null); } });
    });
}

/**
 * Collect both owners' stances for one round. Each owner's first press counts
 * and is confirmed to them alone; `onPick` runs after each so the public
 * message can say who has locked in. Resolves to `{ [userId]: stanceKey }`
 * holding only the owners who picked in time.
 */
function collectStances(message, { players, prefix, time, onPick }) {
    return new Promise(resolve => {
        const picks = {};
        const collector = message.createMessageComponentCollector({
            filter: ownedBy(players, i => i.customId.startsWith(prefix), 'Only the two owners in this battle pick stances.'),
            time,
        });
        collector.on('collect', async i => {
            const stance = i.customId.slice(prefix.length);
            if (!STANCES[stance]) return;
            if (picks[i.user.id]) {
                await i.reply({ content: `You already chose ${stanceTag(picks[i.user.id])} this round.`, flags: MessageFlags.Ephemeral }).catch(() => {});
                return;
            }
            picks[i.user.id] = stance;
            await i.reply({ content: `You chose ${stanceTag(stance)}. Waiting for the reveal…`, flags: MessageFlags.Ephemeral }).catch(() => {});
            if (players.every(id => picks[id])) collector.stop('picked');
            else await onPick?.(picks);
        });
        collector.on('end', () => resolve(picks));
    });
}

function stanceRow(prefix, disabled = false) {
    return new ActionRowBuilder().addComponents(STANCE_KEYS.map(key =>
        new ButtonBuilder()
            .setCustomId(`${prefix}${key}`)
            .setLabel(STANCES[key].label)
            .setEmoji(STANCES[key].emoji)
            .setStyle(key === 'strike' ? ButtonStyle.Danger : key === 'guard' ? ButtonStyle.Primary : ButtonStyle.Success)
            .setDisabled(disabled)));
}

/** What the stance matchup did, in words, e.g. "🛡️ Tom's Guard turns aside 🗡️ Rex's Strike". */
function stanceVerdictLine(edge, sA, sB, nameA, nameB) {
    if (!edge) return `Both chose ${stanceTag(sA)} — an even exchange.`;
    const [wS, lS, wN, lN] = edge === 'a' ? [sA, sB, nameA, nameB] : [sB, sA, nameB, nameA];
    return `${STANCES[wS].emoji} **${wN}**'s ${STANCES[wS].label} ${STANCES[wS].verb} ${STANCES[lS].emoji} **${lN}**'s ${STANCES[lS].label} — **${wN}** has the edge this round!`;
}

async function pvpBattle(interaction, ctx) {
    const { myPet, myPetId, opponent, oppUser, bet, rated, currency } = ctx;
    const guildId = interaction.guild.id;
    // Names this battle for its escrow refunds and its winner payout — the one
    // identifier that survives the challenge window and the collector
    // callbacks that settle the fight, so a live credit and its replay agree.
    const battleId = interaction.id;
    const ownerA = interaction.member?.displayName ?? interaction.user.username;
    const ownerB = interaction.guild.members?.cache?.get?.(opponent.id)?.displayName ?? opponent.globalName ?? opponent.username;

    let ladder = null;
    if (rated) {
        ladder = await getLadder(guildId);
        const pair = ratedPairAllowed(ladder, interaction.user.id, opponent.id);
        if (!pair.ok) return interaction.reply({ content: `⚖️ No rated battle: ${pair.reason}.`, flags: MessageFlags.Ephemeral });
    }
    const choices = defenderChoices(oppUser?.pets, { rated, ladder, challengerPetRef: myPetId });
    if (choices.length === 0) {
        const why = rated && (oppUser?.pets ?? []).some(p => isPetActive(p))
            ? `None of ${opponent.username}'s battle-ready pets is within the rating band of yours.`
            : `${opponent.username} has no battle-ready pet (they need a fed pet).`;
        return interaction.reply({ content: why, flags: MessageFlags.Ephemeral });
    }
    const suggested = pickDefenderPet(choices, myPet.level ?? 1);
    const da = getPetDisplay(myPet), ds = getPetDisplay(suggested);
    const matched = bet > 0 || rated;

    const acceptId  = `petb_accept_${battleId}`;
    const declineId = `petb_decline_${battleId}`;
    const challengeEmbed = new EmbedBuilder()
        .setColor(COLORS.RARE)
        .setTitle(rated ? '⚔️ Rated Pet Battle Challenge!' : '⚔️ Pet Battle Challenge!')
        .setDescription(
            `${da.emoji} **${ownerA}'s ${da.titledName}** (Lv.${myPet.level ?? 1})${rated ? ` · ${ratingTag(ladder, myPetId)}` : ''} ` +
            `challenges ${opponent} to a battle!` +
            (choices.length === 1
                ? `\n\n${ds.emoji} **${ds.titledName}** (Lv.${suggested.level ?? 1}) will answer the call.`
                : `\n\n${opponent.username} picks which pet answers — the closest match is ${ds.emoji} **${ds.titledName}** (Lv.${suggested.level ?? 1}).`) +
            (bet > 0
                ? `\n\n💰 Wager: **${currency}${bet.toLocaleString()}** each — winner takes the pot.`
                : rated ? '' : '\n\n*Friendly match — pet XP only.*') +
            (rated ? '\n\n📊 *Rated: the result moves both pets on the ladder.*' : '') +
            (matched ? `\n⚖️ *${bet > 0 ? 'Wagered' : 'Rated'} battles are level-matched: both pets fight at the lower pet's level.*` : '') +
            `\n\n🎯 Each round, both owners pick a stance in secret. ${STANCE_RULE}.`
        )
        .setFooter({ text: 'Accept within 60 seconds' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(acceptId).setLabel('⚔️ Accept').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(declineId).setLabel('🏳️ Decline').setStyle(ButtonStyle.Danger),
    );

    await interaction.reply({ content: `${opponent}`, embeds: [challengeEmbed], components: [row] });
    const msg = await interaction.fetchReply();
    const cancelled = (text, color = COLORS.ERROR) =>
        ({ content: null, embeds: [EmbedBuilder.from(challengeEmbed).setColor(color).setDescription(text)], components: [] });

    const answer = await awaitPress(msg, ownedBy(opponent.id, i => [acceptId, declineId].includes(i.customId), "This isn't your pet."), ACCEPT_MS);
    if (!answer) return interaction.editReply(cancelled(`${opponent.username} didn't respond in time.`, COLORS.NEUTRAL)).catch(() => {});
    if (answer.customId === declineId) return answer.update(cancelled(`${opponent.username} declined the battle.`, COLORS.NEUTRAL)).catch(() => {});

    // ── The defender picks the pet that answers ──
    const chosenId = await pickDefender(answer, msg, { opponent, choices, suggested, battleId, rated, ladder, challengeEmbed });

    // ── Escrow ──
    // Taken after the pick, so a defender who walks away from the menu costs
    // nobody anything. Each debit is a guarded compare-and-set read back here,
    // so by the time a refund runs the debit is known to have landed — an
    // unconditional keyed credit is the right compensation (#873, pass 10).
    //
    // Each stake that lands is noted on a PendingPetBattle, so a restart in the
    // stance rounds that follow is swept and refunded rather than stranded
    // (services/petBattleEscrowSweep.js).
    const pending = { battleId, guildId, challengerId: interaction.user.id, opponentId: opponent.id, amount: bet };
    if (bet > 0) {
        const ch = await User.findOneAndUpdate({ userId: interaction.user.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } });
        if (!ch) return interaction.editReply(cancelled(`${interaction.user.username} can no longer cover the wager.`)).catch(() => {});
        await notePetStake(pending, interaction.user.id);
        // A throw here is as much a stake not taken as a refusal is, and the
        // challenger's, already taken, has to come back either way.
        const op = await User.findOneAndUpdate({ userId: opponent.id, guildId, balance: { $gte: bet } }, { $inc: { balance: -bet } })
            .catch(err => { console.error('[pet battle] opponent stake debit failed:', err); return null; });
        if (!op) {
            const back = await refundBattleStake(interaction.user.id, guildId, bet, battleId);
            await clearPendingPetBattle(battleId);
            return interaction.editReply(cancelled(`${opponent.username} can't cover the wager.${stakeRefundNote(back)}`)).catch(() => {});
        }
        await notePetStake(pending, opponent.id);
    }

    // From here until the pot is paid, the stakes are in escrow: any way out
    // but a settled fight hands both back.
    let settledPot = false;
    // The pets this battle has claimed, handed back if it does not happen.
    const claims = [];
    const refundAndCancel = async (reason) => {
        let note = '';
        if (bet > 0 && !settledPot) {
            settledPot = true;
            note = battleRefundNote(await refundBothStakes(interaction.user.id, opponent.id, guildId, bet, battleId));
            await clearPendingPetBattle(battleId);
        }
        await Promise.all(claims.splice(0).map(c => releasePet(c.userId, guildId, c.petId, c.at)));
        return interaction.editReply({ ...cancelled(`${reason} — the battle was cancelled.${note}`), files: [], attachments: [] }).catch(() => {});
    };

    try {
        return await fight(interaction, {
            ...ctx, msg, chosenId, battleId, ownerA, ownerB, matched, refundAndCancel, claims,
            markSettled: () => { settledPot = true; claims.length = 0; },
        });
    } catch (err) {
        console.error('[pet battle] member battle failed:', err);
        if (!settledPot) return refundAndCancel('Something went wrong mid-battle');
        throw err;
    }
}

/**
 * Let the defender choose which pet fights. One eligible pet needs no menu;
 * otherwise a select menu of them, with the closest level match marked and a
 * button to take it. Silence for PICK_MS fights with the suggestion. Resolves
 * to the chosen pet's id; the accept press is acknowledged either way.
 */
async function pickDefender(answer, msg, { opponent, choices, suggested, battleId, rated, ladder, challengeEmbed }) {
    const suggestedId = String(suggested._id);
    if (choices.length === 1) {
        await answer.deferUpdate().catch(() => {});
        return suggestedId;
    }
    const menuId = `petb_pick_${battleId}`;
    const goId   = `petb_pickgo_${battleId}`;
    const ds = getPetDisplay(suggested);
    const menu = new StringSelectMenuBuilder()
        .setCustomId(menuId)
        .setPlaceholder('Choose your fighter')
        .addOptions(choices.slice(0, PICK_MENU_LIMIT).map(p => {
            const d = getPetDisplay(p);
            return {
                label: `${d.titledName} · Lv.${p.level ?? 1}`.slice(0, 100),
                description: `${d.name}${rated ? ` · rated ${entryOf(ladder, String(p._id)).rating}` : ''}`.slice(0, 100),
                value: String(p._id),
                emoji: d.emoji,
                default: String(p._id) === suggestedId,
            };
        }));
    const go = new ButtonBuilder().setCustomId(goId).setLabel(`Fight with ${ds.titledName}`.slice(0, 80)).setStyle(ButtonStyle.Success);
    await answer.update({
        content: `${opponent}`,
        embeds: [EmbedBuilder.from(challengeEmbed).setTitle('⚔️ Choose your fighter').setFooter({ text: `${PICK_MS / 1000} seconds — ${ds.titledName} fights if you don't choose` })],
        components: [new ActionRowBuilder().addComponents(menu), new ActionRowBuilder().addComponents(go)],
    }).catch(() => {});

    const press = await awaitPress(msg, ownedBy(opponent.id, i => [menuId, goId].includes(i.customId), "This isn't your pet."), PICK_MS);
    if (!press) return suggestedId;
    await press.deferUpdate().catch(() => {});
    const picked = press.customId === menuId ? press.values?.[0] : null;
    return choices.some(p => String(p._id) === picked) ? picked : suggestedId;
}

async function fight(interaction, ctx) {
    const { opponent, bet, rated, currency, guildSettings, msg, chosenId, battleId, ownerA, ownerB, matched, refundAndCancel, markSettled, myPetId, claims } = ctx;
    const guildId = interaction.guild.id;

    // Re-fetch both fighters fresh so concurrent feeds/battles are reflected
    const [chUser, opUser] = await Promise.all([
        User.findOne({ userId: interaction.user.id, guildId }),
        User.findOne({ userId: opponent.id, guildId }),
    ]);
    const aPet = resolvePetRef(chUser?.pets, myPetId)?.pet;
    const bPet = resolvePetRef(opUser?.pets, chosenId)?.pet;

    // If a fighter is gone, no longer battle-ready, or went on cooldown since
    // the challenge, refund and abort.
    if (!aPet || !bPet) return refundAndCancel('A pet is no longer available');
    if (!petUsable(aPet).ok || !petUsable(bPet).ok) return refundAndCancel('A pet is no longer battle-ready');
    if (onBattleCooldown(aPet) || onBattleCooldown(bPet)) return refundAndCancel('A pet is now recovering from a recent battle');
    if (rated) {
        const ok = ratedEligibility(await getLadder(guildId),
            { userId: interaction.user.id, petRef: myPetId }, { userId: opponent.id, petRef: chosenId });
        if (!ok.ok) return refundAndCancel(`This can no longer be a rated battle: ${ok.reason}`);
    }
    // Both pets are claimed for this battle before a stance is picked; losing
    // either claim means the pet went into another fight since the check above.
    const claimAt = new Date();
    for (const [userId, petId] of [[interaction.user.id, myPetId], [opponent.id, chosenId]]) {
        if (!await claimPet(userId, guildId, petId, claimAt)) return refundAndCancel('A pet is now recovering from a recent battle');
        claims.push({ userId, petId, at: claimAt });
    }

    // A wager or a rated battle fights both pets at the lower level, so what is
    // at stake rides on the matchup rather than on who has grinded further
    // (see levelMatched). The snapshots are what fought, so the HP bars and
    // levels in every frame match the stats the fight used.
    const [aFighter, bFighter] = matched ? levelMatched(aPet, bPet) : [aPet, bPet];
    const aSnap = petSnapshot(aFighter), bSnap = petSnapshot(bFighter);
    const da = getPetDisplay(aSnap), db = getPetDisplay(bSnap);

    const [artA, artB] = await Promise.all([petArt(aPet.petId, guildId, da.name), petArt(bPet.petId, guildId, db.name)]);
    const banner = await renderVersusBanner(artA, artB, { alt: `${da.titledName} versus ${db.titledName}` });
    const single = banner ? null : (artA ?? artB);
    const withArt = embed => {
        if (banner) embed.setImage(`attachment://${BANNER_NAME}`);
        else if (single) embed.setThumbnail(single.url);
        return embed;
    };
    const header = `${matchupLine(aSnap, bSnap, ownerA, ownerB)}`;

    const intro = withArt(new EmbedBuilder()
        .setColor(COLORS.RARE).setTitle('⚔️ Battle commencing…')
        .setDescription(
            `${ownerA}'s ${da.emoji} **${da.titledName}**${moveTag(aPet.petId)}\n🆚\n`
            + `${ownerB}'s ${db.emoji} **${db.titledName}**${moveTag(bPet.petId)}`
        ));
    await interaction.editReply({
        content: null, embeds: [intro], components: [],
        files: banner ? [banner] : single ? [single.attachment] : [], attachments: [],
    }).catch(() => {});
    await _delay(INTRO_PAUSE_MS);

    // ── Stance rounds ──
    const state = createBattle(aFighter, bFighter);
    const players = [interaction.user.id, opponent.id];
    const edges = { a: 0, b: 0 };
    let lastReveal = '';
    for (let r = 1; r <= STANCE_ROUNDS && battleOngoing(state); r++) {
        const prefix = `petb_st_${battleId}_${r}_`;
        const prompt = picked => withArt(new EmbedBuilder()
            .setColor(COLORS.RARE)
            .setTitle(`⚔️ Round ${r} of ${STANCE_ROUNDS} — choose your stance`)
            .setDescription(
                `${header}\n\n${hpLines(aSnap, bSnap, state.a.hp, state.b.hp)}\n\n`
                + (lastReveal ? `${lastReveal}\n\n` : '')
                + `${STANCE_RULE}\n`
                + `${picked[players[0]] ? '✅' : '⏳'} ${ownerA} · ${picked[players[1]] ? '✅' : '⏳'} ${ownerB}`
            )
            .setFooter({ text: `${STANCE_MS / 1000} seconds — a stance is picked at random for anyone who doesn't choose` }));
        // Listening before the buttons show, so a fast click is never dropped.
        const collecting = collectStances(msg, {
            players, prefix, time: STANCE_MS,
            onPick: picked => interaction.editReply({ embeds: [prompt(picked)], components: [stanceRow(prefix)] }).catch(() => {}),
        });
        await interaction.editReply({ content: `${interaction.user} ${opponent}`, embeds: [prompt({})], components: [stanceRow(prefix)] }).catch(() => {});
        const picks = await collecting;
        // Nobody at the table: the battle is abandoned, not decided by dice.
        if (!picks[players[0]] && !picks[players[1]]) {
            return refundAndCancel('Neither owner picked a stance');
        }
        const sA = picks[players[0]] ?? randomStance();
        const sB = picks[players[1]] ?? randomStance();
        const { edge, rounds } = fightStanceRound(state, sA, sB);
        if (edge) edges[edge]++;

        const nameOf = side => (side === 'a' ? da.titledName : db.titledName);
        const randomNote = [!picks[players[0]] && ownerA, !picks[players[1]] && ownerB].filter(Boolean)
            .map(n => `*${n} didn't pick in time — their stance was chosen at random.*`);
        const crit = rounds.some(rd => rd.crit);
        lastReveal = [
            `**Round ${r}:** ${stanceTag(sA)} vs ${stanceTag(sB)}`,
            stanceVerdictLine(edge, sA, sB, da.titledName, db.titledName),
            ...randomNote,
            ...rounds.map(rd => exchangeLine(rd, nameOf)),
            crit ? '💥 **Critical hit!**' : null,
            !battleOngoing(state) ? `💫 **${state.a.hp <= 0 ? da.titledName : db.titledName}** is knocked out!` : null,
        ].filter(Boolean).join('\n');
        await interaction.editReply({
            content: null,
            embeds: [withArt(new EmbedBuilder()
                .setColor(edge === 'a' ? '#3498db' : edge === 'b' ? '#e67e22' : COLORS.NEUTRAL)
                .setTitle(`⚔️ Round ${r} — ${stanceTag(sA)} vs ${stanceTag(sB)}`)
                .setDescription(`${header}\n\n${hpLines(aSnap, bSnap, state.a.hp, state.b.hp)}\n\n${lastReveal}`))],
            components: [],
        }).catch(() => {});
        await _delay(REVEAL_PAUSE_MS);
    }

    const result = battleVerdict(state);
    const aWon   = result.winner === 'a';
    // The fight is decided: from here the claims stand as the pets' cooldown.
    markSettled();

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

    // Payout — the pot moves on its own keyed write, and the embed is worded
    // from what the credit did; a pot that will not land is recorded as owed
    // for `payouts:replay` rather than lost (#873, pass 10).
    let payoutLine = null;
    if (bet > 0) {
        const pot      = bet * 2;
        const houseCut = guildSettings?.economy?.duelHouseCut ?? BATTLE_RAKE;
        const payout   = pot - Math.floor(pot * houseCut);
        const winnerId = aWon ? interaction.user.id : opponent.id;
        const loserId  = aWon ? opponent.id : interaction.user.id;
        const winnerName = aWon ? interaction.user.username : opponent.username;

        const paid = await payBattleWinner(winnerId, guildId, payout, battleId);
        // Paid or owed under the battle's key: the sweep has nothing left to do.
        // A pot that did neither keeps its note, and the sweep refunds the stakes.
        if (paid.credited || paid.owed) await clearPendingPetBattle(battleId);

        // chUser/opUser balances are post-escrow; the loser keeps theirs.
        const loserBalance = (aWon ? opUser : chUser).balance ?? 0;
        logTransaction({ userId: loserId, guildId, type: 'pet_battle', amount: -bet, balance: loserBalance, relatedUserId: winnerId, note: 'Pet battle loss' });

        if (paid.credited) {
            const winnerBalance = paid.doc?.balance ?? (((aWon ? chUser : opUser).balance ?? 0) + payout);
            logTransaction({ userId: winnerId, guildId, type: 'pet_battle', amount: payout - bet, balance: winnerBalance, relatedUserId: loserId, note: 'Pet battle win' });
            payoutLine = `🏆 **${winnerName}** takes the pot: **+${currency}${(payout - bet).toLocaleString()}**` +
                (houseCut > 0 ? `  *(house kept ${Math.round(houseCut * 100)}%)*` : '');
        } else {
            payoutLine = `🏆 **${winnerName}** won, but the **${currency}${payout.toLocaleString()}** pot could not be paid out — ` +
                (paid.owed ? 'it is recorded and an admin can restore it.' : 'please contact a server admin.');
        }
    }

    // The ladder, on its own document: both ratings in one conditional write.
    let ratingLine = null;
    if (rated) {
        const side = (userId, pet) => ({ userId, petRef: String(pet._id), petId: pet.petId, name: getPetDisplay(pet).titledName });
        const [w, l] = aWon
            ? [side(interaction.user.id, aPet), side(opponent.id, bPet)]
            : [side(opponent.id, bPet), side(interaction.user.id, aPet)];
        const res = await recordRatedResult(guildId, w, l).catch(err => {
            console.error('[pet battle] rating write failed:', err);
            return { rated: false, reason: 'error' };
        });
        if (res.rated) {
            const fmt = (name, r) => `${name} ${tierFor(r.after).icon} **${r.after}** (${r.delta >= 0 ? '+' : '−'}${Math.abs(r.delta)})`;
            ratingLine = `📊 **Rated · ${res.seasonId}** — ${fmt(w.name, res.winner)} · ${fmt(l.name, res.loser)}`;
        } else {
            ratingLine = res.reason === 'cap'
                ? '📊 *Not rated — these two owners reached the daily limit of rated battles against each other.*'
                : '📊 *The rating update could not be saved — this battle counts as unrated.*';
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
    // allSettled, not all: both saves have to be waited on and both reported.
    // Keyed (#873, pass 11), one key per fighter, so each fighter's care
    // reward is credited once and recorded as owed on failure.
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

    // The wager is already settled, so the result still stands and is still
    // reported. What a failed save costs is the pet XP, the win/loss record and
    // the battle cooldown, and that has to be said.
    const saveFailed = chSaved.status === 'rejected' || opSaved.status === 'rejected';
    const saveNote = saveFailed
        ? '\n⚠️ *The battle result could not be saved — pet XP, records and cooldowns were not updated.*'
        : '';

    announcePetAchievements(interaction, chUser, guildSettings, earnedA);
    announcePetAchievements(interaction, opUser, guildSettings, earnedB);

    const winnerDisp = aWon ? da : db;
    const winnerOwner = aWon ? ownerA : ownerB;
    const stanceLine = `🎯 Rounds won on stance: **${ownerA}** ${edges.a} · **${ownerB}** ${edges.b}`;
    await interaction.editReply({
        content: null,
        embeds: [withArt(battleResultEmbed({
            color: '#f1c40f',
            title: `🏆 ${winnerDisp.titledName} wins the battle!`,
            petA: aSnap, petB: bSnap, result, ownerA, ownerB,
            extraLines: [`\n👑 **${winnerOwner}**'s ${winnerDisp.titledName} takes it.`, stanceLine, ratingLine],
            payoutLine,
            xpLineA: petXpLine(da.titledName, aXp),
            xpLineB: petXpLine(db.titledName, bXp) + saveNote,
        }))],
        components: [],
    }).catch(() => {});
    // Each side's reveal only once its evolution is actually saved.
    if (chSaved.status === 'fulfilled') {
        await revealEvolution(interaction, aPet, aXp, { ownerId: interaction.user.id, ownerName: ownerA });
    }
    if (opSaved.status === 'fulfilled') {
        await revealEvolution(interaction, bPet, bXp, { ownerId: opponent.id, ownerName: ownerB });
    }
}

module.exports = { pvpBattle, defenderChoices, stanceVerdictLine, STANCE_MS, PICK_MS };
