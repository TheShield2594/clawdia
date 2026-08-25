# Clawdia Setup Guide

## Table of Contents
1. [Discord Bot Setup](#discord-bot-setup)
2. [AI Integration](#ai-integration)
3. [Daily News Configuration](#daily-news-configuration)
4. [Dashboard Setup](#dashboard-setup)
5. [Portainer Deployment](#portainer-deployment)
6. [Database Management](#database-management)
7. [Troubleshooting](#troubleshooting)
8. [Best Practices](#best-practices)
9. [Getting Help](#getting-help)
10. [Next Steps](#next-steps)

## Discord Bot Setup

### 1. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Name your bot and click "Create"
4. Go to the "Bot" section
5. Click "Add Bot"
6. Copy the bot token (this is your `DISCORD_TOKEN`)
7. Enable these Privileged Gateway Intents:
   - Server Members Intent
   - Message Content Intent
   - Presence Intent

### 2. Get Client ID and Secret

1. In the same application, go to "OAuth2" > "General"
2. Copy your "Client ID" (this is your `CLIENT_ID`)
3. Copy your "Client Secret" (this is your `CLIENT_SECRET`)
4. Add a redirect URL — it MUST be the full callback path, not just the domain:
   - Local dev: `http://localhost:3000/auth/callback`
   - Production: `https://YOUR-DOMAIN/auth/callback` (e.g. `https://bot.theshieldit.com/auth/callback`)

> ⚠️ **"Invalid OAuth2 Redirect URI" troubleshooting**
>
> Discord rejects the login if the redirect URI sent by the bot does not exactly match one registered in the Developer Portal. The dashboard always sends `${DASHBOARD_URL}/auth/callback`, so:
>
> - The value registered in Discord must include the `/auth/callback` path.
> - The scheme must match (`https://` in production, `http://` only for `localhost`).
> - No trailing slash after `/auth/callback`.
> - `DASHBOARD_URL` in your `.env` must be **only the scheme + host**, with no path and no trailing slash. Example: `DASHBOARD_URL=https://bot.theshieldit.com` — *not* `https://bot.theshieldit.com/something`, and *not* two URLs concatenated.
>
> If your error URL contains something like `redirect_uri=http://bot.example.com/another-host.com/auth/callback`, your `DASHBOARD_URL` env var has two hosts mashed together — fix it to a single canonical URL. The dashboard now refuses to start with a `DASHBOARD_URL` that contains a path, and prints the exact callback URL to the console at startup; copy that exact string into the Discord Developer Portal.

### 3. Invite Bot to Server

Use this URL (replace CLIENT_ID with yours):

```
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=8&scope=bot%20applications.commands
```

## AI Integration

### OpenAI

1. Go to [OpenAI Platform](https://platform.openai.com/)
2. Create an account or sign in
3. Go to [API Keys](https://platform.openai.com/api-keys)
4. Click "Create new secret key"
5. Copy the key (starts with `sk-...`)
6. Add to `.env` as `OPENAI_API_KEY=sk-...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Default model:** `gpt-4o-mini`. Current rates are at
[OpenAI Pricing](https://openai.com/api/pricing/).

### Google Gemini

1. Go to [Google AI Studio](https://makersuite.google.com/app/apikey)
2. Click "Create API Key"
3. Select or create a Google Cloud project
4. Copy the API key (starts with `AIza...`)
5. Add to `.env` as `GEMINI_API_KEY=AIza...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Default model:** `gemini-2.0-flash`. There is a free tier; current rates and
its limits are at [Google AI Pricing](https://ai.google.dev/pricing).

### Choosing a provider

OpenAI and Gemini are two of five. Clawdia also supports Anthropic (Claude),
OpenRouter, and a local Ollama instance — configured the same way, with
`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, and `OLLAMA_BASE_URL`.

[AI_COMPARISON.md](AI_COMPARISON.md) covers what differs between them and which
to start with.

### MCP Servers

The bot can call tools hosted on remote
[MCP](https://modelcontextprotocol.io) servers — a GitHub repo, a calendar, an
internal search. Whichever model is selected in AI → Chat is the one that uses
them; a connection is configured once and does not need redoing when you switch
provider.

Two routes, chosen automatically from the provider:

| Provider | Route | What happens |
|---|---|---|
| **Anthropic (Claude)** | Native | The server list travels on the request and Anthropic opens the connections |
| **OpenAI, Gemini, Ollama, OpenRouter** | Client | The bot connects, lists the tools, offers them to the model as functions and runs the calls it asks for |

On the client route the model must support tool calling. Every current OpenAI
and Gemini model does; on Ollama and OpenRouter it depends which model you
picked, and one that cannot call tools simply never uses a connection.

There are two ways to add a server, and they stack:

| | Where | Applies to | Who edits it |
|---|---|---|---|
| **Dashboard** | AI → 🔌 Connections | One Discord server | Anyone with Manage Server |
| **Config file** | `config/mcp-servers.json` | Every Discord server | Whoever runs the bot |

A dashboard entry with the same name as a file entry replaces it, so a server
can be defined centrally and pointed at one guild's own credentials.

#### Connecting GitHub from the dashboard

1. Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens),
   granting it only the repositories and scopes the bot should reach.
2. Open AI → **🔌 Connections**, pick **GitHub** under Service. The name and
   endpoint (`https://api.githubcopilot.com/mcp/`) fill themselves in.
3. Paste the token, and list anything destructive under **Never these tools**.
4. Click **Add connection**, then **Test** — the bot connects to the server and
   reports how many tools it offers and which of them your filters leave on.
   The test needs no AI provider key and spends no tokens.

The Service dropdown prefills the services with a documented hosted endpoint —
GitHub, Fastmail (`https://api.fastmail.com/mcp`), DeepWiki, Context7, Hugging
Face and Stripe.

**Gmail and Spotify** are in the list too, marked *your own endpoint*: neither
Google nor Spotify publishes a hosted MCP endpoint, so the server is one you
run yourself or one a hosting provider spins up per account. Picking either
fills in the name and the credential guidance and leaves the URL for you, with
a placeholder showing the shape of the address. Everything after that is
identical.

Anything else works the same way: choose **Custom server…** and paste the
server's https endpoint and token. Services that only offer an OAuth login flow
rather than a token are not usable here — the dashboard has one credential field
and it holds a token.

**Tool gating.** *Only these tools* is an allowlist — leave it empty to allow
everything the server offers. *Never these tools* is a denylist and wins over
the allowlist. Filling in the denylist is worth the minute it takes: the model
decides on its own when to call a tool. The **Test** button lists the server's
tool names, which is the easiest way to fill either list in.

**Tokens are write-only.** A saved token is never sent back to the browser and
never appears in the rendered page — the panel shows only that one exists. Edit
a connection without retyping the token to keep it, or save an empty token field
to clear it.

#### The config file

For servers that should apply to every Discord server the bot is in:

```bash
cp config/mcp-servers.example.json config/mcp-servers.json
```

The default path is `config/mcp-servers.json` next to `package.json`. Set
`MCP_SERVERS_CONFIG` in `.env` to read it from somewhere else — useful when the
file lives outside the repo checkout.

```json
{
  "servers": [
    {
      "name": "docs-search",
      "url": "https://mcp.example.com/docs"
    },
    {
      "name": "calendar",
      "url": "https://mcp.example.com/calendar",
      "authorization_token": "${CALENDAR_MCP_TOKEN}",
      "allowed_tools": ["search_events", "list_events"]
    }
  ]
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique identifier, letters/digits/`_`/`-`. Appears in Claude's tool calls. |
| `url` | Yes | The server's HTTPS endpoint (Streamable HTTP or SSE). Local stdio servers cannot be reached this way. |
| `enabled` | No | Set `false` to keep an entry in the file without connecting to it. |
| `authorization_token` | No | OAuth bearer token, if the server needs one. |
| `allowed_tools` | No | Allowlist of tool names. Empty means every tool. |
| `blocked_tools` | No | Denylist of tool names. Wins over `allowed_tools`. |
| `default_config` / `configs` | No | The API's raw toolset shape, if you need `defer_loading` or another setting the two lists above don't cover. |

**Keeping tokens out of the file.** Any `url` or `authorization_token` written
as `${VAR_NAME}` is read from the environment at startup, so real credentials
stay in `.env`:

```env
CALENDAR_MCP_TOKEN=your_oauth_access_token
```

A `${VAR}` that resolves to nothing disables that one server (with a log line)
rather than sending the literal `${VAR}` text to it. This expansion is
deliberately **file-only** — a dashboard token is used exactly as typed, so a
guild admin cannot read the bot's environment back out through a server they
control.

`config/mcp-servers.json` is gitignored and excluded from the Docker image;
`docker-compose.yml` mounts `./config` read-only instead, so tokens stay on the
host.

#### Locking it down

Set `MCP_ALLOW_GUILD_SERVERS=false` in `.env` to make the config file the only
way in. The Connections tab still lists what is active but refuses to save.

#### Checking it works

```text
[MCP] 2 server(s) from /app/config/mcp-servers.json: docs-search, calendar
```

Problems are reported as `[MCP] ...` warnings and skip the offending entry — a
malformed config disables the connector, it never stops the bot from starting.

**Notes**

- Tokens are not free: every enabled tool's description is sent with each
  request, and on the client route each tool call costs another round trip to
  the model. Trim with the allow/deny lists if you connect a large server.
- `/forge` and `/questgen` parse the model's reply as JSON and deliberately run
  without MCP tools.
- A tool call is capped at four rounds per message, after which the model is
  asked once more with no tools so it has to answer.
- A server that is unreachable is skipped with an `[MCP]` warning rather than
  failing the reply, and named in the reply's footer — the model answering
  without it is otherwise indistinguishable from the model not knowing.
- Replies show their tool use: a line naming the tool while it runs, and a
  summary on the finished message. Nothing about it reaches the conversation
  history, so it costs no tokens on the next message.
- Servers are all dialled at once when a turn starts, and the calls in one round
  run concurrently, up to six at a time. A round costs its slowest call rather
  than the sum, but a server on the far side sees several requests together.
- On the client route the bot opens the connection, so the URL must be a public
  https address — one that resolves into private or reserved space is refused
  at the socket, the same guard the Ollama base URL uses.
- Data retention needs checking on both sides. With Claude, Anthropic's
  zero-data-retention arrangements do **not** cover the MCP connector, so tool
  definitions and tool results are retained under their standard policy; on the
  client route the tool results are sent to your provider as ordinary messages
  and retained under whatever policy applies to those. Separately, the remote
  server is a third party that sets its own retention and downstream processing
  for whatever the bot sends it. Read the privacy policy of every server you
  connect before pointing it at a Discord server's traffic.

## Daily News Configuration

### Finding RSS Feeds

Most news sites and blogs provide RSS feeds. Here are some examples:

**Major News Sources:**
- BBC: `http://feeds.bbci.co.uk/news/rss.xml`
- CNN: `http://rss.cnn.com/rss/cnn_topstories.rss`
- Reuters: `https://www.reutersagency.com/feed/`
- TechCrunch: `https://techcrunch.com/feed/`
- The Verge: `https://www.theverge.com/rss/index.xml`

**Finding RSS Feeds:**
1. Look for RSS icon on websites
2. Check `/feed`, `/rss`, or `/feed.xml` paths
3. Use browser extensions like "RSS Feed Reader"
4. Use RSS feed discovery tools

### Configuration Steps

1. Open the bot dashboard
2. Select your server
3. Go to "Daily News" tab
4. Enable Daily News Digest
5. Select a channel for posting
6. Set delivery time (e.g., `09:00` for 9 AM)
7. Add RSS feed URLs (one per line)
8. Set max items per feed (1-10)
9. Customize the digest title
10. Save settings

### Testing Daily News

Open the dashboard's **Daily News** panel and press **Send digest now** (the
dashboard already requires Manage Server on the guild). It posts a digest
immediately to the configured channel, so you can check the feeds, the
channel and the bot's permissions without waiting for the scheduled time.

The button calls `POST /api/guild/:guildId/dailynews/trigger`; there is no
slash command for it.

## Dashboard Setup

### Environment Variables

Create a `.env` file with these required variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
CLIENT_ID=your_client_id_here
CLIENT_SECRET=your_client_secret_here

# Database — the name is still "ultrabot" from before the rebrand, deliberately.
# Renaming it points the bot at a new, empty database rather than moving data.
# Upgrading an existing deployment? See "Migrating an existing UltraBot stack"
# below: the volume holding this database is namespaced by your stack name.
MONGODB_URI=mongodb://mongodb:27017/ultrabot

# Dashboard
# DASHBOARD_URL must be https:// whenever NODE_ENV=production — the dashboard
# refuses to start otherwise. This http://localhost value is paired with the
# NODE_ENV=development at the bottom of this block; change the two together.
DASHBOARD_PORT=3000
DASHBOARD_URL=http://localhost:3000
SESSION_SECRET=random_string_here_32_characters_min

# AI (Optional - can also configure per-server in dashboard)
OPENAI_API_KEY=sk-your_openai_key_here
GEMINI_API_KEY=AIza_your_gemini_key_here

# MCP servers, used by whichever AI provider is selected (Optional)
# Defaults to config/mcp-servers.json; set this only to read it from elsewhere.
# MCP_SERVERS_CONFIG=/opt/clawdia/config/mcp-servers.json

# Meme Generation (Optional — required for /meme command)
# Free account at https://imgflip.com/api
IMGFLIP_USERNAME=your_imgflip_username
IMGFLIP_PASSWORD=your_imgflip_password

# Environment
NODE_ENV=development
```

The block above is a working local setup: `NODE_ENV=development` goes with the
`http://localhost:3000` dashboard URL. Going to production means changing both
lines together —

```env
DASHBOARD_URL=https://bot.example.com
NODE_ENV=production
```

— because `NODE_ENV=production` with a non-HTTPS `DASHBOARD_URL` aborts startup
with `DASHBOARD_URL must use HTTPS in production`. Discord also rejects
non-HTTPS OAuth redirect URIs, so there is no production setup where the
`http://` value is correct.

### Generating Session Secret

Use this command to generate a secure session secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Portainer Deployment

### Migrating an existing UltraBot stack

Skip this section on a fresh install. If you already run the stack under the old
name, read it before deploying — the container and network renames are not
drop-in.

**The data lives in the volume, and the volume is namespaced by the stack name.**
`mongodb_data` is a normal (non-external) named volume, so Compose stores it as
`<stack-name>_mongodb_data`. A stack deployed as `ultrabot` holds its data in
`ultrabot_mongodb_data`. Deploy the same file under the name `clawdia` and
Compose creates a *new, empty* `clawdia_mongodb_data` — the bot starts up clean
and the old data is still on disk, just orphaned. Confirm what you have first:

```bash
docker volume ls | grep mongodb_data
```

Then pick one:

- **Keep the stack name (simplest).** Leave the Portainer stack called
  `ultrabot` and redeploy the updated file into it. The containers and network
  get their new names; the volume path never changes, so nothing moves.
- **Rename the stack and reuse the volume.** Stop and remove the old stack
  first — `container_name` is fixed, so `clawdia-mongodb` and `clawdia` collide
  with the still-running old containers, as does the published port. Then, in
  the new stack, point at the existing volume explicitly:

  ```yaml
  volumes:
    mongodb_data:
      external: true
      name: ultrabot_mongodb_data
  ```

- **Rename the stack and move the data.** Run `./scripts/backup.sh` against the
  old stack, deploy the new one, then `./scripts/restore.sh <archive>`. Use this
  if you want the volume named after the new stack too.

Removing a stack in Portainer does not delete its volumes, so the old data
survives a mistake here — but verify the bot came up with your servers intact
before deleting anything.

### Method 1: Docker Compose in Portainer

1. Open Portainer
2. Go to "Stacks"
3. Click "Add stack"
4. Name it "clawdia" (or keep your existing stack name — see the migration note above)
5. Paste the `docker-compose.yml` content
6. Add environment variables in the env section or upload `.env` file
7. Click "Deploy the stack"

### Method 2: Manual Container Creation

1. Create a custom bridge network: `clawdia-network`
2. Deploy MongoDB container first
3. Deploy bot container with environment variables
4. Link containers to the network

### Updating the Bot

**With Portainer:**
1. Go to Stacks > clawdia
2. Click "Pull and redeploy"

**Manual:**

```bash
docker-compose pull
docker-compose up -d
```

### Viewing Logs

**Portainer:** Stacks > clawdia > bot > Logs

**Command line:**

```bash
docker logs clawdia -f
```

### Health Monitoring

The bot serves `GET /health` on the dashboard port — 3000 inside the container,
and whatever `DASHBOARD_HOST_PORT` publishes on the host (3000 under
`docker-compose.yml`, 7001 under `portainer-stack.yml`):

```bash
curl -s http://localhost:3000/health   # or 7001 on the Portainer stack
# {"status":"healthy","uptime":43200}
```

`status` is `healthy`, `degraded` (MongoDB is up, but a scheduled service —
RSS, raid detection, temp-ban sweeps, the daily verse — is failing every run) or
`unhealthy` (MongoDB is not connected). Only `healthy` answers HTTP 200.

Nothing watches this for you. Point an uptime monitor at the endpoint and alert
on a non-200 response *and* on a body whose `status` is not `"healthy"` — the
`degraded` case is the one you would otherwise never hear about, because the bot
keeps answering Discord perfectly well while it is in it. README's **Monitoring**
section covers the setup, and the optional `autoheal` service that restarts an
`unhealthy` container.

## Database Management

### MongoDB Connection

The bot automatically creates the database and collections. No manual setup needed.

### Automated Backups

Both `docker-compose.yml` and `portainer-stack.yml` run a `backup` service that
dumps the database once a day at 03:00 UTC and prunes archives older than
`BACKUP_RETENTION_DAYS` (30). It is **on by default in both** — it used to exist
only in the compose file, and only behind a profile, which meant the production
Portainer deploy had no automated backups at all.

Where the archives land differs, because a Portainer stack has no repo checkout
on the host to bind-mount:

| Deploy | Location |
| --- | --- |
| `docker compose` | `./backups/` in the checkout |
| Portainer stack | the `backups` named volume (usually `clawdia_backups`) |

The bot mounts the same location at `/app/backups`, which is where
`src/migrations/runner.js` puts its pre-migration dump. Those archives are named
`pre-migration-*.gz` and are pruned on the same schedule.

To copy an archive out of the Portainer volume:

```bash
docker run --rm -v clawdia_backups:/b -v "$PWD:/out" alpine \
  sh -c 'cp /b/clawdia-<timestamp>.gz /out/'
```

To opt out of the scheduled service (only if something else — a host cron
running `scripts/backup.sh`, a volume snapshot — is demonstrably taking its
place):

```bash
docker compose up -d --scale backup=0
```

`--scale` is Compose-only. On a Portainer stack, delete the `backup` service
from the stack definition and redeploy.

### Backup on Demand

```bash
./scripts/backup.sh              # → ./backups/clawdia-<timestamp>.gz
```

It uses `mongodump` if it is on `PATH` and otherwise runs it inside the
`clawdia-mongodb` container, so it works whether or not the host has the mongo
tools installed.

### Verify a Backup Restores

An untested backup is a guess, and migrations here are destructive and
forward-only. `scripts/verify-backup.sh` restores an archive into a throwaway
database beside the real one, compares per-collection document counts, and drops
the scratch database on the way out. Nothing touches the live data.

A restored collection is expected to be a little behind the live one, which
keeps taking writes while the archive restores; one that comes back more than
10% short fails the run, so a truncated archive is caught rather than passed.
Set `VERIFY_SHORTFALL` (0–1) to loosen that for a collection written to hard
enough that a healthy restore trips it.

```bash
./scripts/verify-backup.sh --latest       # newest archive in ./backups
./scripts/verify-backup.sh ./backups/clawdia-20260101T030000Z.gz
```

It exits non-zero if any collection comes back empty, so it can be wired into a
host cron and monitored like any other job. Run it after any change to the
backup service, and periodically thereafter.

### Restore Database

```bash
./scripts/restore.sh ./backups/clawdia-<timestamp>.gz          # merge
./scripts/restore.sh ./backups/clawdia-<timestamp>.gz --drop   # clean restore
```

Both forms prompt for confirmation first. Verify the archive with
`scripts/verify-backup.sh` before running this against a live database.

## Troubleshooting

### Bot Not Responding

1. Check bot is online in Discord
2. Verify `DISCORD_TOKEN` is correct
3. Check intents are enabled in Discord Developer Portal
4. View logs: `docker logs clawdia`

### Dashboard Not Loading

1. Check port 3000 is accessible
2. Verify `DASHBOARD_URL` matches your domain
3. Check MongoDB is running: `docker ps`

### AI Not Working

1. Verify API key is correct
2. Check you have credits/quota remaining
3. Try switching providers (OpenAI ↔ Gemini)
4. Check logs for specific error messages

### Daily News Not Posting

1. Verify RSS feed URLs are valid
2. Check delivery time is in correct format (HH:MM)
3. Ensure channel ID is valid
4. Press **Send digest now** in the dashboard's Daily News panel to test a delivery
5. Check bot has permission to post in channel

## Best Practices

### Security

- Never share your `.env` file or API keys
- Use strong session secrets (32+ characters)
- Limit bot permissions to only what's needed
- Regularly update dependencies
- In Docker, deliver secrets as files rather than environment variables. Anyone
  who can reach the Docker API can read a container's environment in full —
  `docker inspect clawdia` prints it, and the Portainer UI shows the same
  values — without needing a shell in the container. Every secret variable also
  accepts a `<NAME>_FILE` form naming a file to read the value from:

  ```yaml
  environment:
    DISCORD_TOKEN_FILE: /run/secrets/discord_token
  secrets:
    - discord_token
  ```

  The container environment then holds only the path. `docker-compose.yml` and
  `portainer-stack.yml` both carry a commented block covering every supported
  secret; uncomment the entries you want on the service, the matching top-level
  declarations, and nothing else — a declared secret whose file is missing fails
  the deploy. Setting both forms uses the plain value and logs a warning, so
  secrets can be migrated one at a time; an unreadable or empty file aborts
  startup rather than leaving the variable quietly unset.

  Two cases need more than uncommenting. In `portainer-stack.yml` the
  `MONGODB_URI` mapping carries a `:-` default, so it is never empty and always
  wins over `MONGODB_URI_FILE` — delete that line rather than blanking it. And
  the `backup` service is a stock mongo image with no loader of its own; it
  reads `MONGODB_URI_FILE` in its entrypoint, so mount the same secret there if
  you move the database URI to a file. Its entrypoint prefers the file over
  `MONGODB_URI`, so unlike the bot's, its `MONGODB_URI` mapping can stay.

### Performance

- Use MongoDB indexes for large servers
- Limit RSS feed checks to reasonable intervals (5-10 minutes)
- Monitor API usage to avoid rate limits
- Use caching where possible

### Moderation

- Set up moderation log channel
- Configure auto-mod before enabling
- Test moderation commands in a test channel first
- Create staff roles with appropriate permissions

### AI Usage

- Set reasonable system prompts
- Monitor AI responses for quality
- Use per-server API keys for cost control
- Enable AI only in designated channels

## Getting Help

- Check logs first: `docker logs clawdia -f`
- Review this guide thoroughly
- Check Discord.js documentation for bot issues
- Review API provider documentation for AI issues

## Next Steps

After basic setup:

1. Configure welcome messages with custom cards
2. Set up leveling and economy systems
3. Add RSS feeds for your community's interests
4. Configure auto-moderation rules
5. Create custom commands in dashboard
6. Set up auto-roles for new members

Enjoy your fully-featured Discord bot! 🚀