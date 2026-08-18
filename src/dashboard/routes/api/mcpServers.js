const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { logAuditEvent } = require('../../lib/apiHelpers');
const {
    MAX_GUILD_SERVERS,
    MAX_TOOL_NAMES,
    MAX_TOKEN_LENGTH,
    NAME_PATTERN,
    guildServersAllowed,
    getMcpServers
} = require('../../../config/mcpServers');

const MAX_URL_LENGTH = 2048;
const MAX_TOOL_NAME_LENGTH = 128;

// Known remote MCP servers, offered in the dashboard as prefill so an admin does
// not have to hunt for the endpoint. Only servers with a documented, publicly
// hosted URL belong here — everything else is added with the "Custom" option.
const PRESETS = [
    {
        id: 'github',
        label: 'GitHub',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        tokenLabel: 'GitHub personal access token',
        tokenHint: 'Create a fine-grained PAT at github.com/settings/personal-access-tokens and grant it only the repositories and scopes the bot should reach.',
        suggestedBlockedTools: ['delete_file', 'delete_repository']
    }
];

// The token is write-only from the dashboard's point of view: it goes in, and
// only ever comes back as "there is one". Everything sent to the browser passes
// through here.
function publicServer(server) {
    return {
        name: server.name,
        url: server.url,
        enabled: server.enabled !== false,
        hasToken: Boolean(server.authorizationToken),
        allowedTools: server.allowedTools || [],
        blockedTools: server.blockedTools || [],
        addedBy: server.addedBy || null,
        createdAt: server.createdAt || null
    };
}

function validateToolNames(value, field) {
    if (value === undefined || value === null) return { value: [] };
    if (!Array.isArray(value)) return { error: `${field} must be an array of tool names` };
    if (value.length > MAX_TOOL_NAMES) return { error: `${field} is limited to ${MAX_TOOL_NAMES} tools` };
    const names = [];
    for (const entry of value) {
        if (typeof entry !== 'string') return { error: `${field} must contain only tool names` };
        const trimmed = entry.trim().slice(0, MAX_TOOL_NAME_LENGTH);
        if (trimmed && !names.includes(trimmed)) names.push(trimmed);
    }
    return { value: names };
}

function validateServerInput(body, name) {
    if (!NAME_PATTERN.test(name)) {
        return { error: 'Name must be 1–64 characters of letters, digits, underscores or hyphens' };
    }

    const rawUrl = typeof body.url === 'string' ? body.url.trim() : '';
    if (!rawUrl) return { error: 'A server URL is required' };
    if (rawUrl.length > MAX_URL_LENGTH) return { error: 'URL is too long' };

    let parsed;
    try {
        parsed = new URL(rawUrl);
    } catch {
        return { error: 'URL is not valid' };
    }
    // Anthropic opens this connection, not the bot, so there is no SSRF surface
    // here — but the API only accepts https and so does the MCP spec.
    if (parsed.protocol !== 'https:') return { error: 'URL must start with https://' };
    // The URL is listed back to the dashboard; a secret smuggled into it would
    // be readable there and in the audit log, which is exactly what keeping the
    // token in its own write-only field avoids.
    if (parsed.username || parsed.password) {
        return { error: 'URL must not contain a username or password — put the credential in the authorization token field' };
    }

    const allowed = validateToolNames(body.allowedTools, 'allowedTools');
    if (allowed.error) return { error: allowed.error };
    const blocked = validateToolNames(body.blockedTools, 'blockedTools');
    if (blocked.error) return { error: blocked.error };

    if (body.authorizationToken !== undefined && body.authorizationToken !== null) {
        if (typeof body.authorizationToken !== 'string') return { error: 'authorizationToken must be a string' };
        if (body.authorizationToken.length > MAX_TOKEN_LENGTH) return { error: 'Authorization token is too long' };
    }

    return {
        value: {
            name,
            url: rawUrl,
            enabled: body.enabled !== false,
            allowedTools: allowed.value,
            blockedTools: blocked.value
        }
    };
}

