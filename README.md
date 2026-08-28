# Clawdia

A chill, self-hosted Discord bot with serious teeth — no cloud lock-in, no per-server pricing.

By volume, Clawdia is an **economy/RPG bot**: 43 of her 98 commands and about a
third of the code are the coin economy, the gathering and crafting loop, and the
progression systems stacked on top of them. Around that sits a full
server-management suite — moderation with a case system, leveling, welcome
cards, AI chat, RSS digests, and a dashboard that configures all of it.

If you want a lean moderation bot, Clawdia will do the job, but you will be
running a lot of code you don't need. If you want a server-wide game with
moderation attached, that is what she is built for.

## Shape of the codebase

| Area | Commands | Lines |
|---|---:|---:|
| Economy / RPG | 43 | 22,572 |
| Utility | 14 | 1,479 |
| Moderation | 16 | 1,076 |
| Fun | 8 | 1,354 |
| Community | 7 | 1,122 |
| Admin | 2 | 507 |
| Leveling | 4 | 486 |
| AI | 4 | 332 |

`/fish` alone is 3,190 lines — more than the moderation, leveling, AI, and admin
command sets put together.

## Features

### The game layer

- **Core economy**: Balance, bank, daily/work/crime/rob, item shop, inventory, gifting, and a player-to-player market
- **Gathering & crafting**: `/fish`, `/hunt`, `/mine`, material tiers, crafting, and AI-forged one-off items
- **Exploration**: Narrated expeditions across gated regions, with relics, landmarks, and secrets
- **Pets**: Adopt, name, feed, and grow companions that feed back into the gathering loop
- **Group & PvP**: Syndicates, group heists, duels, server-vs-server wars, and rob protections
- **Progression**: Prestige tiers, season pass, quests, achievements, cross-system synergies, and daily challenges
- **Casino**: Blackjack, crash, cup game, higher-lower, keno, poker, roulette, slots, and a progressive jackpot
- **Seasonal events**: Event shop, event currency, and per-event commands and regions

### Server management

- **Moderation**: Ban, kick, warn, mute, timeout, clear, lockdown, and slowmode, plus a case system with appeals and mod notes
- **Auto-Moderation**: Spam, invite, link, profanity, caps, emoji, mention, and zalgo filtering
- **Raid Detection / Anti-Nuke**: Join-rate thresholds with automatic response
- **Welcome/Farewell**: Customizable messages with generated image cards
- **Leveling System**: XP and level tracking with rank cards and leaderboards
- **Web Dashboard**: Full-featured admin dashboard, per server

### Content & extras

- **AI Chat**: OpenAI GPT, Google Gemini, Anthropic Claude, OpenRouter, or optional local Ollama
- **AI Dungeon Master**: `/dm` runs a collaborative text RPG in a channel
- **RSS Feeds**: Automatic RSS feed monitoring and posting
- **Daily News Digest**: Compile multiple RSS feeds into a daily summary
- **Server Newspaper**: AI-written recap of recent server activity
- **Reminders**: Relative, absolute, and recurring, with per-user timezones
- **Server Insights**: Net-retention proxy, active-hours histogram, channel hotspots, mod resolution-time trends, and newcomer conversion

## Prerequisites

- Node.js 24.19+
- MongoDB (local or cloud)
- Discord Application with Bot & OAuth2 scopes enabled
- (Optional) An AI provider — OpenAI, Google Gemini, Anthropic, or OpenRouter API key, or a local Ollama instance

## Quick Start with Docker (Portainer)

1. Clone the repository
2. Create a `.env` file based on `.env.example`
3. Add your Discord bot token and other credentials
4. Import the `docker-compose.yml` in Portainer or run:

```bash
docker-compose up -d
```

That is the whole deploy. In particular there is no separate command-registration
step: the bot publishes its slash commands to Discord itself when it connects,
and re-publishes only when the command set has actually changed — so a restart
costs nothing and an upgrade that adds a command needs no extra action. Global
commands can take up to an hour to appear in every server the first time.
`DEPLOY_COMMANDS` below turns that off if you would rather drive it by hand.

