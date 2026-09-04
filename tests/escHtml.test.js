const fs = require('fs');
const path = require('path');

const { escHtml } = require('../src/dashboard/public/esc-html');

const VIEW = fs.readFileSync(path.join(__dirname, '../src/dashboard/views/guild-settings.ejs'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, '../src/dashboard/public/guild-settings.js'), 'utf8');
// The page is the template plus the script it loads; either one could
// reintroduce the patterns below.
const PAGE = VIEW + SCRIPT;

describe('escHtml', () => {
    it('escapes the characters that break out of an attribute', () => {
        expect(escHtml(`&<>"'\``)).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
    });

    it('neutralises the reported nickname payload in a single-quoted attribute', () => {
        const payload = "');fetch('/api/guild/1/achievements/grant',{method:'POST'})//";
        const attr = `data-member-name='${escHtml(payload)}'`;
        expect(attr).not.toContain("'" + ')');   // no raw quote to close the attribute
        expect(escHtml(payload)).not.toMatch(/'/);
    });

    it('renders falsy-but-real values instead of dropping them', () => {
        // The old third copy returned '' for anything falsy, so a 0 vanished.
        expect(escHtml(0)).toBe('0');
        expect(escHtml(false)).toBe('false');
        expect(escHtml(null)).toBe('');
        expect(escHtml(undefined)).toBe('');
    });

    it('escapes idempotently-unsafe input without double-decoding', () => {
        expect(escHtml('&amp;')).toBe('&amp;amp;');
    });
});

describe('guild-settings.ejs', () => {
    it('defines escHtml once, in the shared script', () => {
        expect(PAGE).not.toMatch(/function\s+escHtml/);
        expect(VIEW).toContain("<script defer src=\"<%= asset('/esc-html.js') %>\"></script>");
    });

    it('never concatenates escaped values into an inline event handler', () => {
        // An on*="" attribute is HTML-decoded before it is parsed as JS, so
        // escHtml cannot protect a JS string literal built this way.
        const inlineHandlerWithEscHtml = /\son[a-z]+="[^"]*'\s*\+\s*escHtml\(/;
        expect(PAGE).not.toMatch(inlineHandlerWithEscHtml);
    });

    it('wires the member-search dropdown through dataset, not an inline handler', () => {
        expect(PAGE).toContain('data-action="member-select"');
        expect(PAGE).not.toContain('onmousedown="selectGrantMember');
        expect(PAGE).toContain("selectGrantMember(el.dataset.memberId, el.dataset.memberName)");
    });
});
