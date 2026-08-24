# Changelog

Clawdia follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
Every released version gets an entry here and a `v`-prefixed git tag, which is
what CI turns into a versioned container image — see [docs/RELEASING.md](docs/RELEASING.md).

Each entry records the **schema migration high-water mark**: the last migration
in `src/migrations/` that a deployment of this version will have run. That
mapping is the point of the file. Migrations here are destructive and
forward-only, so knowing which migrations a given image has applied is what
makes a rollback decision possible at all — you cannot roll back to a version
whose schema predates a migration that has already run.

`npm test` fails if the newest entry below does not name both the current
`package.json` version and the highest-numbered migration on disk.

## [4.3.0] - 2026-08-24

Migrations through `015_drop_dead_giveaway_index`.

The dashboard API is mounted at `/api/v1` and answers one response shape per
kind of response. The unversioned `/api` stays mounted beside it as an alias to
the same router, so a browser holding a cached bundle and anything scripted
against an instance keeps working; the response *bodies* of five endpoints did
change, and a script reading them needs updating. See
[API_REFERENCE.md](API_REFERENCE.md#response-shapes).

- **One envelope, and a version** (#582). Bare arrays, `{entries,…}`,
  `{cases,…}`, bare objects and `{success:true,…}` all coexisted, so a caller
  had to learn each endpoint separately. A list is `{ items, page, limit, total,
  pages }` now — `items` for every endpoint, built by
  `src/dashboard/lib/apiPage.js` — a single resource is the object itself, and a
  write is `{success:true,…}`. No endpoint answers with a bare JSON array, which
  is the shape that cannot grow a field later without breaking every caller.
- **The knowledge base and summary job lists page** (#583). The knowledge base
  had a hard `.limit(100)` and no cursor, so a guild's hundred-and-first entry
  was not on a later page — it was unreachable through the API, and unremovable
  through the dashboard that lists it. Summary jobs were unbounded. Both take
  `?page=` and `?limit=` now, and the knowledge base panel has a pager.
- **A mistyped snowflake no longer creates a phantom member** (#584). The
  economy and leveling admin adjust endpoints passed `upsert: true`. A Discord
  snowflake carries no checksum, so a typo is still a well-formed id: the
  adjustment created a member document for someone who may not exist and
  reported success, while the coins went somewhere nobody could see. Both
  return `404` when no member document matches.
- **The Guild schema is the single home for its indexes** (#576). The model
  declared one thing — `unique` on guildId — while migration 001 created two
  more on the same collection, so "what is indexed on guilds" had no single
  answer, and the two halves had drifted: 001's `idx_giveaways_active` covers
  paths (`giveaways.ended`, `giveaways.endsAt`) that no query filters on any
  more, because the giveaway sweep was rewritten. `015_drop_dead_giveaway_index`
  drops it. Five indexes are declared in the schema in its place, covering the
  giveaway, RSS, temp voice, dynamic pricing and bank district sweeps; each is
  partial or sparse, so guilds with the feature off cost nothing to index.
- **MCP connections work with whichever model you picked**, not only Claude.
  Anthropic's connector opens these connections on their side, so the feature
  was Anthropic-only; the bot is an MCP client of its own now
  (`src/services/ai/mcp/`), offering the same servers' tools to OpenAI, Gemini,
  Ollama and OpenRouter as functions, running the calls and feeding the results
  back. A connection is configured once and survives a change of provider. The
  Connections tab gained presets beyond GitHub — Fastmail, DeepWiki, Context7,
  Hugging Face and Stripe, plus Gmail and Spotify prefilled apart from an
  address neither of them publishes — and its **Test** button connects to the
  server itself: no AI provider key, no tokens spent, and it reports the tool
  names, which is what the allow and deny lists want filling in from.

`015_drop_dead_giveaway_index` drops an index no query uses and creates nothing,
so the 4.2.0 image reads the migrated database unchanged — rolling back to
4.2.0 is the image tag alone. It would rebuild `idx_giveaways_active` on its
next boot, which is the state it started from.

## [4.2.0] - 2026-08-24

Migrations through `014_scope_item_images_per_guild`.

The first tagged release. The version had sat at `1.0.0` across 299 commits and
fourteen migrations, while the dashboard and landing page separately displayed a
hardcoded `v4.2.0` that nothing produced (#708). `4.2.0` adopts the number the
UI had already been showing, so no deployment sees its version go backwards, and
the templates now read it from `package.json` instead of carrying their own copy.

Also in this release:

- **Exploration drops fieldcraft materials, and has a rare companion** (#753).
  Exploration was the one grind track with no unpurchasable pet, because a
  companion needs a favourite food that resolves in `MATERIAL_RARITY` and
  exploration produced only coins, Explorer XP and relics. It has eleven
  materials of its own now, dropping from treasure finds tier-matched to the
  treasure, and the 🦉 Lantern Owl (+15% Explorer XP) drops from legendary
  treasure and eats Lantern Glass. No migration: `GrindProfile.data` is
  schemaless, so an existing explorer picks the pile up on their next
  expedition.
- **The landing page reports this instance rather than a hardcoded one** (#704).
- **FEATURES.md's dashboard section list is generated** from the sidebar and the
  panels (#705), via `npm run docs:panels`.

No schema migration is part of this release, so its high-water mark is the one
recorded above. Rolling *back* to it is a matter of the image tag alone only
from a later version carrying that same mark — once a newer release has run a
migration past `014_scope_item_images_per_guild`, the database is ahead of this
version's code and the tag alone will not undo that. Check the mark on the
version you are leaving before you pin this one.
