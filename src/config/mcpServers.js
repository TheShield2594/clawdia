const fs = require('fs');
const path = require('path');

// Beta flag the Messages API requires for the MCP connector. The older
// mcp-client-2025-04-04 flag (tool config nested inside the server definition)
// is deprecated; this one splits the server list from the toolset config.
const MCP_BETA = 'mcp-client-2025-11-20';

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'mcp-servers.json');

// Server names are echoed back by the API in mcp_tool_use blocks and have to
// match a toolset entry exactly, so keep them to something unambiguous.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

// Ceiling on dashboard-managed servers per guild. Every enabled tool's
// description is sent with every request, so this is a token-cost guard as much
// as a storage one.
const MAX_GUILD_SERVERS = 10;
const MAX_TOOL_NAMES = 50;
const MAX_TOKEN_LENGTH = 4096;

let cache = null;

function configPath() {
    const fromEnv = process.env.MCP_SERVERS_CONFIG;
    if (!fromEnv || !fromEnv.trim()) return DEFAULT_CONFIG_PATH;
    return path.resolve(fromEnv.trim());
}

// Dashboard-managed servers can be turned off entirely by the bot operator —
// some hosts want the config file to be the only way in.
function guildServersAllowed() {
    return process.env.MCP_ALLOW_GUILD_SERVERS !== 'false';
}

// Config-file values may be written as ${ENV_VAR} so tokens live in the
// environment rather than in a file that is easy to commit by accident.
// Returns null when the reference names a variable that is not set — callers
// drop the server rather than send the literal "${...}" text to it.
//
// This is deliberately NOT applied to dashboard-supplied values: a guild admin
// who could write ${ANTHROPIC_API_KEY} into a token field would be able to read
// the bot's environment back out of a server they control.
function resolveSecret(value, { expandEnv, label, warnings }) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!expandEnv) return trimmed;

    const match = ENV_REF_PATTERN.exec(trimmed);
    if (!match) return trimmed;

    const resolved = process.env[match[1]];
    if (!resolved || !resolved.trim()) {
        warnings.push(`${label} references ${match[0]} but that environment variable is not set`);
        return null;
    }
    return resolved.trim();
}

// Only `enabled` and `defer_loading` are meaningful per tool. Anything else is
// dropped so a typo in the config file cannot turn into an API validation error.
function normalizeToolConfig(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out = {};
    const enabled = raw.enabled;
    const deferLoading = raw.defer_loading ?? raw.deferLoading;
    if (typeof enabled === 'boolean') out.enabled = enabled;
    if (typeof deferLoading === 'boolean') out.defer_loading = deferLoading;
    return Object.keys(out).length ? out : null;
}

function normalizeToolConfigs(raw, label, warnings) {
    if (raw == null) return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`${label} "configs" must be an object keyed by tool name — ignoring it`);
        return null;
    }
    const out = {};
    for (const [toolName, toolConfig] of Object.entries(raw)) {
        const normalized = normalizeToolConfig(toolConfig);
        if (normalized) out[toolName] = normalized;
        else warnings.push(`${label} tool "${toolName}" has no usable enabled/defer_loading setting — ignoring it`);
    }
    return Object.keys(out).length ? out : null;
}

function toolNameList(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter(n => typeof n === 'string')
        .map(n => n.trim())
        .filter(Boolean)
        .slice(0, MAX_TOOL_NAMES);
}

