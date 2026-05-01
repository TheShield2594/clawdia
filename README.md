# UltraBot

A feature-rich, self-hosted Discord bot with extensive moderation tools, welcome systems, leveling, economy, RSS feeds, 24/7 music streaming, AI chat integration, and a full-featured web dashboard.

## Features

- **Moderation**: Ban, kick, warn, mute, timeout, and message clearing
- **Welcome/Farewell**: Customizable messages with image cards
- **Leveling System**: XP and level tracking with leaderboards
- **Economy**: Balance, daily rewards, work command, and transfers
- **Music Player**: 24/7 music streaming with queue management
- **RSS Feeds**: Automatic RSS feed monitoring and posting
- **Daily News Digest**: Compile multiple RSS feeds into a daily summary
- **AI Chat**: OpenAI GPT and Google Gemini integration for AI-powered conversations
- **Reminders**: Set reminders with flexible time options
- **Web Dashboard**: Full-featured admin dashboard for configuration
- **Auto-Moderation**: Spam, invite, and link filtering
- **Server Insights**: Retention cohorts, active hours, toxic channel hotspots, mod SLA trends, and newcomer conversion

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
npm run deploy  # Deploy slash commands
npm start
```

## Configuration

1. Invite the bot to your server
2. Visit the dashboard at `http://localhost:3000`
3. Login with Discord
4. Select your server and configure settings

## Environment Variables

- `DISCORD_TOKEN` - Your Discord bot token
- `CLIENT_ID` - Discord application client ID
- `CLIENT_SECRET` - Discord OAuth2 client secret
- `MONGODB_URI` - MongoDB connection string
- `DASHBOARD_PORT` - Web dashboard port (default: 3000)
- `DASHBOARD_URL` - Public URL for the dashboard
- `SESSION_SECRET` - Random string for session encryption
- `OPENAI_API_KEY` - (Optional) OpenAI API key for AI features
- `GEMINI_API_KEY` - (Optional) Google Gemini API key for AI features

## Commands

### Moderation
- `/ban` - Ban a user
- `/kick` - Kick a user
- `/warn` - Warn a user
- `/mute` - Timeout a user
- `/unmute` - Remove timeout
- `/clear` - Delete messages
- `/warnings` - View user warnings

### Economy
- `/balance` - Check balance
- `/daily` - Claim daily reward
- `/work` - Work for coins
- `/transfer` - Transfer coins

### Leveling
- `/rank` - View rank card
- `/leaderboard` - View server leaderboard

### Music
- `/play` - Play music
- `/skip` - Skip current song
- `/stop` - Stop music
- `/queue` - View queue
- `/nowplaying` - Current song info

### Fun
- `/8ball` - Ask the magic 8-ball
- `/roll` - Roll a dice
- `/coinflip` - Flip a coin

### Utility
- `/avatar` - Get user avatar
- `/userinfo` - User information
- `/serverinfo` - Server information
- `/help` - Command list
- `/ping` - Bot latency

### AI
- `/ai` - Ask AI a question (supports OpenAI GPT or Google Gemini)
- `/remind` - Set a reminder

### Admin
- `/settings` - Get dashboard link
- `/dailynews` - Manually trigger daily news digest (Admin only)

## Tech Stack

- Node.js
- Discord.js v14
- MongoDB with Mongoose
- Express.js
- Passport (Discord OAuth2)
- OpenAI API
- Google Gemini API
- play-dl (Music streaming)
- RSS Parser
- Canvas (Image generation)

## AI Chat Configuration

### Supported Providers

1. **OpenAI (GPT-3.5/GPT-4)**
   - Get your API key from https://platform.openai.com/
   - Add to `.env` as `OPENAI_API_KEY` or configure per-server in dashboard
   - Models: GPT-3.5 Turbo (default)

2. **Google Gemini**
   - Get your API key from https://makersuite.google.com/app/apikey
   - Add to `.env` as `GEMINI_API_KEY` or configure per-server in dashboard
   - Models: Gemini Pro

### Setup

1. Go to the dashboard AI Chat section
2. Select your preferred AI provider
3. (Optional) Add server-specific API keys
4. Choose a channel for AI chat
5. Customize the system prompt
6. Enable AI Chat

Users can now chat with AI in the designated channel or use `/ai` command anywhere.


## Insights Layer

UltraBot includes an **Insights** view in the dashboard focused on decisions instead of raw event logs.

### Key Metrics

- **Retention Cohorts**: Track D1/D7/D30 member retention by join week
- **Active Hours Heatmap**: See peak activity hours by day/time (UTC or server timezone)
- **Toxic Channel Detection**: Rank channels by moderation events, warning density, and repeat offenders
- **Moderator SLA Trends**: Measure median response time from incident to first mod action
- **Newcomer Conversion (7/30 days)**: Track how many new members become active contributors

### Why it matters

Server owners can use these metrics to:
- Schedule events during true peak hours
- Spot channels that need policy updates or more moderators
- Improve onboarding flows and newcomer retention
- Track whether moderation performance is improving over time

## Daily News Digest

The Daily News feature compiles multiple RSS feeds into a single daily post.

### Setup

1. Go to the dashboard Daily News section
2. Enable Daily News Digest
3. Select a channel for posting
4. Set delivery time (24-hour format, e.g., 09:00)
5. Add RSS feed URLs (one per line)
6. Configure title and max items per feed
7. Save settings

The bot will automatically post a compiled digest at your specified time.

### Manual Trigger

Admin users can manually trigger the digest with:
```
/dailynews
```

## License

MIT