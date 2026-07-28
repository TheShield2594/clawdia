const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

// jsonForScript is defined inside dashboard/server.js's start() closure, which
// needs a live Discord client and Mongo URL to run. Rather than booting the
// dashboard, lift the function out of the source so the test exercises exactly
// the shipped implementation.
function loadJsonForScript() {
    const src = fs.readFileSync(path.join(__dirname, '../src/dashboard/server.js'), 'utf8');
    const start = src.indexOf('function jsonForScript(value) {');
    const end = src.indexOf('\n    }', start) + '\n    }'.length;
    if (start === -1 || end < start) throw new Error('jsonForScript not found in server.js');
    // eslint-disable-next-line no-new-func
    return new Function(`${src.slice(start, end)}; return jsonForScript;`)();
}

const jsonForScript = loadJsonForScript();

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
});
