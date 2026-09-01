# Contributing to Clawdia

The contribution guidance used to be six bullets at the bottom of the extension
guide, the fourth of which was "test thoroughly" — without naming `npm test`
([#718]). This is the rest of it: what to install, what has to pass before a
pull request is worth opening, and the handful of things about this codebase
that will surprise you if nobody says them first.

- [Getting set up](#getting-set-up)
- [Before you open a pull request](#before-you-open-a-pull-request)
- [Tests](#tests)
- [Things that will surprise you](#things-that-will-surprise-you)
- [Adding a command, a route or a model](#adding-a-command-a-route-or-a-model)
- [Commits and pull requests](#commits-and-pull-requests)

## Getting set up

Node **24.19.0** or newer — the version in `.nvmrc`, which CI reads and
`package.json` enforces via `engines`. A MongoDB you can write to; the compose
stack brings one up if you would rather not install it.

```bash
git clone https://github.com/TheShield2594/clawdia.git
cd clawdia
npm ci                  # ci, not install — the lockfile is the build
cp .env.example .env    # then fill it in
npm test                # should be green before you change anything
```

[`.env.example`](.env.example) is the complete, annotated list of every
environment variable the bot reads, and the only one — a test fails the build
if the code reads something the file does not explain. Five variables are
start-or-fail: `DISCORD_TOKEN`, `CLIENT_ID`, `CLIENT_SECRET`, `MONGODB_URI` and
a `SESSION_SECRET` of 32 characters or more. Everything else is defaulted.

`src/config/validateEnv.js` checks all of it before the process touches the
database, and reports every problem at once rather than one per restart.

You do not need a real Discord bot or a real database to run the tests. You do
need both to run the bot: [SETUP_GUIDE.md](docs/SETUP_GUIDE.md) walks through
creating the application, and the integration suites use
`mongodb-memory-server`, which downloads a MongoDB binary on first run.

```bash
npm run dev             # nodemon, restarts on save
npm start               # plain node, and what the image runs
```

## Before you open a pull request

All three of these gate CI, and the Docker image is only published when they
pass, so a red one means nothing ships:

```bash
npm test                # the whole suite, ~20s
npm run lint            # eslint, flat config
npm audit --audit-level=high
```

CI also builds the image on every pull request, boots it, and scans it — the
Dockerfile used to be built only after a merge, which made the deploy the first
thing to notice a broken layer. `npm run image:smoke` is the check the workflow
runs *inside* the container: it is about the image rather than the source, so
running it on your machine tells you little. Point it at a build instead:

```bash
docker build -t clawdia:dev .
docker run --rm --entrypoint node clawdia:dev scripts/image-smoke.js
```

The two coverage ratchets are two separate commands: `npm test -- --coverage`
applies Jest's global thresholds, and `npm run coverage:check` applies the
per-directory floors. CI runs both — see [Coverage](#coverage) below.
`npm run lint:fix` applies what ESLint can fix on its own.

Formatting is `npm run format -- <paths>`, and it takes explicit paths on
purpose: Prettier's settings match the style the tree is already written in,
but it has never been run over the whole tree, because that would rewrite
~45,000 lines and every `git blame` along with them. Run it on the files your
change already touches, nothing else.

Some documentation is generated and a test compares it against a fresh render,
so adding a command or an endpoint turns the suite red until you regenerate:

```bash
npm run docs:commands   # docs/COMMANDS.md, from the loaded command set
npm run docs:api        # docs/API_REFERENCE.md's endpoint tables, from the routers
npm run docs:panels     # the panel reference in docs/FEATURES.md
```

The dashboard's own JavaScript and CSS are minified before they ship, and that
one is *not* something you have to keep in step:

```bash
npm run build:assets    # write the .min twins into src/dashboard/public/
```

The twins are gitignored and the Docker image builds them in a stage of its
own, so a checkout run with `npm start` has none and serves the readable files
— which is what you want while working on them. `asset()` prefers a twin when
one is there and falls back when it is not, so the views are the same either
way. Run it if you want to see what production serves; delete the `*.min.*`
files to go back.

## Tests

Every `*.test.js` under `tests/`, run by Jest.

```bash
npm test                            # everything
npx jest tests/birthday.test.js     # one file
npx jest -t "leap day"              # every test whose name matches
npx jest --watch                    # re-run affected files on save
```

A new test goes next to its subject in `tests/`, named after what it holds
rather than after the file it imports. [docs/EXTENDING.md](docs/EXTENDING.md#testing)
covers how the suite is laid out and how to write one against Mongo and against
Discord's API.

`npm test` deliberately does **not** pass `--forceExit`. A suite that leaks a
Mongoose connection or an un-`unref`'d timer hangs at the end of the run instead
of being silently shot, because the hang is the bug. If your new test hangs the
run, something it opened is still open.

### Coverage

Two ratchets, both applied by CI, both failable locally:

```bash
npm test -- --coverage    # the global thresholds in jest.config.js
npm run coverage:check    # the per-directory floors in coverage-floors.json
```

The global number cannot see *where* coverage is — `src/services/ai` sits near
80% and `src/commands/economy` near 20%, and deleting every AI test would cost
about four points of the total and stay green. So `coverage-floors.json` holds
a floor per directory, and also fails on a file that stops being executed at
all. Raise a floor when you raise the coverage under it; do not lower one to
land a change.

## Things that will surprise you

**Migrations run themselves, on every boot.** `src/index.js` runs everything in
`src/migrations/` in order before the bot logs in and before the dashboard opens
its port. There is no separate migrate step and no way to start without them.
Some are irreversible and none roll back on their own, so the runner takes a
`mongodump` before an irreversible one. Both stack files set
`MIGRATION_BACKUP=require`, which makes a failed backup abort startup rather
than warn; a bare checkout defaults to the warning and needs `mongodump` on
your PATH. Writing one:
[docs/EXTENDING.md](docs/EXTENDING.md#schema-migrations).

**The bot registers its own slash commands.** It publishes the command set to
Discord on connect, and only when it differs from the set last published. That
is what makes the Docker deploy work at all — the image runs `node src/index.js`
and nothing in either stack file runs a registration step. Changing a command's
*shape* re-publishes on the next restart; changing only its handler body sends
nothing. `DEPLOY_COMMANDS=never` turns it off, `always` forces it.

**A command file that fails to load is fatal.** Startup refuses to come up with
an incomplete set, because the deploy publishes exactly the collection startup
builds — a command that quietly failed to load would otherwise unregister itself
from Discord on the next boot.

**Dependencies only run one way.** `eslint-rules/layer-boundaries.js` enforces
the layering declared in `eslint.config.js`: models and config at the bottom,
then utils, views, services, commands, and the dashboard and events at the top.
A module may require its own layer and anything below it. There is exactly one
documented exception. `npm run lint` is where you find out.

**`GET /health` is the operator's window in.** Served on the dashboard port,
unauthenticated, and behind both Docker healthchecks. `healthy` answers 200 and
anything less answers 503 — `degraded` means MongoDB is up but a scheduled
service is failing every run, which is exactly the half-broken bot a monitor
exists to catch. The compose healthchecks parse `status` out of the body and
restart only on `unhealthy`, deliberately: restarting does not fix a feed that
is 404ing, and a restart loop is worse than a degraded bot. If you add a
scheduled service, report its runs through `src/health.js` so it shows up there.

**Ephemeral replies use the flag, not the boolean.** `flags:
MessageFlags.Ephemeral`, never `ephemeral: true`, which discord.js v14
deprecated. ESLint fails the build on the boolean.

## Adding a command, a route or a model

[docs/EXTENDING.md](docs/EXTENDING.md) is the guide, and the part worth reading
before your first command is
[the full module contract](docs/EXTENDING.md#the-full-module-contract).

A command is one object. `data` and `execute` are required and the loader
refuses to start without them. Four optional hooks are read by name and
validated by nothing: `cooldownAmount`, `cooldownKey`, `autocomplete` and
`requiredPermissions`. A typo in any of them is not an error — it is a key
nobody reads, so the command loads, deploys, runs, and your hook never fires.
On `requiredPermissions` that is a security bug rather than an annoyance,
because `setDefaultMemberPermissions` on the builder is only a default that a
guild admin can reassign.

### New features ship as subcommands

Discord registers at most **100 global application commands**, and going over is
not a truncation — it rejects the whole `PUT`, so one command too many
unregisters every other command at deploy time. `COMMAND_BUDGET` in
`src/utils/commandDeployer.js` is the ratchet and `tests/commandCap.test.js`
fails when the count moves, which is the only local signal there is.

So: **a new feature is a subcommand of an existing group unless there is a
specific reason it cannot be.** `/hunt`, `/fish`, `/mine`, `/explore`, `/casino`,
`/season` and `/event` are all groups for this reason, and adding to one costs
nothing from the budget. A command too big for one file becomes
`commands/<category>/<name>/index.js` plus siblings — the loader counts the
folder as one command, so its parts never register as commands of their own.

Spending a slot means displacing one: fold or retire a command, then lower
`COMMAND_BUDGET` to match. Raising the budget to get the suite green is how the
repo arrives at a deploy that a revert cannot undo.

Permission gating is worth a thought here, because Discord's
`setDefaultMemberPermissions` applies to the whole command and not to one
subcommand. `/event` checks Manage Server inside `start` and `end` for exactly
that reason: gating the command would have hidden the five player activities
beside them.

For an HTTP endpoint, [API_REFERENCE.md](docs/API_REFERENCE.md) documents what the
dashboard's API already serves and how its authentication, authorization and
response envelopes work; the tables in it are generated, so write the route's
one-sentence `//` comment and run `npm run docs:api`.

## Commits and pull requests

Work on a branch. One logical change per commit.

Commit subjects here are sentence-case and imperative, and say what the change
does rather than which files it touches — "Move the feed cursor only as far as
delivery actually got", not "fix(rss): update cursor". No conventional-commit
prefixes. Then a body explaining *why*, which is the part that survives: the
constraint you found, the failure mode you were closing, what you rejected.
Close an issue with `Fixes #123`.

Before you push: the tests and the lint pass, the generated docs are
regenerated if you touched their sources, and the diff contains nothing you
cannot explain.

Releases are cut separately and are not part of an ordinary change — see
[docs/RELEASING.md](docs/RELEASING.md). Do not bump the version in a feature
pull request.

[#718]: https://github.com/TheShield2594/clawdia/issues/718
