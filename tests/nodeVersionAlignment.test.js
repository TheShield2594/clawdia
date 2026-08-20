'use strict';

const fs   = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// The image shipped to production used to run a different Node major from the
// one CI tests on: the Dockerfile was on 26 while .nvmrc — which
// actions/setup-node reads via node-version-file — pinned 22.12.0. Nothing
// failed, which is the problem: the runtime that ships was never the runtime
// under test. These assertions are the thing that notices next time.
describe('Node version alignment', () => {
    const nvmrc = read('.nvmrc').trim();
    const engines = JSON.parse(read('package.json')).engines.node;
    const dockerTags = [...read('Dockerfile').matchAll(/^FROM node:(\S+)/gm)].map(m => m[1]);

    // Handles both "24.19.0" and a bare image tag like "24-alpine".
    const major = version => version.match(/\d+/)?.[0];

    test('.nvmrc pins an exact version', () => {
        expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    });

    test('every Dockerfile stage builds on the .nvmrc major', () => {
        expect(dockerTags.length).toBeGreaterThan(0);
        for (const tag of dockerTags) {
            expect(major(tag)).toBe(major(nvmrc));
        }
    });

    test('all Dockerfile stages agree with each other', () => {
        expect(new Set(dockerTags).size).toBe(1);
    });

    test('engines declares the .nvmrc version as its floor', () => {
        expect(engines).toBe(`>=${nvmrc}`);
    });

    test('CI installs the version .nvmrc names', () => {
        expect(read('.github/workflows/ci.yml')).toContain("node-version-file: '.nvmrc'");
    });
});
