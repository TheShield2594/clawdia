const axios = require('axios');

const COMPOSIO_BASE = process.env.COMPOSIO_BASE || 'https://backend.composio.dev/api/v1';

// Allowed hostnames for the native Discord webhook action (SSRF guard)
const DISCORD_WEBHOOK_HOSTS = new Set(['discord.com', 'discordapp.com', 'ptb.discord.com', 'canary.discord.com']);

// Curated list of integrations shown in the dashboard
const AVAILABLE_INTEGRATIONS = [
    { id: 'github',         name: 'GitHub',           description: 'Create issues, add comments, trigger workflows', icon: '🐙', category: 'Development'        },
    { id: 'linear',         name: 'Linear',           description: 'Create and manage engineering issues',           icon: '⚡', category: 'Development'        },
    { id: 'notion',         name: 'Notion',           description: 'Create pages and update databases',             icon: '📝', category: 'Productivity'       },
    { id: 'googlesheets',   name: 'Google Sheets',    description: 'Append rows and update cells',                  icon: '📊', category: 'Productivity'       },
    { id: 'googledrive',    name: 'Google Drive',     description: 'Create and manage files',                       icon: '📁', category: 'Productivity'       },
    { id: 'gmail',          name: 'Gmail',            description: 'Read, search, and send emails',                 icon: '📧', category: 'Communication'      },
    { id: 'googlecalendar', name: 'Google Calendar',  description: 'Create and manage calendar events',             icon: '📅', category: 'Productivity'       },
    { id: 'airtable',       name: 'Airtable',         description: 'Update bases and records',                      icon: '🗃️', category: 'Productivity'       },
    { id: 'slack',          name: 'Slack',            description: 'Send messages to channels',                     icon: '💬', category: 'Communication'      },
    { id: 'trello',         name: 'Trello',           description: 'Create cards, update boards',                   icon: '📋', category: 'Project Management' },
    { id: 'jira',           name: 'Jira',             description: 'Create and update tickets',                     icon: '🔧', category: 'Project Management' },
    { id: 'discord',        name: 'Discord Webhook',  description: 'Post to other servers via webhook',             icon: '🔔', category: 'Communication'      },
];

// Trigger definitions (shared with automationEngine)
const TRIGGER_TYPES = [
    { id: 'member_join',       name: 'Member Joins',      description: 'Fires when someone joins the server',     variables: ['user.name', 'user.id', 'guild.name', 'timestamp'] },
    { id: 'member_leave',      name: 'Member Leaves',     description: 'Fires when someone leaves the server',    variables: ['user.name', 'user.id', 'guild.name', 'timestamp'] },
    { id: 'message_keyword',   name: 'Keyword Message',   description: 'Fires when a message contains a keyword', variables: ['user.name', 'user.id', 'message.content', 'guild.name', 'timestamp'] },
    { id: 'role_assigned',     name: 'Role Assigned',     description: 'Fires when a role is given to a user',    variables: ['user.name', 'user.id', 'role.name', 'guild.name', 'timestamp'] },
    { id: 'moderation_action', name: 'Moderation Action', description: 'Fires on ban, kick, warn, or mute',       variables: ['user.name', 'user.id', 'action.type', 'action.reason', 'guild.name', 'timestamp'] },
    { id: 'level_up',          name: 'User Levels Up',    description: 'Fires when a user reaches a new level',   variables: ['user.name', 'user.id', 'level', 'guild.name', 'timestamp'] },
    { id: 'scheduled',         name: 'Scheduled',         description: 'Fires on a recurring cron schedule',      variables: ['guild.name', 'guild.id', 'timestamp'] },
];

function makeClient(apiKey) {
    return axios.create({
        baseURL: COMPOSIO_BASE,
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        timeout: 15000
    });
}

function entityId(guildId) {
    return `guild-${guildId}`;
}

// Fetch action definitions from Composio and format as OpenAI-compatible tools
async function getTools(guildId, apiKey, appNames) {
    if (!apiKey || !appNames?.length) return [];
    try {
        const { data } = await makeClient(apiKey).get('/actions', {
            params: { appNames: appNames.join(','), limit: 20 }
        });
        return (data.items || []).map(action => ({
            type: 'function',
            function: {
                name: action.name,
                description: action.description || action.display_name || action.name,
                parameters: action.parameters || { type: 'object', properties: {} }
            }
        }));
    } catch (err) {
        console.error(`[Composio] getTools error for guild ${guildId}:`, err.message);
        return [];
    }
}

async function initiateConnection(guildId, apiKey, appName, redirectUri) {
    const { data } = await makeClient(apiKey).post('/connectedAccounts', {
        appName,
        entityId: entityId(guildId),
        redirectUri
    });
    return data;
}

async function getConnections(guildId, apiKey) {
    if (!apiKey) return [];
    const { data } = await makeClient(apiKey).get('/connectedAccounts', {
        params: { entityId: entityId(guildId) }
    });
    return data.items || [];
}

async function getConnectionStatus(connectionId, apiKey) {
    const { data } = await makeClient(apiKey).get(`/connectedAccounts/${connectionId}`);
    return data;
}

async function deleteConnection(connectionId, apiKey) {
    await makeClient(apiKey).delete(`/connectedAccounts/${connectionId}`);
}

async function executeAction(guildId, apiKey, actionName, input) {
    // Native Discord webhook — validate URL before calling (SSRF guard)
    if (actionName === 'DISCORD_WEBHOOK_SEND') {
        const { webhook_url, content, username } = input;
        if (!webhook_url || !content) throw new Error('webhook_url and content are required');

        let parsed;
        try { parsed = new URL(webhook_url); } catch { throw new Error('Invalid webhook_url'); }
        if (parsed.protocol !== 'https:') throw new Error('webhook_url must use HTTPS');
        if (!DISCORD_WEBHOOK_HOSTS.has(parsed.hostname)) throw new Error('webhook_url must be a Discord webhook URL');

        const webhookClient = axios.create({ timeout: 8000 });
        const res = await webhookClient.post(webhook_url, { content, username: username || 'UltraBot' });
        if (res.status < 200 || res.status >= 300) throw new Error(`Webhook returned status ${res.status}`);
        return { success: true };
    }

    const { data } = await makeClient(apiKey).post(`/actions/${actionName}/execute`, {
        entityId: entityId(guildId),
        input
    });
    return data;
}

module.exports = {
    AVAILABLE_INTEGRATIONS,
    TRIGGER_TYPES,
    getTools,
    initiateConnection,
    getConnections,
    getConnectionStatus,
    deleteConnection,
    executeAction
};
