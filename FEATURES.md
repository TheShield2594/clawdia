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

**MCP Servers** (Anthropic provider only):

Claude can call tools on remote [MCP](https://modelcontextprotocol.io) servers.
Add them per-server in the dashboard under **AI → 🔌 Connections**, or
operator-wide in `config/mcp-servers.json`; a dashboard entry overrides a file
entry of the same name.

Dashboard:
- Preset for GitHub (`https://api.githubcopilot.com/mcp/`), or any https MCP endpoint
- Allow/deny lists per tool, so a destructive tool can be switched off by name
- **Test** button — one real request, reports whether Claude reached the server
- Tokens are write-only: stored on the bot, never returned to the browser

Config file:

```json
{
  "servers": [
    { "name": "docs", "url": "https://mcp.example.com/docs" },
    {
      "name": "calendar",
      "url": "https://mcp.example.com/calendar",
      "authorization_token": "${CALENDAR_MCP_TOKEN}",
      "allowed_tools": ["search_events"]
    }
  ]
}
```

- `${VAR}` values resolve from the environment, so tokens stay out of the file
- `enabled: false` parks a server without deleting the entry
- `MCP_ALLOW_GUILD_SERVERS=false` makes the file the only way in
- With neither source configured, requests are unchanged

Full field reference: [SETUP_GUIDE.md](SETUP_GUIDE.md#mcp-servers-anthropic-only)

### Usage

**Dedicated Channel:**
- Set an AI chat channel in dashboard
- Users chat naturally, bot responds to every message and @-mentions/replies anywhere
- Bot shows typing indicator while processing

**Customization:**

```text
System Prompt Examples:
- "You are a helpful gaming assistant for our Discord server."
- "You are a coding tutor. Explain concepts simply."
- "You are a dungeon master for D&D campaigns."
```

**Memories:**

Clawdia pins facts she learns about a user across conversations. `/ai memories`
lists them and `/ai memories delete <number>` removes one.

### AI Dungeon Master

`/dm` runs a collaborative text RPG in a channel, narrated by the configured AI
provider. Session state lives in the `DmSession` model, so an adventure survives
a bot restart.

```text
/dm start            - Start a new session in this channel
/dm join <name> <class> - Join with a character
/dm begin            - Begin the adventure (host only)
/dm action <text>    - Describe what your character does
/dm status           - Show current party status
/dm stop             - End the session
```

- Up to **6 players** per session, one session per channel
- Six classes with distinct starting HP and inventory: Warrior (120), Paladin (110), Cleric (100), Ranger (95), Rogue (90), Mage (70)
- The last 20 story beats are kept as context for the narrator

Requires a working AI provider — the same one configured for AI Chat.

### AI-Generated Content

Two other features call the AI provider directly:

- **`/questgen`** — spends **200 coins** to generate a personal legendary quest tuned to one mechanic (`hunt`, `fishing`, `mining`, `social`, `economy`, or `explore`), with targets clamped to sane ranges per mechanic. 23-hour cooldown, and only **one** AI quest can be active at a time.
- **`/newspaper preview`** — renders the AI-written server newspaper on demand. Requires **Manage Server**, and the Newspaper must be enabled under **Engagement → Newspaper** in the dashboard. The scheduled edition posts on its own; this is just the preview.

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

**General News:**

```text
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

```text
/rank                - View your rank card
/leaderboard         - Server leaderboard
```

**Customization:**
- XP rate multiplier
- Level-up message
- Announcement channel

### Economy

The economy is the largest system in the bot — 43 of 98 commands and roughly a
third of the code. The sections below cover it in full.

**Core currency:**

```text
/balance             - Check balance
/daily               - Daily reward (24h cooldown)
/work                - Work for coins (1h cooldown)
/jobs                - View and take jobs
/crime               - Attempt a crime for coins
/bank transfer <user> <amount> - Send coins
/casino <game>       - Casino games: blackjack, crash, cupgame, higherlower, keno, poker, roulette, slots
/casino roulette     - Bet on Red/Black, Odd/Even, Low/High, dozens, columns, or a straight number
/casino jackpot      - View the current progressive jackpot pool
/quiz                - Answer trivia for rewards
/boost               - Activate economy boosts
```

**Dashboard Settings:**
- Currency symbol (💰, 🪙, $, etc.)
- Daily reward amount
- Work reward range (min-max)

### Gathering, Crafting & Pets

**Gathering:** `/fish`, `/hunt`, and `/mine` are three parallel grind tracks,
each with its own stamina pool, material table, and rarity tiers. Materials feed
crafting, pet food, and the market.

```text
/fish · /hunt · /mine  - Gathering activities (stamina-gated)
/craft                 - Craft items from gathered materials
/forge <rarity>        - Have the AI forge a one-of-a-kind item
/showcase [user]       - Trophy card: rarest materials and top achievements
/synergies             - Cross-system bonuses and progress toward them
```

**Mining depths** gate the rarity ladder: each depth only ever yields ore it has
a table for, so progression is what moves the top end.

| Depth | Unlock | Best ore tier |
|---|---|---|
| 🪨 Surface Quarry | Level 1 | Rare |
| 🖤 Coal Tunnels | Level 10 · 3,000 | Rare |
| 🔩 Iron Mines | Level 20 · 12,000 | Epic |
| 💠 Crystal Caves | Level 30 · 30,000 | Legendary |
| 🌑 The Abyss | Level 50 · 75,000 | Legendary, +20% payout |

The ⭐ Event tier sits above Legendary and is the rarest thing in the game. It is
not part of the depth ladder — a Celestial Fragment can land anywhere from the
Coal Tunnels down, and the Abyss adds two event ores of its own.

Once a depth is unlocked it stays accessible for good — the level requirement is
checked at purchase, not every dig.

**A dig** is a risk choice followed by a vein read. You pick how hard to push —
the choice is yours, and it is the only thing that sets the danger:

| Push | Payout | Cave-in risk | Pickaxe wear |
|---|---:|---:|---:|
| ☀️ Surface | 0.7× | 0% | 1 |
| 🪨 Shallow | 1.0× | 5% | 1 |
| 🔩 Mid | 1.4× | 12% | 2 |
| 💎 Deep | 2.0× | 20% | 3 |

Then the tunnel shows you where the seam runs, the dust settles, and you call it.
A correct read promotes the payout one rung — Deep pays the Abyss's **3×** — at the
risk you already chose. 🌑 Abyss cannot be selected; it is only ever earned.

Pass `intensity:` on the command to skip the prompt and dig straight away. An
unanswered prompt repeats whatever you dug last.

Cave in and you choose again: spend a blast charge to dig clear and keep the whole
haul, multiplier included, or flee and lose it.

**Miner prestige** (`/mine prestige`) opens at Miner Level 50 and runs to P5. Each
rank resets Miner Level and XP and keeps everything else — pickaxes, unlocked
depths, materials, consumables and lifetime stats:

| Rank | Grants (cumulative) |
|---|---|
| 🥉 P1 | +2% crit chance |
| 🥈 P2 | +1 max stamina |
| 🥇 P3 | +5% all payouts |
| 🏆 P4 | +2% rarity boost |
| 💎 P5 | +10% all payouts |

**`/forge`** spends coins to have the configured AI provider invent a unique
item, with cost and XP scaling by rarity tier:

| Rarity | Cost | XP |
|---|---:|---:|
| Common | 500 | 25 |
| Uncommon | 1,000 | 50 |
| Rare | 2,500 | 100 |
| Epic | 5,000 | 200 |
| Mythic | 10,000 | 400 |
| Legendary | 25,000 | 1,000 |

**Synergies** unlock automatically once you hit level thresholds in two or more
gathering tracks. `/synergies` shows progress toward each:

| Synergy | Requires | Grants |
|---|---|---|
| 🌿 Outdoorsman | Hunt 30, Fishing 30 | +1 max stamina in Hunting and Fishing |
| 🪝 Deep Prospector | Fishing 30, Mining 30 | +1 max stamina in Fishing and Mining |
| ⚒️ Artificer | Mining 50 | +5% ore yield, +1 max mining stamina |
| ⚙️ Iron Will | Mining 50, Hunt 50 | Blocks cave-ins below 50% pickaxe durability |
| 💼 Merchant | Hunt/Fishing/Mining 20 each | +5% coins from `/work` and `/crime` while carrying items |

**Pets** are passive-bonus companions with their own hunger, mood, level, and
evolution track.

```text
/pet adopt <type> [name]  - Adopt a pet from the shop
/pet status               - View your pets and their mood
/pet feed <material>      - Feed a pet (favourite foods restore most, grant bonus XP)
/pet rename <slot> <name> - Rename a pet
/pet release <slot>       - Release a pet permanently
```

- **Six purchasable pets** — Dog and Cat (2,000), Bird and Fish (3,000), Fox (5,000), Wolf (8,000) — each granting a different passive: work earnings, crime success, XP gain, fish yield, rob success, or hunt yield.
- **Three rare pets** — Eagle, Shark, and Crystal Fox — are not sold anywhere. Each is tied to one grind track and drops at a 4% chance alongside a legendary-tier result there.
- **Progression:** pets level to 30 across three evolution stages (1–9, 10–19, 20+), with stage multipliers of 1.0×/1.5×/2.0× on the passive plus per-level growth. Stacked bonuses of the same type cap at **40%**.
- **Upkeep:** hunger decays 10/day (5/day while resting). Below 30 a pet is starving, and a pet left starving for 3 days runs away. Base capacity is 3 slots, expandable 3 times.

### Trading & Server Investment

```text
/gift <user> <coins|item>  - Send coins or an item to another player
/market list <item> <qty> <price>  - List an item for sale
/market browse [item]      - Browse active listings
/market buy <listing_id>   - Buy a listing
/market cancel <listing_id>- Cancel a listing and reclaim the item
/invest contribute <district> <amount>  - Fund a server district
/invest status             - District funding progress and active benefits
```

**Market:** 5 listings per user, 48-hour listing TTL, 5% sale fee, 10-coin
minimum unit price, and a confirmation prompt above 500 coins. `lifesaver` and
`streak_shield` are soulbound and cannot be listed.

**Districts** are server-wide goals funded collectively. Each has a 1,000,000
coin goal and, once funded, activates its benefit for **7 days**:

| District | Benefit when funded |
|---|---|
| 🛒 Marketplace | +10% shop item drop chance from activities |
| 🏦 Bank | +5% interest on banked coins (weekly, first 100k) |
| 🕳️ Underground | −15% crime fine severity |
| 🌲 Wilderness | +10% hunt/fish/mine yield for all members |
| 🏟️ Arena | +15% duel prize pool |

### Group Play & PvP

```text
/duel <user>              - Challenge another user
/heist start <target>     - Open a heist lobby (60s join window)
/heist status             - Check the running heist
/syndicate create|join|leave|invite|kick|open|info
/syndicate leaderboard|heist|sabotage|upgrade
/war challenge|accept|status|cancel  - Server-vs-server war (admin)
/rob <user>               - Rob another player
/robstatus <user>         - Spy on a target's active rob protections
/trap set|status          - Arm a tripwire that fires when someone robs you
```

**Heists** are role-based group runs. Each participant takes a role — Hacker
(logic question), Lookout (spot the duplicate), Muscle (higher-lower), or Driver
(pick the safe route) — and passes or fails a skill check that feeds the crew's
overall success roll. Targets scale the reward: Server Bank (1.0×), Casino Safe
(1.25×), Faction Vault (1.5×).

**Syndicates** are persistent crews with a leader, invite-only or open
membership, a shared heat level, and their own heist targets. Skill checks are
DM'd to each member and resolve when everyone answers or time runs out. Seven
roles are available (driver, hacker, lookout, muscle, grifter, courier, scout).

| Syndicate target | Min crew | Base success | Payout | Heat |
|---|---:|---:|---|---:|
| 🏦 Bank Job | 3 | 45% | 10k–25k | +8 |
| 🏛️ Museum Heist | 5 | 30% | 30k–80k | +15 |
| 🏙️ City Hall Con | 7 | 20% | 100k–200k | +25 |
| 🔐 Vault Breach | 9 | 15% | 250k–500k | +35 |

Vault Breach requires the syndicate's fourth-target upgrade. Syndicate
leadership itself is gated behind Prestige III.

**Wars** run 7 days between two servers, matched by exchanging invite codes. An
admin on each side uses `/war challenge` and `/war accept`; points accrue from
member activity and `/war status` shows the live scoreboard.

**Rob protections:** `/trap` arms a 12-hour tripwire for 6,000 coins that fires
on a successful rob against you. `/robstatus` lets a would-be robber scout a
target's active protections first — at the cost of a 2-minute cooldown per check.

### Progression

```text
/prestige info      - Every prestige tier and what it unlocks
/prestige up        - Prestige your account (resets level)
/prestige [user]    - Inspect a player's rank, bonuses, and unlocks
/dailychallenge     - Claim the Prestige VI+ daily challenge bonus
/season             - Current season info
```

**Prestige** resets your level in exchange for a permanent global bonus stack
and content unlocks, across 10 ranks:

| Rank | Unlocks at this tier |
|---|---|
| P1 | 🏴 Black Market shop tab |
| P2 | 🗺️ Legendary hunt / fish / mine zones |
| P3 | 🕴️ Crime syndicate leadership |
| P4 | 🦝 Exclusive pets |
| P5 | ⭐ Prestige V star + animated badge |
| P6 | 📋 Daily Challenge board |
| P7 | 👥 +2 syndicate member slots (12 total) for leaders |
| P8 | 💠 P8+ Black Market items (Voidsteel Cache, Ghost Ledger, Obsidian Crown) |
| P10 | ✨ "The Ascended" title + animated profile accent |

Bonuses stack with rank, reaching +10% yield, +10% stamina regen, +10% crime
success, +10% XP, and a +1.5% rare-tier shift at P10.

**`/dailychallenge`** is the P6+ board: a rotating objective with a flat 5,000
coin and 250 XP bonus, claimable once every 24 hours.

### Feeds & Rotation

```text
/featured   - Today's featured rotation (+25% payout, +10% rare chance)
/winfeed    - Last 20 big wins in this server (50k+ coins or legendary drops)
```

`/featured` rotates daily per guild and highlights specific activities.
`/winfeed` pulls from hunt, fish, mine, slots, crash, keno, and duel results.

### Seasonal Commands

These are only usable while their seasonal event is running:

```text
/trackhunt   - Track game across the Arctic Tundra (Winter Hunt)
/sandcastle  - Build a sandcastle on the shore (Summer Festival)
/lovenote    - Send a love note into the Arcade (Valentine's Day)
/snowball    - Winter snowball throwing
/trickortreat- Spooky-season treat run
/eventshop   - Spend event currency
```

### World Exploration

Narrated expeditions in Clawdia's voice. Players set out into distinct regions, each with its own weighted event table — encounters, discoveries, traps, treasure, lore fragments, and rare secrets.

**Commands:**

```text
/explore go [region]   - Set out on an expedition (1 stamina, 60s cooldown)
/explore travel        - Unlock and move between regions
/explore regions       - Browse every region, requirements, and progress
/explore journal       - Reread your most recent finds
/explore relics        - Open your relic case and see what it earns you
/explore profile       - Explorer level, stamina, and field record
/explore map - Unroll your persistent Explorer's Map
```

**Regions:**
- Core: Whispering Forest → Crumbling Ruins → Crystal Caves → Sunken Docks → Starfall Wastes (level + coin gated, rising payouts)
- Seasonal: Frostveil Pass (winter), Hollowgrave Lane (spooky), Scorchglass Shore (summer), The Velvet Arcade (Valentine's), Arctic Tundra (winter hunt) — open only while their seasonal event runs, and they drop event currency for the event shop
- A bare `/explore go` follows your active region, and reroutes itself if that region has gone out of season or been switched off

**Progression:**
- **Secret pity** — every expedition into a region that still hides a secret lifts the odds of finding one, shown as a live chance on the result embed. Regions you have fully uncovered stop building pity instead of promising a secret they can't deliver
- **Fully surveyed** — chart every landmark, lore fragment and secret in a region and everything it pays you afterwards carries a standing +15%
- **Relic case** — each distinct relic is worth +1% on exploration coins, up to +10%. Treasure prefers relics you don't own yet, so the case fills instead of stacking duplicates
- **Encounters are a real bet** — the prompt quotes the win chance and both coin bands in the money *you* would see, and losing is priced off what was on the table rather than a flat fee, so the long-odds encounters with the biggest prizes are worth taking instead of worth dodging
- **Quiet expeditions** cost the cooldown but refund the stamina point — a blank walk isn't charged for
- **Level-ups are announced** on the result embed, and name any region the new Explorer Level just brought within reach
- **Daily coin caps ramp** — the first 100,000 coins in a rolling 24h window pay in full, everything up to 150,000 pays at 50%, and past that expeditions still chart the map and pay Explorer XP but stop paying cash
- Losses scale with how deep the region is, and deliberately *not* with the seasonal coin bonus or the admin drop-rate knob

**Integration:**
- Treasure coins feed the economy (transaction-logged, daily-capped — and the embed says so when the cap trims a haul); relics land in `/inventory` under their own section
- **Featured region** — one core region a day pays +25%, rotating per guild alongside the featured crime, hunt zone, fishing spot and mine depth in `/featured`
- **Quests and season missions** — daily and weekly expedition quests, plus two season pass daily missions
- **Hourly micro-competition** — richest expedition of the hour wins coins, alongside the biggest dig and largest haul
- **Weekly newspaper** — the top explorer joins the Game Standouts
- Expeditions grant Explorer XP and mirror guild leveling XP, and Explorer Level shows on `/profile`
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

```text
{user}         - Mention the user
{server}       - Server name
{memberCount}  - Total member count
{username}     - Username without @
```

### Example Messages

**Welcome:**

```text
Welcome {user} to {server}! 🎉
You are member #{memberCount}!
Check out #rules to get started.
```

**Farewell:**

```text
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

The Insights view turns the data Clawdia already collects — member join/leave
counts, command usage, and moderation cases — into a small set of decision-
oriented figures. Everything is computed from those three sources, which bounds
what the metrics can honestly say. Definitions are spelled out below because
several of them are proxies rather than the textbook metric of the same name.

### Included Insights

| Insight | What is actually computed | Source |
|---|---|---|
| **Net Retention (7/30 d)** | `(joins − leaves) / joins`, clamped at 0, over the last 7 and 30 tracked member-event days. Guild-wide **proxy** — individual members are not followed, so there is no D1 figure and no join-week cohort | `analytics.memberEvents` |
| **Active Hours** | 24-bucket histogram of command invocations by hour, plus the top 5 hours. **UTC only** — no weekday dimension, no server-timezone rendering | `analytics.commandUsage` |
| **Toxic Channels** | Up to 8 channels from the most recent 1,000 cases, scored `warns + (2 × severe)` where severe is mute/kick/ban. Channel is parsed from the case's evidence jump URL; cases without one fall into `unknown` | `Case` |
| **Mod Resolution Time** | Median hours from case creation to case **resolution**, plus a 6-month monthly trend. Time-to-close, **not** time-to-first-response | `Case` |
| **Newcomer Conversion** | Share of user records at least 7 / 30 days old that have reached 20+ messages or level 2+ | `User` |

### Known gaps

These were previously documented as shipped and are not implemented. They are
open work items, not wording problems:

- **Retention cohorts** — D1/D7/D30 segmented by join week needs per-member join dates retained over time. Only aggregate daily join/leave counts are stored, so no cohort can be reconstructed from existing data.
- **Weekday heatmap / server timezone** — `commandUsage` records the UTC hour and nothing else. A weekday dimension needs a schema change; a timezone toggle needs the guild's timezone plumbed through the endpoint.
- **First-response SLA** — `Case` carries `createdAt` and `resolvedAt` but no first-mod-action timestamp, so response time cannot be distinguished from resolution time.

### Practical Actions

- Move events and announcements to high-engagement windows (read the histogram as UTC)
- Rebalance moderator coverage by time block
- Prioritize intervention in channels with rising incident scores
- Compare newcomer conversion across onboarding changes over time

## 🔧 Advanced Features

### Custom Commands

Create simple text response commands in dashboard:

```text
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

```text
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
7. **Exploration** - Region toggles, payout multipliers, secret announcements
8. **Achievements / Quests** - Milestone and quest tracking
9. **Season Pass / Progression Tracks** - Season and progression rewards
10. **Starboard** - Highlight popular messages
11. **Suggestions** - Community suggestion tracking
12. **Reaction Roles** - Self-assignable roles via reactions
13. **Temp Voice** - Temporary voice channel management
14. **Birthdays** - Birthday announcements
15. **Bible Verses** - Daily scripture posts
16. **RSS Feeds** - Individual feed management
17. **Daily News** - Digest configuration
18. **Newspaper** - AI-written server recap (Engagement → Newspaper)
19. **AI Chat** - Provider and prompt settings
20. **Analytics** - Insights and engagement metrics
21. **Event Log** - Audit log for server events
22. **Command Policies** - Per-command permission overrides

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
| `/dailychallenge` | 24 hours |
| `/questgen` | 23 hours |
| `/work` | 1 hour |
| `/casino` (games) | 5–10 seconds |
| `/newspaper preview` | 30 seconds |
| `/winfeed` | 10 seconds |
| `/fish`, `/hunt`, `/mine`, `/explore` | 5 seconds (plus stamina) |
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