router.get('/guild/:guildId/mcp-servers', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const servers = (guildSettings?.ai?.mcpServers || []).map(publicServer);

        res.json({
            servers,
            // Config-file servers apply to every guild and are not editable
            // here; listing them stops an admin from wondering where a tool came
            // from. URLs only — the file's tokens never leave the process.
            globalServers: getMcpServers().map(s => ({ name: s.name, url: s.server.url })),
            presets: PRESETS,
            editable: guildServersAllowed(),
            maxServers: MAX_GUILD_SERVERS,
            provider: guildSettings?.ai?.provider || 'openai'
        });
    } catch (error) {
        console.error('MCP servers list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.put('/guild/:guildId/mcp-servers/:name', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    if (!guildServersAllowed()) {
        return res.status(403).json({ error: 'Dashboard-managed MCP servers are disabled by the bot operator' });
    }

    const validated = validateServerInput(req.body || {}, name);
    if (validated.error) return res.status(400).json({ error: validated.error });

    try {
        const guildSettings = await Guild.findOne({ guildId });
        if (!guildSettings) return res.status(404).json({ error: 'Guild settings not found' });

        if (!guildSettings.ai) guildSettings.ai = {};
        const servers = guildSettings.ai.mcpServers || [];
        const existing = servers.find(s => s.name === name);

        if (!existing && servers.length >= MAX_GUILD_SERVERS) {
            return res.status(400).json({ error: `At most ${MAX_GUILD_SERVERS} MCP servers per server` });
        }

        // An omitted token on an update means "leave the stored one alone", so
        // the UI can re-save a server without the admin re-entering the secret.
        // An explicit empty string clears it.
        const tokenProvided = typeof req.body?.authorizationToken === 'string';
        const token = tokenProvided ? (req.body.authorizationToken.trim() || null) : undefined;

        if (existing) {
            existing.url = validated.value.url;
            existing.enabled = validated.value.enabled;
            existing.allowedTools = validated.value.allowedTools;
            existing.blockedTools = validated.value.blockedTools;
            if (token !== undefined) existing.authorizationToken = token;
        } else {
            servers.push({
                ...validated.value,
                authorizationToken: token ?? null,
                addedBy: req.user?.id || null
            });
            guildSettings.ai.mcpServers = servers;
        }

        await guildSettings.save();
        await logAuditEvent(req, guildId, existing ? 'mcp_server_update' : 'mcp_server_add', {
            name,
            url: validated.value.url,
            enabled: validated.value.enabled,
            tokenChanged: token !== undefined
        });

        res.json({ success: true, servers: (guildSettings.ai.mcpServers || []).map(publicServer) });
    } catch (error) {
        if (error?.name === 'ValidationError') {
            return res.status(400).json({ error: error.message });
        }
        console.error('MCP server save error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.delete('/guild/:guildId/mcp-servers/:name', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    try {
        const result = await Guild.findOneAndUpdate(
            { guildId, 'ai.mcpServers.name': name },
            { $pull: { 'ai.mcpServers': { name } } },
            { new: true }
        );
        if (!result) return res.status(404).json({ error: 'No MCP server with that name' });

        await logAuditEvent(req, guildId, 'mcp_server_remove', { name });
        res.json({ success: true, servers: (result.ai?.mcpServers || []).map(publicServer) });
    } catch (error) {
        console.error('MCP server remove error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Anthropic connects to the server, so the only honest way to check a URL and
// token is to make a real request and see what comes back. One token of output
// is enough: the connection and tool listing happen before any generation.
router.post('/guild/:guildId/mcp-servers/:name/test', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    try {
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const stored = (guildSettings?.ai?.mcpServers || []).find(s => s.name === name);
        if (!stored) return res.status(404).json({ error: 'No MCP server with that name' });

        const { resolveProviderConfig, DEFAULT_MODELS } = require('../../../services/aiService');
        const ai = guildSettings?.ai || {};
        // The stored model only belongs on this request if Anthropic is the
        // provider in use — testing from a guild set to OpenAI would otherwise
        // send a GPT model name to Anthropic and fail for the wrong reason.
        const { apiKey } = resolveProviderConfig({ ...ai, provider: 'anthropic' });
        const model = ai.provider === 'anthropic' && ai.model ? ai.model : DEFAULT_MODELS.anthropic;
        if (!apiKey) {
            return res.status(400).json({ error: 'No Anthropic API key configured — add one in the Chat tab first' });
        }

        const Anthropic = require('@anthropic-ai/sdk');
        const { MCP_BETA, resolveMcpServers } = require('../../../config/mcpServers');
        const resolved = resolveMcpServers([{ ...stored, enabled: true }]).find(s => s.name === name);
        if (!resolved) return res.status(400).json({ error: 'Stored server is not valid — re-save it' });

        const client = new Anthropic({ apiKey });
        await client.beta.messages.create({
            model,
            max_tokens: 1,
            betas: [MCP_BETA],
            messages: [{ role: 'user', content: 'ping' }],
            mcp_servers: [resolved.server],
            tools: [resolved.toolset]
        });

        res.json({ success: true, message: 'Claude connected to the server.' });
    } catch (error) {
        // A failed test is an expected outcome, not a server fault: report what
        // the API said and let the admin fix the URL or token.
        const status = error?.status;
        if (!status) console.error('MCP server test error:', error?.message || error);
        const detail = error?.error?.error?.message || error?.message || 'Unknown error';
        res.json({ success: false, message: status ? `HTTP ${status}: ${detail}` : detail });
    }
});

module.exports = router;
module.exports.PRESETS = PRESETS;
module.exports.publicServer = publicServer;
module.exports.validateServerInput = validateServerInput;
