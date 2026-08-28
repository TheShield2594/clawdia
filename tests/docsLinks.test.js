'use strict';

// Cross-references between the markdown files are load-bearing now that no file
// repeats another: README points at .env.example for the variables, CONTRIBUTING
// points at docs/EXTENDING.md for the command contract, and both point into
// SETUP_GUIDE by anchor. A moved heading breaks that quietly — the link still
// renders, it just lands at the top of the file.
//
// So: every relative link in every markdown file must resolve, anchor included.
// Eleven files, no exceptions granted, because there are none to grant today.

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'coverage']);

function markdownFiles(dir = ROOT) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) out.push(...markdownFiles(full));
        else if (entry.name.endsWith('.md')) out.push(full);
    }
    return out;
}

// GitHub's slug: lowercase, drop anything that is not a word character, space or
// hyphen, then spaces to hyphens. Close enough for the headings in this repo.
function anchorsIn(markdown) {
    const slugs = new Set();
    for (const line of markdown.split('\n')) {
        const heading = /^#{1,6}\s+(.*)$/.exec(line);
        if (!heading) continue;
        const slug = heading[1]
            .trim()
            .toLowerCase()
            .replace(/[`*_]/g, '')
            .replace(/[^\w\s-]/g, '')
            .replace(/\s+/g, '-')
            .replace(/^-+|-+$/g, '');
        slugs.add(slug);
    }
    return slugs;
}

describe('markdown cross-references', () => {
    test('every relative link resolves, anchor included', () => {
        const broken = [];

        for (const file of markdownFiles()) {
            const text = fs.readFileSync(file, 'utf8');
            const from = path.relative(ROOT, file);

            for (const [, link] of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
                if (/^(https?:|mailto:)/.test(link)) continue;

                const [target, anchor] = link.split('#');
                let resolved = file;

                if (target) {
                    resolved = path.resolve(path.dirname(file), target);
                    if (!fs.existsSync(resolved)) {
                        broken.push(`${from} -> ${link} (no such file)`);
                        continue;
                    }
                }
                if (!anchor || !resolved.endsWith('.md')) continue;

                if (!anchorsIn(fs.readFileSync(resolved, 'utf8')).has(anchor)) {
                    broken.push(`${from} -> ${link} (no such heading)`);
                }
            }
        }

        expect(broken).toEqual([]);
    });
});

// CONTRIBUTING.md tells a newcomer which commands to run and which Node to run
// them on. Both are claims about files in this repo, so neither is left to
// someone noticing.
describe('CONTRIBUTING.md', () => {
    const contributing = fs.readFileSync(path.join(ROOT, 'CONTRIBUTING.md'), 'utf8');

    test('names only npm scripts that exist', () => {
        const { scripts } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const named = [...contributing.matchAll(/\bnpm run ([\w:]+)/g)].map(m => m[1]);

        expect(named.length).toBeGreaterThan(0);
        expect(named.filter(name => !(name in scripts))).toEqual([]);
    });

    test('names the Node version in .nvmrc', () => {
        const nvmrc = fs.readFileSync(path.join(ROOT, '.nvmrc'), 'utf8').trim();

        expect(contributing).toContain(nvmrc);
    });

    test('names the variables validateEnv actually requires', () => {
        const { REQUIRED_ENV } = require('../src/config/validateEnv');
        const sentence = /Five variables are\s+start-or-fail:([^.]*)\./.exec(contributing);

        expect(sentence).not.toBeNull();
        for (const name of REQUIRED_ENV) expect(sentence[1]).toContain(name);
    });
});
