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

No schema migration is part of this release, so rolling back to it from a later
version is a matter of the image tag alone.
