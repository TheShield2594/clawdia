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

- Node.js 22.12+
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

## Manual Installation

```bash
npm install
npm run deploy  # Deploy slash commands globally
npm start
```

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
- `OPENAI_API_KEY` - (Optional) OpenAI API key for AI features
- `GEMINI_API_KEY` - (Optional) Google Gemini API key for AI features
- `ANTHROPIC_API_KEY` - (Optional) Anthropic Claude API key for AI features
- `OPENROUTER_API_KEY` - (Optional) OpenRouter API key for AI features
- `OLLAMA_BASE_URL` - (Optional) Local Ollama endpoint (e.g., `http://localhost:11434`)
- `IMGFLIP_USERNAME` / `IMGFLIP_PASSWORD` - (Optional) Imgflip credentials for `/meme` command

## Commands

### Moderation
- `/ban` - Ban a user
- `/kick` - Kick a user
- `/softban` - Ban and immediately unban (clears messages)
- `/massban` - Ban multiple users at once
- `/warn` - Warn a user
- `/mute` - Timeout a user
- `/unmute` - Remove timeout
- `/unban` - Unban a user
- `/clear` - Delete messages
- `/slowmode` - Set channel slowmode
- `/lockdown` - Lock a channel
- `/case` / `/cases` / `/closecase` - Case management
- `/appeal` - Submit a ban appeal
- `/note` - Add a moderator note to a user

### Economy — currency and items
- `/balance` - Check balance
- `/bank` - Manage your bank account
- `/daily` - Claim daily reward
- `/work` - Work for coins
- `/jobs` - View and take jobs
- `/crime` - Attempt a crime for coins
- `/rob` - Rob another user
- `/robstatus` - Spy on a target's active rob protections before committing
- `/trap set` / `/trap status` - Arm a hidden tripwire that fires when someone robs you
- `/shop` - Browse and buy items (`/shop buy`)
- `/inventory` - View your items
- `/use` - Use an item
- `/gift` - Send coins or an item to another user
- `/market` - Player-to-player marketplace (list, browse, buy, cancel)
- `/invest` - Fund server districts to unlock server-wide benefits
- `/boost` - Activate economy boosts
- `/featured` - Today's featured rotation (+25% payout, +10% rare chance)

### Economy — gathering, crafting, and exploration
- `/fish` / `/hunt` / `/mine` - Gathering activities
- `/craft` - Craft items from gathered materials
- `/forge` - Spend coins to have the AI forge a one-of-a-kind item
- `/explore` - Narrated expeditions across regions (go, travel, regions, journal, relics, profile, map)
- `/map` - Shortcut for `/explore map`
- `/pet` - Adopt, name, feed, rename, and release pets
- `/showcase` - Trophy card of a player's rarest items and top achievements

### Economy — competition and groups
- `/duel` - Challenge another user
- `/heist` - Plan and run a group heist
- `/syndicate` - Crime syndicates: create, join, leave, invite, kick, open, info, leaderboard, heist, sabotage, upgrade
- `/war` - Server-vs-server war events (admin to challenge/accept)
- `/casino` - Casino games and the progressive jackpot
- `/quiz` - Answer trivia for rewards
- `/winfeed` - Last 20 big wins in this server (50k+ coins or legendary drops)

### Economy — progression
- `/prestige` - Reset your level for permanent rewards and unlocks
- `/dailychallenge` - Prestige VI+ daily challenge board
- `/synergies` - Cross-system synergy bonuses and your progress toward them
- `/season` - View current season info

### Economy — seasonal
- `/eventshop` - Seasonal event shop
- `/trackhunt` - Track game across the Arctic Tundra (Winter Hunt only)
- `/sandcastle` - Build a sandcastle (Summer Festival only)
- `/lovenote` - Send a love note into the Arcade (Valentine's Day only)

### Leveling
- `/rank` - View rank card
- `/leaderboard` - View server leaderboard
- `/xpinfo` - View XP settings
- `/setlevel` - Set a user's level (admin)

### Community
- `/remind` - Set a reminder (relative or absolute time, optionally recurring)
- `/reminders` - List or cancel your open reminders
- `/timezone` - Set your timezone for accurate reminder times
- `/streak` - View your activity streak
- `/quests` - View active quests
- `/achievements` - View achievements
- `/season` - View current season info
- `/notifications` - Manage your notifications
- `/track` - Track events or milestones
- `/questgen` - Spend coins to have the AI generate a personal legendary quest
- `/newspaper` - Preview the AI-written server newspaper (Manage Server)

### Fun
- `/8ball` - Ask the magic 8-ball
- `/roll` - Roll a dice
- `/coinflip` - Flip a coin
- `/meme` - Generate a meme (requires Imgflip credentials)
- `/caption` - Add a caption to an image
- `/wanted` / `/wasted` - Image filter commands
- `/achievement` - Generate a fake achievement card
- `/snowball` / `/trickortreat` - Seasonal fun commands

### Utility
- `/avatar` - Get user avatar
- `/userinfo` - User information
- `/serverinfo` - Server information
- `/help` - Command list
- `/ping` - Bot latency
- `/poll` - Create a poll
- `/giveaway` - Manage giveaways
- `/birthday` - Set or view birthdays
- `/profile` - View your profile card
- `/role` - Self-assignable roles
- `/suggest` - Submit a suggestion
- `/vc` - Voice channel utilities
- `/bible` - Bible verse lookup

### AI
- `@Clawdia` - Mention the bot to start an AI conversation
- `/ai memories` - View and manage the facts Clawdia has pinned about you
- `/dm` - AI Dungeon Master: run a collaborative text RPG (start, join, begin, action, status, stop)

### Admin
- `/raidmode` - Configure raid detection and case management
- `/event` - Manage seasonal events

Configuration that previously lived behind slash commands (settings link, level roles, starboard, escalation ladder, daily news scheduling and manual trigger) is now in the web dashboard.

## Tech Stack

- Node.js
- Discord.js v14
- MongoDB with Mongoose
- Express.js
- Passport (Discord OAuth2)
- OpenAI API / Google Gemini API / Anthropic Claude API / Ollama (optional)
- RSS Parser
- Canvas (Image generation)

## AI Chat Configuration

### Supported Providers

1. **OpenAI (GPT-3.5/GPT-4)**
   - Get your API key from https://platform.openai.com/
   - Add to `.env` as `OPENAI_API_KEY` or configure per-server in dashboard

2. **Google Gemini**
   - Get your API key from https://makersuite.google.com/app/apikey
   - Add to `.env` as `GEMINI_API_KEY` or configure per-server in dashboard

3. **Anthropic (Claude)**
   - Get your API key from https://console.anthropic.com/
   - Add to `.env` as `ANTHROPIC_API_KEY` or configure per-server in dashboard

4. **Local (Ollama)**
   - Point `OLLAMA_BASE_URL` to your local instance
   - Configure `OLLAMA_MODEL` in dashboard (e.g., `llama3.2`, `mistral`)
   - Ideal for private, zero-cost inference

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

- **Net Retention (7/30 days)**: `(joins − leaves) / joins` over the last 7 and 30 days of tracked member events. A guild-wide **proxy** — it does not follow individual members, so there is no D1 figure and no join-week segmentation.
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

## Troubleshooting

- **Slash commands not appearing**: Run `npm run deploy` and ensure the bot has `applications.commands` scope.
- **Portainer/Docker startup fails**: Verify `MONGODB_URI` is reachable from the container network and `.env` is properly mounted.
- **AI commands timeout**: Check API key validity or Ollama endpoint accessibility from the bot container.

## License

MIT
