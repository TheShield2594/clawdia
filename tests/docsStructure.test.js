/**
 * #720. Six markdown files at the repo root, ~75 KB, with AI provider setup
 * written three times (README, SETUP_GUIDE, FEATURES) and Daily News setup
 * three times — and those three copies had already drifted about `/dailynews`,
 * which was the concrete cost: a correction has to land in three places and
 * last time it landed in two.
 *
 * The reference material now lives in docs/ and each topic is written in one
 * file. This is what keeps that true. It is deliberately not a general prose
 * duplication detector — those flag every legitimate cross-reference. It picks
 * one phrase per topic that only the file *teaching* that topic has any reason
 * to contain, and requires exactly one file to contain it.
 *
 * Naming a topic and linking to it is not duplication and must stay free. Only
 * a second set of instructions counts.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DOCS = path.join(ROOT, 'docs');

const markdown = dir => fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

const rootDocs = markdown(ROOT);
const docsDir = markdown(DOCS);
const allDocs = [...rootDocs, ...docsDir.map(f => `docs/${f}`)];

describe('the reference material lives in docs/', () => {
    it('keeps the root to the files a repo root is for', () => {
        // README, the changelog, and the two contributor-facing files.
        // Everything else is reference and belongs in docs/, where the four
        // moved files — and now the audit log — live.
        //
        // PRODUCTIONREADY.md was the fifth entry here until #915. It is a
        // scrupulous audit log that says in its own header not to read it as a
        // release gate, under a filename that asserted exactly that from the
        // repo root, where it was one of the first things a visitor saw. It is
        // docs/AUDIT_LOG.md now, which is what the file has always called
        // itself.
        expect(rootDocs).toEqual([
            'CHANGELOG.md',
            'CLAUDE.md',
            'CONTRIBUTING.md',
            'README.md',
        ]);
    });

    it('has the four files the issue named', () => {
        for (const doc of ['AI_COMPARISON.md', 'API_REFERENCE.md', 'FEATURES.md', 'SETUP_GUIDE.md']) {
            expect([doc, docsDir.includes(doc)]).toEqual([doc, true]);
        }
    });

    it('names every one of them in README\'s index', () => {
        // An index that silently omits a file is how a doc stops being read,
        // and then stops being updated. tests/docsLinks.test.js already checks
        // that each link resolves; this checks that none is missing.
        const readme = read('README.md');
        const index = readme.slice(readme.indexOf('## Documentation'));

        const missing = docsDir.filter(doc => !index.includes(`docs/${doc}`));
        expect(missing).toEqual([]);
    });
});

// phrase -> the one file that teaches it
const TOPICS = {
    // AI provider setup: getting a key and where to put it.
    'Add to `.env` as': 'docs/SETUP_GUIDE.md',
    // Daily News setup: the numbered walkthrough.
    'Enable Daily News Digest': 'docs/SETUP_GUIDE.md',
    // The log level/format table, as opposed to naming the two variables.
    '| `LOG_FORMAT` |': 'docs/SETUP_GUIDE.md',
    // The insights metric definitions, which README carried a second copy of.
    '(joins − leaves) / joins': 'docs/FEATURES.md',
    '24-bucket': 'docs/FEATURES.md',
    // The generated command list.
    'BEGIN GENERATED COMMANDS': 'docs/COMMANDS.md',
};

describe('each topic is written once', () => {
    it.each(Object.entries(TOPICS))('%s is taught only in %s', (phrase, home) => {
        const carriers = allDocs.filter(doc => read(doc).includes(phrase));
        expect(carriers).toEqual([home]);
    });

    it('looks at a real corpus', () => {
        // Every assertion above is a filter over this list. Derived wrong, it
        // reports the same green for "nothing is duplicated" as for "nothing
        // was read".
        expect(allDocs.length).toBeGreaterThanOrEqual(10);
        expect(allDocs).toContain('README.md');
        expect(allDocs).toContain('docs/FEATURES.md');
    });
});

describe('the drift the issue was about', () => {
    it('describes the manual digest trigger the same way everywhere', () => {
        // Three copies disagreed about whether `/dailynews` exists. It does
        // not, and no command file provides it — so no doc may promise one.
        const promises = allDocs.filter(doc => /`\/dailynews/.test(read(doc)));
        expect(promises).toEqual([]);

        expect(fs.existsSync(path.join(ROOT, 'src', 'commands'))).toBe(true);
        const commandFiles = [];
        (function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith('.js')) commandFiles.push(entry.name);
            }
        })(path.join(ROOT, 'src', 'commands'));
        expect(commandFiles).not.toContain('dailynews.js');
    });

    it('gives the trigger endpoint the version prefix it is actually mounted under', () => {
        // The guide said `/api/guild/…`; the router is mounted at `/api/v1`,
        // which is what API_REFERENCE.md and the dashboard's fetch both use.
        const guide = read('docs/SETUP_GUIDE.md');
        expect(guide).toContain('/api/v1/guild/:guildId/dailynews/trigger');
        expect(guide).not.toContain('`POST /api/guild/');
    });
});
