const fs = require('fs');
const path = require('path');
const ejs = require('ejs');
const { guildSettingsLocals } = require('./helpers/guildSettingsLocals');
const { PUBLIC, PAGE_SCRIPTS, pageScriptSource } = require('./helpers/dashboardScripts');

const VIEW = path.join(__dirname, '..', 'src', 'dashboard', 'views', 'guild-settings.ejs');

function render(overrides) {
    return ejs.render(fs.readFileSync(VIEW, 'utf8'), guildSettingsLocals(overrides), { filename: VIEW });
}

/** The contents of every inline (src-less) <script> on the page. */
function inlineScripts(html) {
    return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
}

describe('guild-settings view', () => {
    const html = render();

    it('renders without leaving any EJS behind', () => {
        expect(html).not.toContain('<%');
    });

    it('keeps the page behaviour in cacheable files rather than inline', () => {
        const inlineBytes = inlineScripts(html).reduce((n, s) => n + s.length, 0);
        const scriptBytes = PAGE_SCRIPTS.reduce((n, f) => n + fs.statSync(path.join(PUBLIC, f)).size, 0);
        expect(inlineBytes).toBeLessThan(60_000);
        expect(scriptBytes).toBeGreaterThan(100_000);
    });

    // The page's scripts are three lists that have to agree: the view's tags,
    // the build's SOURCES and the suites' boot order (#935). Execution order is
    // document order because every tag is deferred, so this is what stops the
    // view loading a panel before the machinery it registers into.
    it('loads exactly the page scripts the build knows about, in that order', () => {
        const loaded = [...html.matchAll(/<script defer src="\/([a-z-]+)(?:\.min)?\.js\?v=/g)]
            .map(m => `${m[1]}.js`);
        expect(loaded).toEqual(PAGE_SCRIPTS);
    });

    // `.min` is optional throughout: asset() serves the minified twin when the
    // build has written one and the readable file when it has not (#905), so
    // which of the two a checkout renders says only whether `npm run
    // build:assets` has been run. What is being asserted either way is that the
    // URL carries the hash.
    it('loads that file through a content-hashed URL', () => {
        expect(html).toMatch(/<script defer src="\/guild-settings(\.min)?\.js\?v=[0-9a-f]{10}"><\/script>/);
        expect(html).toMatch(/href="\/styles(\.min)?\.css\?v=[0-9a-f]{10}"/);
        expect(html).toMatch(/src="\/esc-html(\.min)?\.js\?v=[0-9a-f]{10}"/);
    });

    it('bootstraps the script before loading it', () => {
        expect(html.indexOf('window.CLAWDIA_BOOTSTRAP'))
            .toBeLessThan(html.search(/\/guild-settings(\.min)?\.js\?v=/));
    });

    it('hands the script every value it reads off the bootstrap', () => {
        const boot = inlineScripts(html).find(s => s.includes('window.CLAWDIA_BOOTSTRAP'));
        const script = pageScriptSource();
        const keys = new Set([...script.matchAll(/boot\('(\w+)'\)/g)].map(m => m[1]));
        keys.add('guildId');
        keys.add('guildName');
        for (const key of keys) {
            expect(boot).toContain(`${key}:`);
        }
    });

    it('never lets a guild name break out, in the bootstrap block or anywhere else', () => {
        const payload = '</script><img src=x onerror=alert(1)>';
        const hostile = render({
            guild: { id: '1', name: payload, icon: null, ownerId: '1', owner: true },
        });

        // The name is printed in several places besides the bootstrap — the
        // title, the sidebar, the topbar — so the whole response has to be
        // clear of the raw payload, not just the script block. Checking for
        // the markup, not for "onerror=": that substring survives inside the
        // escaped text, where it is inert for want of a real tag around it.
        expect(hostile).not.toContain(payload);
        expect(hostile).not.toContain('<img');

        // Scoped to the bootstrap: the page legitimately contains </script>
        // tags of its own, so this one can only be asserted there.
        const boot = inlineScripts(hostile).find(s => s.includes('window.CLAWDIA_BOOTSTRAP'));
        expect(boot).not.toContain('</script>');

        // And the name did reach the page, escaped — otherwise the above passes
        // by the payload having been dropped rather than neutralised.
        expect(hostile).toContain('&lt;img src=x onerror=alert(1)&gt;');
    });
});
