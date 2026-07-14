const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const Reminder = require('../../models/Reminder');

function shortId(reminder) {
    return reminder._id.toString().slice(-6);
}

function truncate(text, max) {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('reminders')
        .setDescription('View or cancel your open reminders')
        .addSubcommand(sub => sub
            .setName('list')
            .setDescription('List your open reminders'))
        .addSubcommand(sub => sub
            .setName('cancel')
            .setDescription('Cancel one of your reminders')
            .addStringOption(option => option.setName('id')
                .setDescription('The short id shown in /reminders list')
                .setRequired(true))),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();

        if (sub === 'list') {
            const open = await Reminder.find({ userId: interaction.user.id, completed: false }).sort({ remindAt: 1 });
            if (!open.length) {
                return interaction.reply({ content: "You don't have any open reminders.", flags: MessageFlags.Ephemeral });
            }

            const lines = open.map(r => {
                const epoch = Math.floor(r.remindAt.getTime() / 1000);
                const cadence = r.repeatInterval ? ` (repeats ${r.repeatInterval})` : '';
                return `\`${shortId(r)}\` — ${truncate(r.message, 80)} — <t:${epoch}:R>${cadence}`;
            });

            let body = lines.join('\n');
            if (body.length > 1900) {
                let shown = 0;
                let acc = '';
                for (const line of lines) {
                    if (acc.length + line.length + 1 > 1850) break;
                    acc += (acc ? '\n' : '') + line;
                    shown++;
                }
                body = `${acc}\n_…and ${open.length - shown} more._`;
            }

            return interaction.reply({ content: `**Your open reminders:**\n${body}`, flags: MessageFlags.Ephemeral });
        }

        // cancel
        const id = interaction.options.getString('id', true).trim().toLowerCase();
        const open = await Reminder.find({ userId: interaction.user.id, completed: false });
        const matches = open.filter(r => shortId(r) === id);

        if (matches.length === 0) {
            return interaction.reply({ content: `No open reminder found with id \`${id}\`. Check \`/reminders list\`.`, flags: MessageFlags.Ephemeral });
        }
        if (matches.length > 1) {
            return interaction.reply({ content: `Multiple reminders match \`${id}\` — this shouldn't normally happen. Please contact an admin.`, flags: MessageFlags.Ephemeral });
        }

        await Reminder.deleteOne({ _id: matches[0]._id });
        return interaction.reply({ content: `✅ Cancelled reminder: "${truncate(matches[0].message, 100)}"`, flags: MessageFlags.Ephemeral });
    }
};
