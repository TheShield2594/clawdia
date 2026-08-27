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
    getMcpServers,
    resolveMcpServers,
    requiresApproval,
    CONFIRM_MODES,
    DEFAULT_CONFIRM_MODE,
    MCP_ROUTES,
    DEFAULT_MCP_ROUTE
} = require('../../../config/mcpServers');
const { getToolUsage } = require('../../../services/ai/mcp/usage');
const { inspectServer } = require('../../../services/ai/mcp/inspect');
const { prewarmMcpServers } = require('../../../services/ai/mcp/toolkit');
const { providers, mcpMode } = require('../../../services/ai/providers');

const MAX_URL_LENGTH = 2048;
const MAX_TOOL_NAME_LENGTH = 128;

// A week is what makes "is this connection healthy" answerable without the
// panel having to offer a date picker for a question nobody asks that way.
const DEFAULT_USAGE_DAYS = 7;

// Services offered in the dashboard as prefill, so an admin does not have to
// hunt for an endpoint or work out what kind of credential it wants.
//
// These are a starting point, not a whitelist: every field is editable, and a
// server that moves is fixed by typing the new address. Services that only
// accept an OAuth authorization-code flow are deliberately absent, because the
// dashboard has one credential field and it holds a token, not a login.
//
// A preset with an empty `url` is a service with no single hosted endpoint to
// point at — the server is one you run or one a hosting provider spins up per
// account, so the address is yours and only the rest can be prefilled. Those
// carry a `urlPlaceholder` and say so in their `hint`.
const PRESETS = [
    {
        id: 'github',
        label: 'GitHub',
        name: 'github',
        url: 'https://api.githubcopilot.com/mcp/',
        requiresToken: true,
        hint: 'GitHub hosts this one: repositories, issues, pull requests and code search.',
        tokenLabel: 'GitHub personal access token',
        tokenHint: 'Create a fine-grained PAT at github.com/settings/personal-access-tokens and grant it only the repositories and scopes the bot should reach.',
        suggestedBlockedTools: ['delete_file', 'delete_repository']
    },
    {
        id: 'fastmail',
        label: 'Fastmail',
        name: 'fastmail',
        url: 'https://api.fastmail.com/mcp',
        requiresToken: true,
        hint: 'Fastmail hosts this one: mail, contacts and calendar for the account the token belongs to.',
        tokenLabel: 'Fastmail API token',
        tokenHint: 'Create one in Fastmail under Settings → Privacy & Security → Integrations, with only the scopes the bot needs. Run Test after saving and block anything that sends or deletes mail.',
        suggestedBlockedTools: []
    },
    {
        id: 'gmail',
        label: 'Gmail (your own endpoint)',
        name: 'gmail',
        url: '',
        urlPlaceholder: 'https://your-mcp-host.example.com/gmail/mcp',
        requiresToken: true,
        hint: 'Google does not publish a hosted Gmail MCP endpoint. Run a Gmail MCP server yourself, or use a hosting provider that gives you a per-account https URL, and paste that URL here.',
        tokenLabel: 'The token your Gmail MCP server expects',
        tokenHint: 'Whatever bearer token your server issues — not a Google password. Run Test after saving and block anything that sends, trashes or deletes mail.',
        suggestedBlockedTools: []
    },
    {
        id: 'spotify',
        label: 'Spotify (your own endpoint)',
        name: 'spotify',
        url: '',
        urlPlaceholder: 'https://your-mcp-host.example.com/spotify/mcp',
        requiresToken: true,
        hint: 'Spotify does not publish a hosted MCP endpoint. Run a Spotify MCP server yourself, or use a hosting provider that gives you a per-account https URL, and paste that URL here.',
        tokenLabel: 'The token your Spotify MCP server expects',
        tokenHint: 'Whatever bearer token your server issues. Playback control needs a Premium account on Spotify\'s side; search and library reads do not.',
        suggestedBlockedTools: []
    },
    {
        id: 'deepwiki',
        label: 'DeepWiki (open-source repo docs)',
        name: 'deepwiki',
        url: 'https://mcp.deepwiki.com/mcp',
        requiresToken: false,
        hint: 'Documentation for public repositories. No account and no token.',
        tokenHint: 'No token needed — DeepWiki serves public repository documentation.',
        suggestedBlockedTools: []
    },
    {
        id: 'context7',
        label: 'Context7 (library documentation)',
        name: 'context7',
        url: 'https://mcp.context7.com/mcp',
        requiresToken: false,
        hint: 'Up-to-date documentation for open-source libraries, by version.',
        tokenLabel: 'Context7 API key',
        tokenHint: 'Optional. Works without a key at a lower rate limit; a key from context7.com raises it.',
        suggestedBlockedTools: []
    },
    {
        id: 'huggingface',
        label: 'Hugging Face',
        name: 'huggingface',
        url: 'https://huggingface.co/mcp',
        requiresToken: true,
        hint: 'Search models, datasets, Spaces and papers on the Hub.',
        tokenLabel: 'Hugging Face access token',
        tokenHint: 'Create a read token at huggingface.co/settings/tokens. A read token is enough to search models, datasets and papers.',
        suggestedBlockedTools: []
    },
    {
        id: 'stripe',
        label: 'Stripe',
        name: 'stripe',
        url: 'https://mcp.stripe.com',
        requiresToken: true,
        hint: 'Customers, payments and subscriptions for the account the key belongs to.',
        tokenLabel: 'Stripe restricted API key',
        tokenHint: 'Use a restricted key from the Stripe dashboard with read-only permissions — a Discord bot has no business holding a key that can move money.',
        suggestedBlockedTools: []
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
        confirmTools: server.confirmTools || [],
        resources: server.resources === true,
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
    // https only: Anthropic's connector accepts nothing else, and neither does
    // the MCP spec. The bot now opens this connection itself for every other
    // provider, so a guild admin is choosing where it dials — the SSRF answer
    // for that is not this check but src/utils/outboundGuard.js, which refuses
    // private and reserved space at the socket, on the first request and on
    // every redirect. This one is here to fail early with a clear message.
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
    const confirm = validateToolNames(body.confirmTools, 'confirmTools');
    if (confirm.error) return { error: confirm.error };

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
            blockedTools: blocked.value,
            confirmTools: confirm.value,
            // Reading a server's documents into the system prompt is a separate
            // decision from calling its tools, so it is a separate switch.
            resources: body.resources === true
        }
    };
}

