'use strict';

/**
 * #637. `docker/metadata-action` published only `main`, `latest` and semver
 * tags on releases, and portainer-stack.yml deployed `:latest`. Every one of
 * those names moves with the next push, so after a bad deploy there was no
 * reference left that named the build which had been running a minute earlier
 * — pulling `latest` again just fetches the same broken image.
 *
 * The fix is one immutable tag per build (`sha-<full commit>`) plus a stack
 * that can be pointed at one. This file is here to notice either half being
 * dropped, since either alone restores the hole.
 */

const fs   = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const ROOT = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(ROOT, name), 'utf8');

const ci    = read('.github/workflows/ci.yml');
const stack = yaml.load(read('portainer-stack.yml'));

// The `tags:` block of the metadata step, without the surrounding job.
const tagBlock = (() => {
    const start = ci.indexOf('docker/metadata-action');
    const tags  = ci.indexOf('tags: |', start);
    const rest  = ci.slice(tags);
    // Ends at the next step, i.e. the next line starting a `- name:` entry.
    return rest.slice(0, rest.indexOf('\n      - name:'));
})();

describe('image tagging', () => {
    test('every build publishes an immutable sha tag', () => {
        // `format=long` matters: the short form is a 12-char prefix, which is
        // not what `git rev-parse HEAD` or the Actions UI hands an operator.
        expect(tagBlock).toMatch(/^\s*type=sha,format=long$/m);
    });

    test('the build records its digest, which is the reference that cannot move', () => {
        // Every tag above can be repointed by a later build — sha-<commit>
        // included, by a re-run of this same workflow on the same commit. The
        // digest is the only one that always names one specific build, and it
        // is only reachable at rollback time if the run wrote it down.
        expect(ci).toMatch(/id: build\b/);
        expect(ci).toContain('steps.build.outputs.digest');
        expect(ci).toMatch(/GITHUB_STEP_SUMMARY/);
    });

    test('the moving tags are still published alongside it', () => {
        // The sha tag is the rollback target, not a replacement: `latest` is
        // what a first deploy pulls, and semver is what a release is announced
        // as.
        for (const tag of ['type=ref,event=branch', 'type=raw,value=latest']) {
            expect([tag, tagBlock.includes(tag)]).toEqual([tag, true]);
        }
    });
});

describe('production stack', () => {
    const image = stack.services.bot.image;

    test('takes its tag from an environment variable, so a rollback needs no commit', () => {
        // Hard-coding a sha here would mean every deploy — and every rollback,
        // at the worst possible moment — is a repo commit and a merge.
        expect(image).toMatch(/^ghcr\.io\/theshield2594\/clawdia:\$\{CLAWDIA_IMAGE_TAG:-latest\}$/);
    });

    test('resolves to a tag CI actually publishes', () => {
        // Models Compose's `:-`, which falls back on unset *and* on empty —
        // unlike `:-`'s cousin `-`, which would leave a trailing bare colon and
        // an image reference that does not parse.
        const substitute = tag =>
            image.replace(/\$\{CLAWDIA_IMAGE_TAG:-(\w+)\}/, (_, dflt) => (tag == null || tag === '' ? dflt : tag));

        expect(substitute(null)).toBe('ghcr.io/theshield2594/clawdia:latest');
        // An operator who clears the variable rather than deleting it.
        expect(substitute('')).toBe('ghcr.io/theshield2594/clawdia:latest');
        expect(substitute('sha-' + 'a'.repeat(40)))
            .toBe(`ghcr.io/theshield2594/clawdia:sha-${'a'.repeat(40)}`);
        // A digest pin needs no change to the stack file: Docker accepts
        // `name:tag@sha256:…` and resolves by the digest. This is what the
        // publish job's summary tells an operator to paste.
        expect(substitute(`latest@sha256:${'b'.repeat(64)}`))
            .toBe(`ghcr.io/theshield2594/clawdia:latest@sha256:${'b'.repeat(64)}`);
    });

    test('says how to pin it, beside the line that needs pinning', () => {
        // The variable is useless to an operator who never learns it exists.
        const text = read('portainer-stack.yml');
        expect(text).toContain('CLAWDIA_IMAGE_TAG=sha-');
    });
});
