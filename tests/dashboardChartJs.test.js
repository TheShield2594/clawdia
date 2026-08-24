/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
process.env.SUPPRESS_JEST_WARNINGS = 'true';

const { TextEncoder, TextDecoder } = require('util');
global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

/**
 * #685. Chart.js was a <script> in guild-settings.ejs's <head> pointing at
 * cdn.jsdelivr.net, pinned to a floating major (`chart.js@4`) with no
 * subresource integrity — so the bundle that ran could change between two page
 * loads with nothing to notice, and `https://cdn.jsdelivr.net` had to stay in
 * `script-src` on a page whose CSP is otherwise a per-request nonce. It was
 * also downloaded and parsed on every visit, though only the Analytics panel
 * and the Economy panel's Health tab ever draw a chart.
 *
 * The library is now an exact-pinned devDependency vendored into
 * public/vendor/ by scripts/vendor-chartjs.sh, and injected on the first chart.
 * These tests hold the three halves of that: nothing off-origin, the vendored
 * copy matching the pin, and the page not paying for it up front.
 */
const fs = require('fs');
const path = require('path');
const { bootPage, clickTab, settle, forgetDocumentListeners } = require('./helpers/guildSettingsPage');

const ROOT = path.join(__dirname, '..');
const PUBLIC = path.join(ROOT, 'src', 'dashboard', 'public');
const VENDOR = path.join(PUBLIC, 'vendor', 'chart.umd.min.js');

const read = p => fs.readFileSync(p, 'utf8');
const view = read(path.join(ROOT, 'src', 'dashboard', 'views', 'guild-settings.ejs'));
const dashboardJs = read(path.join(PUBLIC, 'guild-settings.js'));
const server = read(path.join(ROOT, 'src', 'dashboard', 'server.js'));
const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));

describe('Chart.js is served from this origin', () => {
    it('loads no script from a third-party origin', () => {
        const offenders = [...view.matchAll(/<script[^>]+src="(?:https?:)?\/\/[^"]+"/g)].map(m => m[0]);
        expect(offenders).toEqual([]);
    });

    it('leaves no third-party origin in script-src', () => {
        const directive = /`script-src ([^`]*)`/.exec(server);
        expect(directive).not.toBeNull();
        // A nonce and 'self'. Any bare host here is an origin allowed to run
        // arbitrary script on every dashboard page.
        expect(directive[1]).not.toMatch(/https?:\/\//);
        expect(directive[1]).toContain("'self'");
    });

    it('pins an exact version rather than a range', () => {
        const pin = pkg.devDependencies['chart.js'];
        expect(pin).toBeDefined();
        // `^4` or `~4.5` would let the vendored file and the lockfile drift
        // apart, which is the floating-major problem moved rather than fixed.
        expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('ships a vendored bundle that matches the pin', () => {
        expect(fs.existsSync(VENDOR)).toBe(true);
        const vendored = read(VENDOR);
        expect(vendored).toContain(`Chart.js v${pkg.devDependencies['chart.js']}`);
        // The library is what defines the global the dashboard calls.
        expect(vendored).toContain('window.Chart');
        // The .map it would name is 968 KB and deliberately not vendored, so a
        // surviving reference is a 404 on every devtools open.
        expect(vendored).not.toContain('sourceMappingURL');
    });

    it('is a byte-for-byte copy of the installed package, minus that reference', () => {
        // Guards the one thing a hand-edit or a stale checkout would break: the
        // file served is not the file the lockfile's integrity hash covers.
        const installed = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.min.js');
        if (!fs.existsSync(installed)) {
            throw new Error('chart.js is not installed — run npm ci before the suite.');
        }
        // Split rather than searched: `toContain` would accept code appended
        // after the library, which is exactly the supply-chain edit the
        // lockfile's integrity hash cannot see once the file is vendored.
        // scripts/vendor-chartjs.sh writes a three-line banner and then the
        // artifact, so everything past line three must match it byte for byte.
        const BANNER_LINES = 3;
        const lines = read(VENDOR).split('\n');
        const banner = lines.slice(0, BANNER_LINES).join('\n');
        const body = lines.slice(BANNER_LINES).join('\n');

        expect(banner).toContain(`Chart.js v${pkg.devDependencies['chart.js']}`);
        expect(banner).toContain('scripts/vendor-chartjs.sh');
        const strip = s => s.replace(/^\/\/# sourceMappingURL=.*$/m, '').trimEnd();
        expect(body).toBe(`${strip(read(installed))}\n`);
    });
});

describe('Chart.js is fetched only when a chart is drawn', () => {
    it('keeps it out of the page head', () => {
        const head = view.slice(0, view.indexOf('</head>'));
        expect(head).not.toMatch(/<script[^>]+chart/i);
    });

    it('hands the hashed URL to the page rather than hard-coding it', () => {
        // asset() lives in the view, so this is where the content hash can be
        // stamped — the injected <script> is cached like every other asset.
        expect(view).toMatch(/chartJsUrl:\s*<%-\s*jsonForScript\(asset\('\/vendor\/chart\.umd\.min\.js'\)\)\s*%>/);
        expect(dashboardJs).toContain('BOOT.chartJsUrl');
    });
});

describe('the page it loads into', () => {
    const injected = () => Array.from(document.head.querySelectorAll('script[src]'))
        .filter(s => /chart\.umd\.min\.js/.test(s.src));

    beforeEach(() => {
        jest.spyOn(console, 'error').mockImplementation(() => {});
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        bootPage();
    });

    afterEach(async () => {
        await settle();
        forgetDocumentListeners();
        jest.restoreAllMocks();
    });

    it('boots without fetching it at all', () => {
        expect(injected()).toHaveLength(0);
        expect(window.Chart).toBeUndefined();
    });

    it('fetches it when a panel that draws charts is opened', async () => {
        clickTab('analytics');
        await settle();

        const [script] = injected();
        expect(script).toBeDefined();
        // Content-hashed by asset(), so a version bump busts the year-long
        // immutable cache express.static serves it under.
        expect(script.getAttribute('src')).toMatch(/^\/vendor\/chart\.umd\.min\.js\?v=[0-9a-f]+$/);
    });

    it('fetches it once however many charts ask', async () => {
        // The analytics panel starts six charts in a row. Six <script> tags
        // would be six downloads of the same 200 KB.
        clickTab('analytics');
        await settle();
        clickTab('economy');
        await settle();

        expect(injected()).toHaveLength(1);
    });

    it('says so, rather than failing the panel, when the load does not arrive', async () => {
        clickTab('analytics');
        await settle();

        const [script] = injected();
        script.onerror(new window.Event('error'));
        await settle();

        expect(document.getElementById('toast-message').textContent).toMatch(/charts/i);
        // The rest of the panel is still readable: the tiles rendered before
        // the charts were ever asked for.
        expect(document.getElementById('analytics-kpi-row')).not.toBeNull();
    });
});