Schema migrations run on boot too, before the dashboard opens its port. Some are
irreversible; see [Schema migrations](SETUP_GUIDE.md#schema-migrations) before
the first upgrade of a deployment with data in it.

## Manual Installation

```bash
npm install
npm run deploy  # Optional: publish the slash commands now, without starting
npm start
```

`npm run deploy` is the manual path — useful while developing a command, or to
re-publish after `DEPLOY_COMMANDS=never`. It is not a prerequisite for
`npm start`, which registers them itself.

### Sharding

`npm start` runs one process with one gateway connection, and is the default.
Discord suggests preparing for sharding as you approach 2,000 guilds, and
**requires** it at 2,500 or more — past that the gateway refuses an unsharded
IDENTIFY outright:

```bash
npm run start:sharded          # Discord's recommended shard count
SHARD_COUNT=2 npm run start:sharded
```

Each shard is its own process. Discord routes a guild's events to exactly one of
them, which is what keeps the live multiplayer rounds — crash lobbies, heists,
the raid join window — correct without persisting them. Work that must happen
once per deployment rather than once per shard runs on shard 0 only: the
dashboard, schema migrations, and the cron scheduler. `src/utils/sharding.js`
has the full reasoning.

## Development

```bash
npm test                       # Jest, ~20s
npm run lint                   # ESLint (flat config, eslint.config.js)
npm run lint:fix               # …and apply what it can fix
npm run format -- <paths>      # Prettier, on the files you name
npm run docs:commands          # Regenerate README's command list from the code
npm run docs:api               # Regenerate API_REFERENCE's endpoint tables from the routers
```

CI runs the tests and the lint, and the Docker image is only published when
both pass.

`npm run docs:commands` rewrites the **Commands** block below from the command
set the bot loads — the same catalog `/help` renders. A test compares the two,
so adding or renaming a command turns `npm test` red until the block is
regenerated. `npm run docs:api` does the same for the endpoint tables in
[API_REFERENCE.md](API_REFERENCE.md), reading them off the routers in
`src/dashboard/routes/api/`; [docs/EXTENDING.md](docs/EXTENDING.md) is the guide
to adding a command, a route or a model in the first place.

`npm run format` takes explicit paths on purpose. Prettier's settings match the
style the tree is already written in, but it has never been applied wholesale —
doing that rewrites ~45,000 lines and every `git blame` with them — so run it on
the files a change already touches.

## Configuration

1. Invite the bot to your server
2. Visit the dashboard at `http://localhost:3000`
3. Login with Discord OAuth2
4. Select your server and configure modules

## Environment Variables

- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Discord application client ID
- `CLIENT_SECRET` - Discord OAuth2 client secret
- `MONGODB_URI` - MongoDB connection string (required)
- `DASHBOARD_PORT` - Web dashboard port (default: 3000)
- `DASHBOARD_URL` - Public URL for the dashboard
- `SESSION_SECRET` - Random string for session encryption
- `SECRET_ENCRYPTION_KEY` - (Optional, recommended) Encrypts the per-server AI provider keys that admins enter in the dashboard, so database backups hold ciphertext rather than live credentials. Generate with `openssl rand -base64 32`; keep it, because the stored keys cannot be read back without it. See [SETUP_GUIDE.md](SETUP_GUIDE.md#encrypting-stored-provider-keys)
- `OPENAI_API_KEY` - (Optional) OpenAI API key for AI features
- `GEMINI_API_KEY` - (Optional) Google Gemini API key for AI features
- `ANTHROPIC_API_KEY` - (Optional) Anthropic Claude API key for AI features
- `OPENROUTER_API_KEY` - (Optional) OpenRouter API key for AI features
- `OLLAMA_BASE_URL` - (Optional) Local Ollama endpoint (e.g., `http://localhost:11434`). This is the operator's endpoint: a base URL a server admin types into the dashboard is only allowed to reach a private or internal address if it matches this value (or the `localhost:11434` default), so set it when Ollama runs somewhere on your LAN or compose network
- `MCP_SERVERS_CONFIG` - (Optional) Path to the MCP server list (default: `config/mcp-servers.json`)
- `MCP_ALLOW_GUILD_SERVERS` - (Optional) Set to `false` to disable dashboard-managed MCP servers
- `IMGFLIP_USERNAME` / `IMGFLIP_PASSWORD` - (Optional) Imgflip credentials for `/meme` command
- `LOG_LEVEL` - (Optional) `trace`, `debug`, `info` (default), `warn`, `error`, `fatal` or `silent`. See [Logging](#logging)
- `LOG_FORMAT` - (Optional) `json` or `pretty`. Defaults to `json` when `NODE_ENV=production`, `pretty` otherwise
- `ERROR_WEBHOOK_URL` - (Optional) Where to send an uncaught exception or unhandled rejection, on top of logging it. Must be `https://`, or `http://` to loopback. A Discord webhook URL is recognised and formatted for Discord; anything else receives a flat JSON event. Unset, nothing is sent and the crash path behaves exactly as before
- `ERROR_REPORT_TIMEOUT_MS` - (Optional) How long the process waits for that POST before exiting anyway (default 2000)
- `DEPLOY_COMMANDS` - (Optional) `auto` (default — publish the slash commands at startup, but only when the set changed), `always`, or `never`
- `MIGRATION_TIMEOUT_MS` - (Optional) Per-migration wall-clock budget in milliseconds (default 30000)
- `MIGRATION_BACKUP` - (Optional) `require` to abort startup rather than run an irreversible migration without a `mongodump` first; `skip` to not attempt one. Unset, it is attempted and a failure is a loud warning. See [Schema migrations](SETUP_GUIDE.md#schema-migrations)
- `BACKUP_RETENTION_DAYS` - (Optional) Days of nightly `mongodump` archives to keep (default 30)
- `SHARD_COUNT` - (Optional) Pin a shard count for `npm run start:sharded`; unset takes Discord's recommendation

## Commands

<!-- BEGIN GENERATED COMMANDS — npm run docs:commands -->

_Generated by `npm run docs:commands` from the loaded command set — 98 entries. Edit the commands, not this list._

### 📦 Economy

- `/balance` — Check your wallet and bank balance, or look up another member's balance.
- `/bank` — Manage your bank: deposit, withdraw, or transfer coins
- `/boost` — Manage server-wide economy boosts (Admin only)
- `/casino` — Play casino games: blackjack, crash, cupgame, higherlower, keno, poker, roulette, slots.
- `/craft` — Craft items from hunting, fishing, or mining materials
- `/crime` — Choose a crime and attempt it for coins. Higher risk = higher reward. Cooldown: 1.5h.
- `/daily` — Claim your daily coin reward (amount set by server admins, default 100). Resets every 24 hours.
- `/dailychallenge` — View and claim your Prestige VI+ Daily Challenge board bonus.
- `/duel` — Challenge another user to a coin-bet duel
- `/eventshop` — Browse and purchase items with your event currency
- `/explore` — World exploration: set out into the wilds, chart your map, and find what hides there.
- `/featured` — Today's featured rotation — +25% payout and +10% rare chance on each highlighted option.
- `/fish` — Fishing: cast lines, manage gear, shop, craft, quests, locations, and prestige.
- `/forge` — Spend coins to have the AI forge a unique, one-of-a-kind item just for you
- `/gift` — Send coins or an item from your inventory to another user.
- `/heist` — Plan and execute a strategic group heist.
- `/hunt` — Hunt animals, manage gear, quests, zones, and prestige — all in one place
- `/inventory` — View your or another user's inventory
- `/invest` — Contribute coins to server districts and unlock server-wide benefits.
- `/jobs` — Browse all available jobs, their tiers, and pay ranges
- `/lovenote` — Send a love note into the Arcade and see what comes back! Valentine's Day only.
- `/market` — Server player-to-player item marketplace.
- `/mine` — Mining: dig, profile, inventory, quests, and shop.
- `/pet` — Manage your pets.
- `/prestige` — Account-level prestige — reset your level for permanent rewards and unlocks.
- `/quiz` — Answer a trivia question to win coins — or lose some if you're wrong!
- `/rob` — Try to rob another member's wallet. Success is affected by tools and protection.
- `/robstatus` — Spy on a target's active rob protections before committing to a heist.
- `/sandcastle` — Build a sandcastle on the shore! Summer Festival only.
- `/season` — Season pass and economy season commands.
- `/shop` — Browse and buy items from the server shop
- `/showcase` — Display a player's trophy card — rarest items and top achievements.
- `/snowball` — Throw a snowball at another user! Only available during Winter Wonderland.
- `/syndicate` — Crime syndicate system — cooperative heists, territory, and rivalry.
- `/synergies` — View all cross-system synergy bonuses and your progress toward unlocking them
- `/trackhunt` — Track game across the Arctic Tundra! The Winter Hunt only.
- `/trap` — Set a hidden tripwire on your wallet. Triggers if someone successfully robs you.
- `/trickortreat` — Knock on a spooky door for candy or consequences! Spooky Season only.
- `/use` — Use an item from your inventory
- `/war` — Server vs server war events.
- `/winfeed` — See the last 20 big wins in this server (50k+ coins or legendary drops).
- `/work` — Earn coins by working a shift (25–400/tier). Cooldown: 1h. More shifts unlock better jobs.

### 🛡️ Moderation

- `/appeal` — Appeal a moderation case against you
- `/ban` — Ban a member from the server
- `/case` — View a moderation case
- `/cases` — List moderation cases for a user
- `/clear` — Delete multiple messages
- `/closecase` — Close a moderation case
- `/kick` — Kick a member from the server
- `/lockdown` — Lock or unlock all text channels server-wide
- `/massban` — Ban multiple users by ID — useful for raid cleanup
- `/mute` — Timeout a member
- `/note` — Add a note to a case, or assign/label it
- `/slowmode` — Set or clear the slowmode for a channel
- `/softban` — Ban then immediately unban a member to purge their recent messages
- `/unban` — Unban a user from the server
- `/unmute` — Remove timeout from a member
- `/warn` — Manage member warnings

### ⭐ Leveling

- `/leaderboard` — View the top 10 members on the server leaderboard.
- `/rank` — View your rank card showing level, XP, and server position.
- `/setlevel` — Directly assign a level to a member (admin use / MEE6 migration)
- `/xpinfo` — See which channels and roles are excluded from XP gain in this server.

### 🎮 Fun

- `/8ball` — Ask the magic 8-ball a yes/no question
- `/achievement` — Display a Minecraft-style achievement popup with custom text
- `/caption` — Add a caption to any image URL
- `/coinflip` — Flip a coin — for fun, for coins, or against another member.
- `/meme` — Generate a classic meme using a popular template
- `/roll` — Roll a die
- `/wanted` — Generate a Wild West "Wanted" poster with a user's avatar
- `/wasted` — Overlay the GTA "Wasted" screen on a user's avatar

### 🔧 Utility

- `/avatar` — Fetch and display a user's full-size avatar image.
- `/bible` — Look up a Bible verse or get today's daily verse
- `/birthday` — Manage birthdays
- `/giveaway` — Manage giveaways
- `/help` — Browse all bot commands by category
- `/ping` — Check the bot's latency
- `/poll` — Create a button-based poll
- `/profile` — View a unified profile card showing all your key stats.
- `/role` — Self-assign or remove a role from the server reaction role panels
- `/serverinfo` — Display server stats: member count, channels, roles, boost level, and creation date.
- `/suggest` — Submit a suggestion to the server
- `/timezone` — Set your timezone so reminders and times are computed correctly for you
- `/userinfo` — Show username, ID, account age, server join date, nickname, and role count for a user.
- `/vc` — Manage your temporary voice channel

### 🤖 AI

- `@Clawdia` — Mention or ping the bot to start an AI conversation
- `/ai` — AI assistant utilities
- `/dm` — AI Dungeon Master — run a collaborative text RPG
- `/remind` — Set a reminder — posted in this channel when it fires. Combine minutes, hours, and/or days.
- `/reminders` — View or cancel your open reminders

### 👥 Community

- `/achievements` — View achievements and claim rewards
- `/newspaper` — Server newspaper commands.
- `/notifications` — Manage your personal notification preferences.
- `/questgen` — Spend 200 coins to have the AI forge you a unique Legendary Quest
- `/quests` — View your active daily and weekly quests
- `/streak` — View the server streak leaderboard or a user's streak
- `/track` — View or set your progression track

### ⚙️ Admin

- `/event` — Manage limited-time events
- `/raidmode` — Configure raid detection and case management settings

<!-- END GENERATED COMMANDS -->

Configuration that previously lived behind slash commands (settings link, level roles, starboard, escalation ladder, daily news scheduling and manual trigger) is now in the web dashboard.

## Tech Stack

- Node.js
- Discord.js v14
- MongoDB with Mongoose
- Express.js
- Passport (Discord OAuth2)
- Pino (structured logging)
- OpenAI API / Google Gemini API / Anthropic Claude API / Ollama (optional)
- RSS Parser
- Canvas (Image generation)

## AI Chat Configuration

Five providers are supported, and MCP connections work with all of them. For
what actually differs — how each reaches MCP, cost tracking, model naming — see
[AI_COMPARISON.md](AI_COMPARISON.md).

### Supported Providers

1. **OpenAI**
   - Get your API key from https://platform.openai.com/
   - Add to `.env` as `OPENAI_API_KEY` or configure per-server in dashboard

2. **Google Gemini**
   - Get your API key from https://makersuite.google.com/app/apikey
   - Add to `.env` as `GEMINI_API_KEY` or configure per-server in dashboard

3. **Anthropic (Claude)**
   - Get your API key from https://console.anthropic.com/
   - Add to `.env` as `ANTHROPIC_API_KEY` or configure per-server in dashboard

4. **OpenRouter**
   - Get your API key from https://openrouter.ai/keys
   - Add to `.env` as `OPENROUTER_API_KEY` or configure per-server in dashboard
   - Reaches many models through one API; defaults to `openai/gpt-4o-mini`

5. **Local (Ollama)**
   - Point `OLLAMA_BASE_URL` to your local instance
   - Configure `OLLAMA_MODEL` in dashboard (e.g., `llama3.2`, `mistral`)
   - Ideal for private, zero-cost inference
   - The per-server base URL in the dashboard must be an `http(s)` address that
     does not resolve into private or reserved space — otherwise a server admin
     could aim the bot at anything reachable from its container. Your own
     endpoint is exempt: set it as `OLLAMA_BASE_URL`

### MCP Servers

The bot can call tools on remote [MCP](https://modelcontextprotocol.io) servers
— a GitHub repo, a calendar, an internal docs search. **Whichever model you
selected in the Chat tab is the one that uses them.** With Claude the server
list travels on the request and Anthropic opens the connections; with OpenAI,
Gemini, Ollama or OpenRouter, Clawdia is the MCP client — it lists each server's
tools, offers them to the model as functions, runs the calls and feeds the
results back. On that second route the model itself has to support tool calling,
which every current OpenAI and Gemini model does and some Ollama models do not.

While a tool is running the reply names it — with how far it has got, for a
server that says — and the finished message keeps a short summary of what ran,
how long it took and anything that failed or could not be reached, so a slow
answer is legible and a server that is down is visible rather than silently
making the model wrong.

The per-user rate limit bounds tool calls as well as messages, in a window of
its own: eight calls for every message the limit allows, shared across that
window rather than reset per message. So one question that needs a lot of
looking up does not eat the allowance for the next one, and a user cannot spend
without bound by asking the same expensive question over and over. Past it the
model is told the call was refused and answers from what it has.

Tools that write something wait for a person: the Approval setting posts
**Run it** / **Cancel** in the channel for a tool call and does not run it until
the person who asked, or anyone who can manage the server, says so. Adding a
first connection turns that on for writes, since connecting a server is not by
itself consent to unattended ones.

It runs the other way too. A tool that gets halfway and needs one more fact can
ask, and the question appears in the channel as a form to fill in — bounded to
two questions a reply, and labelled with which server is asking, because a real
one will not ask for a password or a key. The Connections tab also keeps a
seven-day rollup of what each connection has been doing — calls, failures,
refusals, latency and the last error.

Approvals and that rollup both need the bot to be the one making the call, which
on Claude it is not by default — Anthropic's connector opens the connections on
their side. Turning approvals on switches Claude to the bot's own MCP client
automatically, and the route is settable either way if you would rather choose.

`/ai mcp` answers the same questions from a channel — which connections exist,
what tools they offer, whether one still works, and what they have been doing.
It needs Manage Server and replies privately. A tool that answers with an image
or a PDF has it posted to the channel rather than dropped.

Tools are one third of MCP, and the other two thirds have homes here too. A
connection can have **Use its documents as knowledge** switched on, which turns
its resources into a second knowledge base: the bot scores them against whatever
somebody just asked, reads the closest few and puts them in the prompt beside the
entries an admin typed in — kept current by whoever owns the documents rather
than by whoever remembered to paste them. And a server's **prompts** — named
templates taking arguments, written by the people who run it — are runnable from
Discord: `/ai mcp prompts` lists them, `/ai mcp prompt name:docs/review
arguments:pr=412` fills one in and answers with it. Both of those are open to
any member, under the same per-user limits a chat message has.

**From the dashboard** (AI → 🔌 Connections): pick a service or paste any https
MCP endpoint, add a token, and optionally list the tools the model may or may
not call. GitHub, Fastmail, DeepWiki, Context7, Hugging Face and Stripe come as
presets; Gmail and Spotify are prefilled except for the address, since neither
publishes a hosted endpoint and the server is one you run. Anything else is a
URL away. A **Test** button connects to the server and
reports the tools it offers — no AI provider key needed, no tokens spent.
Tokens are write-only — once saved they are never sent back to the browser.

**From a config file** for servers that apply to every Discord server, at
`config/mcp-servers.json`:

```json
{
  "servers": [
    { "name": "docs", "url": "https://mcp.example.com/docs" },
    {
      "name": "calendar",
      "url": "https://mcp.example.com/calendar",
      "authorization_token": "${CALENDAR_MCP_TOKEN}",
      "blocked_tools": ["delete_event"]
    }
  ]
}
```

Tokens written as `${VAR}` in the file resolve from the environment, so it holds
no secrets of its own. With neither source configured, requests are exactly what
they were before — no tools are offered at all. See
[SETUP_GUIDE.md](SETUP_GUIDE.md#mcp-servers) for the full field reference and
`MCP_ALLOW_GUILD_SERVERS`.

### Setup

1. Go to the dashboard AI Chat section
2. Select your preferred AI provider
3. (Optional) Add server-specific API keys or local endpoint
4. Choose a channel for AI chat
5. Customize the system prompt
6. Enable AI Chat

Members can chat with Clawdia in the designated channel or mention her anywhere.

## Insights Layer

Clawdia includes an **Insights** view in the dashboard focused on decisions
instead of raw event logs. It is derived from data the bot already collects —
member join/leave counts, command usage, and moderation cases — so the metric
definitions below matter. Read them before acting on a number.

### Key Metrics

- **Net Retention (7/30 days)**: `(joins − leaves) / joins`, clamped at 0, over the last 7 and 30 days of tracked member events. A guild-wide **proxy** — it does not follow individual members, so there is no D1 figure and no join-week segmentation.
- **Active Hours**: A 24-bucket histogram of command usage by hour, plus the top 5 hours. **Always UTC**; there is no server-timezone option and no weekday dimension.
- **Toxic Channel Detection**: Ranks up to 8 channels from the most recent 1,000 moderation cases, scored as `warns + (2 × severe)`, where severe is mute/kick/ban. Channels are resolved from case evidence jump URLs; cases without one are bucketed as `unknown`.
- **Moderator Resolution Time**: Median hours from case creation to case **resolution**, with a 6-month trend. This is time-to-close, **not** time-to-first-response.
- **Newcomer Conversion (7/30 days)**: Share of members whose record is at least 7 or 30 days old and who have reached 20+ messages or level 2+.

### Not implemented

Previously advertised here, and not built. These are open work, not wording gaps:

- **Retention cohorts** (D1/D7/D30 by join week) — needs per-member join dates retained over time; only aggregate join/leave counts are stored today
- **Weekday heatmaps and server-local timezones** for active hours — the histogram records the hour only, and renders UTC
- **First-response SLA** — needs a first-mod-action timestamp on cases, which is not currently recorded

## Daily News Digest

The Daily News feature compiles multiple RSS feeds into a single daily post.

### Setup

1. Go to the dashboard Daily News section
2. Enable Daily News Digest
3. Select a channel for posting
4. Set delivery time (24-hour format, e.g., `09:00`)
5. Add RSS feed URLs (one per line)
6. Configure title and max items per feed
7. Save settings

### Manual Trigger

Use the **Send digest now** button in the dashboard's Daily News panel.

## Logging

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
docker logs clawdia -f | npx pino-pretty
docker logs clawdia --since 1h | jq -c 'select(.level=="error")'
```

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

## Monitoring

The bot serves `GET /health` on the dashboard port. It is unauthenticated and
deliberately thin for anonymous callers — status and uptime, nothing else:

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

### Restarting an unhealthy container

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

## Troubleshooting

- **Slash commands not appearing**: The bot publishes them itself at startup — check the log for a `[READY] Deployed N slash commands` line, and that the invite used the `applications.commands` scope. Newly registered global commands can take up to an hour to appear. `npm run deploy` re-publishes them by hand; `DEPLOY_COMMANDS=always` makes the bot re-publish on every boot rather than only when the set changes.
- **Portainer/Docker startup fails**: Verify `MONGODB_URI` is reachable from the container network and `.env` is properly mounted.
- **AI commands timeout**: Check API key validity or Ollama endpoint accessibility from the bot container.

## License

MIT — see [LICENSE](LICENSE).
