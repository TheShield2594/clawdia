'use strict';

const { EmbedBuilder } = require('discord.js');
const COLORS = require('../utils/embedColors');
const { toolLabel } = require('../utils/toolLabel');

/**
 * How `/ai mcp` looks. No client, no model, no database — embeds built from
 * values the caller already has.
 *
 * Everything an MCP server says about itself ends up in here: tool names, tool
 * titles, the text of whatever error it returned. All of it is the far side's
 * to choose and all of it lands in a message this bot posts to a channel, so
 * every one of those values goes through `toolLabel` first. Server names are
 * validated on the way into the config and go through it anyway, because a view
 * that trusts its input from a distance is a view that stops being safe the
 * first time somebody adds a second way in.
 */

// Discord's field-value ceiling is 1024. These sit under it so a long list
// truncates predictably rather than at whatever length the API refuses.
const MAX_LINES = 15;
const MAX_FIELD_CHARS = 900;

function lines(items, empty) {
    if (!items.length) return empty;

    let body = '';
    let dropped = 0;
    for (const [index, line] of items.entries()) {
        if (index >= MAX_LINES || body.length + line.length + 1 > MAX_FIELD_CHARS) {
            dropped++;
            continue;
        }
        body += (body ? '\n' : '') + line;
    }
    if (dropped) body += `\n… and ${dropped} more`;
    return body || empty;
}

function seconds(ms) {
    if (!ms) return '';
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

/** What one approval mode means, in the words the dashboard uses. */
function describeConfirm(mode) {
    switch (mode) {
        case 'always': return 'every tool call needs approval';
        case 'writes': return 'anything not marked read-only needs approval';
        case 'destructive': return 'tools the server marks destructive need approval';
        default: return 'tools run without asking';
    }
}

/**
 * The route line, or null for a provider that only ever had one route.
 *
 * `auto` is a question rather than an answer, so it is shown resolved.
 */
function describeRoute(provider, route, effective) {
    if (provider !== 'anthropic') return null;
    const resolved = route === 'auto' ? `auto → ${effective}` : route;
    return effective === 'connector'
        ? `Route: ${resolved} — Anthropic opens the connections, so approvals and activity do not apply`
        : `Route: ${resolved} — Clawdia makes the calls`;
}

/** The guild's connections, and what would happen if the model used one. */
function serversEmbed(view) {
    const embed = new EmbedBuilder()
        .setTitle('🔌 MCP connections')
        .setColor(COLORS.INFO);

    const rows = view.servers.map(server => {
        const bits = [];
        if (server.enabled === false) bits.push('disabled');
        if (server.allowedTools?.length) bits.push(`only ${server.allowedTools.length}`);
        if (server.blockedTools?.length) bits.push(`${server.blockedTools.length} blocked`);
        if (server.confirmTools?.length) bits.push(`${server.confirmTools.length} need approval`);
        return `**${toolLabel(server.name)}**${bits.length ? ` — ${bits.join(', ')}` : ''}`;
    });

    embed.addFields({
        name: 'This server',
        value: lines(rows, 'None. Add one in the dashboard, under AI → Connections.')
    });

    if (view.globalServers?.length) {
        embed.addFields({
            name: 'Configured for every server',
            value: lines(view.globalServers.map(s => `**${toolLabel(s.name)}**`), 'None')
        });
    }

    const notes = [`Approval: ${describeConfirm(view.confirmMode)}`];
    const route = describeRoute(view.provider, view.route, view.effectiveRoute);
    if (route) notes.push(route);
    if (!view.mcpSupported) {
        notes.push(`⚠️ ${toolLabel(view.providerLabel)} cannot use MCP connections, so these are inactive.`);
    }
    embed.addFields({ name: 'Settings', value: notes.join('\n') });

    return embed;
}

/** One server's tools, with what it says about each and what happens to it. */
function toolsEmbed(serverName, report) {
    const embed = new EmbedBuilder()
        .setTitle(`🔧 ${toolLabel(serverName)}`)
        .setColor(report.success ? COLORS.INFO : COLORS.ERROR)
        .setDescription(toolLabel(report.message, 300));

    if (!report.success) return embed;

    const rows = report.tools.map(tool => {
        const marks = [];
        if (!tool.enabled) marks.push('blocked');
        else if (tool.confirm) marks.push('needs approval');
        if (tool.annotations?.readOnlyHint === true) marks.push('read-only');
        else if (tool.annotations?.destructiveHint === true) marks.push('destructive');
        return `\`${toolLabel(tool.name)}\`${marks.length ? ` — ${marks.join(', ')}` : ''}`;
    });

    embed.addFields({ name: 'Tools', value: lines(rows, 'The server offers none.') });
    return embed;
}

/** The rollup, the same numbers the dashboard's Activity list shows. */
function activityEmbed(servers, days) {
    const embed = new EmbedBuilder()
        .setTitle('📊 MCP activity')
        .setColor(COLORS.INFO)
        .setFooter({ text: `Last ${days} days` });

    if (!servers.length) {
        embed.setDescription('No tool calls yet.');
        return embed;
    }

    for (const server of servers.slice(0, 5)) {
        const summary = [`${server.calls} call${server.calls === 1 ? '' : 's'}`];
        if (server.failures) summary.push(`${server.failures} failed`);
        if (server.declined) summary.push(`${server.declined} not approved`);
        if (server.avgMs) summary.push(`avg ${seconds(server.avgMs)}`);
        // A connection nobody could reach made no calls, so it needs saying
        // separately or a dead server reads as an unused one.
        if (server.unreachable) summary.push(`⚠️ unreachable on ${server.unreachable}`);

        const rows = server.tools.map(tool =>
            `\`${toolLabel(tool.tool)}\` ${tool.calls}` +
            `${tool.failures ? ` · ${tool.failures} failed` : ''}` +
            `${tool.avgMs ? ` · ${seconds(tool.avgMs)}` : ''}`);

        if (server.lastError) rows.push(`⚠️ last error: ${toolLabel(server.lastError, 120)}`);

        embed.addFields({
            name: `${toolLabel(server.server)} — ${summary.join(' · ')}`,
            value: lines(rows, 'No individual tools recorded.')
        });
    }

    return embed;
}

module.exports = { serversEmbed, toolsEmbed, activityEmbed, describeConfirm, describeRoute };
