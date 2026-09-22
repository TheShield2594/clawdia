# Clawdia item icon style

How to generate item art that reads as one set. Copy from this file — never
retype the prompt from memory, and never rely on chat history.

This file and its scripts (`build-manifest.mjs`, `rename-icons.mjs`,
`cutout.mjs`, `prep-icons.mjs`, `manifest.json`, `icons.map.json`) live in
`assets/icons/`.

**The catalogue is 311 icons on `gpt_image_2_5`**, look **B3** (see §0),
anchored to `hunt:steel_rifle`: the original 118 shop-browse gear/guild icons,
the 144 catch/kill/mine results (issue #1081), the 14 pet portraits (issue
#1082), and 10 explore regions + 25 explore relics. Every job id is in
`icons.map.json`; every prompt is in `manifest.json`, built by
`build-manifest.mjs` from the game data. To reproduce or extend the set, that
is the source of truth — start there, not from memory.

---

## 0. The look — settled 2026-09-21

The look was chosen from a test batch (idiom A1/B1/B2/B3/C2 × two subjects,
`hunt:steel_rifle` + `lucky_charm`), judged on the dark shop tiles.

**Chosen: idiom B + a rarity-coloured rim ("B3").**

- **Idiom B** — `minimal flat shading with two tones per material, no gloss
  highlight`. Reads flat at icon size (close to Clawdia's flat-vector UI) while
  keeping enough form to tell materials apart, which the tier ladders need.
- **Rarity rim** — `thick <rarity-colour> rarity rim`. Separates the subject
  from the near-black tile interiors (`#222222`, `#12283d`, `#1c0c2e`) *and*
  makes the set encode rarity. The rim colour per item comes from the rarity
  palette below.

Rejected: A (cel shading + gloss — the 2026-09-21 legacy look; reads as a
different illustration school than the flat UI), pure C (solid fills, no
shading — materials/tiers stopped separating), and the plain dark outline
(disappears on a dark tile).

### Rarity → rim colour

From `RARITY_CONFIG` (`src/commands/economy/forge.js`). The prompt uses the
colour *word*; the hex is recorded for reference / future tinting.

| Rarity | Rim word | Hex |
| --- | --- | --- |
| Common | silver-grey | `#AAAAAA` |
| Uncommon | emerald-green | `#2ECC71` |
| Rare | sapphire-blue | `#3498DB` |
| Epic | amethyst-purple | `#9B59B6` |
| Mythic | molten-orange | `#FF6600` |
| Legendary | radiant-gold | `#FFD700` |

Rarity assignment is in `build-manifest.mjs`: tier ladders escalate across the
palette (12 rifles = 2 tiers per rarity; 5-tier rods/pickaxes = Common→Legendary),
packs escalate Common→Epic, zones/locations/depths escalate Common→Legendary,
guild-shop items use their own `rarity` field, and consumables/upgrades use a
small per-id table. Change it there, not by hand.

## 1. The model

| | |
| --- | --- |
| Provider | Higgsfield |
| Model ID | `gpt_image_2_5` |
| Aspect ratio | `1:1` |
| Quality | `high` |
| Resolution | `1k` (1024×1024 — final icons are 256px, so 2k/4k is waste) |
| Background | `transparent` |
| Variant | `flare` (default) |
| Cost | `quality: high` = 2 credits, `quality: medium` = 1 (both at `1k`); preflight with `get_cost: true` |

`background: "transparent"` is the reason to be on this model — it emits alpha
directly, so the cut-out step disappears (§6). Confirm the media role against
`models_explore`: `gpt_image_2_5` takes `image_references`, not `image`:

```jsonc
"medias": [{ "role": "image_references", "value": "<anchor job_id>" }]
```

**Concurrency.** The account rate-limits at roughly 4–6 concurrent submissions;
larger batches come back partly `submission_failed` with a 429 (not charged).
Submit in small batches, let each drain, and resubmit any failures. The
2026-09-21 run used batches of 6 then swept failures in batches of 4.

## 2. The style block (B3)

Every prompt ends with this sentence, with `<rarity-colour>` filled from the
table in §0:

```
Style: bold cartoon game icon, thick <rarity-colour> rarity rim, minimal flat shading with two tones per material, no gloss highlight, vibrant saturated colors, single object centered with generous padding, no text, transparent background. Readable at small emoji size.
```

Full prompt shape (see `build-manifest.mjs` for every one):

```
Game item icon: <subject, 1–2 sentences of concrete visual detail>. <STYLE BLOCK>
```

Subjects are written from each item's real definition in `src/data/` — its
name, `description`, and `lore`. The lore is usually where the visual idea is.

## 3. Anchor image

Higgsfield accepts a past generation's `job_id` as a style reference — no
re-upload needed, and job IDs don't expire. Pass one on every batch (see §1 for
the role).

### The current anchor

| Field | Value |
| --- | --- |
| Anchor item | `hunt:steel_rifle` (mid-tier, neutral steel) |
| Job ID | `07f39988-6583-48b4-82ac-ad752b513f3f` |
| Model | `gpt_image_2_5` |
| Date | 2026-09-21 |

Every other icon in the catalogue references this job. It is the neutral
mid-tier choice §3 asks for — no strong colour cast, no glow. The **shipped**
`hunt:steel_rifle` icon is a second generation (`309b1ed7-…`) made *against*
this anchor so it matches its siblings; the anchor job itself is the style
reference, not an uploaded item.

Do not anchor to a strongly tinted or glowing icon — it pushes that property
onto everything generated against it.

### Legacy — `gpt_image_2`, 2026-09-21 (reference only)

The 20 `gpt_image_2` icons (flat white backgrounds, cel shading) are a visual
target for the eye, **not** assets and **not** references to pass to 2.5. A
`gpt_image_2` job ID does not reliably carry style into `gpt_image_2_5`.

## 4. Ladders share a silhouette

For anything that's a tier progression (rifles T1–T12, rods T1–T5, pickaxes
T1–T5), every prompt names **the same base silhouette at the same angle**, and
only the material and detail escalate. The full escalation is encoded in
`build-manifest.mjs` (`RIFLE_SUBJECT`, `ROD_SUBJECT`, `PICKAXE_SUBJECT`).

