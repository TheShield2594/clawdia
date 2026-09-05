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

### Anthropic (Claude)

1. Go to the [Anthropic Console](https://console.anthropic.com/)
2. Create an account or sign in
3. Open **API Keys** and create one
4. Copy the key (starts with `sk-ant-...`)
5. Add to `.env` as `ANTHROPIC_API_KEY=sk-ant-...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Default model:** `claude-haiku-4-5`. Current rates are at
[Anthropic Pricing](https://www.anthropic.com/pricing#api).

### OpenRouter

1. Go to [OpenRouter Keys](https://openrouter.ai/keys)
2. Create an account or sign in, and create a key
3. Add to `.env` as `OPENROUTER_API_KEY=...`

**Alternative:** Add the API key per-server in the bot dashboard under AI Chat settings.

**Default model:** `openai/gpt-4o-mini`. One key reaches many vendors' models;
`OPENROUTER_REFERER` sets the attribution header OpenRouter shows on your
dashboard.

### Local (Ollama)

1. Install [Ollama](https://ollama.com/) and pull a model — `ollama pull llama3.2`
2. Point `OLLAMA_BASE_URL` at the instance, e.g. `http://localhost:11434`
3. Set the model in the dashboard under AI Chat settings — `llama3.2`,
   `mistral`, whatever you pulled

No key, no per-token cost, and nothing leaves the host. The per-server base URL
a guild admin can set in the dashboard must be an `http(s)` address that does
not resolve into private or reserved space, or a server admin could aim the bot
at anything reachable from its container. Your own endpoint is exempt from that:
set it as `OLLAMA_BASE_URL`.

Set **Model context window** in the dashboard too — see
[FEATURES.md](FEATURES.md#configuration-options) for why a self-hosted model is
the case where the bot cannot work it out for itself.

### Choosing between them

[AI_COMPARISON.md](AI_COMPARISON.md) is the side-by-side: default model,
credential, whether cost estimates are available, and how each one reaches MCP.

### MCP Servers

Connecting the bot to remote [MCP](https://modelcontextprotocol.io) servers — a
GitHub repo, a calendar, an internal search. What the connections then *do* —
the two routes, tool approvals, the per-user call budget, the activity rollup —
is [FEATURES.md](FEATURES.md#mcp-servers); this is how to set one up.

Whichever model is selected in AI → Chat is the one that uses them, and a
connection is configured once rather than redone when you switch provider.

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

Any other server that wants a login works the same way, over either of MCP's two
HTTP transports. The bot's client tries **Streamable HTTP** first — one endpoint,
every request a POST — and falls back to the older **HTTP+SSE** transport when
the server answers that POST with a 404 or a 405, which is what a server built
against the 2024-11-05 revision does. Nothing has to be configured either way;
paste the endpoint the service publishes.

Local **stdio** servers are still out of reach: they are a subprocess on the
machine running the server, not an address, and the bot connects over HTTP.

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
| `url` | Yes | The server's HTTPS endpoint. Either HTTP transport works — Streamable HTTP is tried first and the older HTTP+SSE is used if the server refuses the POST. Local stdio servers cannot be reached this way. |
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
  for someone to click **Run it** in the channel. Adding your first connection
  sets this to `writes`, because connecting a server is not by itself consent to
  unattended writes on it; change it to `off` if you would rather everything ran
  straight away. `destructive` and `writes` both read the annotations a server
  publishes about its own tools; they differ over a tool that publishes none,
  which `destructive` lets through and `writes` asks about. `always` asks about
  every call, reads included. A prompt can be answered by whoever asked or by
  anyone with Manage Server, and expires unanswered after a minute — which means
  the tool does not run.
- **Questions from a server** are the same idea in reverse. A tool that gets
  halfway and needs one more fact — which environment, which of your three
  organisations — can ask, and the question appears in the channel with an
  **Answer** button that opens a form. Whoever asked, or anyone with Manage
  Server, can fill it in; nobody answering means the server is told so and the
  tool decides what to do about it. At most two questions per reply, and the
  prompt says out loud that a real server will not ask for a password, an API
  key or a login code — cancel if one does.
- **A server asking for a completion** is the third of these, and the one that
  spends money. A server that needs a judgement rather than a fact — summarise
  this diff, is this a duplicate — can ask the bot to run *your* model and send
  the answer back. It is always approved in the channel, whatever Approval is
  set to, because the request is prose the server wrote and the tokens are
  billed to this server: they show up in AI → Usage beside the reply that
  caused them, and count against the same monthly ceilings. At most two per
  reply, capped at 1,024 generated tokens each, no tools offered, and the
  conversation is never included — a server asking for the channel's history
  gets a completion built from its own messages and nothing else.
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
- The bot's own in-channel actions — `create_poll`, `create_reminder`,
  `save_memory`, and `suggest_mod_action` for moderators — are offered as tools
  alongside the servers' wherever the bot runs the tool loop, so they get the
  same schema validation, approval buttons and reply footer. `save_memory` always
  asks before it writes. They do not appear in the Connections panel's usage
  ledger, which counts servers an admin configured. On Claude's own MCP connector
  the bot never sees a tool call, so there they stay on the older trailing-ACTION
  text protocol.
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

### The settings

| Setting | Description | Example |
|---------|-------------|---------|
| **Enabled** | Turn the digest on or off | ✅ |
| **Channel** | Where to post | #news |
| **Time** | Delivery time, 24-hour | `09:00` |
| **Timezone** | The zone that time is read in | `Europe/London` |
| **Title** | Embed title | 📰 Daily News |
| **Max Items** | Items taken from each feed, 1–10 | 3 |
| **Feeds** | RSS URLs, one per line | Several |

A server that wants more than one digest — a morning tech roundup and an
evening general one — adds a second **profile**, each with its own channel,
time and feed list.

### Finding RSS Feeds

Most news sites and blogs publish one. Look for the RSS icon, or try `/feed`,
`/rss` and `/feed.xml` under the site's domain.

**General news:**

```text
http://feeds.bbci.co.uk/news/rss.xml
http://rss.cnn.com/rss/cnn_topstories.rss
https://www.reddit.com/r/worldnews/.rss
```

**Technology:**

```text
https://techcrunch.com/feed/
https://www.theverge.com/rss/index.xml
https://arstechnica.com/feed/
```

**Gaming:**

```text
https://www.ign.com/articles?format=rss
https://www.polygon.com/rss/index.xml
https://kotaku.com/rss
```

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

The button calls `POST /api/v1/guild/:guildId/dailynews/trigger`
([API_REFERENCE.md](API_REFERENCE.md)); there is no slash command for it.

## Dashboard Setup

### Environment Variables

**Start from [`.env.example`](../.env.example)** — `cp .env.example .env` — rather
than from a list in a guide. It is the complete set, it is annotated variable by
variable, and a test fails the build when the code reads something it does not
explain. This guide used to carry its own copy of the list, which had already
dropped `ANTHROPIC_API_KEY` and `OLLAMA_BASE_URL` ([#707]).

What follows is the smallest `.env` that boots, to show the shape of the file
and the one pairing that catches people out. It is not the whole set.

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

# Environment
NODE_ENV=development
```

Everything else is optional and defaulted, `.env.example` says what each one
does, and the ones worth knowing about early are `SECRET_ENCRYPTION_KEY`
("Encrypting stored provider keys" below), the AI provider keys —
`OPENAI_API_KEY`, `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`,
`OLLAMA_BASE_URL` — and `IMGFLIP_USERNAME` / `IMGFLIP_PASSWORD` for `/meme`.

[#707]: https://github.com/TheShield2594/clawdia/issues/707

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

The same key covers the MCP OAuth tokens (`Connecting GitHub from the dashboard`
above). Those are longer-lived than a provider key in one respect that matters:
a refresh token mints new access tokens on demand, so a month-old backup of one
is a month-old key to somebody's GitHub.

Leaving `SECRET_ENCRYPTION_KEY` unset keeps working and is not refused at
startup — encryption shipped opt-in and failing the boot would take down every
deployment that has not set it. It is no longer silent, though: a
`NODE_ENV=production` boot without it prints a warning naming what is exposed,
`.env.example` asks for it beside `SESSION_SECRET`, and migration 018 logs how
many keys it is leaving in the clear. If you are running on one machine you
control and you have read the above, it is a defensible choice — just a
deliberate one.

Encrypting the credentials is the half of this that costs nothing. The other
half is the archives themselves, which hold everything else the database
contains — see below.

## Portainer Deployment

### Which architectures the image is built for

`ghcr.io/theshield2594/clawdia` is published for **linux/amd64 and
linux/arm64**, under one tag as a manifest list — `docker pull` on either
resolves without you choosing. arm64 covers a Raspberry Pi 4 or 5 on a 64-bit
OS, an Oracle Ampere instance, and Docker on an Apple Silicon Mac.

Two things are worth knowing before you deploy to one:

- **arm64 is built and scanned, not booted.** Both images are compiled and
  vulnerability-scanned before anything is published, and a HIGH or CRITICAL
  finding with a fix available stops the release on either. What only the amd64
  image gets is the boot check — it is started with an empty config and has to
  reject it — because booting the arm64 one means running an emulated Node
  through its whole require graph on an x86 runner.

  So the arm64 image is proven to *compile*, including the native `canvas`
  binding that an architecture change actually breaks, and proven to carry no
  known fixable vulnerability. It is not proven to *start*. If it does not,
  that is a bug worth filing rather than something known.
- **32-bit ARM is not built.** A Pi running the 32-bit Raspberry Pi OS needs the
  64-bit one; `uname -m` says `aarch64` when you are on it and `armv7l` when you
  are not. `docker pull` on armv7l fails with "no matching manifest", which is
  the intended failure — it is clearer than an image that starts and then
  crashes.

Everything else in this guide is the same on either architecture.

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

Two things happen on that first boot without being asked for, and both are worth
knowing about before an upgrade rather than during one:

- **Schema migrations run**, before the dashboard opens its port. Some are
  irreversible. See [Schema migrations](#schema-migrations) — the
  `MIGRATION_BACKUP=require` both stack files set is what makes the
  pre-migration dump a guarantee rather than an attempt.
- **Slash commands re-register** if the command set changed, so a release that
  adds or renames a command needs no separate step. Newly registered global
  commands can take up to an hour to appear.

`mongo:7` and the `node:24-alpine` base are pinned by `@sha256:` digest rather
than by tag, so `docker-compose pull` fetches the exact images the release was
tested against and a rebuild for a rollback cannot quietly pick up a newer base.
Dependabot raises the bumps; there is nothing to do by hand.

### Viewing Logs

**Portainer:** Stacks > clawdia > bot > Logs. **Command line:** `docker logs
clawdia -f`.

Everything the bot writes goes through [pino](https://getpino.io): one line per
event, carrying a level, an ISO timestamp, the subsystem it came from, and — for
anything a dashboard request produced — a correlation id shared by every line of
that request.

```json
{"level":"error","time":"2026-08-14T11:42:35.001Z","component":"RSS","requestId":"5f3c…","msg":"Feed fetch failed","err":{"type":"Error","message":"404"}}
```

| Variable | Default | Effect |
|---|---|---|
| `LOG_LEVEL` | `info` | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent`. Anything below the level is not written at all |
| `LOG_FORMAT` | `json` under `NODE_ENV=production`, else `pretty` | `pretty` renders `11:42:35.001 ERROR [RSS] Feed fetch failed` instead |

`component` is the `[TAG]` every log line in this codebase already carried —
`READY`, `MIGRATIONS`, `RSS`, `DASHBOARD` — promoted to a field, so a log backend
can filter on it rather than grepping text. Under sharding, `shard` is a field
too. Credentials are redacted before a line is written: tokens, `Authorization`
headers, cookies and provider keys come out as `[redacted]`.

Everything goes to stdout, errors included — a change from the bare
`console.error` this replaced, and the convention every JSON log shipper
expects. The `json-file` driver in `docker-compose.yml` captures it either way
(50 MB × 5 files per service). To read a production stream by hand:

```bash
docker logs clawdia -f | npx pino-pretty                       # readable lines
docker logs clawdia --since 1h | jq -c 'select(.level=="error")'
docker logs clawdia --since 1h | jq -c 'select(.component=="MIGRATIONS")'
```

`LOG_LEVEL=warn` is the setting for a busy install whose 250 MB of retention is
being spent on startup notices.

**`ERROR_WEBHOOK_URL` is the other half.** An uncaught exception or a burst of
unhandled rejections exits the process, and until you set this the only record
is a line in a rolling file nobody is watching — which is how a bot that
crash-loops at 04:00 gets noticed days later, by a user. Set it to a Discord
webhook (recognised and formatted as a Discord message) or to any endpoint that
accepts a JSON POST, and the process reports the crash before it goes. It waits
at most `ERROR_REPORT_TIMEOUT_MS` (2000) for that and exits either way; unset,
the exit is synchronous and nothing is sent.

The report carries a stack trace, so the URL must be `https://` — or `http://`
to loopback, for a collector on the same host, where there is no wire to read.
Anything else is refused with a warning rather than sent in cleartext, and a
redirect is never followed, so a `3xx` cannot walk the report to a host you did
not configure.

### Health Monitoring

The bot serves `GET /health` on the dashboard port — 3000 inside the container,
and whatever `DASHBOARD_HOST_PORT` publishes on the host (3000 under
`docker-compose.yml`, 7001 under `portainer-stack.yml`). It is unauthenticated
and deliberately thin for anonymous callers — status and uptime, nothing else:

```json
{ "status": "healthy", "uptime": 43200 }
```

A caller who is logged in and administers a guild the bot is in gets the full
payload instead: MongoDB connection state, heap and RSS, unhandled-rejection and
uncaught-exception counts, and a per-service record of the last run, last error
and success/error/skip counts for every scheduled job.

`status` is one of three values, and the HTTP code follows it:

| `status` | HTTP | Meaning |
|---|---:|---|
| `healthy` | 200 | MongoDB connected, every scheduled service's last run succeeded |
| `degraded` | 503 | MongoDB connected, but a scheduled service is failing |
| `unhealthy` | 503 | MongoDB is not connected — the bot can neither read nor write |

`degraded` is the state worth wiring up. It is what a dead RSS poller, a stalled
temp-ban sweep or a raid detector throwing every tick looks like from outside,
and the bot keeps answering Discord perfectly well while it is in it.

**Point an uptime monitor at `/health`** — Uptime Kuma, Better Stack, Healthchecks.io,
a Prometheus blackbox probe, anything that can make an HTTP request on a
schedule. Alert on both:

- a non-200 response, and
- a body whose `status` is not `"healthy"`, for monitors that can assert on
  JSON — it survives a proxy that rewrites status codes, and it names which of
  the two failure states you are in.

A 30–60 second interval matches the scheduler's granularity. Give it a couple of
minutes of grace on startup: the container healthcheck already allows 90 seconds
before the first probe counts.

#### Restarting an unhealthy container

`restart: unless-stopped` restarts a container whose process exited. It does
nothing about a container that is up and failing its healthcheck — outside
Swarm, Docker records `unhealthy` and stops there. `docker-compose.yml` carries
an optional `autoheal` service for that, off by default:

```bash
docker compose --profile autoheal up -d
```

It watches the daemon and restarts containers labelled `autoheal=true`, which
the bot service already is. `portainer-stack.yml` has the same block, commented
out.

It is opt-in because it holds the Docker API, and anything that can reach the
Docker API can read every environment variable of every container on the host —
`docker inspect clawdia` prints the bot token and each provider key in full. If
you enable it, move the secrets to the `<NAME>_FILE` form first (see
`src/config/fileSecrets.js`) so there is nothing in the environment to read.

Note that only `unhealthy` restarts. `degraded` answers 503 to the monitor but
is not a healthcheck failure: restarting the process does not fix a feed that is
404ing, and the restart loop would be worse than the degraded state.

## Database Management

### MongoDB Connection

The bot automatically creates the database and collections. No manual setup needed.

### Schema migrations

**Schema migrations run automatically on every boot.** There is no migrate step
to invoke and no flag that skips them. `src/index.js` runs
`src/migrations/runner.js` after the database connects and *before* the bot logs
in or the dashboard opens its port, so a container that is accepting traffic is
a container whose migrations have already finished. Under sharding only shard 0
runs them.

That matters more than it usually would, because of what these migrations do:

- **They are forward-only in practice.** The runner never rolls back on its own.
- **Several are irreversible.** Dropping a field or merging two documents cannot
  be computed backwards, so those migrations declare `irreversible: true` and
  have no `down()` at all. Six of the eighteen are: `005_grind_profiles`,
  `006_drop_wheel_fields`, `008_pet_decay_cursor`,
  `010_merge_duplicate_inventory_slots`, `011_clamp_negative_balances` and
  `017_merge_slots_jackpot_pool`.
- **A failed migration aborts startup.** Booting on a half-applied schema would
  be worse than not booting, so the runner rethrows and the process exits — a
  supervisor then restarts it and it tries again. The exception is a migration
  marked `optional` (a performance index, not a schema change): that one is
  logged, left unapplied, and retried next boot.

**Both stack files set `MIGRATION_BACKUP=require` for you.** Immediately before
any irreversible migration the runner takes a `mongodump` into
`MIGRATION_BACKUP_DIR` (default `./backups`, which both stack files mount) named
`pre-migration-<timestamp>.gz`. Under `require` a backup that fails or cannot be
taken aborts the startup, so the destructive step never runs unprotected; the
image ships `mongodb-tools`, so `mongodump` is on `PATH` there. With
`MIGRATION_BACKUP` unset — which is what a bare checkout gets — a missing or
failing `mongodump` is a loud warning and the migration proceeds anyway, so set
it yourself if you run outside Docker. `skip` does not attempt one.

Restore it with `scripts/restore.sh`, the same as any nightly archive. These
dumps are pruned on the same `BACKUP_RETENTION_DAYS` schedule as the rest.

What it looks like in the log:

```
[MIGRATIONS] Already applied: 001_add_indexes
[MIGRATIONS] Taking pre-migration backup → /app/backups/pre-migration-20260814T114235Z.gz
[MIGRATIONS] Pre-migration backup complete.
[MIGRATIONS] Applying: 018_encrypt_guild_ai_keys (budget 30000ms)
[MIGRATIONS] Applied 018_encrypt_guild_ai_keys in 412ms
[MIGRATIONS] Applied 1 migration(s).
```

Each migration records its name in the `migrationrecords` collection when it
succeeds, and that record is the only thing that stops it running again:

```bash
docker exec -it clawdia-mongodb mongosh ultrabot --eval \
  'db.migrationrecords.find({}, {name: 1, appliedAt: 1, durationMs: 1}).sort({name: 1})'
```

**If startup hangs or loops on a migration**, the budget is the usual cause. Each
one gets 30 seconds of wall-clock by default, and `005_grind_profiles` rewrites
every user document — on a large install that is a boot loop, since every
restart hits the same wall. Raise it without shipping a code change:

```bash
MIGRATION_TIMEOUT_MS=300000
```

The log line names which migration ran out. A migration may also ask for more
than the default on its own, in which case the larger of the two applies.

**Rolling one back** is a deliberate, manual act, and only possible for a
migration that has a `down()`:

```bash
npm run migrate:rollback -- 013_split_guild_analytics
```

It runs `down()` and deletes the `MigrationRecord`, which means the next boot
re-applies it — so pair a rollback with deploying the code you are rolling back
to. Only the most recently applied migration can be rolled back. For an
irreversible one there is no rollback: restore the pre-migration dump and
redeploy the old image, in that order. [docs/RELEASING.md](RELEASING.md)
covers the version-rollback case; [docs/EXTENDING.md](EXTENDING.md#schema-migrations)
covers writing a new migration.

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

### Running MongoDB as a single-node replica set

Off by default. Turning it on is what makes MongoDB's **multi-document
transactions** available; a standalone `mongod` has none, at any version.

That matters because every cross-user and cross-collection money move — `/rob`,
the market, syndicate payouts, `/bank transfer` — has to reach for something
instead. What it reaches for is hand-rolled compensation: retry, then the
owed-payout ledger (`src/utils/owedPayout.js`), then an operator running
`npm run payouts:replay`. That machinery is good and it is not going anywhere —
it also covers Discord-side delivery failures, which a transaction cannot — but
it is opt-in per code path, so its correctness depends on every author of a new
money path remembering to reimplement it. A replica set is what lets the paths
that are genuinely two-party use a real transaction instead.

One node is a legitimate replica set. It buys no redundancy — there is nothing
to fail over to — only the transaction support, the oplog and change streams
that come with the replication machinery.

**Fresh deployment (empty `mongodb_data` volume):** set one variable before the
first `docker compose up`:

```bash
MONGODB_REPLICA_SET_ARGS=--replSet rs0
```

`MONGODB_URI` needs no change: the driver discovers the set from
`mongodb://mongodb:27017/ultrabot` and switches to a replica-set topology on its
own. Adding `?replicaSet=rs0` is optional and makes the expectation explicit.

The `mongo-replset-init` container does the one-time `rs.initiate()` and exits.
Until it has, `mongod` reports itself unhealthy — its healthcheck asks whether it
will accept a write, not merely whether it is listening — so the bot waits rather
than starting against a node that would fail every migration. Check it with:

```bash
docker logs clawdia-mongo-replset-init
docker exec -it clawdia-mongodb mongosh --quiet --eval 'rs.status().myState'   # 1 = primary
```

One ordering detail for a fresh volume: the mongo image runs its first-boot
initialization (the root user, then `scripts/mongo-init.js`) against a temporary
`mongod`, and it drops `--replSet` from that temporary server only when
`MONGODB_ROOT_USERNAME` and `MONGODB_ROOT_PASSWORD` are both set. So set the app
variables **with** the root ones, as the authentication section above already
says — `MONGODB_APP_USERNAME` on its own, with no root user, would have the init
script try to create a user against a replica set that has not been initiated
yet, and fail.

**With authentication also on:** MongoDB requires *internal* authentication for
an authenticated replica set, and `mongod` refuses to start without a key file.
Create one, then name it in the same variable:

```bash
# On the Docker host, beside docker-compose.yml (or wherever the stack keeps it):
mkdir -p secrets
openssl rand -base64 756 > secrets/mongo-keyfile
chmod 400 secrets/mongo-keyfile
chown 999:999 secrets/mongo-keyfile          # the mongo image's own uid

MONGODB_REPLICA_SET_ARGS=--replSet rs0 --keyFile /etc/mongo-keyfile
```

and uncomment the key-file mount on the `mongodb` service. The
`mongo-replset-init` container also needs `MONGODB_ROOT_USERNAME` and
`MONGODB_ROOT_PASSWORD` in that case: reading the set name off `mongod` is an
authenticated command, and it is the one step that cannot be done anonymously.
If those are missing it says so and exits non-zero rather than leaving the set
half-configured.

**Existing deployment (volume already has data):** the same variable, and no
dump, no restore and no wipe — `rs.initiate()` adopts the existing data
directory:

```bash
# 1. Set MONGODB_REPLICA_SET_ARGS (plus the key file, if auth is on) in .env or
#    the stack environment.

# 2. Recreate the stack. mongod comes back as an uninitiated replica-set member,
#    the init container initiates it, and the bot starts once it is primary.
docker compose up -d --force-recreate
```

Expect the bot to wait around a minute on that first recreate: it is gated on
`mongod` being writable, which now happens after the initiation rather than at
startup.

Going back is clearing the variable and recreating: `mongod` starts standalone
against a data directory that has been a replica-set member, and the data is
untouched. The set's configuration survives in the `local` database, so turning
the variable back on resumes the same set rather than needing a second
`rs.initiate()` — and transactions are unavailable again for as long as it is
off, which is the thing to weigh, not the data.

### Encrypting MongoDB traffic with TLS

Off by default, and genuinely optional — read the tradeoff before turning it on.

`db-network` is declared `internal: true`: it has no gateway, no published ports,
and nothing outside the Docker host can route to it. So this is defence in depth
rather than a live hole. What it closes is a process that has *already* joined
that network. Authentication (the section above) closed half of that position —
such a process can no longer log in. This is the other half: with auth on and TLS
off, it still reads every balance, every audit entry and every administrative
command off the wire, including the root session `mongo-replset-init` uses to
initiate the replica set.

To be precise about how urgent that is, because it changes the answer: MongoDB
authenticates with SCRAM, a challenge-response exchange. No password is ever
transmitted, and a captured session cannot be replayed to log in. Everything
*after* the handshake is cleartext.

If an `internal: true` network is an acceptable trust boundary for your
deployment — one host, one operator, nothing else scheduled on it — leaving this
off is a defensible decision and not a deferred one. What is not defensible is
turning it on and forgetting the expiry date; see the last part of this section.

**It is all clients or none.** Five things talk to `mongod` on `db-network`, and
one of them left on cleartext leaves the traffic readable. Worse, a `mongod` in
`requireTLS` mode with one client that was not told is not a weaker deployment —
it is a deployment that cannot reach its own database. They are configured by
three settings, and `tests/deployStackParity.test.js` holds both stack files in
step so neither can gain a client the other does not have:

| Client | Configured by |
| --- | --- |
| the bot | `tls=true&tlsCAFile=…` on `MONGODB_URI` |
| the nightly `mongodump` and its `mongorestore --dryRun` | the same `MONGODB_URI` |
| `mongod`'s healthcheck (`mongosh`) | `MONGODB_CLIENT_TLS_ARGS` |
| `mongo-replset-init` (`mongosh`) | `MONGODB_CLIENT_TLS_ARGS` |
| `mongod` itself | `MONGODB_TLS_ARGS` |

The two `mongosh` probes need their own setting because they connect by host and
port and have no connection string to carry the options. The three that do take
one all read the same `MONGODB_URI`, so they are one edit and cannot disagree
with each other — and they are deliberately given *no* command-line TLS flags:
the database tools reject a configuration specified both ways.

**1. Issue the certificate.** On the Docker host, beside `docker-compose.yml`
(or wherever the stack keeps its secrets):

```bash
./scripts/mongo-tls-cert.sh                    # writes ./secrets/mongo-tls
./scripts/mongo-tls-cert.sh /opt/clawdia/mongo-tls    # Portainer host path
```

That writes three files:

| File | What reads it |
| --- | --- |
| `ca.crt` | every client, to validate `mongod` — and `mongod` itself, for its own replication connection |
| `server.pem` | `mongod` only. Certificate and private key concatenated, which is the single file `--tlsCertificateKeyFile` wants |
| `ca.key` | nothing, until you renew. It is the only thing that can mint a certificate this deployment would trust, and it goes into no container at all — this is the one file worth moving off the host once the pair is issued |

The certificate is issued for `mongodb`, the service name every client dials,
plus `localhost` and `127.0.0.1` for a `docker exec` `mongosh`; pass any
additional hostnames as further arguments. It chowns `server.pem` to uid 999,
which is what `mongod` runs as inside the image — if you did not run it as root
it says so, and `mongod` will not start until you do that step.

**2. Mount it, file by file.** Uncomment the five `mongo-tls` mounts: `ca.crt`
on all four services, and `server.pem` on `mongodb` as well. Four containers
mount the CA, or step 4 locks out whichever one you skipped.

They name files rather than the directory that holds them, and that is
deliberate. A `mongo-tls:/etc/mongo-tls:ro` mount is one line shorter and hands
`ca.key` — and `mongod`'s private key — to the `bot` container, which is the one
with a route to the internet. Neither has any reader there. If you add a
container that talks to `mongod`, give it `ca.crt` and nothing else;
`tests/deployStackParity.test.js` fails on a directory mount or a mounted
`ca.key` in either stack file.

**3. Point the clients at it, before `mongod`.** In `.env` or the stack
environment:

```bash
MONGODB_CLIENT_TLS_ARGS=--tls --tlsCAFile /etc/mongo-tls/ca.crt
MONGODB_URI=mongodb://clawdia:<app-password>@mongodb:27017/ultrabot?authSource=ultrabot&tls=true&tlsCAFile=/etc/mongo-tls/ca.crt
```

**4. Then turn `mongod` over**, in the same edit:

```bash
MONGODB_TLS_ARGS=--tlsMode requireTLS --tlsCertificateKeyFile /etc/mongo-tls/server.pem --tlsCAFile /etc/mongo-tls/ca.crt --tlsAllowConnectionsWithoutCertificates
```

```bash
docker compose up -d --force-recreate
```

The last flag is not a weakening and not optional. Naming a CA file is what lets
`mongod` validate the certificate it presents to *itself* over the replication
connection — a single-node replica set still opens one — and it is also what
makes `mongod` start demanding a certificate from every client. None of the four
clients has one, because this is server authentication, not mutual TLS. Without
that flag the CA file turns every client connection away.

The ordering above is the safe one, but it is not load-bearing, because the
healthcheck is: `mongod`'s probe is a `mongosh` carrying
`MONGODB_CLIENT_TLS_ARGS`, so a `mongod` that requires TLS and a probe that was
not told never reports healthy — and the bot and the `backup` service both wait
on `service_healthy`. A half-configured deployment stalls with a red container
instead of starting the bot against a database it cannot reach. The one gap that
guard does not cover is `MONGODB_URI`: forget the options there and `mongod` goes
green while the bot fails to connect, which is why it belongs in step 3 rather
than being left for later.

Check it took:

```bash
docker exec -it clawdia-mongodb mongosh --tls --tlsCAFile /etc/mongo-tls/ca.crt \
  --quiet --eval 'db.adminCommand({ getParameter: 1, sslMode: 1 })'
```

**Turning it back off** is the reverse order — clear `MONGODB_TLS_ARGS` first,
recreate, then clear the two client settings — and no data is touched either way.

#### The expiry date

This is the part that decides whether the whole thing was worth having on. A
`mongod` that stops accepting connections at midnight on a date nobody recorded
is a worse outage than the cleartext it was turned on to prevent, and a
self-signed CA is very easy to leave un-rotated.

Two things are done about it. The lifetimes are deliberately long — ten years for
the CA, five for the server certificate — because a private CA on an
internal-only network gains nothing from short rotation; there is no revocation
path here that would make it meaningful, and every month shaved off is a month
closer to that outage. And the script will tell you where you stand:

```bash
./scripts/mongo-tls-cert.sh --check              # prints the days remaining
```

It exits non-zero under 60 days (`MONGO_TLS_WARN_DAYS`) and reports to
`ERROR_WEBHOOK_URL` — the same sink the bot posts crashes to and
`verify-backup.sh` posts failures to — so it belongs in the host crontab beside
that one:

```bash
0 6 * * *  cd /opt/clawdia && ./scripts/mongo-tls-cert.sh --check >> /var/log/clawdia-tls.log 2>&1
```

**Renewing the server certificate** is the same script against the same
directory. It reuses the existing CA rather than minting a new one — a new CA
would mean re-distributing `ca.crt` to all four containers, which is exactly the
step someone renewing in a hurry skips — so only `server.pem` changes, nothing
else has to be touched, and `mongod` keeps serving the old certificate until it
is restarted:

```bash
./scripts/mongo-tls-cert.sh
docker compose up -d --force-recreate mongodb
```

If the CA has less time left than the five years a server certificate normally
gets, the new certificate is capped at whatever the CA has and the script says
so. That is not a limitation being worked around: a certificate is only good for
as long as the CA above it, and every client rejects the chain on the CA's date
whatever the leaf's own dates claim. A certificate issued for longer would be
lying about when it stops working.

**Rolling the CA over** is the other half, and it is a different job: it replaces
the trust material every client holds, so it cannot be done one container at a
time. The script refuses to issue against a CA with less than
`MONGO_TLS_WARN_DAYS` left and points here. With a ten-year CA this should
happen roughly never, which is exactly why it is worth having written down:

```bash
# 1. Mint a new CA and a server certificate under it. This overwrites ca.crt,
#    ca.key and server.pem in place; keep a copy of the old ca.crt if you want
#    a way back before step 3.
./scripts/mongo-tls-cert.sh --new-ca

# 2. On a Portainer host, copy the new ca.crt and server.pem to wherever the
#    mounts point (the mounted paths do not change, so the stack file does not).

# 3. Recreate every container with a mongo-tls mount, together. A client still
#    holding the old ca.crt refuses the new certificate, so a rolling restart
#    is an outage taken one container at a time instead of once.
docker compose up -d --force-recreate mongodb mongo-replset-init bot backup
```

There is no revocation here, so the old CA stops mattering the moment nothing
holds it any more. Delete the copy you kept once the stack is up and
`./scripts/mongo-tls-cert.sh --check` is green.

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

### Knowing When Backups Stop

A backup that fails is worth nothing and looks like nothing: the loop used to
log `[backup] FAILED` and sleep until the next day, and with no healthcheck on
the container, `docker ps` and every Portainer dashboard went on reporting it
`Up`. Three things now make that visible.

**The container reports unhealthy.** Its healthcheck asserts an artifact, not a
process — a run that finished *and* was read back in the last 26 hours. The
process is a `sleep` and survives every failure it can have, so liveness would
never have caught this. If you run the optional `autoheal` service, note that
the backup container deliberately does not carry the `autoheal` label: restarting
it mid-dump would not help.

**Every archive is read back before it counts.** `mongodump` exiting 0 says the
command ran, not that what it wrote is usable — a dump truncated by a full disk
is the failure that stays hidden until the restore. Each new archive is parsed
with `mongorestore --dryRun`, which writes nothing; one that fails is renamed to
`clawdia-<timestamp>.gz.unverified` so neither the healthcheck nor
`verify-backup.sh --latest` mistakes it for the day's backup. It is still pruned
on the normal retention schedule.

**Failures post to `ERROR_WEBHOOK_URL`.** The same sink the bot sends crashes to,
the same shapes — a Discord webhook URL gets a Discord message, anything else
gets flat JSON — and the same rule about which URLs are usable at all:
`https://` anywhere, `http://` only to loopback (`localhost`, `127.0.0.1`,
`[::1]`). Anything else is refused rather than downgraded, with a line in the log
saying so; the report names a database host and an archive path, and over
cleartext to a third party that is readable on the wire. Unset — the default —
the loop logs and does nothing more.

Two files in the backup directory carry the state, both readable from the host:

| File | What it holds |
| --- | --- |
| `.backup-status` | `ok`, `dump-failed` or `verify-failed`, with the timestamp and archive |
| `.backup-ok` | empty; its mtime is the last good run, and is what the healthcheck reads |

A dump that fails part-way leaves whatever it had written behind — `mongodump`
has no rollback — so that file is renamed `.gz.unverified` too. Under its real
name it would be exactly what the catch-up and `--latest` reach for: a failure
that reads as a success.

A container that was down at 03:00 — a host reboot, an image pull, a stack
redeploy — no longer skips the day in silence: on boot, if the newest archive is
over 24 hours old, it dumps immediately rather than waiting.

### Encrypting the Archives

`mongodump --gzip` is compression, not encryption. Every archive in the backup
directory is a readable copy of the whole database, and thirty days of them sit
beside the volume the database itself lives in — so "you need database access to
read this" quietly means "you need read access to `./backups`", which is a much
lower bar.

Set a passphrase and each archive is sealed with AES-256-CBC (PBKDF2, 200,000
iterations) and named `clawdia-<timestamp>.gz.enc`:

```bash
openssl rand -base64 32
```

```env
BACKUP_ENCRYPTION_PASSPHRASE=the_generated_value
```

Recreate the stack and the next run writes a sealed archive. Nothing else
changes: the retention window prunes `.gz.enc` on the same schedule, the boot
catch-up counts one as the day's backup, and the healthcheck reads the same
marker. Existing plain `.gz` archives are left alone and age out normally.

Three things are worth knowing:

- **The dump never touches the archive directory in the clear.** `mongodump`
  writes into the container's own `/tmp` and only the sealed file is moved into
  `./backups` — not even for the seconds in between, because that directory
  being readable is the whole premise.
- **The archive that is kept is the one that is verified.** Each night's archive
  is decrypted and then parsed with `mongorestore --dryRun`, so an archive that
  will not open is found the night it is taken rather than on the day you need
  it. One that fails either step is quarantined as `.gz.enc.unverified` and does
  not count as that day's backup.
- **Keep the passphrase somewhere other than `./backups`.** A passphrase stored
  beside the archives it protects protects nothing. It is also not recoverable:
  without it those archives cannot be read, so keep it for at least as long as
  the oldest archive you would ever restore.

If the passphrase is set and `openssl` is missing from the image, the backup
container exits at boot rather than writing plaintext — an operator who believes
the archives are encrypted and gets readable ones is worse off than one who
never asked.

`scripts/backup.sh`, `scripts/restore.sh` and `scripts/verify-backup.sh` all
read `BACKUP_ENCRYPTION_PASSPHRASE` from `.env` and handle either form, so the
commands below are the same whichever way the archives are written.

This is the archive half of the exposure; `SECRET_ENCRYPTION_KEY` ("Encrypting
stored provider keys" above) is the credential half, and it is the one to set
first — it is the difference between a leaked archive costing you your own data
and costing your users their provider bills.

### Off-site Backups

The archives and the database they protect share a host. That covers a bad
migration, an accidental delete or a botched deploy; it covers nothing about
losing the machine. A failed disk, a wiped VPS or a mistaken
`docker volume prune` takes the database *and* every backup of it in one event.

`scripts/offsite-sync.sh` copies the archive directory to any
[rclone](https://rclone.org/) remote — S3, B2, Backblaze, a box in another
building, anything rclone speaks:

```bash
rclone config                                   # once, on the host
```

```env
BACKUP_REMOTE=s3:my-bucket/clawdia
```

```cron
17 * * * *  cd /opt/clawdia && ./scripts/offsite-sync.sh >> /var/log/clawdia-offsite.log 2>&1
```

Hourly is plenty — the archives are written once a day — and a failure posts to
`ERROR_WEBHOOK_URL` like the backup container's own, so a sync that has been
failing for a month is not something you find out about during the restore.

It is a host script rather than a service in the stack for the same reason
`verify-backup.sh` is: what it needs — a remote, its credentials, a network path
off the host — is yours to configure, and a stack service that cannot work until
you have would just be a container in a crash loop.

Two deliberate choices in it:

- **It copies, it does not mirror.** `rclone sync` would propagate deletions,
  which sounds right until the thing that empties `./backups` is exactly the
  event this exists for — and the next run empties the off-site copy too.
  Expiry belongs to the remote's own lifecycle policy, where deleting is
  something somebody configured on purpose.
- **It does not upload unencrypted archives.** Sending a readable copy of the
  database to a third party is a wider exposure than the one off-site
  replication closes, not a narrower one. Plaintext archives are skipped with a
  line saying how many — the bot's own `pre-migration-*.gz` dump has no
  passphrase to seal it with, so one turns up after every irreversible migration
  and stays for the retention window, and refusing the whole run over it would
  take the off-site copy away for a month. A run that would send *nothing* is
  refused instead, which is what an install with no
  `BACKUP_ENCRYPTION_PASSPHRASE` gets. Set
  `BACKUP_REMOTE_ALLOW_PLAINTEXT=true` only when the remote encrypts for you —
  an rclone `crypt` remote, or a bucket with SSE-KMS.

On a Portainer stack the archives are in a named volume rather than a checkout,
so point the script at a directory the volume is mounted into, or run the same
`rclone copy` from a container that mounts it.

Whatever you use, the rule is the same one that applies to the passphrase: the
off-site copy has to be somewhere that losing this host does not also lose.

### Backup on Demand

```bash
./scripts/backup.sh              # → ./backups/clawdia-<timestamp>.gz
```

It uses `mongodump` if it is on `PATH` and otherwise runs it inside the
`clawdia-mongodb` container, so it works whether or not the host has the mongo
tools installed. With `BACKUP_ENCRYPTION_PASSPHRASE` set it seals the archive
the same way the nightly service does and writes `clawdia-<timestamp>.gz.enc`,
so a dump taken by hand does not become the one readable copy in a directory of
encrypted ones.

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

This is the deeper check, and it is the one to schedule. The backup container
proves each archive *parses*; only a real restore proves it *restores*, and that
needs write access to a second database — which the backup container is
deliberately not given (its MongoDB user has `readWrite` on the bot's database
and nothing else). So it runs from the host, weekly is plenty:

```cron
0 4 * * 1  cd /opt/clawdia && ./scripts/verify-backup.sh --latest >> /var/log/clawdia-verify.log 2>&1
```

It exits non-zero if any collection comes back short or empty, and a failing run
posts to `ERROR_WEBHOOK_URL` the same way the backup container does — so a
scheduled run that starts failing is not something you have to go and read a log
file to discover. Run it after any change to the backup service too.

### Restore Database

```bash
./scripts/restore.sh ./backups/clawdia-<timestamp>.gz          # merge
./scripts/restore.sh ./backups/clawdia-<timestamp>.gz --drop   # clean restore
./scripts/restore.sh ./backups/clawdia-<timestamp>.gz.enc      # sealed archive
```

A `.gz.enc` archive is decrypted into a private temp directory first — never
beside the archive — and that copy is removed when the script exits, however it
exits. It needs `BACKUP_ENCRYPTION_PASSPHRASE`, which it reads from `.env`.

Both forms prompt for confirmation first. Verify the archive with
`scripts/verify-backup.sh` before running this against a live database.

## Troubleshooting

### Bot Not Responding

1. Check bot is online in Discord
2. Verify `DISCORD_TOKEN` is correct
3. Check intents are enabled in Discord Developer Portal
4. View logs: `docker logs clawdia`

### Slash Commands Not Appearing

The bot publishes them itself at startup — check the log for a
`[READY] Deployed N slash commands` line, and that the invite used the
`applications.commands` scope. Newly registered global commands can take up to
an hour to appear. `npm run deploy` re-publishes them by hand;
`DEPLOY_COMMANDS=always` makes the bot re-publish on every boot rather than
only when the set changes.

### Dashboard Not Loading

1. Check port 3000 is accessible
2. Verify `DASHBOARD_URL` matches your domain
3. Check MongoDB is running: `docker ps`
4. Verify `MONGODB_URI` is reachable from the container network and that `.env`
   is mounted where the stack expects it

### AI Not Working

1. Verify API key is correct
2. Check you have credits/quota remaining
3. Try switching providers (OpenAI ↔ Gemini)
4. Check logs for specific error messages
5. On Ollama, check the endpoint is reachable from the bot's container — a
   timeout here is usually a host address the container cannot resolve

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
- Set `SECRET_ENCRYPTION_KEY`. Without it the AI provider keys server admins
  enter in the dashboard, and the MCP OAuth refresh tokens, are plaintext in the
  database and in every nightly dump in `./backups` — a rolling month of live
  credentials that bill someone else's account. A production boot without it
  warns. See
  [Encrypting stored provider keys](#encrypting-stored-provider-keys)
- Set `BACKUP_ENCRYPTION_PASSPHRASE` so the archives themselves are ciphertext,
  not just the credentials inside them. See
  [Encrypting the Archives](#encrypting-the-archives)
- Keep a copy of the archives off the host, so losing the machine does not lose
  the backups with it. See [Off-site Backups](#off-site-backups)
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