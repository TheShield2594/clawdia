const { SlashCommandBuilder, EmbedBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const User = require('../../models/User');
const Guild = require('../../models/Guild');
const {
    resolveMcpServers,
    getMcpServers,
    requiresApproval,
    DEFAULT_CONFIRM_MODE,
    DEFAULT_MCP_ROUTE
} = require('../../config/mcpServers');
const { providers, mcpMode } = require('../../services/ai/providers');
const { inspectServer } = require('../../services/ai/mcp/inspect');
const { getToolUsage } = require('../../services/ai/mcp/usage');
const { serversEmbed, toolsEmbed, activityEmbed } = require('../../views/mcpView');
const { toolLabel } = require('../../utils/toolLabel');

const MEMORY_CAP = 10;

// The same window the dashboard's Activity list uses, so the two do not
// disagree about what "recently" means.
const ACTIVITY_DAYS = 7;

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ai')
        .setDescription('AI assistant utilities')
        .setDMPermission(false)
        .addSubcommand(sub =>
            sub.setName('memories')
                .setDescription('View and manage your pinned AI memories')
                .addIntegerOption(opt =>
                    opt.setName('delete')
                        .setDescription('Delete a memory by its number (from the list)')
                        .setMinValue(1)
                        .setMaxValue(MEMORY_CAP)
                )
        )
        // A group rather than four top-level commands: Discord registers at
        // most a hundred, and tests/commandCap pins the count so spending one
        // is a decision rather than an accident.
        .addSubcommandGroup(group =>
            group.setName('mcp')
                .setDescription('Inspect this server\'s MCP connections (Manage Server)')
                .addSubcommand(sub =>
                    sub.setName('servers')
                        .setDescription('List the MCP connections and what they are set to do'))
                .addSubcommand(sub =>
                    sub.setName('tools')
                        .setDescription('List one connection\'s tools and which of them need approval')
                        .addStringOption(opt =>
                            opt.setName('server')
                                .setDescription('Which connection')
                                .setRequired(true)
                                .setAutocomplete(true)))
                .addSubcommand(sub =>
                    sub.setName('test')
                        .setDescription('Connect to one MCP server and report what came back')
                        .addStringOption(opt =>
                            opt.setName('server')
                                .setDescription('Which connection')
                                .setRequired(true)
                                .setAutocomplete(true)))
                .addSubcommand(sub =>
                    sub.setName('activity')
                        .setDescription('What the connections have been doing lately'))
        ),

    // Names the guild has configured, so nobody has to remember one exactly.
    // Answers with what is stored rather than dialling anything: an
    // autocomplete has three seconds and a handshake does not fit in them.
    async autocomplete(interaction) {
        // The same gate execute() applies. `/ai` carries no default member
        // permission — `memories` is for everyone — so without this a member
        // who may not read the connections could still learn what they are
        // called by starting to type.
        if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
            return interaction.respond([]).catch(() => {});
        }

        const typed = (interaction.options.getFocused() || '').toLowerCase();
        const names = (await guildMcpServers(interaction.guild.id)).map(server => server.name);

        await interaction.respond(
            names.filter(name => name.toLowerCase().includes(typed))
                .slice(0, 25)
                .map(name => ({ name, value: name }))
        ).catch(() => {});
    },

    async execute(interaction) {
        if (interaction.options.getSubcommandGroup(false) === 'mcp') {
            // Connections carry credentials and reach outside the server, so
            // reading them is for the people who could have configured them.
            if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
                return interaction.reply({
                    content: 'You need **Manage Server** permission to inspect MCP connections.',
                    flags: MessageFlags.Ephemeral
                });
            }
            return handleMcp(interaction);
        }

        const sub = interaction.options.getSubcommand();
        if (sub !== 'memories') return;

        const deleteIndex = interaction.options.getInteger('delete');

        let userDoc = await User.findOne({ userId: interaction.user.id, guildId: interaction.guild.id });
        if (!userDoc) {
            userDoc = await User.create({ userId: interaction.user.id, guildId: interaction.guild.id });
        }

        const memories = userDoc.pinnedMemories || [];

        if (deleteIndex != null) {
            const idx = deleteIndex - 1;
            if (idx < 0 || idx >= memories.length) {
                return interaction.reply({ content: `No memory #${deleteIndex} found. You have ${memories.length} pinned memory/memories.`, flags: MessageFlags.Ephemeral });
            }
            memories.splice(idx, 1);
            userDoc.pinnedMemories = memories;
            await userDoc.save();
            return interaction.reply({ content: `🗑️ Memory #${deleteIndex} deleted. You now have **${memories.length}** pinned memory/memories.`, flags: MessageFlags.Ephemeral });
        }

        if (memories.length === 0) {
            return interaction.reply({
                content: '📌 You have no pinned memories. React with 📌 to a bot message to save it as a memory.',
                flags: MessageFlags.Ephemeral
            });
        }

        const lines = memories.map((m, i) => {
            const preview = m.content.length > 80 ? m.content.slice(0, 80) + '…' : m.content;
            return `**${i + 1}.** ${preview}`;
        });

        const embed = new EmbedBuilder()
            .setTitle('📌 Your Pinned Memories')
            .setColor('#f1c40f')
            .setDescription(lines.join('\n\n'))
            .setFooter({ text: `${memories.length}/${MEMORY_CAP} slots used · Use /ai memories delete:<number> to remove one` });

        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
};

