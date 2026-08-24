#!/usr/bin/env bash
# Regenerate the dashboard's self-hosted web fonts.
#
# The dashboard's CSP is `style-src 'self'` / `font-src 'self'`, so a
# stylesheet pulled from fonts.googleapis.com is blocked outright and every
# face falls back silently (#681). The three families are therefore vendored
# into src/dashboard/public/fonts/ and served from the app's own origin.
#
# Run this only to pick up an upstream font revision. It rewrites
# public/fonts/fonts.css and re-downloads every .woff2 next to it.
#
# Usage: ./scripts/fetch-fonts.sh
# Requires: curl, node
set -euo pipefail

FONTS_DIR="$(cd "$(dirname "$0")/.." && pwd)/src/dashboard/public/fonts"
# Keep this in sync with the families and weights styles.css actually asks for.
CSS_URL="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter+Tight:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap"
# Google serves woff2 only to a user agent it recognises as supporting it.
UA="Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Fetching font stylesheet…"
curl -fsS -A "$UA" "$CSS_URL" -o "$WORK/google.css"

mkdir -p "$FONTS_DIR"

# Parse the upstream CSS into one @font-face per (family, weight, style,
# subset), give each file a readable name, and emit our own stylesheet
# pointing at /fonts/. The unicode-range of each block is carried over
# verbatim so browsers still download only the subsets a page renders.
node - "$WORK/google.css" "$FONTS_DIR" "$WORK/urls.txt" <<'NODE'
const fs = require('fs');
const [, , src, outDir, urlList] = process.argv;
const css = fs.readFileSync(src, 'utf8');

const slug = f => f.toLowerCase().replace(/\s+/g, '-');
const faces = [];
const re = /\/\*\s*([a-z-]+)\s*\*\/\s*@font-face\s*\{([^}]*)\}/g;
let m;
while ((m = re.exec(css))) {
    const [, subset, body] = m;
    const prop = k => (body.match(new RegExp(k + ':\\s*([^;]+);')) || [, ''])[1].trim();
    const family = prop('font-family').replace(/'/g, '');
    const style = prop('font-style');
    const weight = prop('font-weight');
    faces.push({
        family, style, weight, subset,
        url: (body.match(/url\((https:\/\/[^)]+)\)/) || [])[1],
        file: `${slug(family)}-${weight}${style === 'italic' ? 'i' : ''}-${subset}.woff2`,
        range: prop('unicode-range'),
    });
}
if (!faces.length) throw new Error('no @font-face blocks found — did the css2 API change?');

fs.writeFileSync(urlList, faces.map(f => `${f.url} ${f.file}`).join('\n') + '\n');

const header = `/* ============================================================
   Clawdia — self-hosted web fonts

   Generated from the Google Fonts css2 API, then vendored under
   public/fonts/ so the files load under the dashboard's own CSP
   (\`style-src 'self'\`, \`font-src 'self'\` — see src/dashboard/server.js).
   Pulling them from fonts.googleapis.com meant the browser blocked
   both the stylesheet and the font files, so every face silently fell
   back to Georgia / system-ui / monospace (#681).

   Subsets carry their original unicode-range, so a browser still
   downloads only the ranges a page actually renders.

   Regenerate with scripts/fetch-fonts.sh — do not edit by hand.
   ============================================================ */

`;
const blocks = faces.map(f => `/* ${f.family} ${f.weight}${f.style === 'italic' ? ' italic' : ''} — ${f.subset} */
@font-face {
    font-family: '${f.family}';
    font-style: ${f.style};
    font-weight: ${f.weight};
    font-display: swap;
    src: url('/fonts/${f.file}') format('woff2');
    unicode-range: ${f.range};
}`);
fs.writeFileSync(`${outDir}/fonts.css`, header + blocks.join('\n\n') + '\n');
console.log(`Wrote fonts.css with ${faces.length} faces.`);
NODE

echo "Downloading font files…"
while read -r url file; do
    curl -fsS "$url" -o "$FONTS_DIR/$file"
done < "$WORK/urls.txt"

# A face declared but not downloaded renders as a silent fallback, which is
# exactly the failure this script exists to prevent — so fail loudly instead.
missing=0
while read -r _ file; do
    [ -s "$FONTS_DIR/$file" ] || { echo "MISSING: $file" >&2; missing=1; }
done < "$WORK/urls.txt"
[ "$missing" -eq 0 ] || { echo "Some fonts failed to download." >&2; exit 1; }

echo "Done: $(wc -l < "$WORK/urls.txt") files in $FONTS_DIR"
