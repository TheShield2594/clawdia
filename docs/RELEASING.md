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
behind `needs: [test, image]`, so a tag publishes nothing unless the suite, the
linter and the dependency audit are green *and* the image builds, boots and
comes back clean from the vulnerability scan. On a green run
`docker/metadata-action` derives these tags from `v4.2.1`:

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

The summary page of a green publish carries three lines: the digest, the
`CLAWDIA_IMAGE_TAG=sha-<commit>` to deploy this build, and the
`CLAWDIA_IMAGE_TAG=latest@sha256:…` to pin it immutably. It also carries a
**Scanned-image check** table saying, per platform, whether the layers that were
published are the ones the vulnerability scan actually looked at. (amd64 is also
booted before it is scanned; arm64 is scanned but never booted, because booting
it would mean running an emulated Node through its whole require graph.) Those
rows normally read "match the scanned image". If one says **DO NOT DEPLOY**, the
build cache was evicted between the scan job and the publish job, so the image
in the registry was rebuilt and never scanned — re-run the workflow before
deploying that tag.

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

## Getting told there is something to deploy

Nothing pulls on its own. A Portainer stack holds whatever image it last
deployed until somebody redeploys it, so a repointed `:latest` — or a newer
`sha-` tag, for a deployment pinned to one — changes nothing until an operator
acts. Left at that, a published security fix can sit undeployed indefinitely
because nothing announced it.

There are two signals, and the first always runs:

1. **The run summary.** Every green publish writes the `CLAWDIA_IMAGE_TAG` line
   for that build, as above. An operator watching CI sees what to move to
   without having to work it out from a commit sha.

2. **A Portainer stack webhook**, which is opt-in and off by default. Portainer
   can expose a URL that redeploys a stack when it is POSTed to; give the
   workflow that URL and a push to `main` redeploys the stack on its own.

To turn the second one on:

1. In Portainer, open the stack, and under **Webhooks** create (or copy) the
   stack webhook URL. It looks like
   `https://portainer.example.com/api/stacks/webhooks/<uuid>`.
2. In GitHub, add it as a repository secret named `PORTAINER_WEBHOOK_URL`
   (Settings > Secrets and variables > Actions).

The publish job then POSTs to it after a successful push to the default branch.
Some notes on the edges:

- **It fires on `main` only.** A `v*` tag push publishes a version tag that
  nothing is pointed at until you choose to be, so firing a redeploy on one
  would deploy something you did not ask for.
- **It fires only behind the scanned-image check.** If that table reports
  anything other than a match on every platform — including "not checked" — no
  redeploy is requested, and the summary says so. A workflow that told you not
  to deploy an image and then deployed it for you would make the check
  worthless.
- **The URL must be `https://`.** It carries its own credential in the path, so
  a cleartext POST would hand that credential to every hop in between. An
  `http://` value is refused with a warning rather than being sent. The usual
  LAN argument does not apply: this runs on a GitHub-hosted runner, so any URL
  it can reach is one crossing the public internet.
- **It redeploys whatever the stack is pinned to.** The webhook tells Portainer
  to pull and recreate; it does not change `CLAWDIA_IMAGE_TAG`. A stack pinned to
  `4.2.1` will pull `4.2.1` again and come back on the same image. The webhook is
  useful precisely when the stack tracks `latest`.
- **The URL is a deploy credential.** Anyone holding it can redeploy the stack,
  so it belongs in a secret and nowhere else. The workflow never echoes it.
- **A failure does not fail the build.** The image is published and scanned
  either way; an unreachable Portainer is logged as a warning on the run, with a
  line in the summary saying to redeploy by hand.
- Portainer invalidates a stack's webhook when the stack is recreated. If the
  run starts warning about an HTTP 404, the secret is naming a stack that no
  longer exists — create a new webhook and update it.

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