/** The guild's stored connections, merged with the operator's config file. */
async function guildMcpServers(guildId) {
    const settings = await Guild.findOne({ guildId }).lean();
    return resolveMcpServers(settings?.ai?.mcpServers || []);
}

async function handleMcp(interaction) {
    const sub = interaction.options.getSubcommand();
    const settings = await Guild.findOne({ guildId: interaction.guild.id }).lean();
    const ai = settings?.ai || {};

    if (sub === 'servers') {
        const provider = ai.provider || 'openai';
        const route = ai.mcpRoute || DEFAULT_MCP_ROUTE;
        const confirmMode = ai.mcpConfirm || DEFAULT_CONFIRM_MODE;

        return interaction.reply({
            embeds: [serversEmbed({
                servers: ai.mcpServers || [],
                globalServers: getMcpServers(),
                provider,
                providerLabel: providers.get(provider)?.label || provider,
                mcpSupported: Boolean(mcpMode(provider)),
                confirmMode,
                route,
                effectiveRoute: route !== 'auto'
                    ? route
                    : (requiresApproval(confirmMode, ai.mcpServers || []) ? 'client' : 'connector')
            })],
            flags: MessageFlags.Ephemeral
        });
    }

    if (sub === 'activity') {
        const usage = await getToolUsage(interaction.guild.id, ACTIVITY_DAYS);
        return interaction.reply({
            embeds: [activityEmbed(usage, ACTIVITY_DAYS)],
            flags: MessageFlags.Ephemeral
        });
    }

    // Both remaining subcommands name a server and then talk to it, which is a
    // network round trip and will not fit inside an interaction's three
    // seconds.
    const name = interaction.options.getString('server');
    const server = resolveMcpServers(ai.mcpServers || []).find(entry => entry.name === name);
    if (!server) {
        return interaction.reply({
            content: `No MCP connection named \`${name}\` — run \`/ai mcp servers\` to see what is configured.`,
            flags: MessageFlags.Ephemeral
        });
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const report = await inspectServer(server, { confirmMode: ai.mcpConfirm || DEFAULT_CONFIRM_MODE });

    // `test` is asking whether the connection works; `tools` is asking what it
    // offers. Same handshake, so the difference is only how much is shown.
    //
    // The failure goes in `content` rather than an embed, which is the one path
    // here that can carry a mention — and the text is whatever the far side put
    // in its error body. So it gets the same treatment every other server-chosen
    // string gets, plus allowedMentions to settle it whatever the string says.
    return interaction.editReply(sub === 'test' && !report.success
        ? { content: `❌ ${toolLabel(report.message, 300)}`, allowedMentions: { parse: [] } }
        : { embeds: [toolsEmbed(name, report)] });
}
