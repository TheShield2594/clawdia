const Guild = require('../models/Guild');
const { EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { createWelcomeCard } = require('../utils/cardGenerator');

module.exports = {
    name: 'guildMemberAdd',
    async execute(member, client) {
        try {
            const guildSettings = await Guild.findOne({ guildId: member.guild.id });
            
            if (!guildSettings || !guildSettings.welcome.enabled) return;
            
            const channel = member.guild.channels.cache.get(guildSettings.welcome.channelId);
            if (!channel) return;
            
            const message = guildSettings.welcome.message
                .replace(/{user}/g, `<@${member.id}>`)
                .replace(/{server}/g, member.guild.name)
                .replace(/{memberCount}/g, member.guild.memberCount);
            
            if (guildSettings.welcome.cardEnabled) {
                const card = await createWelcomeCard(member);
                const attachment = new AttachmentBuilder(card, { name: 'welcome.png' });
                
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setDescription(message)
                    .setImage('attachment://welcome.png')
                    .setTimestamp();
                
                await channel.send({ embeds: [embed], files: [attachment] });
            } else {
                const embed = new EmbedBuilder()
                    .setColor('#00ff00')
                    .setTitle('Welcome!')
                    .setDescription(message)
                    .setThumbnail(member.user.displayAvatarURL({ dynamic: true }))
                    .setTimestamp();
                
                await channel.send({ embeds: [embed] });
            }
            
            if (guildSettings.autoRoles.length > 0) {
                for (const autoRole of guildSettings.autoRoles) {
                    const role = member.guild.roles.cache.get(autoRole.roleId);
                    if (role) {
                        await member.roles.add(role).catch(console.error);
                    }
                }
            }
        } catch (error) {
            console.error('Error in guildMemberAdd:', error);
        }
    }
};