# Mine map art

The painted rock faces `/mine map` draws each player's dig site over: one per
depth, the same for every player. Same pipeline and house style as the
Explorer's Map (`assets/explore-map/STYLE.md`): generated on Higgsfield,
shipped under `src/` (the Docker build context drops `assets/`), rendered as a
Discord embed attachment.

## The assets

| Depth | File |
| --- | --- |
| Surface Quarry | `src/assets/mine-map/surface_quarry.jpg` |
| Coal Tunnels | `src/assets/mine-map/coal_tunnels.jpg` |
| Iron Mines | `src/assets/mine-map/iron_mines.jpg` |
| Crystal Caves | `src/assets/mine-map/crystal_caves.jpg` |
| The Abyss | `src/assets/mine-map/the_abyss.jpg` |

All 1200×800 opaque JPEG. `src/utils/mineMapCard.js` decodes each once per
process. Everything per player is drawn in code over the painting, never
painted in: the 10×10 dig site's grid, tunnels carved out of the rock, ore
gems, cave-in rubble, the miner's pin and the stickers. A depth the art does
not cover falls back to the Surface Quarry painting.

## The look

The house style from `assets/icons/STYLE.md`: flat, bold, hand-inked shapes,
minimal two-tone shading, no gloss, brand ink `#14110d`, cream `#faf6ef` and
warm accent `#d97742`. Each depth is described the way its `mine:<depth>`
emblem is in `assets/icons/manifest.json`.

Each painting must be **one solid, evenly textured rock face** with no holes
or tunnels of its own: the code carves the player's tunnels, so a painted
opening would read as a dug cell that isn't. Decoration (timbers, lanterns,
rails, crystals, sky) stays at the outer edges, outside the dig site in the
middle. **No text in the art.**

## The model

| | |
| --- | --- |
| Provider | Higgsfield |
| Model ID | `gpt_image_2_5` |
| Quality | `high` |
| Resolution | `2k` (downscaled to 1200×800) |
| Aspect | `3:2` |
| Background | `opaque` |
| `image_references` | the Explorer's Map world art job, as the style anchor |

Every prompt, job id and url is in `mine-map.map.json`. The 2026-10-26 run
generated one image per depth; Iron Mines failed once on Higgsfield's side and
The Abyss hit the account's rate limit, and both were resubmitted.

## Regenerating

1. Re-run a depth's prompt from `mine-map.map.json` with the same settings and
   reference.
2. Downscale to 1200×800 JPEG (quality ~0.9) into `src/assets/mine-map/`.
3. Check the dig site (the middle 620×620, see `GRID_X`/`GRID_Y` in
   `mineMapCard.js`) is plain rock, and retune that depth's tunnel and gem
   colours in `DEPTH_STYLE` if the palette moved.
4. Record the new job id + url in the map file.

A new depth needs a painting and a `DEPTH_STYLE` entry; `tests/mineMapCard.test.js`
fails until both exist.