The rifle ladder, mundane → fantastical, one property added per step and the
shape never changing:

| T | Material | What's added |
| --- | --- | --- |
| 1 | Raw timber | Rope-wrapped grip |
| 2 | Forged iron | Riveted band |
| 3 | Copper + brass | Scrollwork |
| 4 | Polished steel | **Scope appears** |
| 5 | Cobalt alloy | **Glow appears** |
| 6 | Gold | Engraved filigree |
| 7 | Platinum | Wood drops away entirely |
| 8 | Crimson-lacquered iron | Runes, muzzle smoke |
| 9 | Adamantine | Faceted armor plating |
| 10 | Void-black | Woven fate-threads |
| 11 | White + pale gold | Wing motifs, halo |
| 12 | Cosmic blue-black | Starfield, constellation points |

The scope (T4) and glow (T5) are cumulative — every tier above keeps them.

## 4b. Item IDs are namespaced — get this right

`ItemImage` does **not** key on the bare item id. Activity items carry their
activity as a prefix; the upload route rejects anything else.

| Kind | Storage key | Example |
| --- | --- | --- |
| Hunt / fish / mine gear | `<activity>:<slug>` | `hunt:steel_rifle` |
| Guild shop items | bare id (route adds `shop:`) | `lucky_charm` |
| Caught fish | `fishcatch:<id>` | `fishcatch:great_white` |
| Hunted animals | `animal:<id>` | `animal:grizzly_bear` |
| Mined ores | `ore:<id>` | `ore:diamond` |
| Pets | `pet:<petId>` | `pet:crystal_fox` |

