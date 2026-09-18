const {
    SlashCommandBuilder,
    EmbedBuilder,
    AttachmentBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    MessageFlags,
} = require('discord.js');

// Self-service data access and erasure (#1013). A self-hosted operator in the
// EU or UK is the controller for everything the bot stores about a member and
// has a month to answer an access or erasure request; this is the path that
// answers most of them without a Mongo shell. Both subcommands do exactly what
// the operator-side `scripts/delete-user-data.js` and the dashboard button do —
// all three call src/utils/userDataRegistry.js — so there is one definition of
// what is stored, what is handed back, and what erasure keeps.
const { exportUserData, deleteUserData } = require('../../utils/userDataRegistry');
const { claimIfAvailable, release } = require('../../utils/commandCooldowns');
const { ownedBy } = require('../../utils/collectorOwner');
const COLORS = require('../../utils/embedColors');

// One export a day per member per guild. An access request is not something a
// person needs to make every minute, and the archive is a full read of a dozen
// collections — the rate limit keeps a bored member from turning it into a
// denial-of-service against their own guild's database.
const EXPORT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const CONFIRM_TIMEOUT_MS = 60 * 1000;

/**
 * The export archive as a Discord file attachment.
 *
 * Pretty-printed rather than minified: the member reading it is the audience,
 * and an access request answered with an unreadable wall of JSON is answered in
 * form only.
 */
function buildExportFile(dump) {
    const body = Buffer.from(JSON.stringify(dump, null, 2), 'utf8');
    return new AttachmentBuilder(body, {
        name: `clawdia-data-${dump.guildId}-${dump.userId}.json`,
        description: 'Your Clawdia data export',
    });
}

/**
 * A human-readable account of what erasure just did, one line per collection
 * that changed, grouped by whether the record was removed or kept.
 */
function formatDeletionSummary(report) {
    const removed = report.results.filter(r => r.behavior === 'delete' && r.changed > 0);
    const kept = report.results.filter(r => r.behavior !== 'delete');

    const lines = [];
    if (removed.length) {
        lines.push('**Deleted**');
        for (const r of removed) lines.push(`• ${r.label}`);
    }
    if (report.coinsRemoved > 0) {
        lines.push(`• Balances (${report.coinsRemoved.toLocaleString()} coins), recorded in the guild ledger for accounting`);
    }
    if (kept.length) {
        lines.push('', '**Kept, by necessity**');
        for (const r of kept) {
            const verb = r.behavior === 'pseudonymize' ? 'identity redacted' : 'retained';
            lines.push(`• ${r.label} — ${verb}`);
        }
    }
    return lines.join('\n');
}

async function handleExport(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    // Claim the once-a-day window before doing the work. `claimIfAvailable`
    // returns the existing expiry when the window is still held, which is the
    // refusal below; 0 means it took the window and the export may proceed.
    const heldUntil = await claimIfAvailable(interaction.client, {
        bucket: 'mydata-export', userId, guildId, cooldownMs: EXPORT_COOLDOWN_MS,
    });
    if (heldUntil) {
        return interaction.reply({
            content: `You can export your data once a day. Try again <t:${Math.ceil(heldUntil / 1000)}:R>.`,
            flags: MessageFlags.Ephemeral,
        });
    }

    // If the acknowledgement itself fails (Discord timed out the interaction),
    // give the day's window back — the export never happened, and the member
    // should not be locked out of retrying for 24h over a failure that was ours.
    try {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
        await release(interaction.client, { bucket: 'mydata-export', userId, guildId, cooldownMs: EXPORT_COOLDOWN_MS });
        throw error;
    }

    let file;
    try {
        const dump = await exportUserData(userId, guildId);
        file = buildExportFile(dump);
    } catch (error) {
        console.error('[mydata] export failed:', error);
        // The work never happened, so give the day's window back rather than
        // locking the member out over a failure that was ours.
        await release(interaction.client, { bucket: 'mydata-export', userId, guildId, cooldownMs: EXPORT_COOLDOWN_MS });
        return interaction.editReply('Something went wrong building your export. Please try again.');
    }

    // DM'd rather than posted in-channel: the archive is the member's own data,
    // and a channel it happens to be run in is the wrong place for it.
    try {
        await interaction.user.send({
            content: '📦 Here is everything Clawdia stores about you in this server. '
                + 'The `retained` flag marks the records erasure keeps and why.',
            files: [file],
        });
    } catch {
        await release(interaction.client, { bucket: 'mydata-export', userId, guildId, cooldownMs: EXPORT_COOLDOWN_MS });
        return interaction.editReply(
            "I couldn't DM you — your privacy settings block direct messages from this server. "
            + 'Enable them and run the command again.'
        );
    }

    return interaction.editReply('📬 Sent your data export to your DMs.');
}

async function handleDelete(interaction) {
    const userId = interaction.user.id;
    const guildId = interaction.guild.id;

    const warning = new EmbedBuilder()
        .setColor(COLORS.WARN)
        .setTitle('⚠️ Delete your data')
        .setDescription(
            'This permanently deletes your Clawdia data in **this server** — your economy '
            + 'profile and balances, AI conversations and memories, reminders, progression '
            + 'and more.\n\n'
            + 'Some records are kept because the server must keep them: **active bans** stay '
            + 'in force, and **moderation cases** are kept with your identity redacted rather '
            + 'than dropped. Deleted balances are written to the guild ledger so its coin '
            + 'supply stays accountable.\n\n'
            + '**This cannot be undone.** Export your data first if you want a copy.'
        );

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('mydata_delete_confirm').setLabel('Delete everything').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('mydata_delete_cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
    );

    await interaction.reply({ embeds: [warning], components: [row], flags: MessageFlags.Ephemeral });
    const message = await interaction.fetchReply();

    let choice;
    try {
        choice = await message.awaitMessageComponent({
            filter: ownedBy(userId),
            time: CONFIRM_TIMEOUT_MS,
        });
    } catch {
        return interaction.editReply({
            content: '⏳ Timed out — nothing was deleted.',
            embeds: [], components: [],
        }).catch(() => {});
    }

    if (choice.customId === 'mydata_delete_cancel') {
        return choice.update({ content: 'Cancelled — nothing was deleted.', embeds: [], components: [] });
    }

    await choice.update({ content: '🧹 Deleting your data…', embeds: [], components: [] });

    try {
        const report = await deleteUserData(userId, guildId);
        const done = new EmbedBuilder()
            .setColor(COLORS.SUCCESS)
            .setTitle('✅ Your data has been deleted')
            .setDescription(formatDeletionSummary(report) || 'You had no stored data in this server.');
        return interaction.editReply({ content: '', embeds: [done], components: [] });
    } catch (error) {
        console.error('[mydata] delete failed:', error);
        return interaction.editReply({
            content: 'Something went wrong deleting your data. Nothing may have been fully removed — please try again.',
            embeds: [], components: [],
        });
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mydata')
        .setDescription('Export or delete the data Clawdia stores about you')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('export')
                .setDescription('DM yourself a copy of everything Clawdia stores about you here (once a day)'))
        .addSubcommand(sub =>
            sub.setName('delete')
                .setDescription('Permanently delete your data in this server, with confirmation')),

    async execute(interaction) {
        const sub = interaction.options.getSubcommand();
        if (sub === 'export') return handleExport(interaction);
        if (sub === 'delete') return handleDelete(interaction);
    },

    // Exported for tests/mydataCommand.test.js.
    buildExportFile,
    formatDeletionSummary,
};
