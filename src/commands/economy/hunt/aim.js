'use strict';

// The aim phase: the timed shot prompt, how a shot is graded, and the approach
// profile that decides what the prompt reads like for the quarry in front of you.

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const COLORS = require('../../../utils/embedColors');
const { ownedBy } = require('../../../utils/collectorOwner');

// ── Aim phase timing ─────────────────────────────────────────────────────────
// How long the shot stays perfect once the window opens, and how long after
// that the trigger stays live at all.
//
// The window is wide on purpose, and timed from when the call reaches the
// screen rather than from when the wait elapsed. It has to be comfortably
// longer than the spread in players' round-trip times, or the grade goes back
// to measuring connection quality: a hunter on a 400ms connection spends about
// 650ms of the 900 on the wire and their own reaction, leaving a quarter of a
// second in hand. What separates a perfect shot from a late one is whether the
// player waited for the call, which is the same for everybody.
const AIM_WINDOW_MS = 900;

const AIM_LATE_MS   = 2500;

// Now and then the sights hold a beat longer on a "steady…" before the real
// call, so hammering the button on a rhythm is not a strategy: the only way to
// grade perfect is to wait for the word. One extra edit, never more.
const AIM_FAKEOUT_CHANCE = 0.25;
const AIM_FAKEOUT_MS     = 700;

function gradeShot(shotMs, openAtMs) {
    const grade =
        shotMs === null                    ? 'timeout' :
        shotMs < openAtMs                  ? 'early'   :
        shotMs <= openAtMs + AIM_WINDOW_MS ? 'perfect' :
                                             'late';

    const GRADES = {
        perfect: {
            bonus: 0.18, color: '#FFD700', title: '🎯 Perfect Shot!',
            body: 'You held it until the moment came. **+18% crit chance** this hunt.',
        },
        late: {
            bonus: 0.08, color: '#00CC66', title: '✅ Clean Shot!',
            body: 'A beat behind the call, but the shot landed. **+8% crit chance** this hunt.',
        },
        // A rushed shot costs rather than merely failing to pay: an early
        // trigger used to be impossible, so "don't fire too early" warned about
        // nothing. It is a real decision now, so it has a real price.
        early: {
            bonus: -0.05, color: '#FF6B6B', title: '💨 You rushed it!',
            body: 'You pulled before the shot lined up and the animal bolted at the noise. **−5% crit chance** this hunt.',
        },
        timeout: {
            bonus: 0, color: '#888888', title: '⏰ Never took the shot',
            body: 'The window closed with your finger still off the trigger. No aim bonus this hunt.',
        },
    };

    const { bonus, color, title, body } = GRADES[grade];
    return {
        grade,
        bonus,
        embed: () => new EmbedBuilder().setColor(color).setTitle(title).setDescription(body),
    };
}

/**
 * Runs the timed shot. `options.scene` dresses every embed the phase shows
 * (the encounter's shared header), and `options.fakeOut` holds a "steady…"
 * beat before the call — the caller rolls it, so the phase itself stays
 * deterministic under a stubbed clock.
 */
