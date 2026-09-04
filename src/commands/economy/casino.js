const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const Guild = require('../../models/Guild');
const { getGuildSettings } = require('../../utils/guildSettingsCache');
const User  = require('../../models/User');
const { processJackpotBet, getJackpotDisplay } = require('../../services/casinoJackpotService');
const { advanceMissions } = require('../../services/seasonMissionService');
const { tryAcquire, release } = require('../../utils/activeGameLock');
const { checkAndAwardAtomic, announceAchievements } = require('../../services/achievementService');
const { economyLockKey, casinoLockKey, busyMessage, GRIND_TTL_MS } = require('../../utils/economyLock');

const games = [
    require('../../games/casino/blackjack'),
    require('../../games/casino/crash'),
    require('../../games/casino/cupgame'),
    require('../../games/casino/higherlower'),
    require('../../games/casino/keno'),
    require('../../games/casino/poker'),
    require('../../games/casino/roulette'),
    require('../../games/casino/slots'),
];

/**
 * Award and announce whatever the coins just staked unlocked.
 *
 * Split out of `onWager` so the async work is one awaited chain the caller can
 * attach a single `.catch` to. `guildSettings` is re-read rather than closed
 * over so a crash lobby's joiner — who may be in a different guild's cache
 * entry than the invoker was when the lobby opened — is judged against the
 * settings that apply to them.
 */
async function awardWagerAchievements(doc, better, source) {
    const settings = await getGuildSettings(doc.guildId);
    if (!settings?.achievements?.enabled) return;

    const earned = await checkAndAwardAtomic(
        User, { userId: doc.userId, guildId: doc.guildId }, doc, settings,
    );
    if (!earned.length) return;

    const member = source?.guild?.members?.cache?.get(better.id) ?? null;
    await announceAchievements(source.client, settings, doc, member, earned);
}

// Discord rejects a command description longer than this.
const DESCRIPTION_LIMIT = 100;

// Named off the `games` array rather than beside it. The old description was a
// hand-written copy, and it had gone stale: it still advertised baccarat,
// wheel, plinko and doubleornothing long after they were removed, and never
// mentioned cupgame, keno or poker (#665). A roster that outgrows the
// description limit elides here rather than failing the deploy.
const gameRoster = `Play casino games: ${games.map(game => game.name).join(', ')}.`;
const description = gameRoster.length <= DESCRIPTION_LIMIT
    ? gameRoster
    : `${gameRoster.slice(0, DESCRIPTION_LIMIT - 1).trimEnd()}…`;

const builder = new SlashCommandBuilder()
    .setName('casino')
    .setDescription(description)
    .addSubcommand(sub => sub.setName('jackpot').setDescription('View the current progressive jackpot pool.'))
    .addSubcommand(sub => sub
        .setName('setlimit')
        .setDescription('(Admin) Set or clear the maximum bet allowed in casino games.')
        .addIntegerOption(opt => opt
            .setName('limit')
            .setDescription('Max bet in coins. Set to 0 for no limit.')
            .setMinValue(0)
            .setRequired(true)));

for (const game of games) {
    builder.addSubcommand(sub => {
        const base = sub.setName(game.name).setDescription(game.description);
        return game.configure ? game.configure(base) : base;
    });
}

