/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

// #675. The stylesheet had no `prefers-reduced-motion` in it anywhere, while
// three decorative blobs drifted behind every page on 18–26s infinite loops
// and every panel and modal switch ran `panel-in`. WCAG 2.2.2.
//
// The CSS is checked as text because jsdom has no cascade to ask: it parses
// the stylesheet but resolves nothing, so an assertion about a computed
// animation would pass whatever the file said. What is worth pinning is that
// the block exists, that it covers everything rather than a list of today's
// selectors, and that the things it cannot reach from CSS are handled in the
// script.
const fs = require('fs');
const path = require('path');
const { PUBLIC, bootPage, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const REDUCE = '(prefers-reduced-motion: reduce)';
const css = fs.readFileSync(path.join(PUBLIC, 'styles.css'), 'utf8');

/** The body of the `prefers-reduced-motion: reduce` block, braces balanced. */
function reduceBlock() {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i++) {
        if (css[i] === '{') depth++;
        else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
    }
    throw new Error('unterminated @media block');
}

describe('the stylesheet', () => {
    const block = reduceBlock();

    it('answers the preference at all', () => {
        expect(css).toContain(REDUCE);
    });

    // A list of the selectors that animate today is accurate until the next
    // panel is written; the universal rule is what makes it stay true.
    it('reaches every element rather than the ones that animate today', () => {
        expect(block).toMatch(/\*,\s*\*::before,\s*\*::after/);
        expect(block).toMatch(/animation-duration:\s*\.01ms\s*!important/);
        expect(block).toMatch(/animation-iteration-count:\s*1\s*!important/);
        expect(block).toMatch(/transition-duration:\s*\.01ms\s*!important/);
    });

    // Not `0s`: a zero-duration animation never fires `animationend` in some
    // engines, and anything waiting on one would hang.
    it('never zeroes a duration outright', () => {
        expect(block).not.toMatch(/animation-duration:\s*0s/);
        expect(block).not.toMatch(/transition-duration:\s*0s/);
    });

    // Run to completion the blobs settle 120px from where they were authored,
    // and .blob-3 loses the translate(-50%, -50%) that centres it.
    it('stops the three infinite background blobs where they stand', () => {
        expect(block).toMatch(/\.mesh-bg::before,\s*\.mesh-bg::after,\s*\.mesh-bg \.blob-3\s*\{\s*animation:\s*none\s*!important/);
    });

    it('leaves the loading skeletons legible once they stop pulsing', () => {
        expect(block).toMatch(/\.skel-tile,\s*\.skel-bar,\s*\.skel-chart\s*\{[^}]*animation:\s*none\s*!important/);
        expect(block).toMatch(/\.skel-tile,\s*\.skel-bar,\s*\.skel-chart\s*\{[^}]*opacity:/);
    });

    it('has all three infinite animations inside its reach', () => {
        // If a fourth is ever added, the universal rule above already covers
        // it — this is here so the count in the issue stays checkable.
        expect(css.match(/animation:\s*float-[abc][^;]*infinite/g)).toHaveLength(3);
    });
});

// `scroll-behavior` in CSS does not govern a `behavior: 'smooth'` passed to
// scrollIntoView — the argument wins over the stylesheet — so the one call on
// the page that scrolls has to ask the preference itself.
describe('the script', () => {
    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    function bootWith(reduce) {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.body.innerHTML = '';
        return bootPage({ media: { [REDUCE]: reduce } });
    }

    it('scrolls smoothly when no preference is expressed', () => {
        bootWith(false);
        expect(window.scrollBehavior()).toBe('smooth');
    });

    it('cuts straight there when reduced motion is asked for', () => {
        bootWith(true);
        expect(window.scrollBehavior()).toBe('auto');
    });

    it('follows the preference changing mid-session', () => {
        const page = bootWith(false);
        page.media.set(REDUCE, true);
        expect(window.scrollBehavior()).toBe('auto');
    });

    it('falls back to smooth where the query cannot be answered', () => {
        bootWith(false);
        delete window.matchMedia;
        expect(window.scrollBehavior()).toBe('smooth');
    });

    it('is what the one smooth scroll on the page uses', () => {
        const js = fs.readFileSync(path.join(PUBLIC, 'guild-settings.js'), 'utf8');
        // The literal survives inside scrollBehavior() itself; what must not
        // come back is a scroll that hardcodes it at the call site.
        expect(js).not.toMatch(/scroll(IntoView|To)\([^)]*behavior:\s*'smooth'/);
        expect(js).toMatch(/scrollIntoView\(\{ behavior: scrollBehavior\(\)/);
    });
});
