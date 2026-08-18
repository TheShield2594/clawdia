const fs = require('fs');
const path = require('path');

// Beta flag the Messages API requires for the MCP connector. The older
// mcp-client-2025-04-04 flag (tool config nested inside the server definition)
// is deprecated; this one splits the server list from the toolset config.
const MCP_BETA_HEADER = 'mcp-client-2025-11-20';

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'mcp-servers.json');

// Server names are echoed back by the API in mcp_tool_use blocks and have to
// match a toolset entry exactly, so keep them to something unambiguous.
const NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_REF_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

let cache = null;

function configPath() {
    const fromEnv = process.env.MCP_SERVERS_CONFIG;
    if (!fromEnv || !fromEnv.trim()) return DEFAULT_CONFIG_PATH;
    return path.resolve(fromEnv.trim());
}

// Values may be written as ${ENV_VAR} so tokens live in the environment rather
// than in a file that is easy to commit by accident. Returns null when the
// reference names a variable that is not set — callers drop the server rather
// than call an authenticated endpoint with the literal "${...}" text.
function resolveSecret(value, label, warnings) {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (!trimmed) return undefined;

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

// One config-file entry becomes two API pieces: an mcp_servers connection
// definition and the mcp_toolset that references it by name. The API rejects
// either half on its own, so they are always built together.
function normalizeServer(raw, index, seenNames, warnings) {
    const label = `mcp-servers[${index}]`;

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
    if (seenNames.has(name)) {
        warnings.push(`${label} reuses the name "${name}" — skipping the duplicate`);
        return null;
    }

    const url = resolveSecret(raw.url, `${label} ("${name}") url`, warnings);
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

    const token = resolveSecret(
        raw.authorization_token ?? raw.authorizationToken,
        `${label} ("${name}") authorization_token`,
        warnings
    );
    if (token === null) return null;

    const server = { type: 'url', url, name };
    if (token) server.authorization_token = token;

    const toolset = { type: 'mcp_toolset', mcp_server_name: name };
    const defaultConfig = normalizeToolConfig(raw.default_config ?? raw.defaultConfig);
    if (defaultConfig) toolset.default_config = defaultConfig;
    const configs = normalizeToolConfigs(raw.configs ?? raw.tools, `${label} ("${name}")`, warnings);
    if (configs) toolset.configs = configs;

    seenNames.add(name);
    return { name, server, toolset };
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

    const seenNames = new Set();
    const servers = [];
    list.forEach((raw, index) => {
        const normalized = normalizeServer(raw, index, seenNames, warnings);
        if (normalized) servers.push(normalized);
    });

    return { servers, warnings, path: file };
}

/**
 * Read (and memoize) the MCP server config file.
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
 * Request fragment for the Anthropic Messages API, or null when no servers are
 * configured. `tools` is merged with (not substituted for) any tools the caller
 * already has — every configured server must be referenced by exactly one
 * toolset or the API rejects the request.
 */
function buildAnthropicMcpParams() {
    const servers = getMcpServers();
    if (!servers.length) return null;
    return {
        mcp_servers: servers.map(s => s.server),
        tools: servers.map(s => s.toolset)
    };
}

module.exports = {
    MCP_BETA_HEADER,
    DEFAULT_CONFIG_PATH,
    loadMcpServers,
    getMcpServers,
    buildAnthropicMcpParams
};
