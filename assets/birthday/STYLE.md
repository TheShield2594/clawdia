# Birthday embed art

The two images the birthday wish embed uses by default: a small **author icon**
and a wide **banner**. Same pipeline as the item-icon catalogue
(`assets/icons/STYLE.md`) — generated on Higgsfield, baked in by CI, served as
Discord embed attachments — but only two assets and a different framing, so they
live here rather than in that catalogue.

## The assets

| Key | File (baked to `src/assets/birthday/`) | Shape | Where it renders |
| --- | --- | --- | --- |
| `icon` | `birthday-icon.png` | 256×256, transparent | Embed **author** line icon |
| `banner` | `birthday-banner.png` | ~1024px wide, opaque | Embed **image** (bottom banner) |

Both are optional defaults: `src/utils/birthdayFlair.js` attaches them only when
the files are present, and a guild can always override either with its own URL in
the dashboard (Author icon URL / Banner image URL). The embed works with neither
baked in — the member's avatar thumbnail and the festive colour carry it.

## The look

Clawdia's brand mark is **flat, bold, hand-inked silhouettes** — no gloss, one
warm accent. The birthday art matches it (not the item icons' rarity-rim look):

| Role | Hex |
| --- | --- |
| Ink (outlines/details) | `#14110d` |
| Cream (frosting/plate) | `#faf6ef` |
| Warm accent | `#d97742` |
| Bright accent (flames/highlights) | `#f97316` |

## The model

| | |
| --- | --- |
| Provider | Higgsfield |
| Model ID | `gpt_image_2_5` |
| Quality | `high` |
| Resolution | `1k` |
| Icon | aspect `1:1`, `background: transparent` |
| Banner | aspect `21:9`, `background: opaque` |

The prompts that produced the current assets are recorded on their jobs in
`birthday.map.json`. To regenerate, keep the palette and flat hand-inked style
above, generate on `gpt_image_2_5`, and drop the new `jobId` + `url` into the
map.

## Baking them in

A Claude Code web session can generate the art (and record job ids + urls) but
**cannot download from the Higgsfield CDN** — the egress proxy returns 403. So
the PNGs are committed by CI, exactly like the item icons:

```
Actions tab → "Bake birthday art" → Run workflow (on the branch carrying the map)
```

It runs `assets/birthday/bake-birthday.mjs`, which downloads each url, normalizes
it (the icon → trimmed/centered/padded 256² transparent; the banner → width-capped
and compressed) and commits it under `src/assets/birthday/`. Idempotent — re-run
after changing the map to pick up regenerated art.

To bake locally instead (from a machine that *can* reach the CDN):

```
npm install sharp
node assets/birthday/bake-birthday.mjs
```
