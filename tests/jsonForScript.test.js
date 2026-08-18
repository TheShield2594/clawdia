const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { jsonForScript } = require('../src/dashboard/lib/jsonForScript');

describe('jsonForScript', () => {
    it('neutralises a </script> breakout in operator-supplied strings', () => {
        const shop = [{ name: '</script><img src=x onerror=alert(1)>', price: 10 }];
        const out = jsonForScript(shop);
        expect(out).not.toContain('</script>');
        expect(out).not.toContain('<');
        expect(out).not.toContain('>');
    });

    it('round-trips the original value through JSON.parse', () => {
        const value = [{ name: '</script>&<>"\'\\', nested: { a: [1, 2, null] } }];
        expect(JSON.parse(jsonForScript(value))).toEqual(value);
    });

    it('escapes U+2028/U+2029, which are raw line terminators in JS source', () => {
        const out = jsonForScript({ s: 'a b c' });
        expect(out).not.toContain(' ');
        expect(out).not.toContain(' ');
        expect(JSON.parse(out).s).toBe('a b c');
    });

    it('serialises undefined as null rather than emitting invalid JS', () => {
        expect(jsonForScript(undefined)).toBe('null');
    });

    it('produces output that is valid JS when embedded in a script block', () => {
        const payload = { name: '</script><script>alert(1)</script>' };
        // eslint-disable-next-line no-new-func
        const parsed = new Function(`return ${jsonForScript(payload)};`)();
        expect(parsed).toEqual(payload);
    });
});

describe('guild-settings.ejs', () => {
    const templatePath = path.join(__dirname, '../src/dashboard/views/guild-settings.ejs');
    const source = fs.readFileSync(templatePath, 'utf8');

    it('compiles', () => {
        expect(() => ejs.compile(source, { filename: templatePath })).not.toThrow();
    });

    it('never interpolates a bare JSON.stringify into the page', () => {
        // Every `<%- ... %>` in a <script> block must go through jsonForScript;
        // a bare JSON.stringify there is a stored-XSS vector.
        expect(source).not.toMatch(/<%-[^%]*JSON\.stringify/);
    });

    // Secrets that live on the guild document — provider API keys, and now MCP
    // authorization tokens — must never reach the browser. The route strips
    // them before rendering; this asserts the template would not print them
    // even if that strip were removed.
    it('renders without leaking stored secrets', () => {
        const Guild = require('../src/models/Guild');
        const settings = new Guild({ guildId: '1' }).toObject();
        settings.ai.anthropicKey = 'sk-ant-DO-NOT-LEAK';
        settings.ai.mcpServers = [{
            name: 'github',
            url: 'https://api.githubcopilot.com/mcp/',
            enabled: true,
            authorizationToken: 'ghp_DO-NOT-LEAK',
            allowedTools: [],
            blockedTools: ['delete_file']
        }];

        const html = ejs.render(source, {
            jsonForScript,
            asset: require('../src/dashboard/lib/assets').asset,
            user: { id: '1', username: 'u' },
            guild: { id: '1', name: 'g', icon: null, ownerId: '1', owner: true },
            settings,
            channels: [{ id: '10', name: 'general' }],
            voiceChannels: [], stageChannels: [], categories: [],
            roles: [{ id: '20', name: 'Admin' }],
            defaultJobs: [], defaultTiers: [], builtinAchievements: [],
            huntItems: { weapons: [], upgrades: [], ammo: [], consumables: [] },
            fishItems: { rods: [], upgrades: [], bait: [], consumables: [] },
            mineItems: { pickaxes: [], upgrades: [], blasts: [], consumables: [] },
            explorationRegions: [],
            panels: require('../src/dashboard/lib/panels').PANELS,
            activePanel: 'ai'
        }, { filename: templatePath });

        expect(html).not.toContain('ghp_DO-NOT-LEAK');
        expect(html).not.toContain('sk-ant-DO-NOT-LEAK');
        // The panel itself still renders — otherwise this would pass vacuously.
        expect(html).toContain('id="ai-mcp"');
    });
});
