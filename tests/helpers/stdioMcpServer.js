'use strict';

// A minimal MCP server over stdio, for tests/mcpStdio.test.js: newline-delimited
// JSON-RPC on stdin and stdout, the way the SDK's stdio transport speaks it.
const readline = require('readline');

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);

// Some real servers print a banner to stdout before speaking JSON-RPC.
process.stdout.write('starting test server\n');

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return; // notifications need no answer

    switch (message.method) {
    case 'initialize':
        return send({
            jsonrpc: '2.0', id: message.id,
            result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-stdio', version: '1' } }
        });
    case 'tools/list':
        return send({
            jsonrpc: '2.0', id: message.id,
            result: { tools: [
                { name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } },
                { name: 'env', description: 'Report environment', inputSchema: { type: 'object' } },
                { name: 'crash', description: 'Exit', inputSchema: { type: 'object' } }
            ] }
        });
    case 'tools/call': {
        const { name, arguments: args = {} } = message.params;
        if (name === 'crash') {
            process.stderr.write('crashing on purpose\n');
            process.exit(3);
        }
        const text = name === 'echo'
            ? `echo: ${args.text}`
            : JSON.stringify({ secret: process.env.DISCORD_TOKEN ?? null, vault: process.env.VAULT_PATH ?? null, hasPath: Boolean(process.env.PATH) });
        return send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text }] } });
    }
    default:
        return send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'no such method' } });
    }
});
