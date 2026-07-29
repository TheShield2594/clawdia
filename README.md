# Clawdia

A chill, self-hosted Discord bot with serious teeth. Clawdia brings moderation, AI chat, leveling, economy, RSS feeds, and a full-featured web dashboard to your community — without any cloud lock-in.

## Features

- **Moderation**: Ban, kick, warn, mute, timeout, and message clearing
- **Welcome/Farewell**: Customizable messages with image cards
- **Leveling System**: XP and level tracking with leaderboards
- **Economy**: Balance, daily rewards, work command, and transfers
- **RSS Feeds**: Automatic RSS feed monitoring and posting
- **Daily News Digest**: Compile multiple RSS feeds into a daily summary
- **AI Chat**: OpenAI GPT, Google Gemini, or optional local Ollama integration
- **Reminders**: Set reminders with flexible time options
- **Web Dashboard**: Full-featured admin dashboard for configuration
- **Auto-Moderation**: Spam, invite, and link filtering
- **Server Insights**: Retention cohorts, active hours, toxic channel hotspots, mod SLA trends, and newcomer conversion

## Prerequisites

- Node.js 22.12+
- MongoDB (local or cloud)
- Discord Application with Bot & OAuth2 scopes enabled
- (Optional) OpenAI API Key, Google Gemini API Key, or local Ollama instance

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
- `/clear` - Delete messages
- `/slowmode` - Set channel slowmode
- `/lockdown` - Lock a channel
- `/case` / `/cases` / `/closecase` - Case management
- `/appeal` - Submit a ban appeal
- `/note` - Add a moderator note to a user

### Economy
- `/balance` - Check balance
- `/bank` - Manage your bank account
- `/daily` - Claim daily reward
- `/work` - Work for coins
- `/crime` - Attempt a crime for coins
- `/rob` - Rob another user
- `/duel` - Challenge another user
- `/shop` / `/buy` / `/inventory` / `/use` - Item economy
- `/craft` - Craft items
- `/jobs` - View and take jobs
- `/casino` - Casino games
- `/fish` / `/hunt` / `/mine` - Gathering activities
- `/quiz` - Answer trivia for rewards
- `/boost` - Activate economy boosts
- `/eventshop` - Seasonal event shop

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

Clawdia includes an **Insights** view in the dashboard focused on decisions instead of raw event logs.

### Key Metrics

- **Retention Cohorts**: Track D1/D7/D30 member retention by join week
- **Active Hours Heatmap**: See peak activity hours by day/time (UTC or server timezone)
- **Toxic Channel Detection**: Rank channels by moderation events, warning density, and repeat offenders
- **Moderator SLA Trends**: Measure median response time from incident to first mod action
- **Newcomer Conversion (7/30 days)**: Track how many new members become active contributors

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