module.exports = {
    data: builder,
    cooldownKey: interaction => `casino:${interaction.options.getSubcommand()}`,
    cooldownAmount: interaction => {
        const sub = interaction.options.getSubcommand();
        const game = games.find(g => g.name === sub);
        return game?.cooldown ?? 3;
    },
    async execute(interaction) {
        const guildSettings = await getGuildSettings(interaction.guild.id);
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.gamesEnabled === false) {
            return interaction.reply({ content: 'Economy games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        if (guildSettings?.economy?.casinoEnabled === false) {
            return interaction.reply({ content: 'Casino games are disabled on this server.', flags: MessageFlags.Ephemeral });
        }
        const sub = interaction.options.getSubcommand();

        if (sub === 'setlimit') {
            if (!interaction.memberPermissions?.has('ManageGuild')) {
                return interaction.reply({ content: '❌ You need the **Manage Server** permission to set the casino bet limit.', flags: MessageFlags.Ephemeral });
            }
            const limit = interaction.options.getInteger('limit');
            await Guild.findOneAndUpdate(
                { guildId: interaction.guild.id },
                { $set: { 'economy.casinoMaxBet': limit } }
            );
            const msg = limit === 0
                ? '✅ Casino bet limit **removed** — players can bet any amount up to their wallet balance.'
                : `✅ Casino bet limit set to **${limit.toLocaleString()}** coins.`;
            return interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
        }

        if (sub === 'jackpot') {
            const { hot, display } = await getJackpotDisplay(interaction.guild.id);
            const lastWinner = guildSettings?.casinoJackpot?.lastWinnerName;
            const lastWon    = guildSettings?.casinoJackpot?.lastWonAmount;
            const embed = new EmbedBuilder()
                .setColor(hot ? '#FF6600' : '#FFD700')
                .setTitle(`${hot ? '🔥 ' : '🎰 '}Progressive Casino Jackpot`)
                .setDescription(
                    `${hot ? '🔥 **The jackpot is HOT!** Every bet brings this closer to dropping.\n\n' : ''}` +
                    `**Current Pool:** ${display}\n\n` +
                    `Every casino bet contributes **${Math.round((guildSettings?.casinoJackpot?.contributionRate ?? 0.005) * 100 * 10) / 10}%** to this pool.\n` +
                    `Trigger chance grows with every bet — someone will win it soon.\n` +
                    `🃏 Or take it outright: **Triple Wild** on \`/casino slots\` wins the whole pool.`
                )
                .addFields(
                    lastWinner ? { name: '🏆 Last Winner', value: `**${lastWinner}** — ${lastWon?.toLocaleString() ?? '?'} coins`, inline: true } : { name: '​', value: '​', inline: false }
                )
                .setFooter({ text: 'Play any casino game to contribute and compete for the pool.' })
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        const game = games.find(g => g.name === sub);
        if (!game) {
            return interaction.reply({ content: 'Unknown casino game.', flags: MessageFlags.Ephemeral });
        }

        // Two leases, because the two things being prevented have different
        // lifetimes (#955). The rationale is written up in utils/economyLock.js;
        // the shapes are:
        //
        //   the shared economy key   /fish, /hunt, /mine, /explore and /craft
        //                            contend for it too, so nothing of this
        //                            player's interleaves with the opening
        //                            debit. Released when execute() returns,
        //                            like every grind command's.
        //   the casino key           one game per player, held for the whole
        //                            hand — which outlives execute() by as long
        //                            as the player takes to play it, hence the
        //                            primitive's ten-minute default.
        //
        // The economy key used to do both jobs, which is what made an abandoned
        // blackjack hand a ten-minute lockout from every other economy command.
        // It is safe to stop holding it across the hand because every coin write
        // a hand makes past this point is already atomic — placeWager's
        // compare-and-set for the stake, `$inc` for every payout — and no grind
        // command can write a stale balance over one (tests/balanceSaveGuard).
        //
        // Economy first, then casino, which is the order everywhere and the
        // reason there is no cycle to deadlock on.
        const economyKey   = economyLockKey(interaction.guild.id, interaction.user.id);
        const economyToken = await tryAcquire(economyKey, GRIND_TTL_MS, 'casino');
        if (!economyToken) {
            return interaction.reply({
                content: await busyMessage(economyKey),
                flags: MessageFlags.Ephemeral,
            });
        }

        const lockKey   = casinoLockKey(interaction.guild.id, interaction.user.id);
        const lockToken = await tryAcquire(lockKey, undefined, 'casino');
        if (!lockToken) {
            // Hand it straight back: holding the shared key while refusing the
            // game would lock the player out of the grind commands for a hand
            // that never started.
            await release(economyKey, economyToken);
            return interaction.reply({
                content: await busyMessage(lockKey),
                flags: MessageFlags.Ephemeral,
            });
        }

        // The lock is released by the game itself (via releaseLock) once the
        // hand actually resolves — win/loss/cash-out/timeout, or an early
        // validation failure — not simply when execute() returns, since every
        // game's interactive turns continue via button collectors well after
        // that point. A "Play Again" follow-up doesn't need the lock re-held:
        // it goes through the same atomic balance debit as any fresh bet, so
        // it can't double-spend even if another casino game starts in
        // parallel once the original hand has settled.
        //
        // If a game throws, or forgets to call releaseLock on some exotic
        // early-return path, the lock's own TTL (10 min) frees the slot —
        // worst case the player is blocked from *the casino* for that long,
        // never permanently, and never from the rest of the economy.
        // Fire-and-forget: the games call this from collector callbacks that
        // cannot await, and a release that loses its round trip is covered by
        // the lease's own TTL.
        let released = false;
        const releaseLock = () => {
            if (released) return;
            released = true;
            release(lockKey, lockToken).catch(err => console.error('[casino] lock release failed:', err));
        };

        // What a bet *is*, for everything that wants to know one happened.
        //
        // This used to read the bet straight off the command options and fire on
        // `bet > 0` — before game.execute had validated anything. A bet larger
        // than the wallet, or over the guild's casinoMaxBet, or refused for any
        // other game-level reason still contributed to the jackpot pool and
        // still ticked "Play 5 casino games", for a hand that never happened.
        //
        // Now the games report it: utils/placeWager calls this once the coins
        // have actually moved, and only for the wager that opens a hand — a
        // double-down or a poker raise is more money on a hand already counted,
        // not another game played. `user` and `source` are the player and the
        // interaction to announce through, which differ from the invoker for a
        // crash lobby: joiners stake their own coins on someone else's command.
        const onWager = ({ amount, user = null, source = null, doc = null }) => {
            const better = user ?? interaction.user;

            // Fire-and-forget — the service handles pool reset, user credit, and logging.
            processJackpotBet({
                guildId:  interaction.guild.id,
                userId:   better.id,
                username: better.username,
                bet:      amount,
                interaction: source ?? interaction,
            }).catch(err => console.error('[CasinoJackpot] error:', err));

            // Season pass: "Play 5 casino games".
            advanceMissions(
                User,
                { userId: better.id, guildId: interaction.guild.id },
                'casino', 1, guildSettings,
            ).catch(err => console.error('[casino] season mission error:', err));

            // The wagering achievements. `doc` is the document placeWager's own
            // `$inc` returned, so `lifetimeGambled` on it already includes this
            // stake — nothing else has to be read back.
            //
            // Without this the casino awarded nothing at all: the only checks
            // that ran were the ones on the grind commands and on messageCreate,
            // so crossing a million coins wagered unlocked High Roller whenever
            // the player next happened to type in chat, which is a strange place
            // for a casino achievement to appear. The award is atomic (see
            // checkAndAwardAtomic) precisely because this document was read
            // mid-hand and must not be saved back wholesale.
            if (doc) {
                awardWagerAchievements(doc, better, source ?? interaction)
                    .catch(err => console.error('[casino] achievement check error:', err));
            }
        };

        try {
            return await game.execute(interaction, { releaseLock, onWager });
        } catch (err) {
            releaseLock();
            throw err;
        } finally {
            // The shared key, and only the shared key. Its job — keeping this
            // invocation from interleaving with another of the player's economy
            // commands — is finished the moment execute() returns; the hand
            // itself is guarded by the casino key, which the game releases.
            await release(economyKey, economyToken);
        }
    },
};
