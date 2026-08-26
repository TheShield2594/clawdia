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
run `docker/metadata-action` derives these tags from `v4.2.1`:

- `ghcr.io/theshield2594/clawdia:4.2.1`
- `ghcr.io/theshield2594/clawdia:4.2`
- `ghcr.io/theshield2594/clawdia:latest` (default branch only)
- `ghcr.io/theshield2594/clawdia:sha-<40-char commit sha>`

The last one is published for **every** build, tagged or not. `latest`, `main`
and `4.2` all get repointed by the next push, so none of them can name the build
that was running before a bad deploy.

`sha-<commit>` is stable but not immutable: re-running the workflow on the same
commit rebuilds and repoints it, and the rebuild can differ, because a lockfile
does not pin the base image or the apt packages under it. For a rollback target
that cannot move at all, use the **digest** — the publish job writes it to the
run's summary page, along with the exact `CLAWDIA_IMAGE_TAG` value to paste.

## Pinning the deploy

`portainer-stack.yml` reads its tag from `CLAWDIA_IMAGE_TAG`:

```yaml
image: ghcr.io/theshield2594/clawdia:${CLAWDIA_IMAGE_TAG:-latest}
```

Set it in the stack's environment — Portainer > Stacks > Environment variables,
or the `.env` beside the file — to a released version or a commit sha:

```dotenv
CLAWDIA_IMAGE_TAG=4.2.1
```

Unset, it falls back to `latest`. That is fine for a first deploy and is why it
is the default, but it leaves nothing to roll back to the next time.

To pin to a digest instead of a tag, keep a tag in front of it and append the
digest — Docker accepts `name:tag@sha256:…` and resolves by the digest, so this
needs no change to the stack file:

```dotenv
CLAWDIA_IMAGE_TAG=latest@sha256:3f8a…
```

## Rolling back

1. Find the reference the previous deploy was on. If it was pinned, it is the
   previous value of `CLAWDIA_IMAGE_TAG`. Otherwise open that build's Actions
   run: its summary page carries the digest and the `CLAWDIA_IMAGE_TAG` line to
   paste. Falling back to `sha-<full sha>` also works, with the caveat above
   that a re-run of the workflow will have rebuilt it.
2. Check the CHANGELOG: the target version's migration high-water mark must not
   be behind one that has already run against the database. The mark is recorded
   per release for exactly this check.
3. Set `CLAWDIA_IMAGE_TAG` to that tag and redeploy the stack.

The schema does not roll back with the image. Migrations here are forward-only
and destructive, so a rollback across a migration boundary — step 2 failing —
also needs the pre-migration dump the runner writes to `/app/backups` before an
irreversible migration. Restore that dump first, then redeploy the old image.
