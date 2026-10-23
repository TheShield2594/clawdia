# Explorer's Map art

The painted world `/explore map` draws its fog of war, markers and labels over.
One image, the same for every player. Same pipeline as the item icons
(`assets/icons/STYLE.md`) and the birthday art (`assets/birthday/STYLE.md`):
generated on Higgsfield, shipped under `src/` (the Docker build context drops
`assets/`), rendered as a Discord embed attachment.

## The asset

| Key | File | Shape | Where it renders |
| --- | --- | --- | --- |
| `world` | `src/assets/explore-map/world.jpg` | 1200×800, opaque JPEG | Embed **image** on `/explore map` |

`src/utils/exploreMapCard.js` decodes it once per process. Everything that
changes per player is drawn over it in code, never painted in: region names,
progress, markers, the player pin, the clouds over locked regions, the sepia
wash on unexplored ones, and the sea painted over hidden seasonal islands.

## The look

The house style from `assets/icons/STYLE.md`, carried to a scene the way the
birthday banner is: **flat, bold, hand-inked shapes, minimal two-tone shading,
no gloss, vibrant saturated colours**, brand ink `#14110d`, cream `#faf6ef`
and warm accent `#d97742`. Each region is described the way its emblem is in
`assets/icons/manifest.json` (`explore:<id>`), so the map and the thumbnails
agree on what a place looks like.

**No text in the art, ever.** The code draws every label; a painted letter
under a real one looks broken.

## The model

| | |
| --- | --- |
| Provider | Higgsfield |
| Model ID | `gpt_image_2_5` |
| Quality | `high` |
| Resolution | `2k` (downscaled to 1200×800) |
| Aspect | `3:2` |
| Background | `opaque` |
| `image_references` | a flat layout guide (region ovals at `LAYOUT`), then the birthday banner job as the style anchor |

The exact prompt, job id, url and reference ids are in
`explore-map.map.json`. The 2026-10-23 run was two variants at 2.75 credits;
variant 2 shipped (sand-shored islands, cleaner continent).

## Regenerating

1. Re-run the prompt from `explore-map.map.json` with the same settings and
   references. Keep the layout guide: it is what puts each region where
   `LAYOUT` expects it.
2. Downscale the result to 1200×800 JPEG (quality ~0.92) into
   `src/assets/explore-map/world.jpg`.
3. **Re-measure `LAYOUT`** in `exploreMapCard.js` against the new art — each
   region's centre, radius and squash. Labels, markers, clouds and the sepia
   wash all hang off those numbers. Drawing the ellipses over the art and
   eyeballing them is enough.
4. Record the new job id + url in the map file.

A region added to the game without a place in the art still shows up: the
card gives it a spare spot in open sea with a small drawn island, until the
art is regenerated with it.