// allowed/blocked tool lists are the shape the dashboard collects, because two
// lists of names are far easier to fill in than a nested per-tool config. They
// compile down to the same default_config/configs the API takes: an allowlist
// flips the default off and re-enables the named tools, a denylist leaves the
// default alone and switches the named tools off.
function buildToolset(name, raw, label, warnings) {
    const toolset = { type: 'mcp_toolset', mcp_server_name: name };

    const defaultConfig = normalizeToolConfig(raw.default_config ?? raw.defaultConfig);
    const configs = normalizeToolConfigs(raw.configs, label, warnings) || {};

    const allowed = toolNameList(raw.allowed_tools ?? raw.allowedTools);
    const blocked = toolNameList(raw.blocked_tools ?? raw.blockedTools);

    const merged = { ...configs };
    for (const toolName of allowed) merged[toolName] = { ...merged[toolName], enabled: true };
    // Blocking wins: a tool named in both lists stays off.
    for (const toolName of blocked) merged[toolName] = { ...merged[toolName], enabled: false };

    const effectiveDefault = allowed.length
        ? { ...defaultConfig, enabled: false }
        : defaultConfig;

    if (effectiveDefault) toolset.default_config = effectiveDefault;
    if (Object.keys(merged).length) toolset.configs = merged;
    return toolset;
}

/**
 * Whether one tool is on, according to a toolset built above.
 *
 * The toolset is the single description of a server's tool policy: Anthropic's
 * connector reads it directly, and the client-side loop the other providers use
 * asks this. Deriving both from the same object is what keeps "blocked" meaning
 * the same thing whichever model a guild has selected.
 */
function isToolEnabled(toolset, toolName) {
    const specific = toolset?.configs?.[toolName];
    if (specific && typeof specific.enabled === 'boolean') return specific.enabled;
    const fallback = toolset?.default_config?.enabled;
    return typeof fallback === 'boolean' ? fallback : true;
}

// One entry becomes three pieces: an mcp_servers connection definition for
// Anthropic's server-side connector, the mcp_toolset that references it by name
// (the API rejects either half on its own, so they are always built together),
// and the plain url/token pair the bot's own MCP client dials for every other
// provider.
function normalizeServer(raw, { label, source, expandEnv, warnings }) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        warnings.push(`${label} is not an object — skipping it`);
        return null;
    }
    if (raw.enabled === false) return null;

    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!NAME_PATTERN.test(name)) {
        warnings.push(`${label} needs a "name" of letters, digits, underscores or hyphens — skipping it`);
        return null;
    }

    const url = resolveSecret(raw.url, { expandEnv, label: `${label} ("${name}") url`, warnings });
    if (url === null) return null;
    if (!url) {
        warnings.push(`${label} ("${name}") has no "url" — skipping it`);
        return null;
    }
    let parsed;
    try {
        parsed = new URL(url);
    } catch {
        warnings.push(`${label} ("${name}") url is not a valid URL — skipping it`);
        return null;
    }
    if (parsed.protocol !== 'https:') {
        warnings.push(`${label} ("${name}") url must start with https:// — skipping it`);
        return null;
    }

    const token = resolveSecret(raw.authorization_token ?? raw.authorizationToken, {
        expandEnv,
        label: `${label} ("${name}") authorization_token`,
        warnings
    });
    if (token === null) return null;
    if (token && token.length > MAX_TOKEN_LENGTH) {
        // Truncating would send a token that cannot possibly authenticate and
        // surface as a puzzling 401 from the server instead of a config error.
        warnings.push(`${label} ("${name}") authorization_token is longer than ${MAX_TOKEN_LENGTH} characters — skipping it`);
        return null;
    }

    const server = { type: 'url', url, name };
    if (token) server.authorization_token = token;

    return {
        name,
        source,
        server,
        // What src/services/ai/mcp/ connects to when the guild is not on
        // Anthropic. Same url and same token — only the side that opens the
        // socket differs.
        connection: { url, authorizationToken: token || null },
        toolset: buildToolset(name, raw, `${label} ("${name}")`, warnings)
    };
}

function readConfigFile(file, warnings) {
    const explicit = Boolean(process.env.MCP_SERVERS_CONFIG?.trim());
    let contents;
    try {
        contents = fs.readFileSync(file, 'utf8');
    } catch (err) {
        // No config file is the normal case — the connector is opt-in. Only an
        // explicitly pointed-at path that cannot be read is worth complaining about.
        if (explicit || err.code !== 'ENOENT') {
            warnings.push(`could not read ${file}: ${err.message}`);
        }
        return null;
    }

    try {
        return JSON.parse(contents);
    } catch (err) {
        warnings.push(`${file} is not valid JSON: ${err.message}`);
        return null;
    }
}

