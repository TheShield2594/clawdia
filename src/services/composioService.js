const axios = require('axios');

const COMPOSIO_BASE = 'https://backend.composio.dev/api/v1';

// Curated list of integrations we surface to server owners
const AVAILABLE_INTEGRATIONS = [
    { id: 'github',       name: 'GitHub',         description: 'Create issues, add comments, trigger workflows', icon: '🐙', category: 'Development',        color: '#24292e' },
    { id: 'linear',       name: 'Linear',          description: 'Create and manage engineering issues',           icon: '⚡', category: 'Development',        color: '#5e6ad2' },
    { id: 'notion',       name: 'Notion',          description: 'Create pages and update databases',             icon: '📝', category: 'Productivity',       color: '#000000' },
    { id: 'googlesheets', name: 'Google Sheets',   description: 'Append rows and update cells',                  icon: '📊', category: 'Productivity',       color: '#0f9d58' },
    { id: 'googledrive',  name: 'Google Drive',    description: 'Create and manage files',                       icon: '📁', category: 'Productivity',       color: '#4285f4' },
    { id: 'airtable',     name: 'Airtable',        description: 'Update bases and records',                      icon: '🗃️', category: 'Productivity',       color: '#18bfff' },
    { id: 'slack',        name: 'Slack',           description: 'Send messages to channels',                     icon: '💬', category: 'Communication',      color: '#4a154b' },
    { id: 'trello',       name: 'Trello',          description: 'Create cards, update boards',                   icon: '📋', category: 'Project Management', color: '#0052cc' },
    { id: 'jira',         name: 'Jira',            description: 'Create and update tickets',                     icon: '🔧', category: 'Project Management', color: '#0052cc' },
    { id: 'discord',      name: 'Discord Webhook', description: 'Post to other servers via webhook',             icon: '🔔', category: 'Communication',      color: '#5865f2' },
];

// Curated action definitions per integration (used in the UI and automation builder)
const APP_ACTIONS = {
    github: [
        { id: 'GITHUB_CREATE_AN_ISSUE',                          name: 'Create Issue',         inputs: ['owner', 'repo', 'title', 'body'] },
        { id: 'GITHUB_CREATE_A_COMMENT_ON_AN_ISSUE_OR_PULL_REQUEST', name: 'Add Comment',     inputs: ['owner', 'repo', 'issue_number', 'body'] },
    ],
    linear: [
        { id: 'LINEAR_CREATE_LINEAR_ISSUE', name: 'Create Issue', inputs: ['team_id', 'title', 'description'] },
    ],
    notion: [
        { id: 'NOTION_CREATE_PAGE', name: 'Create Page', inputs: ['parent_id', 'title', 'content'] },
    ],
    googlesheets: [
        { id: 'GOOGLESHEETS_BATCH_UPDATE', name: 'Append Row', inputs: ['spreadsheet_id', 'range', 'values'] },
    ],
    slack: [
        { id: 'SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL', name: 'Send Message', inputs: ['channel', 'text'] },
    ],
    trello: [
        { id: 'TRELLO_CREATE_CARD_IN_BOARD', name: 'Create Card', inputs: ['list_id', 'name', 'desc'] },
    ],
    jira: [
        { id: 'JIRA_CREATE_ISSUE', name: 'Create Issue', inputs: ['project_key', 'summary', 'description'] },
    ],
    airtable: [
        { id: 'AIRTABLE_CREATE_RECORD', name: 'Create Record', inputs: ['base_id', 'table_name', 'fields'] },
    ],
    googledrive: [
        { id: 'GOOGLEDRIVE_CREATE_FILE', name: 'Create File', inputs: ['name', 'content', 'folder_id'] },
    ],
    // discord webhook is handled natively in the automation engine
    discord: [
        { id: 'DISCORD_WEBHOOK_SEND', name: 'Send Webhook Message', inputs: ['webhook_url', 'content', 'username'] },
    ],
};

// Trigger type definitions used across the UI and engine
const TRIGGER_TYPES = [
    { id: 'member_join',       name: 'Member Joins',      description: 'Fires when someone joins the server',          variables: ['user.name', 'user.id', 'user.tag', 'guild.name', 'guild.id', 'timestamp'] },
    { id: 'member_leave',      name: 'Member Leaves',     description: 'Fires when someone leaves the server',         variables: ['user.name', 'user.id', 'user.tag', 'guild.name', 'guild.id', 'timestamp'] },
    { id: 'message_keyword',   name: 'Keyword Message',   description: 'Fires when a message contains a keyword',      variables: ['user.name', 'user.id', 'message.content', 'message.channelId', 'guild.name', 'timestamp'] },
    { id: 'role_assigned',     name: 'Role Assigned',     description: 'Fires when a role is given to a user',         variables: ['user.name', 'user.id', 'role.name', 'role.id', 'guild.name', 'timestamp'] },
    { id: 'moderation_action', name: 'Moderation Action', description: 'Fires on ban, kick, warn, or mute',            variables: ['user.name', 'user.id', 'mod.name', 'action.type', 'action.reason', 'guild.name', 'timestamp'] },
    { id: 'level_up',          name: 'User Levels Up',    description: 'Fires when a user reaches a new level',        variables: ['user.name', 'user.id', 'level', 'guild.name', 'timestamp'] },
    { id: 'scheduled',         name: 'Scheduled',         description: 'Fires on a recurring schedule (cron syntax)',  variables: ['guild.name', 'guild.id', 'timestamp'] },
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

async function initiateConnection(guildId, appName, redirectUri) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not configured');

    const client = makeClient(apiKey);
    const { data } = await client.post('/connectedAccounts', {
        appName,
        entityId: entityId(guildId),
        redirectUri
    });
    // Returns { connectionId, redirectUrl, status }
    return data;
}

async function getConnections(guildId) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) return [];

    const client = makeClient(apiKey);
    const { data } = await client.get('/connectedAccounts', {
        params: { entityId: entityId(guildId) }
    });
    return data.items || [];
}

async function getConnectionStatus(connectionId) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) return null;

    const client = makeClient(apiKey);
    const { data } = await client.get(`/connectedAccounts/${connectionId}`);
    return data;
}

async function deleteConnection(connectionId) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not configured');

    const client = makeClient(apiKey);
    await client.delete(`/connectedAccounts/${connectionId}`);
}

async function executeAction(guildId, actionName, input) {
    const apiKey = process.env.COMPOSIO_API_KEY;
    if (!apiKey) throw new Error('COMPOSIO_API_KEY is not configured');

    // Native Discord webhook action — no Composio call needed
    if (actionName === 'DISCORD_WEBHOOK_SEND') {
        const { webhook_url, content, username } = input;
        if (!webhook_url || !content) throw new Error('webhook_url and content are required');
        await axios.post(webhook_url, { content, username: username || 'UltraBot' });
        return { success: true };
    }

    const client = makeClient(apiKey);
    const { data } = await client.post(`/actions/${actionName}/execute`, {
        entityId: entityId(guildId),
        input
    });
    return data;
}

function isConfigured() {
    return Boolean(process.env.COMPOSIO_API_KEY);
}

module.exports = {
    AVAILABLE_INTEGRATIONS,
    APP_ACTIONS,
    TRIGGER_TYPES,
    initiateConnection,
    getConnections,
    getConnectionStatus,
    deleteConnection,
    executeAction,
    isConfigured
};