async function runAimPhase(interaction, huntMsg, { scene = e => e, fakeOut = false } = {}) {
    const delay = ms => new Promise(r => setTimeout(r, ms));

    const aimWaitMs = 1000 + Math.floor(Math.random() * 1001);

    const fireId = `hunt_fire_${interaction.id}`;
    const aimRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(fireId).setLabel('🔫 Fire!').setStyle(ButtonStyle.Danger)
    );
    const aimSightsEmbed = new EmbedBuilder()
        .setColor('#8B0000')
        .setTitle('🎯 Target in Sights…')
        .setDescription('*Hold your breath… wait for the shot to line up.*')
        .setFooter({ text: 'Fire when the shot is called — rush it and you spoil the shot.' });

    await interaction.editReply({ embeds: [scene(aimSightsEmbed)], components: [aimRow] });
    const aimTime = Date.now();

    const collector = huntMsg.createMessageComponentCollector({
        filter: ownedBy(interaction.user.id, i => i.customId === fireId, "This isn't your shot."),
        time: aimWaitMs + AIM_LATE_MS,
        max: 1,
    });

    let shotTaken = false;
    const shot = new Promise(resolve => {
        // The clock is read the moment the press arrives, before the
        // acknowledgement goes back over the wire — awaiting deferUpdate first
        // charged a full round trip to the shot, which is the latency this
        // phase exists to keep out of the grade. Resolving before the ack also
        // means a rejected ack cannot leave the phase waiting forever.
        collector.on('collect', i => {
            resolve(Date.now() - aimTime);
            i.deferUpdate().catch(() => {});
        });
        collector.on('end',     (_, reason) => { if (reason !== 'limit') resolve(null); });
    }).then(ms => { shotTaken = ms !== null; return ms; });

    // Call the shot when the window opens — unless it has already been taken,
    // in which case editing to "FIRE!" would tell a player who jumped the gun
    // that they were right on time.
    //
    // The window is timed from when the call is actually on screen, not from
    // when the wait elapsed: the edit is a round trip of its own, and charging
    // it to the player would put the latency straight back into the grade this
    // phase exists to take it out of.
    let windowOpensAt = aimWaitMs;
    await Promise.race([shot, delay(aimWaitMs)]);
    if (!shotTaken && fakeOut) {
        // Not the call. A press here is still early, exactly as before it —
        // the window has not opened, so nothing yet counts as on time.
        windowOpensAt = Infinity;
        await interaction.editReply({
            embeds: [scene(new EmbedBuilder()
                .setColor('#8B0000')
                .setTitle('🎯 Steady…')
                .setDescription('*It shifts its weight. Not yet — wait for the shot.*'))],
            components: [aimRow],
        });
        await Promise.race([shot, delay(AIM_FAKEOUT_MS)]);
        // The window opens after this beat, so the collector's deadline has to
        // move with it or the fake-out would come out of the late grace.
        if (!shotTaken) collector.resetTimer({ time: AIM_FAKEOUT_MS + AIM_LATE_MS });
    }
    if (!shotTaken) {
        await interaction.editReply({
            embeds: [scene(new EmbedBuilder()
                .setColor(COLORS.ERROR)
                .setTitle('💥 FIRE!')
                .setDescription('**Take the shot — NOW!**'))],
            components: [aimRow],
        });
        windowOpensAt = Date.now() - aimTime;

        // Re-arm for the same reason the window is timed from here. The
        // collector was armed before the edit went out, so its deadline counts
        // the edit's round trip against the player's grace period — a slow
        // connection got less time to take a late shot than a fast one, which
        // is the latency-decides-the-grade problem again at the other end of
        // the window. AIM_LATE_MS is a promise about time after the call.
        if (!shotTaken) collector.resetTimer({ time: AIM_LATE_MS });
    }

    const shotMs = await shot;
    const aim    = gradeShot(shotMs, windowOpensAt);

    await interaction.editReply({ embeds: [scene(aim.embed())], components: [] });
    await delay(600);

    return aim;
}

// ─── STEALTH OUTCOME ─────────────────────────────────────────────────────────
// The approach is a read of the animal, and the read is the skill: a correct
// one always pays. There used to be a hidden 80/50/20 roll on top, which meant
// one correct read in five was *penalised* — worse than the safe option — while
// the screen said "no bonus". Variance belongs to the shot, which is already a
// roll; the read itself is now deterministic.

const STEALTH_OUTCOMES = {
    perfect: {
        color: '#00FF7F', title: '🤫 Perfect approach!',
        body: '*You read it perfectly. It froze for a moment — then relaxed. It never sensed you.*',
    },
    decent: {
        color: '#FFA500', title: '🌿 Decent approach…',
        body: '*Not the ideal line, but you kept your noise down. It stirred — then settled.*',
    },
    spooked: {
        color: '#FF6B6B', title: '🔊 You spooked it!',
        body: '*It heard you before you were in range, and fixed you with a stare. Every advantage lost.*',
    },
    timeout: {
        color: '#888888', title: '⏰ Hesitated too long…',
        body: '*You weighed your options too long — the moment passed. No approach bonus.*',
    },
};

/**
 * Grades an approach choice against the profile. Returns
 * { outcome, bonus, label } where outcome is perfect | decent | spooked |
 * timeout and bonus is the option's own stealthBonus (0 on a timeout).
 */
function resolveStealth(profile, pickedId) {
    const chosen = profile.options.find(o => o.id === pickedId);
    if (!chosen) return { outcome: 'timeout', bonus: 0, label: '' };
    const outcome =
        pickedId === profile.correctId ? 'perfect' :
        chosen.stealthBonus >= 0       ? 'decent'  :
                                         'spooked';
    return { outcome, bonus: chosen.stealthBonus, label: chosen.label };
}

/** Fisher–Yates over the given random source; the old sort-by-coin-flip was biased. */
function shuffled(items, random = Math.random) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// ─── STEALTH APPROACH PROFILES (per animal) ──────────────────────────────────
// The prey is rolled before the prompt (rollHuntEncounter), so the hint
// describes the animal that is actually there and the correct answer follows
// from how *that* animal behaves. Trait prey keys on its traits — elusive
// rewards patience, aggressive rewards cover, giant/armored/venomous reward
// distance, spectral rewards stillness — and trait-less prey rolls one of
// three behaviours per hunt. Either way the right answer changes hunt to
// hunt, so the prompt is a read, not a memorised zone fact (issue #739).
//
// Each profile: one correct option (+0.25), one safe-but-suboptimal (+0.05),
// one wrong (−0.10). The probabilistic outcome layer on top is unchanged.

