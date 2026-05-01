# UltraBot Feature Reference

## 🤖 AI Chat Integration

### Supported Providers

| Provider | Free Tier | Speed | Best For |
|----------|-----------|-------|----------|
| **Google Gemini** | ✅ 60 req/min | ⚡ Fast | General chat, testing |
| **OpenAI GPT-3.5** | ❌ Paid | ⚡ Fast | Complex tasks, coding |
| **OpenAI GPT-4** | ❌ Paid | 🐌 Slower | Advanced reasoning |

### Configuration Options

**Global Configuration** (`.env` file):
```env
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
```

**Per-Server Configuration** (Dashboard):
- Choose AI provider per server
- Override API keys per server
- Custom system prompts
- Dedicated AI chat channel

### Usage

**Dedicated Channel:**
- Set an AI chat channel in dashboard
- Users chat naturally, bot responds to every message
- Bot shows typing indicator while processing

**Command Usage:**
```
/ai prompt:What is the capital of France?
```

**Customization:**
```
System Prompt Examples:
- "You are a helpful gaming assistant for our Discord server."
- "You are a coding tutor. Explain concepts simply."
- "You are a dungeon master for D&D campaigns."
```

## 📰 Daily News Digest

### Overview

Compiles multiple RSS feeds into a single daily post at a scheduled time.

### Features

- ✅ Multiple RSS feeds in one digest
- ✅ Customizable delivery time
- ✅ Beautiful embed formatting
- ✅ Configurable items per feed
- ✅ Source attribution
- ✅ Manual trigger option

### Configuration

| Setting | Description | Example |
|---------|-------------|---------|
| **Enabled** | Turn on/off | ✅ |
| **Channel** | Where to post | #news |
| **Time** | Delivery time (24h) | 09:00 |
| **Title** | Embed title | 📰 Daily News |
| **Max Items** | Items per feed | 3 |
| **Feeds** | RSS URLs | Multiple URLs |

### RSS Feed Examples

**Technology:**
```
https://techcrunch.com/feed/
https://www.theverge.com/rss/index.xml
https://arstechnica.com/feed/
```

**Gaming:**
```
https://www.ign.com/articles?format=rss
https://www.polygon.com/rss/index.xml
https://kotaku.com/rss
```

**General News:**
```
http://feeds.bbci.co.uk/news/rss.xml
http://rss.cnn.com/rss/cnn_topstories.rss
https://www.reddit.com/r/worldnews/.rss
```

### Manual Trigger

Administrators can test or trigger an immediate digest:
```
/dailynews
```

## 🎵 Music System

### Features

- 24/7 music streaming
- YouTube support
- Queue management
- Volume control
- Persistent voice connection

### Commands

```
/play <song/url>     - Play or queue a song
/skip                - Skip current song
/stop                - Stop music and clear queue
/queue               - View queue
/nowplaying          - Current song info
```

### Dashboard Settings

- **DJ Role**: Restrict music controls to specific role
- **Default Volume**: Set initial volume (0-100)
- **Max Queue Size**: Limit queue length

## ⚖️ Moderation System

### Commands

| Command | Description | Required Permission |
|---------|-------------|---------------------|
| `/ban` | Ban a user | Ban Members |
| `/kick` | Kick a user | Kick Members |
| `/warn` | Warn a user | Moderate Members |
| `/mute` | Timeout user | Moderate Members |
| `/unmute` | Remove timeout | Moderate Members |
| `/clear` | Delete messages | Manage Messages |
| `/warnings` | View warnings | Moderate Members |

### Auto-Moderation

Enable in dashboard for automatic enforcement:

- **Spam Protection**: Duplicate messages
- **Invite Filter**: Discord invite links
- **Link Filter**: HTTP/HTTPS links
- **Profanity Filter**: Custom word list

### Logging

Set a moderation log channel to track:
- Bans/kicks
- Warnings
- Timeouts
- Auto-mod actions

## 📊 Leveling & Economy

### Leveling

**How it works:**
- Users gain 10-25 XP per message
- XP cooldown: 60 seconds
- Level formula: `Level * 100 + 100` XP needed

**Commands:**
```
/rank                - View your rank card
/leaderboard         - Server leaderboard
```

**Customization:**
- XP rate multiplier
- Level-up message
- Announcement channel

### Economy

**Commands:**
```
/balance             - Check balance
/daily               - Daily reward (24h cooldown)
/work                - Work for coins (1h cooldown)
/transfer <user> <amount> - Send coins
```

