# Releasing

The version in `package.json` had been `1.0.0` since the first commit, across
299 commits and fourteen schema migrations, while three templates displayed a
hardcoded `v4.2.0` that nothing produced (#708). With no tags, there was no way
to say which build a container was running, and `portainer-stack.yml` had
nothing to pin but `:latest` — which is the same reason there was no rollback
path.

This is the process that replaces that.

## Versioning rule

[Semantic versioning](https://semver.org/spec/v2.0.0.html), read against what an
operator of a self-hosted instance experiences:

| Bump | When |
|---|---|
| **major** | An upgrade needs a human: a renamed environment variable, a dropped command, a migration that cannot be rolled back by restoring the previous image alone. |
| **minor** | New commands, panels, or settings. Anything additive that an operator can take without reading release notes first. |
| **patch** | Fixes and internal work with no visible surface change. |

A schema migration on its own is not automatically a major bump — most are
additive (indexes, new fields). It is major when the *previous* image can no
longer read the migrated data, because that is exactly when rolling back stops
working.

## Cutting a release

1. Pick the version by the table above.
2. `npm version <major|minor|patch> --no-git-tag-version` — updates
   `package.json` and `package-lock.json` together.
3. Add the entry to [`CHANGELOG.md`](../CHANGELOG.md), newest first. It must
   name the version and the highest-numbered file in `src/migrations/`;
   `npm test` fails until it does.
4. `npm test && npm run lint`.
5. Commit, merge to `main`.
6. Tag the merge commit and push the tag:

   ```bash
   git tag -a v4.2.1 -m 'v4.2.1'
   git push origin v4.2.1
   ```

## What the tag does

`.github/workflows/ci.yml` runs on `push: tags: v*`, and the publish job is
behind `needs: test`, so a tag whose tests fail publishes nothing. On a green
run `docker/metadata-action` derives three tags from `v4.2.1`:

- `ghcr.io/theshield2594/clawdia:4.2.1`
- `ghcr.io/theshield2594/clawdia:4.2`
- `ghcr.io/theshield2594/clawdia:latest` (default branch only)

## Pinning the deploy

`portainer-stack.yml` deploys `:latest`, which is why a bad build reaches
production and cannot be backed out of. With versioned tags published, pin it:

```yaml
image: ghcr.io/theshield2594/clawdia:4.2.1
```

Rolling back is then editing that line to the previous version and redeploying
— provided the CHANGELOG says that version's migration high-water mark is not
behind one that has already run against the database. That check is why the
mark is recorded per release.