const APPROACH_PROFILES = {
    stillness: {
        id: 'stillness',
        hint: a => `${a.emoji} A **${a.name}** drifts at the edge of sight, half there and half not. It doesn't listen for you — it *feels* movement.`,
        options: [
            { id: 'freeze',    label: '🗿 Freeze and let it drift closer',    stealthBonus: 0.25 },
            { id: 'ease_back', label: '🌿 Ease back and wait it out',         stealthBonus: 0.05 },
            { id: 'circle',    label: '🏃 Circle around for a better angle',  stealthBonus: -0.10 },
        ],
        correctId: 'freeze',
    },
    patience: {
        id: 'patience',
        hint: a => `${a.emoji} A **${a.name}** flickers between cover, never still for more than a breath — one hasty move and it's gone.`,
        options: [
            { id: 'read_pattern', label: '⏳ Study its pattern and wait for the pause', stealthBonus: 0.25 },
            { id: 'shadow',       label: '🌿 Shadow it from a distance',                stealthBonus: 0.05 },
            { id: 'rush',         label: '🏃 Rush it before it slips away',             stealthBonus: -0.10 },
        ],
        correctId: 'read_pattern',
    },
    cover: {
        id: 'cover',
        hint: a => `${a.emoji} A **${a.name}** prowls the clearing, head snapping up at every sound — whatever it sees, it charges.`,
        options: [
            { id: 'hard_cover', label: '🌳 Keep hard cover between you and it', stealthBonus: 0.25 },
            { id: 'downwind',   label: '💨 Circle downwind in the open',        stealthBonus: 0.05 },
            { id: 'direct',     label: '⚔️ Advance on it directly',             stealthBonus: -0.10 },
        ],
        correctId: 'hard_cover',
    },
    distance: {
        id: 'distance',
        hint: a => `${a.emoji} A **${a.name}** dominates the ground ahead — up close it's the one holding every advantage. Take it from range.`,
        options: [
            { id: 'high_ground', label: '🎯 Line up a long shot from high ground', stealthBonus: 0.25 },
            { id: 'treeline',    label: '🌿 Skirt the treeline at range',          stealthBonus: 0.05 },
            { id: 'close_in',    label: '🏃 Slip in close for a sure shot',        stealthBonus: -0.10 },
        ],
        correctId: 'high_ground',
    },
    // Behaviours for trait-less prey, rolled per hunt.
    grazing: {
        id: 'grazing',
        hint: a => `${a.emoji} A **${a.name}** feeds in the open, ears flicking at every sound — it hasn't noticed you yet.`,
        options: [
            { id: 'undergrowth', label: '🌿 Creep through the undergrowth',   stealthBonus: 0.25 },
            { id: 'call',        label: '📢 Mimic a call to distract it',     stealthBonus: 0.05 },
            { id: 'sprint',      label: '🏃 Sprint in to close the gap',      stealthBonus: -0.10 },
        ],
        correctId: 'undergrowth',
    },
    alert: {
        id: 'alert',
        hint: a => `${a.emoji} A **${a.name}** stands rigid, nose working the air — it's caught wind of something.`,
        options: [
            { id: 'go_downwind', label: '💨 Circle downwind before closing in',  stealthBonus: 0.25 },
            { id: 'hold',        label: '⏳ Hold position until it settles',     stealthBonus: 0.05 },
            { id: 'upwind',      label: '🌬️ Push straight in from upwind',      stealthBonus: -0.10 },
        ],
        correctId: 'go_downwind',
    },
    moving: {
        id: 'moving',
        hint: a => `${a.emoji} A **${a.name}** is on the move, weaving through cover with somewhere to be.`,
        options: [
            { id: 'ambush', label: '🪤 Cut ahead and set an ambush',        stealthBonus: 0.25 },
            { id: 'trail',  label: '🐾 Trail it and wait for it to stop',   stealthBonus: 0.05 },
            { id: 'chase',  label: '🏃 Run it down',                        stealthBonus: -0.10 },
        ],
        correctId: 'ambush',
    },
};

// First matching trait wins; the order puts the most read-defining trait
// first. Traits with no behavioural read of their own (enraged) fall through
// to the rolled behaviours.
const TRAIT_PROFILE_ORDER = [
    ['spectral',    'stillness'],
    ['elusive',     'patience'],
    ['aggressive',  'cover'],
    ['pack_hunter', 'cover'],
    ['giant',       'distance'],
    ['armored',     'distance'],
    ['venomous',    'distance'],
];

const GENERIC_PROFILE_IDS = ['grazing', 'alert', 'moving'];

function pickApproachProfile(animal) {
    const traits = animal?.traits ?? [];
    for (const [trait, profileId] of TRAIT_PROFILE_ORDER) {
        if (traits.includes(trait)) return APPROACH_PROFILES[profileId];
    }
    return APPROACH_PROFILES[GENERIC_PROFILE_IDS[Math.floor(Math.random() * GENERIC_PROFILE_IDS.length)]];
}

module.exports = {
    AIM_FAKEOUT_CHANCE,
    AIM_FAKEOUT_MS,
    AIM_LATE_MS,
    AIM_WINDOW_MS,
    STEALTH_OUTCOMES,
    resolveStealth,
    shuffled,
    APPROACH_PROFILES,
    GENERIC_PROFILE_IDS,
    TRAIT_PROFILE_ORDER,
    gradeShot,
    pickApproachProfile,
    runAimPhase,
};
