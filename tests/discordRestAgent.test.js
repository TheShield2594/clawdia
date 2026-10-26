'use strict';

// discord.js uploads must not depend on which undici loaded first. Requiring
// the top-level undici (8.x) before discord.js installs undici 8's Agent as the
// shared global dispatcher, which rejects the platform FormData @discordjs/rest
// builds for `files` — the /pet card failure. A REST client given
// discordRestAgent() dispatches through its own undici instead.

const http = require('http');
require('undici');
const { REST } = require('discord.js');
const { discordRestAgent } = require('../src/utils/discordRestAgent');

let server;
let api;

beforeAll(done => {
    server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ contentType: req.headers['content-type'] }));
        });
    });
    server.listen(0, '127.0.0.1', () => {
        api = `http://127.0.0.1:${server.address().port}`;
        done();
    });
});

afterAll(done => {
    server.closeAllConnections();
    server.close(done);
});

function upload(rest) {
    return rest.post('/channels/1/messages', {
        body: { content: 'pet' },
        files: [{ name: 'pet-card.png', data: Buffer.from('png') }],
    });
}

test('the shared global dispatcher rejects the upload once undici 8 has loaded', async () => {
    const rest = new REST({ api, retries: 0 }).setToken('token');
    await expect(upload(rest)).rejects.toThrow(/FormData created by this undici/);
});

test('a REST client with discordRestAgent() sends the upload as multipart', async () => {
    const rest = new REST({ api, retries: 0, agent: discordRestAgent() }).setToken('token');
    const res = await upload(rest);
    expect(res.contentType).toMatch(/^multipart\/form-data/);
});