function parseConfig(file) {
    const warnings = [];
    const parsed = readConfigFile(file, warnings);
    if (parsed == null) return { servers: [], warnings, path: file };

    // Accept either a bare array or { "servers": [...] }.
    const list = Array.isArray(parsed) ? parsed : parsed.servers;
    if (!Array.isArray(list)) {
        warnings.push(`${file} must contain an array of servers, or an object with a "servers" array`);
        return { servers: [], warnings, path: file };
    }

    const seen = new Set();
    const servers = [];
    list.forEach((raw, index) => {
        const normalized = normalizeServer(raw, {
            label: `mcp-servers[${index}]`,
            source: 'file',
            expandEnv: true,
            warnings
        });
        if (!normalized) return;
        if (seen.has(normalized.name)) {
            warnings.push(`mcp-servers[${index}] reuses the name "${normalized.name}" — skipping the duplicate`);
            return;
        }
        seen.add(normalized.name);
        servers.push(normalized);
    });

    return { servers, warnings, path: file };
}

/**
 * Read (and memoize) the operator-wide MCP server config file.
 *
 * The file is read once per process; pass { reload: true } to pick up edits
 * without a restart. Never throws — a broken config disables the connector and
 * logs why, rather than taking the bot down at startup.
 */
function loadMcpServers({ reload = false } = {}) {
    const file = configPath();
    if (!reload && cache && cache.path === file) return cache;

    cache = parseConfig(file);
    for (const warning of cache.warnings) console.warn(`[MCP] ${warning}`);
    if (cache.servers.length) {
        console.log(`[MCP] ${cache.servers.length} server(s) from ${cache.path}: ${cache.servers.map(s => s.name).join(', ')}`);
    }
    return cache;
}

function getMcpServers() {
    return loadMcpServers().servers;
}

/**
 * Merge the operator's config file with the servers a guild added in the
 * dashboard. A guild entry with the same name as a file entry replaces it, so a
 * server can be defined centrally and pointed at a guild's own credentials.
 */
function resolveMcpServers(guildServers = []) {
    const byName = new Map(getMcpServers().map(s => [s.name, s]));

    if (guildServersAllowed() && Array.isArray(guildServers)) {
        const warnings = [];
        guildServers.slice(0, MAX_GUILD_SERVERS).forEach((raw, index) => {
            const normalized = normalizeServer(raw, {
                label: `guild mcpServers[${index}]`,
                source: 'guild',
                // Guild input is untrusted: no environment expansion here.
                expandEnv: false,
                warnings
            });
            if (normalized) byName.set(normalized.name, normalized);
        });
        // Guild entries are validated again on the way in through the dashboard,
        // so anything caught here is a stored record that has gone stale.
        for (const warning of warnings) console.warn(`[MCP] ${warning}`);
    }

    return [...byName.values()];
}

/**
 * Request fragment for the Anthropic Messages API, or null when no servers
 * apply. `tools` is merged with (not substituted for) any tools the caller
 * already has — every server in mcp_servers must be referenced by exactly one
 * toolset or the API rejects the request.
 */
function buildAnthropicMcpParams(guildServers = []) {
    const servers = resolveMcpServers(guildServers);
    if (!servers.length) return null;
    return {
        mcp_servers: servers.map(s => s.server),
        tools: servers.map(s => s.toolset)
    };
}

module.exports = {
    MCP_BETA,
    DEFAULT_CONFIG_PATH,
    MAX_GUILD_SERVERS,
    MAX_TOOL_NAMES,
    MAX_TOKEN_LENGTH,
    NAME_PATTERN,
    guildServersAllowed,
    isToolEnabled,
    loadMcpServers,
    getMcpServers,
    resolveMcpServers,
    buildAnthropicMcpParams
};
