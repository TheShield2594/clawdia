#!/usr/bin/env bash
# Regenerate the dashboard's vendored copy of Chart.js.
#
# The dashboard used to pull Chart.js from cdn.jsdelivr.net at a floating major
# (`chart.js@4`) with no subresource integrity, on a page that otherwise runs a
# strict nonce CSP (#685). The resolved bundle could therefore change between
# two page loads with nothing to notice it, so `https://cdn.jsdelivr.net` had
# to stay in `script-src` — one third-party origin allowed to execute anything
# it liked on every guild-settings page.
#
# The library is now an exact-pinned devDependency, and this script copies the
# UMD build it resolves to into public/vendor/. The pin plus package-lock's
# integrity hash is the check the SRI attribute would have been, applied at
# install time rather than at page load.
#
# Run this after changing the chart.js pin in package.json, and commit the
# result — the vendored file is what the dashboard serves, and production
# installs with `--omit=dev` never see the package at all.
#
# Usage: ./scripts/vendor-chartjs.sh
# Requires: node, an installed node_modules (npm ci)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/node_modules/chart.js/dist/chart.umd.min.js"
OUT_DIR="$ROOT/src/dashboard/public/vendor"
OUT="$OUT_DIR/chart.umd.min.js"

[ -f "$SRC" ] || { echo "chart.js is not installed — run npm ci first." >&2; exit 1; }

VERSION="$(node -p "require('$ROOT/node_modules/chart.js/package.json').version")"
mkdir -p "$OUT_DIR"

# The bundle ends with a sourceMappingURL pointing at a 968 KB .map that is not
# vendored, which would be a 404 on every devtools open. Dropped here rather
# than shipped.
{
    echo "/*! Chart.js v$VERSION | MIT | https://www.chartjs.org"
    echo " * Vendored from node_modules/chart.js by scripts/vendor-chartjs.sh (#685)."
    echo " * Do not edit: change the pin in package.json and re-run the script. */"
    node -e '
        const fs = require("fs");
        const src = fs.readFileSync(process.argv[1], "utf8");
        process.stdout.write(src.replace(/^\/\/# sourceMappingURL=.*$/m, "").trimEnd() + "\n");
    ' "$SRC"
} > "$OUT"

echo "Wrote $OUT (Chart.js $VERSION, $(wc -c < "$OUT") bytes)."