Three registries in `src/data/activityItems.js` are the authority: the 83
shop-browse gear ids (`ACTIVITY_ITEM_IDS`), the 144 catch/kill/mine result ids
(`RESULT_ITEM_IDS`), and the 14 pet species ids (`PET_ITEM_IDS`, issue #1082).
The upload route accepts an id in either of the first two
(`isUploadableItemId`); `build-manifest.mjs` validates every namespaced key
against the union of all three and throws if one is missing. Colons are illegal
in filenames on some OSes, so the on-disk name writes `:` as `__`
(`hunt__steel_rifle.png`, `animal__grizzly_bear.png`, `pet__crystal_fox.png`)
and the upload converts back.

**Pets are bundle-only.** They are a fixed roster with no dashboard panel to
upload against, so `PET_ITEM_IDS` is deliberately kept *out* of
`isUploadableItemId`: pet art ships only as a baked default and is never a
per-guild upload. `getItemImageAttachment('pet:<id>', …)` still serves the baked
portrait (it checks the default set first), and `/pet` renders it as a thumbnail
on the status, adopt and feed embeds, falling back to the species emoji. The
roster is the ten ownable species in `PET_DEFINITIONS` plus the four wild battle
opponents `makeWildPet` fields; a test (`tests/petArtCatalog.test.js`) keeps the
id list in step with both.

Pet art uses a **portrait** framing distinct from the item silhouettes — a
front-facing character mascot rather than a centered object — while keeping the
B3 rarity rim and flat two-tone shading, so `build-manifest.mjs` gives them
their own `PET_STYLE`/`petPrompt` (see the "Pet portrait icon:" prompts) instead
of the item `STYLE`. Rarity is by tier: the six ownable species escalate by
adoption cost (Common → Epic), the four unpurchasable rare companions are
Legendary, and the wild opponents are Common.

Results get their own namespaces so they never collide with the gear ones
(`fish:`/`hunt:`/`mine:`) even when a species and a tier share a slug. Their
rarity comes from the item's `tier` field, and the `event` tier — Clawdia's
"MYTHICAL CATCH" bracket, above Legendary — maps onto the **Mythic** rim
(molten-orange). The catch/hunt/mine result renderers call
`getItemImageAttachment()` for the caught item and set it as the embed
thumbnail, falling back to the unicode emoji (already in the title) when no art
is bundled or uploaded — so the set can ship incrementally.

## 5. Identify the downloads — `rename-icons.mjs`

Higgsfield names every download `hf_<date>_<job_id>.png`. `icons.map.json` is
the record of which job produced which item.

```
node assets/icons/rename-icons.mjs ~/Downloads ./assets/icons/generated
```

It reads the job_id out of each filename, looks it up, and writes a copy named
`<storage-key>.png`. It copies (never moves), skips `_min.webp` previews,
reports unknown job_ids, refuses when two files map to the same item, lists
which mapped items are still missing, and exits non-zero if anything was
unresolved.

## 6. Background removal — *not needed on `gpt_image_2_5`*

With `background: "transparent"` (§1) icons arrive with alpha already. **Skip
to §7.** `cutout.mjs` is the fallback for an icon that arrives opaque (older
model, a background setting that didn't take, art on a field):

```
node assets/icons/cutout.mjs ./generated ./raw
```

It flood-fills inward from the border, clearing only near-white pixels
reachable from the edge, so white inside the subject is never touched. It warns
under 15% (background wasn't white) or over 92% (fill leaked through the
outline). Note the B3 rim is light, not a dark dam — if you ever feed a
white-background B3 icon through this, re-verify the >92% warning.

## 7. Normalize — `prep-icons.mjs`

```
npm install sharp      # the scripts' only dependency
node assets/icons/prep-icons.mjs ./assets/icons/generated ./assets/icons/icons
```

Input filenames must be the storage-key filename (`rename-icons.mjs`
guarantees that). Output: 256×256 PNG with alpha, subject centered with an 8%
margin, typically well under 10 KB. It rejects images with no alpha channel
(a loud failure instead of shipping un-normalized icons), tries full-colour PNG
first and falls back to a palette only over the size cap, and exits non-zero if
any icon fails.

## Full pipeline, end to end

```
build-manifest.mjs    (game data -> manifest.json + icons.map.json seed)     free, local
generate_image_batch  (gpt_image_2_5, background: transparent, B3 style,
                       anchor via image_references)                           ~2 credits each (high; 1 at medium)
        ↓  record every job_id in icons.map.json   ← do this immediately
        ↓  download from Higgsfield (the CDN is reachable from your machine,
           not from a Claude Code web session behind the egress proxy)
rename-icons.mjs      (hf_<date>_<job_id>.png -> <storage-key>.png)           free, local
        ↓  ./assets/icons/generated/<storage-key>.png   ← already has alpha
prep-icons.mjs        (trim -> center -> pad -> 256px -> compress)            free, local
        ↓  ./assets/icons/icons/<storage-key>.png
dashboard economy panel -> ItemImage collection                              manual upload
```

Only generation costs credits: ~2 per icon at `quality: high` (1 at `medium`), nothing after that.

## How the app uses them — baked-in defaults (no upload needed)

The whole set ships **inside the app** as default artwork, so every item shows
its icon with no per-guild upload — and the catalogue is the **standard**: it
overrides any guild upload, so every server looks the same.

- The PNGs live at **`src/assets/item-icons/<storage-key>.png`** (under `src/`
  because the Docker build context is an allowlist that ships `src/` and drops
  `assets/`). `src/utils/defaultItemImages.js` serves them.
- `getItemImageAttachment()` (`src/utils/itemImageHelper.js`) checks the
  **bundled default first**: when the catalogue ships art for an item it wins,
  overriding uploads. Only for items the catalogue does *not* cover (custom shop
  items, anything new) does it fall back to uploads — the guild's own shop
  image, then its activity image, then the shared pre-#561 one. The dashboard
  image routes apply the same order, so the panel preview matches Discord.
- The PNGs are committed by the **`Bake item icons`** GitHub Action
  (`.github/workflows/bake-item-icons.yml`), which runs `assets/icons/bake-icons.mjs`:
  it reads the `url` of each item in `icons.map.json`, downloads it, normalizes
  it (same as `prep-icons.mjs`) and writes it under `src/assets/item-icons/`.
  This runs in CI because a GitHub runner can reach the Higgsfield CDN that a
  sandbox cannot — **no local download or dashboard upload required.** Trigger it
  from the Actions tab (workflow_dispatch) on the branch that carries the map;
  re-running picks up any regenerated icons (new job ids in the map).

The manual `rename-icons.mjs` → `prep-icons.mjs` → dashboard-upload path (below)
still works and is how a guild replaces a default with its own art.

## Where these icons render

Icons are **not** Discord emojis. Per-guild uploads live in the `ItemImage`
collection (`src/models/ItemImage.js`) via the dashboard economy panel; the
baked defaults ship in `src/assets/item-icons/`. Either way they're rendered as
Discord embed attachments through `getItemImageAttachment()`.

- **Backgrounds must be transparent.** Tile interiors are dark — `#222222`
  (common), `#12283d` (fish), `#1c0c2e` (epic). A white-background PNG renders
  as a white square.
- **Render box is ~196×154** via `fitContain`, so judge at that size, not 1024.
- **Upload cap is 512 KB** (`src/dashboard/routes/api/itemImages.js`). Stored
  as Mongo Buffers, so smaller is better; prep output is ~10 KB.
- **The emoji is the fallback.** If no image exists, `shopBanner.js` draws
  `item.emoji` at 72px, so a missing icon degrades gracefully — the set can
  ship incrementally.

## Brand reference

From `src/dashboard/public/favicon.svg` and the dashboard CSS. The mark is
**flat, bold, hand-inked silhouettes** — solid ellipses, no shading, one warm
accent stroke. Idiom B was chosen to sit closer to this than the legacy cel
shading did.

| Role | Hex | Where |
| --- | --- | --- |
| Ink | `#14110d` | The paw mark |
| Cream | `#faf6ef` | Favicon plate |
| Paw accent | `#d97742` | The one warm stroke |
| Dashboard accent | `#f97316` | Buttons, highlights |

Activity accents from `src/utils/shopBanner.js`:

| Activity | Accent | Tile interior |
| --- | --- | --- |
| Hunt | `#27ae60` | `#16331c` |
| Fish | `#2980b9` | `#12283d` |
| Mine | `#b5651d` | `#2b1a0c` |
| Shop, common → mythic | `#7f8c8d` → `#e67e22` | `#222222` → `#2d1a00` |

Price text across every banner is gold `#f1c40f`.

## Changelog

- **2026-09-22** — Added **10 explore regions + 25 explore relics**: regions
  under an `explore:` namespace (the "round scene emblem" framing shared with
  hunt zones / fish locations / mine depths; core five laddered Common→Legendary
  by depth, seasonal five a flat Rare), relics under a `relic:` namespace
  (single-object icons, rarity from each relic's own tier — rare/epic/legendary
  only). Both are bundle-only like pets (`EXPLORE_ITEM_IDS` in
  `src/data/activityItems.js`, kept out of `isUploadableItemId`); relic keys use
  a slug derived from the display name (`relicSlug` in `src/data/exploreData.js`).
  All 35 generated on `gpt_image_2_5` B3 at `quality: high` against the
  steel_rifle anchor; job ids + urls recorded in `icons.map.json` (now 311
  items). `/explore` renders them as embed thumbnails (relic on a treasure find,
  region on travel/regions/the result embed, rarest relic on the case) with the
  emoji fallback until the PNGs are baked.
- **2026-09-21** — Added **14 pet portraits** (issue #1082): the ten ownable
  species (`PET_DEFINITIONS`) plus the four wild battle opponents, under a new
  bundle-only `pet:` namespace (`PET_ITEM_IDS` in `src/data/activityItems.js`).
  New `PET_STYLE`/`petPrompt` in `build-manifest.mjs` gives them a front-facing
  character-portrait framing on top of the B3 rim + flat shading; rarity is by
  tier (ownable Common→Epic, rare companions Legendary, wild opponents Common).
  `/pet` renders the art as a thumbnail on the status/adopt/feed embeds with an
  emoji fallback. All 14 generated on `gpt_image_2_5` B3 at `quality: high`
  against the steel_rifle anchor; job ids + urls recorded in `icons.map.json`
  (now 276 items), and the PNGs are baked and shipped under
  `src/assets/item-icons/pet__*.png`, served as bundled default art by
  `defaultItemImages.js`.
- **2026-09-21** — Retargeted to `gpt_image_2_5`; the 20 `gpt_image_2` icons
  became reference-only.
- **2026-09-21** — Settled the look (§0): idiom **B** (minimal flat shading, no
  gloss) + a **rarity-coloured rim** ("B3"), chosen from an A1/B1/B2/B3/C2 test
  batch judged on the dark tiles. Recorded the rarity→rim palette.
- **2026-09-21** — Established the 2.5 anchor: `hunt:steel_rifle`,
  `07f39988-6583-48b4-82ac-ad752b513f3f`.
- **2026-09-21** — Added `build-manifest.mjs` (game data → all 118 prompts +
  rarity, the reproducible source of truth), `manifest.json`, and
  `icons.map.json`.
- **2026-09-21** — Generated the **full catalogue**: 83 activity ids + 35 guild
  shop items = 118 icons on `gpt_image_2_5`, B3, anchored to steel_rifle. All
  job ids recorded in `icons.map.json`. Not yet downloaded / prepped / uploaded
  (a Claude Code web session can't reach the Higgsfield CDN through the egress
  proxy — download + prep + upload run on the owner's machine).
- **2026-09-21** — Re-generated the shipped `hunt:steel_rifle` icon against the
  anchor (`309b1ed7-…`) so its background matches the rest of the set.
- **2026-09-21** — Added the **144 catch/kill/mine result icons** (issue #1081):
  59 fish (`fishcatch:`), 62 animals (`animal:`), 23 ores (`ore:`), rarity from
  each item's `tier` (`event` → Mythic rim), all on `gpt_image_2_5` B3 against
  the same anchor. Generated at `quality: high` for parity with the gear set —
  which is **2 credits each** (the earlier "~1 credit" note was wrong); at `1k`,
  `medium` (1 credit) is a near-identical alternative once downscaled to 256px.
  Job ids + urls recorded in `icons.map.json` (now 262 items).

## Next steps — bake them in (no manual work)

Run the **Bake item icons** workflow (Actions tab → `workflow_dispatch`) on this
branch. It downloads all 311 from the CDN, normalizes them, and commits them to
`src/assets/item-icons/`. After that they're the default art everywhere — no
download, no upload. Re-run it any time the map changes.

The baked catalogue is the standard and overrides guild uploads for every item
it covers. Dashboard uploads still work, but only take effect for items the
catalogue does not ship (custom shop items an admin named themselves, anything
new). Existing upload rows are left in the DB, just no longer shown for
catalogued items — purging them is a separate migration if ever wanted.

## Open questions

- **Caught fish / animals / ores** — *resolved* (issue #1081). They now have
  storage keys, upload-route validation, manifest prompts, and result renderers
  that show their art (§4b). What remains is a scope call on **which** to
  actually generate + bake: all 144, or only the rarer tiers players linger on.
  The emoji fallback means either ships cleanly.
- **Rod and pickaxe ladders** reuse the scope/glow escalation shape (§4).
- **Pets** (issue #1082) — *shipped.* Storage keys, bundle-only route handling,
  manifest prompts, the `/pet` thumbnail renderers and all 14 portraits are in
  place: the PNGs are baked under `src/assets/item-icons/pet__*.png` and served
  as bundled default art by `defaultItemImages.js`, with the species emoji as
  the fallback. Whether the four wild battle opponents want art wired into the
  battle embeds (they only render as emoji in `/pet battle` today) is a separate,
  optional follow-up — their portraits are in the set either way.