/**
 * Which route a Claude request would actually take right now.
 *
 * `auto` is the default and reads as a question rather than an answer, so the
 * panel is told the answer as well as the setting.
 */
function effectiveMcpRoute(guildSettings) {
    const route = guildSettings?.ai?.mcpRoute || DEFAULT_MCP_ROUTE;
    if (route !== 'auto') return route;
    return requiresApproval(guildSettings?.ai?.mcpConfirm, guildSettings?.ai?.mcpServers || [])
        ? 'client'
        : 'connector';
}

// The guild's MCP servers, the operator's global ones, the presets, and whether editing is allowed at all.
router.get('/guild/:guildId/mcp-servers', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    try {
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const servers = (guildSettings?.ai?.mcpServers || []).map(publicServer);
        const provider = guildSettings?.ai?.provider || 'openai';

        res.json({
            servers,
            // Config-file servers apply to every guild and are not editable
            // here; listing them stops an admin from wondering where a tool came
            // from. URLs only — the file's tokens never leave the process.
            globalServers: getMcpServers().map(s => ({ name: s.name, url: s.server.url })),
            presets: PRESETS,
            editable: guildServersAllowed(),
            maxServers: MAX_GUILD_SERVERS,
            provider,
            providerLabel: providers.get(provider)?.label || provider,
            // The guild's approval policy, so the panel can say what each
            // connection's tools will actually do without a second request.
            confirmMode: guildSettings?.ai?.mcpConfirm || DEFAULT_CONFIRM_MODE,
            confirmModes: CONFIRM_MODES,
            // Only Anthropic has two ways to reach a server, so this is the
            // setting and what it currently resolves to — the panel says which
            // route is actually in effect rather than making an admin work out
            // what "auto" means for their own configuration.
            mcpRoute: guildSettings?.ai?.mcpRoute || DEFAULT_MCP_ROUTE,
            mcpRoutes: MCP_ROUTES,
            effectiveRoute: effectiveMcpRoute(guildSettings),
            // 'native' (the provider's own API takes the servers), 'client'
            // (the bot lists and calls the tools itself) or false. The panel
            // only has to warn when it is false.
            mcpMode: mcpMode(provider),
            // The same answer for every provider, so the panel can update its
            // note when the Chat tab's dropdown changes rather than only after
            // the change has been saved and reloaded.
            providerSupport: Object.fromEntries(
                [...providers.values()].map(p => [p.name, { label: p.label, mcp: p.mcp || false }])
            )
        });
    } catch (error) {
        console.error('MCP servers list error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Creates or replaces one guild MCP server: URL, token, and its tool allow and block lists.
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
            existing.confirmTools = validated.value.confirmTools;
            existing.resources = validated.value.resources;
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
            resources: validated.value.resources,
            tokenChanged: token !== undefined
        });

        // The saved server, dialled now rather than on whoever sends the next
        // message in the guild. An admin who saves a connection is about to go
        // and try it, and discovery is the same handshake and list either way —
        // paid here, off the clock, instead of on a Discord reply. Deliberately
        // not awaited: the panel is waiting on this response, and a server that
        // is slow or down changes nothing about whether the save worked.
        if (validated.value.enabled) {
            prewarmMcpServers([{ ...validated.value, authorizationToken: token ?? existing?.authorizationToken ?? null }])
                .catch(err => console.warn(`[MCP] prewarm after save failed: ${err.message}`));
        }

        res.json({ success: true, servers: (guildSettings.ai.mcpServers || []).map(publicServer) });
    } catch (error) {
        if (error?.name === 'ValidationError') {
            return res.status(400).json({ error: error.message });
        }
        console.error('MCP server save error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Removes one guild MCP server.
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

// Connects to one MCP server and reports what it found.
//
// The bot does the handshake itself rather than asking a model to do it, which
// is what makes the result mean the same thing for every guild: it needs no AI
// provider key, spends no tokens, and answers the two questions an admin
// actually has — is the URL right, and is the token accepted — instead of
// reporting them through whatever the model said back.
router.post('/guild/:guildId/mcp-servers/:name/test', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const name = String(req.params.name || '').trim();

    try {
        const guildSettings = await Guild.findOne({ guildId }).lean();
        const stored = (guildSettings?.ai?.mcpServers || []).find(s => s.name === name);
        if (!stored) return res.status(404).json({ error: 'No MCP server with that name' });

        // Resolved rather than read straight off the document, so the test
        // dials exactly what a chat request would — same https check, same
        // token, same tool filters.
        const resolved = resolveMcpServers([{ ...stored, enabled: true }]).find(s => s.name === name);
        if (!resolved) return res.status(400).json({ error: 'Stored server is not valid — re-save it' });

        const mode = guildSettings?.ai?.mcpConfirm || DEFAULT_CONFIRM_MODE;
        // The same inspection `/ai mcp test` runs in Discord, so an admin who
        // tests here and then checks from a channel is told the same thing.
        // It reports a failed connection rather than throwing: a failed test is
        // the expected outcome of a test, and what the server said is the
        // useful part of it.
        const report = await inspectServer(resolved, { confirmMode: mode });

        res.json({
            success: report.success,
            message: report.message,
            toolCount: report.toolCount,
            // The other two halves of the protocol: documents the connection
            // can answer questions from, and prompt templates `/ai mcp prompt`
            // can run. Both are counted whether or not the guild switched
            // resources on, because "this server has 40 documents" is what
            // makes that switch mean something.
            resourceCount: report.resourceCount,
            promptCount: report.promptCount,
            enabledCount: report.enabledCount,
            confirmCount: report.confirmCount,
            confirmMode: mode,
            // Named so an admin filling in the allow/block lists can copy them
            // instead of guessing at what the server calls things.
            tools: report.tools.map(tool => tool.name),
            // The same tools with what each one says about itself and what the
            // guild's policy makes of it. Alongside `tools` rather than
            // replacing it, so anything already reading the plain name list
            // keeps working.
            toolDetail: report.tools
        });
    } catch (error) {
        console.error('MCP server test error:', error?.message || error);
        res.json({ success: false, message: error?.message || 'Unknown error' });
    }
});

// What the guild's MCP connections have actually been doing.
//
// The Test button answers "does this work right now"; this answers the two
// questions it cannot — is anything using this connection, and has it been
// failing when nobody was looking. A server that went down last Tuesday shows
// up here as a run of unreachable turns rather than as a console warning on a
// host the admin cannot read.
router.get('/guild/:guildId/mcp-servers/usage', checkAuth, checkGuildAccess, async (req, res) => {
    const { guildId } = req.params;

    const requested = Number.parseInt(req.query.days, 10);
    const days = Number.isFinite(requested) ? Math.min(90, Math.max(1, requested)) : DEFAULT_USAGE_DAYS;

    try {
        res.json({ days, servers: await getToolUsage(guildId, days) });
    } catch (error) {
        console.error('MCP usage error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
module.exports.PRESETS = PRESETS;
module.exports.publicServer = publicServer;
module.exports.validateServerInput = validateServerInput;
