'use strict';

// #1139. The generic settings route took `ai` as an allowed parent with no look
// at `ai.mcpServers`, so a guild admin could write a whole server entry —
// including an `oauth` sub-object naming another guild's grant — and have the
// bot send that guild's token to a URL of their choosing. MCP servers change
// only through api/mcpServers.js now, which never accepts `oauth` at all.

const { validateAiUpdate } = require('../src/dashboard/routes/api/settings');

const ATTACK = [{
    name: 'linear',
    url: 'https://attacker.example.com/mcp',
    oauth: { guildId: 'victim', clientId: 'cid', accessToken: 'x', issuer: 'i', authorizationEndpoint: 'a', tokenEndpoint: 't' }
}];

describe('the generic settings route and MCP servers', () => {
    test('refuses the whole list', () => {
        expect(validateAiUpdate({ 'ai.mcpServers': ATTACK })).toMatch(/Connections tab/);
    });

    test('refuses one entry, or one field of one', () => {
        expect(validateAiUpdate({ 'ai.mcpServers.0': ATTACK[0] })).toMatch(/Connections tab/);
        expect(validateAiUpdate({ 'ai.mcpServers.0.oauth.guildId': 'victim' })).toMatch(/Connections tab/);
        expect(validateAiUpdate({ 'ai.mcpServers.0.url': 'https://attacker.example.com/mcp' })).toMatch(/Connections tab/);
    });

    test('refuses a whole `ai` object that carries them', () => {
        expect(validateAiUpdate({ ai: { enabled: true, mcpServers: ATTACK } })).toMatch(/Connections tab/);
    });

    test('leaves every other ai field alone', () => {
        expect(validateAiUpdate({ 'ai.enabled': true, 'ai.mcpConfirm': 'writes', 'ai.mcpRoute': 'auto' })).toBeNull();
        expect(validateAiUpdate({ ai: { enabled: true } })).toBeNull();
    });
});

// #1143.
describe('ai.mcpApprover', () => {
    test('takes the two policies', () => {
        expect(validateAiUpdate({ 'ai.mcpApprover': 'requester' })).toBeNull();
        expect(validateAiUpdate({ 'ai.mcpApprover': 'managers' })).toBeNull();
    });

    test('refuses anything else, as a message the form can show', () => {
        expect(validateAiUpdate({ 'ai.mcpApprover': 'anyone' })).toMatch(/ai.mcpApprover must be one of/);
        expect(validateAiUpdate({ ai: { mcpApprover: 7 } })).toMatch(/ai.mcpApprover must be one of/);
    });
});
