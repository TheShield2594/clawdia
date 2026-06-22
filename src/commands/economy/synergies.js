'use strict';

const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const User  = require('../../models/User');
const { attachGrind } = require('../../utils/grindProfile');
const Guild = require('../../models/Guild');
const { SYNERGY_LIST } = require('../../data/crossSystemData');
const { ensureHuntData }    = require('../../services/huntService');
const { ensureFishingData } = require('../../services/fishService');
const { ensureMineData }    = require('../../services/mineService');

module.exports = {
    cooldown: 5,

    data: new SlashCommandBuilder()
        .setName('synergies')
        .setDescription('View all cross-system synergy bonuses and your progress toward unlocking them'),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', flags: MessageFlags.Ephemeral });
        }

        const user = await User.findOneAndUpdate(
            { userId: interaction.user.id, guildId: interaction.guild.id },
            { $setOnInsert: { userId: interaction.user.id, guildId: interaction.guild.id } },
            { upsert: true, new: true }
        );
        await attachGrind(user);
        ensureHuntData(user);
        ensureFishingData(user);
        ensureMineData(user);

        const huntLevel  = user.hunt?.level    ?? 0;
        const fishLevel  = user.fishing?.level ?? 0;
        const mineLevel  = user.mining?.level  ?? 0;

        const lines = SYNERGY_LIST.map(syn => {
            const req = syn.requirements;
            const checks = [];
            if (req.hunt)    checks.push({ label: `Hunt Lv.${req.hunt}`,   have: huntLevel,  need: req.hunt  });
            if (req.fishing) checks.push({ label: `Fish Lv.${req.fishing}`, have: fishLevel,  need: req.fishing });
            if (req.mining)  checks.push({ label: `Mine Lv.${req.mining}`,  have: mineLevel,  need: req.mining  });

            const unlocked = checks.every(c => c.have >= c.need);

            const reqStr = checks.map(c => {
                const met = c.have >= c.need;
                const bar = progressBar(c.have, c.need);
                return `${met ? '✅' : '❌'} ${c.label} — ${bar} (${Math.min(c.have, c.need)}/${c.need})`;
            }).join('\n');

            const status = unlocked ? '🔓 **UNLOCKED**' : '🔒 Locked';

            return [
                `${syn.emoji} **${syn.name}** ${status}`,
                `> ${syn.description}`,
                `> *${syn.flavor}*`,
                reqStr,
            ].join('\n');
        });

        const embed = new EmbedBuilder()
            .setColor('#1abc9c')
            .setTitle('🔗 Cross-System Synergies')
            .setDescription(
                'Reach level milestones across **Hunt**, **Fish**, and **Mine** to unlock ' +
                'permanent passive bonuses that work across all three systems.\n​'
            )
            .addFields({ name: '​', value: lines.join('\n\n'), inline: false })
            .addFields({
                name: '📊 Your Levels',
                value: [
                    `🏹 Hunt: **${huntLevel}**`,
                    `🎣 Fish: **${fishLevel}**`,
                    `⛏️ Mine: **${mineLevel}**`,
                ].join('  ·  '),
                inline: false,
            })
            .setFooter({ text: 'Synergy bonuses apply automatically once unlocked • Use /craft list for cross-system recipes' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed] });
    },
};

function progressBar(have, need) {
    if (need <= 0) return have > 0 ? '[██████████] 100%' : '[░░░░░░░░░░] 0%';
    const safeHave = Math.max(0, have);
    const pct      = Math.min(1, safeHave / need);
    const filled   = Math.round(pct * 10);
    return `[${'█'.repeat(filled)}${'░'.repeat(10 - filled)}] ${Math.round(pct * 100)}%`;
}
