const fs = require('fs');
const path = require('path');
const { asset, assetVersion } = require('../src/dashboard/lib/assets');

const PUBLIC_DIR = path.join(__dirname, '..', 'src', 'dashboard', 'public');

describe('asset()', () => {
    it('stamps a public file with a hash of its contents', () => {
        expect(asset('/styles.css')).toMatch(/^\/styles\.css\?v=[0-9a-f]{10}$/);
    });

    it('gives the same URL for unchanged content', () => {
        expect(asset('/esc-html.js')).toBe(asset('/esc-html.js'));
    });

    it('changes the URL when the file changes, so a deploy busts the cache', () => {
        const file = path.join(PUBLIC_DIR, 'asset-version-fixture.js');
        fs.writeFileSync(file, '// one\n');
        const before = assetVersion('/asset-version-fixture.js');
        try {
            fs.writeFileSync(file, '// two\n');
            // mtime granularity can be coarse; make the change unambiguous.
            const future = new Date(Date.now() + 5000);
            fs.utimesSync(file, future, future);
            expect(assetVersion('/asset-version-fixture.js')).not.toBe(before);
        } finally {
            fs.unlinkSync(file);
        }
    });

    it('leaves a URL alone when the file does not exist', () => {
        expect(asset('/no-such-file.js')).toBe('/no-such-file.js');
    });

    it('refuses to reach outside the public directory', () => {
        expect(assetVersion('/../../../package.json')).toBeNull();
    });
});
