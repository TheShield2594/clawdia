# Impeccable detector config

This directory holds the project's [Impeccable](https://github.com/pbakaus/impeccable)
design-detector configuration — currently the ignore rules in `config.json`
(the brand fonts and the Discord accent bars the detector would otherwise flag).

Impeccable itself is a developer tool and is **not** vendored into this repo.
Install it locally to get the `/impeccable` Claude Code skill and its hooks:

    npx impeccable install

Or run the standalone detector without installing anything:

    npx impeccable detect src/dashboard/

`config.json` (shared, committed) is picked up automatically by either. The
detector's local cache (`hook.cache.json`) and any per-user overrides
(`config.local.json`) are gitignored.
