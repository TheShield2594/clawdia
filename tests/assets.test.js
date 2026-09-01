const fs = require('fs');
const os = require('os');
const path = require('path');
const { asset, assetVersion, PUBLIC_DIR } = require('../src/dashboard/lib/assets');

describe('asset()', () => {
    // Against a root of this test's own rather than the real public/, because
    // asset() prefers a `.min` twin when one is there (#905) and whether one is
    // there depends on whether the developer has run `npm run build:assets`.
    // A suite that answers differently on the same commit is worse than no
    // suite; the preference itself is covered in dashboardMinifiedAssets.
    it('stamps a public file with a hash of its contents', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-assets-'));
        try {
            fs.writeFileSync(path.join(dir, 'styles.css'), 'body { color: red }\n');
            expect(asset('/styles.css', dir)).toMatch(/^\/styles\.css\?v=[0-9a-f]{10}$/);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('gives the same URL for unchanged content', () => {
        expect(asset('/esc-html.js')).toBe(asset('/esc-html.js'));
    });

    // The fixture has to be a file this test is free to rewrite, and it used to
    // be written into the real public/ and deleted again — a transient file
    // inside src/ that any suite sweeping the tree in another Jest worker could
    // list and then fail to read. It lives in a temp directory now, which
    // assetVersion takes as its second argument; nothing under src/ is touched.
    it('changes the URL when the file changes, so a deploy busts the cache', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-assets-'));
        const file = path.join(dir, 'asset-version-fixture.js');
        try {
            fs.writeFileSync(file, '// one\n');
            const before = assetVersion('/asset-version-fixture.js', dir);
            expect(before).toMatch(/^[0-9a-f]{10}$/);

            fs.writeFileSync(file, '// two\n');
            // mtime granularity can be coarse; make the change unambiguous.
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(file, future, future);

            expect(assetVersion('/asset-version-fixture.js', dir)).not.toBe(before);
            expect(fs.existsSync(path.join(PUBLIC_DIR, 'asset-version-fixture.js'))).toBe(false);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    // The cache is keyed by root and url path together. Keyed by the path alone
    // — as it was while there was only ever one root — the second root here
    // would be served the first one's hash for entirely different bytes.
    it('does not confuse two roots serving the same url path', () => {
        const a = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-assets-a-'));
        const b = fs.mkdtempSync(path.join(os.tmpdir(), 'clawdia-assets-b-'));
        try {
            fs.writeFileSync(path.join(a, 'same-name.js'), '// from a\n');
            fs.writeFileSync(path.join(b, 'same-name.js'), '// from b\n');

            expect(assetVersion('/same-name.js', a)).not.toBe(assetVersion('/same-name.js', b));
        } finally {
            for (const dir of [a, b]) fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it('leaves a URL alone when the file does not exist', () => {
        expect(asset('/no-such-file.js')).toBe('/no-such-file.js');
    });

    it('refuses to reach outside the public directory', () => {
        expect(assetVersion('/../../../package.json')).toBeNull();
        // …including when the root is one the caller chose.
        expect(assetVersion('/../package.json', path.join(PUBLIC_DIR, 'fonts'))).toBeNull();
    });
});
