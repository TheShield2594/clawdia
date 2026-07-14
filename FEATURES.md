# Clawdia Feature Reference

## 🤖 AI Chat Integration

### Supported Providers

| Provider | Free Tier | Speed | Best For |
|----------|-----------|-------|----------|
| **Google Gemini** | ✅ 60 req/min | ⚡ Fast | General chat, testing |
| **OpenAI GPT-3.5** | ❌ Paid | ⚡ Fast | Complex tasks, coding |
| **OpenAI GPT-4** | ❌ Paid | 🐌 Slower | Advanced reasoning |
| **Anthropic Claude** | ❌ Paid | ⚡ Fast | Nuanced reasoning, long context |
| **OpenRouter** | ❌ Paid | ⚡ Fast | Access to many models via one API |
| **Ollama (self-hosted)** | ✅ Free | Varies | Privacy-first, local inference |

### Configuration Options

**Global Configuration** (`.env` file):
```env
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=AIza...
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=...
OLLAMA_BASE_URL=http://localhost:11434
```

**Per-Server Configuration** (Dashboard):
- Choose AI provider per server
- Override API keys per server
- Custom system prompts
- Dedicated AI chat channel

### Usage

**Dedicated Channel:**
- Set an AI chat channel in dashboard
- Users chat naturally, bot responds to every message and @-mentions/replies anywhere
- Bot shows typing indicator while processing

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

Administrators can send an immediate digest using the **Send digest now** button in the dashboard's Daily News panel.

## ⚖️ Moderation System

### Commands

| Command | Description | Required Permission |
|---------|-------------|---------------------|
| `/ban` | Ban a user | Ban Members |
| `/kick` | Kick a user | Kick Members |
| `/warn add` | Warn a user | Moderate Members |
| `/warn list` | View warnings for a user | Moderate Members |
| `/warn remove` | Remove a warning | Moderate Members |
| `/mute` | Timeout user | Moderate Members |
| `/unmute` | Remove timeout | Moderate Members |
| `/clear` | Delete messages | Manage Messages |

### Auto-Moderation

Enable in dashboard for automatic enforcement:

- **Spam Protection**: Duplicate messages
- **Invite Filter**: Discord invite links
- **Link Filter**: HTTP/HTTPS links
- **Profanity Filter**: Custom word list
- **Caps Filter**: Excessive capitalization
- **Emoji Filter**: Emoji flooding
- **Mention Filter**: Mass mentions
- **Zalgo Filter**: Corrupted/zalgo text

### Logging

Set a moderation log channel to track:
- Bans/kicks
- Warnings
- Timeouts
- Auto-mod actions

## 📊 Leveling & Economy

### Leveling

**How it works:**
- Users gain 10-24 XP per message
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
/bank transfer <user> <amount> - Send coins
/casino wheel        - Spin the Wheel of Fortune (free spin per cooldown, or buy extra spins)
/casino roulette     - Bet on Red/Black, Odd/Even, Low/High, dozens, columns, or a straight number
```

**Wheel of Fortune:**
- One free spin per cooldown window (default: 24 hours, configurable per server)
- Optional paid spins at any time using server currency
- Weighted prize segments — coins, jackpot, free re-spin, or bust
- Animated reveal in the embed before the result is shown

**Dashboard Settings:**
- Currency symbol (💰, 🪙, $, etc.)
- Daily reward amount
- Work reward range (min-max)
- Wheel of Fortune: enable/disable, cooldown hours, extra spin cost

### World Exploration

Narrated expeditions in Clawdia's voice. Players set out into distinct regions, each with its own weighted event table — encounters, discoveries, traps, treasure, lore fragments, and rare secrets.

**Commands:**

```text
/explore go [region]   - Set out on an expedition (1 stamina, 60s cooldown)
/explore travel        - Unlock and move between regions
/explore regions       - Browse every region, requirements, and progress
/explore journal       - Reread your most recent finds
/explore profile       - Explorer level, stamina, and field record
/explore map  or  /map - Unroll your persistent Explorer's Map
```

**Regions:**
- Core: Whispering Forest → Crumbling Ruins → Crystal Caves → Sunken Docks (level + coin gated, rising payouts)
- Seasonal: Frostveil Pass (winter), Hollowgrave Lane (spooky), Scorchglass Shore (summer), The Velvet Arcade (Valentine's) — open only while their seasonal event runs and they drop event currency for the event shop

**Integration:**
- Treasure coins feed the economy (transaction-logged, daily-capped); relics land in `/inventory`
- Expeditions grant Explorer XP and mirror guild leveling XP
- Rare finds unlock exploration achievements (including secret ones)
- The Explorer's Map persists per player: landmarks, lore, and secrets charted per region

**Dashboard Settings:**
- Enable/disable exploration, per-region toggles
- Payout multiplier and rare-event bonus knobs
- Secret discovery announcements

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

Set personal reminders using relative time options, or an absolute time:
```
/remind minutes:30 message:Check the oven
/remind hours:2 message:Meeting at 9am
/remind days:2 message:Submit report
/remind at:17:00 message:Log off
/remind at:"2026-07-20 09:00" message:Submit report
/remind message:Standup every:daily at:9:00
```
Reminders post in the channel where they were set; if that channel is no longer
reachable, the bot DMs the user instead. Set `/timezone set` so absolute times
(and the AI's natural-language reminders — e.g. "remind me at 5pm") resolve to
your local time instead of UTC. Use `/reminders list` to see your open
reminders and `/reminders cancel` to remove one.

The slash command accepts `minutes`, `hours`, and `days` as individual integer options (combine as needed).

## 📱 Dashboard Features

Access at `http://your-domain:3000`

### Sections

1. **Overview** - Server stats, quick settings
2. **Welcome / Farewell** - Welcome/farewell message configuration
3. **Moderation** - Auto-mod, case settings, and logging
4. **Raid Detection / Anti-Nuke** - Server protection settings
5. **Leveling** - XP system settings
6. **Economy** - Currency configuration
7. **Achievements / Quests** - Milestone and quest tracking
8. **Season Pass / Progression Tracks** - Season and progression rewards
9. **Starboard** - Highlight popular messages
10. **Suggestions** - Community suggestion tracking
11. **Reaction Roles** - Self-assignable roles via reactions
12. **Temp Voice** - Temporary voice channel management
13. **Birthdays** - Birthday announcements
14. **Bible Verses** - Daily scripture posts
15. **RSS Feeds** - Individual feed management
16. **Daily News** - Digest configuration
17. **AI Chat** - Provider and prompt settings
18. **Analytics** - Insights and engagement metrics
19. **Event Log** - Audit log for server events
20. **Command Policies** - Per-command permission overrides

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
| `/daily` | 24 hours |
| `/work` | 1 hour |
| `/casino wheel` | 24 hours (configurable; bypass with paid spin) |
| `/casino` (other games) | 5–10 seconds |
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