**Dashboard Settings:**
- Currency symbol (💰, 🪙, $, etc.)
- Daily reward amount
- Work reward range (min-max)

## 👋 Welcome System

### Features

- Custom welcome messages
- Auto-generated welcome cards
- Farewell messages
- Variable substitution

### Variables

```
{user}         - Mention the user
{server}       - Server name
{memberCount}  - Total member count
{username}     - Username without @
```

### Example Messages

**Welcome:**
```
Welcome {user} to {server}! 🎉
You are member #{memberCount}!
Check out #rules to get started.
```

**Farewell:**
```
Goodbye {user}! We'll miss you 😢
```

### Welcome Cards

Auto-generated cards include:
- User avatar
- Username
- Server name
- Member count
- Custom background


## 📈 Insights & Analytics Layer

### Decision-Focused Dashboards

UltraBot now provides decision-grade analytics so server owners can move from raw events to clear actions.

### Included Insights

- **Retention Cohorts**: D1/D7/D30 retention segmented by join week
- **Active Hours**: Hourly and weekday heatmaps for engagement timing
- **Toxic Channels**: Channels scored by moderation incidents and warning concentration
- **Mod SLA Trends**: First-response and resolution-time trends for moderation actions
- **Newcomer Conversion**: 7-day and 30-day conversion from joiner to active member

### Practical Actions

- Move events and announcements to high-engagement windows
- Rebalance moderator coverage by time block
- Prioritize intervention in channels with rising toxicity
- A/B test onboarding and compare conversion gains over time

## 🔧 Advanced Features

### Custom Commands

Create simple text response commands in dashboard:
```
Trigger: !website
Response: Visit us at https://example.com
```

### Auto-Roles

Automatically assign roles to new members:
- Select roles in dashboard
- Applied immediately on join
- Multiple roles supported

### Reminders

Set personal reminders:
```
/remind time:1h message:Check the oven
/remind time:tomorrow message:Meeting at 9am
/remind time:2d message:Submit report
```

Time formats:
- `1h`, `2h` - Hours
- `30m`, `45m` - Minutes
- `1d`, `2d` - Days
- `tomorrow`, `today` - Relative days

## 📱 Dashboard Features

Access at `http://your-domain:3000`

### Sections

1. **Overview** - Server stats, quick settings
2. **Welcome** - Welcome/farewell configuration
3. **Moderation** - Auto-mod and logging
4. **Leveling** - XP system settings
5. **Economy** - Currency configuration
6. **Music** - Player settings
7. **RSS Feeds** - Individual feed management
8. **Daily News** - Digest configuration
9. **AI Chat** - Provider and prompt settings

### Multi-Server Support

- Manage all servers bot is in
- Independent settings per server
- Quick server switching
- Server list with stats

## 🔐 Permissions

### Bot Permissions Required

Minimum permissions needed:
- View Channels
- Send Messages
- Embed Links
- Attach Files
- Read Message History
- Add Reactions
- Use Slash Commands
- Connect (voice)
- Speak (voice)
- Manage Messages (moderation)
- Ban Members (moderation)
- Kick Members (moderation)
- Moderate Members (timeout)

### User Permissions

Commands respect Discord's built-in permissions:
- Moderation commands require mod permissions
- Admin commands require administrator
- Everyone can use fun/utility commands

## 📈 Performance Tips

### Large Servers (1000+ members)

- Reduce XP rate to prevent spam
- Enable auto-mod for spam protection
- Limit queue size for music
- Use per-server API keys for AI

### Resource Optimization

- RSS checks every 5 minutes (configurable)
- Leveling uses 60s cooldown
- Economy cooldowns prevent spam
- Caching reduces database queries

## 🆘 Command Cooldowns

Prevent spam with built-in cooldowns:

| Command | Cooldown |
|---------|----------|
| `/ai` | 10 seconds |
| `/daily` | 24 hours |
| `/work` | 1 hour |
| `/play` | 3 seconds |
| Most others | 3 seconds |

## 🎨 Customization Ideas

### Gaming Community
- Gaming news RSS feeds
- XP for active gamers
- Tournament coins (economy)
- Game night reminders

### Study Group
- Educational RSS feeds
- Study session reminders
- Homework help AI
- Study time tracker (economy)

### Content Creators
- Social media RSS feeds
- Stream schedule reminders
- Engagement rewards (economy)
- Community polls (AI)

### General Community
- Mixed news feeds
- Daily digest at 9 AM
- Welcome cards for branding
- Community currency

Start customizing and make the bot your own! 🚀