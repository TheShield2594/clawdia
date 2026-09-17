# Clawdia documentation

Every topic is written in exactly one place. This is the index to all of it —
grouped by what you are trying to do. The [top-level README](../README.md) is
the starting point for the project as a whole.

## Deploying and operating

| Doc | What it covers |
|---|---|
| [SETUP_GUIDE.md](SETUP_GUIDE.md) | Discord app, provider keys, Daily News, Portainer, MongoDB, backups, logging, health monitoring, troubleshooting |
| [AI_COMPARISON.md](AI_COMPARISON.md) | The five AI providers side by side — default model, credential, cost, MCP route — and which to start with |

## Using the bot

| Doc | What it covers |
|---|---|
| [COMMANDS.md](COMMANDS.md) | Every slash command by category, generated from the loaded command set (the same catalog `/help` renders) |
| [FEATURES.md](FEATURES.md) | What each feature does — AI chat and MCP, the economy and gathering loop, moderation, leveling, welcome cards, insights, the dashboard panels |

## Developing and extending

| Doc | What it covers |
|---|---|
| [EXTENDING.md](EXTENDING.md) | Adding a command, model, service, event, dashboard page, API route, or scheduled task, and the conventions each follows |
| [API_REFERENCE.md](API_REFERENCE.md) | Every dashboard HTTP endpoint, who may call it, and what it does, generated from the routers |
| [CANVAS_BACKEND.md](CANVAS_BACKEND.md) | What the image's native build toolchain is for, and the measured case for replacing it |
| [RELEASING.md](RELEASING.md) | Cutting a release: versions, tags, and the process |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Getting set up, the coverage ratchets, and what surprises people |

## Project direction and history

| Doc | What it covers |
|---|---|
| [ROADMAP.md](ROADMAP.md) | What is planned next, in what order, and the tradeoff that decides the order |
| [AUDIT_LOG.md](AUDIT_LOG.md) | Which subsystems have been through a line-by-line audit, what each found, and the much longer list of what has not |
| [../CHANGELOG.md](../CHANGELOG.md) | Release-by-release history of what changed |

## Generated docs

Some of these files carry blocks regenerated from the code, and a test fails the
suite when they drift. Edit the code, not the generated block, then run:

```bash
npm run docs:commands   # COMMANDS.md, from the loaded command set
npm run docs:api        # the endpoint tables in API_REFERENCE.md, from the routers
npm run docs:panels     # the dashboard section list in FEATURES.md
npm run docs:shape      # the "Shape of the codebase" table in the top-level README
```
