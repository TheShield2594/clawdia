const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const User  = require('../../models/User');
const Guild = require('../../models/Guild');

const COOLDOWN_MS   = 2 * 3_600_000; // 2 hours
const SUCCESS_CHANCE = 0.45;
const MIN_ROB_BALANCE = 50;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('rob')
        .setDescription('Attempt to steal coins from another member')
        .addUserOption(o =>
            o.setName('target')
                .setDescription('The member to rob')
                .setRequired(true)),

    async execute(interaction) {
        const guildSettings = await Guild.findOne({ guildId: interaction.guild.id });
        if (guildSettings?.economy?.enabled === false) {
            return interaction.reply({ content: 'The economy is disabled on this server.', ephemeral: true });
        }

        const currency = guildSettings?.economy?.currency || '💰';
        const target   = interaction.options.getUser('target');

        if (target.id === interaction.user.id) {
            return interaction.reply({ content: "You can't rob yourself.", ephemeral: true });
        }
        if (target.bot) {
            return interaction.reply({ content: "You can't rob a bot.", ephemeral: true });
        }

        const [robber, victim] = await Promise.all([
            User.findOneAndUpdate({ userId: interaction.user.id, guildId: interaction.guild.id }, {}, { upsert: true, new: true }),
            User.findOne({ userId: target.id, guildId: interaction.guild.id })
        ]);

        // Cooldown
        if (robber.lastWork && Date.now() - new Date(robber.lastWork).getTime() < COOLDOWN_MS) {
            const remaining = COOLDOWN_MS - (Date.now() - new Date(robber.lastWork).getTime());
            const mins = Math.ceil(remaining / 60000);
            return interaction.reply({ content: `You're lying low after your last job. Try again in **${mins} min**.`, ephemeral: true });
        }

        if (!victim || victim.balance < MIN_ROB_BALANCE) {
            return interaction.reply({ content: `${target.username} doesn't have enough ${currency} to be worth robbing (minimum ${currency}${MIN_ROB_BALANCE}).`, ephemeral: true });
        }

        try {
            const success = Math.random() < SUCCESS_CHANCE;
            robber.lastWork = new Date();

            let embed;
            if (success) {
                const stolen = Math.floor(victim.balance * (0.1 + Math.random() * 0.2));
                robber.balance += stolen;
                victim.balance -= stolen;
                await Promise.all([robber.save(), victim.save()]);

                embed = new EmbedBuilder()
                    .setColor('#f39c12')
                    .setTitle('🦹 Successful Heist!')
                    .setDescription(`You slipped into **${target.username}'s** wallet and made off with **${currency}${stolen.toLocaleString()}**!`)
                    .addFields(
                        { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true },
                        { name: 'Their Balance', value: `${currency}${victim.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();
            } else {
                const fine = Math.floor(robber.balance * 0.1);
                const paid = Math.min(fine, robber.balance);
                robber.balance = Math.max(0, robber.balance - paid);
                victim.balance += paid;
                await Promise.all([robber.save(), victim.save()]);

                embed = new EmbedBuilder()
                    .setColor('#e74c3c')
                    .setTitle('🚔 Caught Red-Handed!')
                    .setDescription(`**${target.username}** caught you and you were fined **${currency}${paid.toLocaleString()}**, which went straight to them.`)
                    .addFields(
                        { name: 'Fine Paid', value: `${currency}${paid.toLocaleString()}`, inline: true },
                        { name: 'Your Balance', value: `${currency}${robber.balance.toLocaleString()}`, inline: true }
                    )
                    .setTimestamp();
            }

            await interaction.reply({ embeds: [embed] });
        } catch (error) {
            console.error('Rob command error:', error);
            if (!interaction.replied) {
                await interaction.reply({ content: 'Something went wrong.', ephemeral: true });
            }
        }
    }
};
