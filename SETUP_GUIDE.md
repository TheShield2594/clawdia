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
https://discord.com/api/oauth2/authorize?client_id=CLIENT_ID&permissions=1101957033174&scope=bot%20applications.commands
```

The `permissions` value is the minimum set the bot's features need — the list in
FEATURES.md under "Bot Permissions Required", computed from
`src/config/invitePermissions.js`. It deliberately does **not** include
Administrator: if a feature misbehaves, grant the specific missing permission
(the bot logs which one) rather than falling back to Administrator.

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
Face and Stripe, plus the three below that take a login instead of a token.

**Gmail and Spotify** are in the list too, marked *your own endpoint*: neither
Google nor Spotify publishes a hosted MCP endpoint, so the server is one you
run yourself or one a hosting provider spins up per account. Picking either
fills in the name and the credential guidance and leaves the URL for you, with
a placeholder showing the shape of the address. Everything after that is
identical.

Anything else works the same way: choose **Custom server…** and paste the
server's https endpoint and token.

#### Servers that want a login rather than a token

Linear, Notion and Sentry issue no static token at all. They answer the first
request with a 401 naming their authorization server, and the connection is
finished by signing in.

1. Add the connection as above — pick the service, leave the token field empty,
   and click **Add connection**.
2. Click **Connect** on the row. A tab opens on the service's own sign-in page.
3. Sign in and approve. The tab tells you it worked and can be closed.
4. Reload the dashboard and click **Test**. The row now reads
   *🔓 signed in to …* instead of *no token*.

The row's **Sign out** button forgets the login and leaves the connection in
place, which is what you want before reconnecting as a different account.

A few things worth knowing:

- **The login belongs to whoever performed it.** The bot acts as that account
  for everything it does through the connection, in every channel of that
  Discord server. Sign in as an account whose access you are happy to lend, and
  fill in *Never these tools* before anyone uses it.
- **The tokens are encrypted at rest** when `SECRET_ENCRYPTION_KEY` is set, the
  same as the provider API keys — a refresh token is a long-lived credential for
  somebody's mailbox or issue tracker. Set that variable before connecting one.
- **Claude always uses the bot's own client** for these, whatever *Connection
  route* is set to. An access token expires within the hour and only the bot can
  refresh it, so Anthropic's connector — which opens the connection on their
  side — cannot be given one that keeps working.
- **Changing the URL, or setting a token, signs the connection out.** The login
  was issued for one address and one way of authorizing; the dashboard says so
  when it happens.
- **The redirect URL is `<DASHBOARD_URL>/api/mcp/oauth/callback`.** Nothing has
  to be registered anywhere for the three presets above — the bot registers
  itself with the service automatically. A server that does not support that
  reports the URL to register by hand.

Any other server that wants a login works the same way, as long as it speaks
the Streamable HTTP transport — the one the bot's MCP client implements, here
and for token connections alike. Atlassian is the notable absence: its published
endpoint uses the older HTTP+SSE transport, which is a separate protocol rather
than a response format, and is not implemented.

**Tool gating.** *Only these tools* is an allowlist — leave it empty to allow
everything the server offers. *Never these tools* is a denylist and wins over
the allowlist. Filling in the denylist is worth the minute it takes: the model
decides on its own when to call a tool. The **Test** button lists the server's
tool names, which is the easiest way to fill either list in.

**Tokens are write-only.** A saved token is never sent back to the browser and
never appears in the rendered page — the panel shows only that one exists. Edit
a connection without retyping the token to keep it, or save an empty token field
to clear it. The same goes for a login: the panel shows which service it is
with and when it was made, never the tokens behind it.

#### Documents and prompts

Tools are one third of what an MCP server can offer. The other two have homes
here as well.

**Resources** are the documents a server publishes — a wiki, a runbook, a
project's own notes. Switch **Use its documents as knowledge** on for a
connection and they become a second knowledge base: when somebody asks the AI
something, the bot scores the server's resource list against the question, reads
the closest few and puts them in the prompt alongside the entries an admin typed
into AI → Knowledge Base. The difference is who keeps them up to date — these
are read at the moment the question is asked, from wherever they actually live.

It is off by default and set per connection, because a tool runs when the model
asks for it while a resource is read before the model has said anything. The
**Test** button says how many resources a connection publishes, which is what
makes the switch worth flipping or not. Up to three documents are read per
message, trimmed to 2,000 characters each and 6,000 in total, with the whole
retrieval abandoned after eight seconds — a documentation server having a slow
morning costs the answer nothing.

**Prompts** are named templates the server owner wrote, each taking arguments:
"review this pull request", "summarise this incident". `/ai mcp prompts` lists
what the connections publish and what each one wants; `/ai mcp prompt` fills one
in and answers with it. Both are open to any member — running a prompt is
talking to the AI with somebody else's wording, and it spends the same per-user
and per-channel limits a chat message does.

```text
/ai mcp prompt name:docs/review arguments:pr=412 focus="the migration"
```

The prompt name autocompletes as `server/prompt`, and a prompt that takes a
single argument takes the whole `arguments` string as it, so
`arguments:what broke last night` works without naming anything. Required
arguments that are missing are named back rather than sent half-filled.

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
| `url` | Yes | The server's HTTPS endpoint, speaking the Streamable HTTP transport. Local stdio servers cannot be reached this way, and neither can the older HTTP+SSE transport — a Streamable HTTP server may still answer in SSE, which is a different thing. |
| `enabled` | No | Set `false` to keep an entry in the file without connecting to it. |
| `authorization_token` | No | OAuth bearer token, if the server needs one. |
| `allowed_tools` | No | Allowlist of tool names. Empty means every tool. |
| `blocked_tools` | No | Denylist of tool names. Wins over `allowed_tools`. |
| `resources` | No | Set `true` to search this server's resources when somebody asks the AI something and put the relevant ones in the prompt. Off by default. |
| `default_config` / `configs` | No | The API's raw toolset shape, if you need `defer_loading` or another setting the two lists above don't cover. |

**The config file cannot hold a login.** Its secrets are `${ENV_VAR}`
references, which the bot reads and never writes — and a refresh token rotates,
so a login has to be written back somewhere every time it is used. A server that
takes a login rather than a token is a dashboard connection, per Discord server.

**`defer_loading`** decides whether a tool's full JSON Schema is sent to the
model on every message or withheld until it asks for it by name. Left unset, the
bot withholds everything past the first two dozen tools automatically, which is
what keeps a server publishing ninety of them from costing more tokens per
message than the reply is allowed. Set it to `false` on the handful you actually
use and they stay loaded however long the list gets; set it to `true` to withhold
one on a small server.

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
- **Approval** (Connections → Approval) decides which tool calls stop and wait
  for someone to click **Run it** in the channel. `off` is the default and runs
  everything straight away. `destructive` and `writes` both read the annotations
  a server publishes about its own tools; they differ over a tool that publishes
  none, which `destructive` lets through and `writes` asks about. `always` asks
  about every call, reads included. A prompt can be answered by whoever asked or
  by anyone with Manage Server, and expires unanswered after a minute — which
  means the tool does not run.
- Tool annotations come from the server, so the two middle modes are worth what
  that server is honest about. *Never these tools* and the per-connection
  *Always ask before these tools* list ask the server nothing; use those where
  the answer has to be a guarantee.
- **Activity** (Connections → Activity) is a seven-day rollup per server and
  tool: calls, failures, refusals, average latency and the last error. Turns
  where a server could not be reached are counted separately, so a dead
  connection does not read as an unused one.
- **How Claude connects** (Connections → How Claude connects) only appears on
  Anthropic, the one provider with two routes. Their connector opens the
  connections on their side and the bot never sees the calls, so approvals, the
  tool line in replies and the activity rollup do not apply on it. `auto` takes
  the connector unless approvals are on, `connector` and `client` force either.
  Every other provider has only ever had the client route.
- `/ai mcp` gives the same answers in Discord, for admins with Manage Server:
  `servers`, `tools <server>`, `test <server>` and `activity`. All of them
  answer privately, and `test` runs the same handshake the dashboard's button
  does — no provider key, no tokens spent. `prompts` and `prompt` are the two
  subcommands anybody may run: they use a connection rather than reading how it
  is configured, which is what the AI does on every message anyway.
- A prompt template is written on somebody else's server, so it is run as data:
  the reply goes out with mentions disarmed and the system prompt says where the
  wording came from. The model's answer is posted in the channel; everything
  else under `/ai mcp` stays private.
- A tool result carrying a PNG, JPEG, GIF, WebP, MP3, WAV, OGG or PDF is posted
  to the channel as a file, up to four per reply. Anything else non-text is
  reported to the model as omitted, the way it always was.
- Tool results are labelled with the server and tool they came from, and the
  system prompt tells the model they are reference data rather than
  instructions. That is not the defence — the block list, the approval prompt
  and the per-tool filters are, and they hold whatever the model believes — but
  it is added whenever a server is configured, not only when in-channel actions
  are on.
- One turn's tools are capped at 24,000 characters of output in total and 90
  seconds of wall clock. The two ceilings do different things. Past the output
  one a call still runs — the model may want the side effect — but what comes
  back says the output did not fit rather than carrying it. Past the clock no
  further call is dialled at all, and no approval prompt is put in front of
  anyone for a call that will not happen either way. Both are refusals worded so
  the model can answer around them rather than leaving a reply open.
- A 429 carrying a short `Retry-After` is waited out once. A 429 without one, or
  asking for longer than a reply can wait, is reported as a failure.
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

# Encrypts the per-server AI provider keys stored in MongoDB (Optional,
# recommended). See "Encrypting stored provider keys" below.
SECRET_ENCRYPTION_KEY=

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

### Encrypting stored provider keys

The AI panel lets each server's admins enter their own provider key, and those
keys are stored in MongoDB rather than in the environment. That matters more
than it sounds: the `backup` service dumps the database nightly into `./backups`
in the clear and keeps a month of archives, so on a default install those
archives contain live credentials that bill someone else's account. A directory
that is only as protected as "it's on my server" is a weaker boundary than the
database itself.

Set `SECRET_ENCRYPTION_KEY` and those keys are stored AES-256-GCM encrypted
instead, so the dumps hold ciphertext:

```bash
openssl rand -base64 32
```

```env
SECRET_ENCRYPTION_KEY=the_generated_value
```

Keep it somewhere other than the backups it protects — a value stored next to
the archive it encrypts protects nothing. It is also not recoverable: without
it the stored per-guild keys cannot be read back. The bot does not break if it
is lost or rotated (it falls back to the bot-wide `*_API_KEY` variables and logs
a warning), but every affected server has to re-enter its key in the dashboard.

Keys already saved before the variable was set are rewritten on the next boot,
by migration `018_encrypt_guild_ai_keys`. If you set it *later* than that — the
migration has already run and recorded itself — sweep them by hand:

```bash
npm run secrets:encrypt
```

That is idempotent, so running it again, or after a new server adds a key, does
nothing. The bot-wide `OPENAI_API_KEY` / `GEMINI_API_KEY` / `ANTHROPIC_API_KEY`
/ `OPENROUTER_API_KEY` variables are unaffected either way — they are read from
the environment and never stored in the database.

Leaving `SECRET_ENCRYPTION_KEY` unset is a supportable choice, and on a
single-machine install where you control the backup directory it may well be
the right one. It is just worth making deliberately: the migration logs how many
keys it is leaving in the clear so the decision shows up on the first boot after
upgrading.

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

### Enabling MongoDB authentication

Strongly recommended. MongoDB sits on an internal-only Docker network with no
published ports, but without authentication that isolation is the *only*
control: any container joined to `db-network` has full, credential-less access
to the database.

**Fresh deployment (empty `mongodb_data` volume):** set all four variables
before the first `docker compose up` (in `.env`, or in the Portainer stack's
environment variables):

```bash
MONGODB_ROOT_USERNAME=root
MONGODB_ROOT_PASSWORD=$(openssl rand -hex 24)   # MongoDB's admin user
MONGODB_APP_USERNAME=clawdia
MONGODB_APP_PASSWORD=$(openssl rand -hex 24)    # the user the bot connects as
```

and point `MONGODB_URI` at the app user:

```bash
MONGODB_URI=mongodb://clawdia:<app-password>@mongodb:27017/ultrabot?authSource=ultrabot
```

The root variables make the mongo image create its admin user and start with
`--auth`; the app variables make `scripts/mongo-init.js` create a dedicated
user with `readWrite` on `ultrabot` and nothing else, which is what the bot,
the migrations and the nightly `mongodump` need. (On a Portainer stack the
init script has to be copied to the Docker host first — see the comment on the
`mongodb` service in `portainer-stack.yml`.) The `backup` service reads the
same `MONGODB_URI`, so it needs no separate configuration.

**Existing deployment (volume already has data):** the mongo image only runs
initialization against an empty volume, so create the users by hand — no wipe,
no dump-and-restore, one restart:

```bash
# 1. Create the users while auth is still off:
docker exec -it clawdia-mongodb mongosh --eval '
  db.getSiblingDB("admin").createUser({
    user: "root", pwd: "<root-password>", roles: ["root"] });
  db.getSiblingDB("ultrabot").createUser({
    user: "clawdia", pwd: "<app-password>",
    roles: [{ role: "readWrite", db: "ultrabot" }] });
'

# 2. Set the four variables (plus the credentialed MONGODB_URI) in .env or the
#    stack environment, exactly as in the fresh-deployment section above.

# 3. Recreate the stack so mongod comes back with --auth and the bot and
#    backup services pick up the new URI:
docker compose up -d --force-recreate
```

If a password is ever lost, the recovery path is the reverse: unset the
variables, `--force-recreate`, and mongod is back to no-auth so the users can
be recreated. That works because auth here is driven by the environment, which
is also why the variables must not be quietly removed once set.

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
- Set `SECRET_ENCRYPTION_KEY` if server admins enter their own AI provider keys
  in the dashboard, so the nightly database dumps in `./backups` hold ciphertext
  rather than live credentials. See
  [Encrypting stored provider keys](#encrypting-stored-provider-keys)
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