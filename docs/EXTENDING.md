# Extending Clawdia

This guide is for developers who want to add custom features or modify existing
functionality: commands, models, services, events, dashboard pages and API
routes, scheduled tasks, and the conventions each of them follows.

It is a guide to writing code, not a description of the running system. For the
HTTP endpoints the dashboard actually serves — every path, who may call it, and
what it does — see [API_REFERENCE.md](../API_REFERENCE.md).

## Project Structure

```
src/
├── commands/          # Slash commands by category
│   ├── admin/        # Administrator commands
│   ├── ai/           # AI-related commands
│   ├── community/    # Community and social commands
│   ├── economy/      # Economy system
│   ├── fun/          # Fun/entertainment
│   ├── leveling/     # XP and leveling
│   ├── moderation/   # Moderation tools
│   └── utility/      # Utility commands
├── dashboard/        # Web dashboard
│   ├── public/       # Static files (CSS, JS)
│   ├── routes/       # Express routes
│   └── views/        # EJS templates
├── events/           # Discord.js events
├── views/            # Discord embeds and component rows
├── models/           # MongoDB schemas
├── data/             # Static tables (drop tables, role definitions)
├── services/         # Business logic
├── games/            # Casino round state machines
├── bot/              # The gateway facade the dashboard talks to
└── utils/            # Helper functions
```

### Which way dependencies run

These directories are layers, and the direction is enforced — `npm run lint`
fails on a module requiring one from a layer above it. Lowest first:

| Layer | May require |
| --- | --- |
| `models`, `config`, `data`, `migrations` | each other |
| `utils` | the above |
| `views` | the above |
| `services`, `games` | the above |
| `commands`, `bot` | the above |
| `dashboard`, `events` | the above |

A module may always require its own layer. If two layers need the same code,
the code moves *down* — a Discord embed several callers share belongs in
`views/`, a table belongs in `data/`, an operation belongs in `services/`. The
rule and the one documented exception live in `eslint-rules/layer-boundaries.js`
and `eslint.config.js`.

## Creating a New Command

A command is one file under `src/commands/<category>/`, or a folder with an
`index.js` when it has outgrown one file. The category comes from the
directory; nothing else registers a command.

### Basic Command Template

```javascript
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('commandname')
        .setDescription('Command description'),
    cooldown: 5, // Optional: cooldown in seconds
    async execute(interaction) {
        // Command logic here
        await interaction.reply('Response!');
    }
};
```

That is the smallest working command, not the whole contract — see
[The full module contract](#the-full-module-contract) below for the four
optional keys the interaction handler also looks for.

### The full module contract

A command module is a plain object. Two keys are required and the loader
refuses to start without them; the rest are optional hooks
`events/interactionCreate.js` looks for by name.

| Key | Required | Shape | What reads it |
| --- | --- | --- | --- |
| `data` | yes | a `SlashCommandBuilder` (anything with `toJSON()`) | the loader, for `client.commands`; the deploy, for what it publishes to Discord |
| `execute` | yes | `async (interaction, client) => void` | run on every chat-input use |
| `cooldown` | no | seconds, number — defaults to `3` | the per-user cooldown gate |
| `cooldownAmount` | no | `(interaction) => seconds` | same gate, when the window depends on which subcommand or option was used |
| `cooldownKey` | no | `(interaction) => string` — defaults to the command name | which bucket the cooldown is charged to |
| `autocomplete` | no | `async (interaction, client) => void` | autocomplete interactions for this command |
| `requiredPermissions` | no | an array of `PermissionFlagsBits` | checked before `execute`, and before the cooldown is claimed |
| `category` | never set this | string | stamped by the loader from the directory the file is in |

#### The two required keys

`isCommandModule` in `utils/commandLoader.js` checks that `execute` is callable
and that `data` has a callable `toJSON`. Both, not merely present: a module
whose `execute` holds a string is caught at startup rather than the moment
someone runs the command. A file that fails the check is fatal — startup
refuses to come up with an incomplete set, because the deploy publishes exactly
the collection startup builds, and a command that quietly failed to load would
otherwise *unregister* itself from Discord on the next boot.

#### A typo in an optional key fails silently

Nothing validates the optional keys. They are read as `command.cooldownKey`,
`command.autocomplete` and so on, so `cooldownkey` or `autoComplete` is not an
error — it is a key nobody reads. The command loads, deploys and runs, and the
hook you wrote never fires. `requiredPermissions` is the one where that is a
security bug rather than an annoyance, so grep an existing user of the key and
copy the spelling:

```
cooldownAmount   cooldownKey   autocomplete   requiredPermissions
```

#### Cooldowns

`cooldown` is one number for the whole command. That is wrong for a command
whose subcommands cost different amounts, and it is wrong for a command whose
window should not be shared across its subcommands — which is why the two
function forms exist. `casino.js`, `heist.js`, `syndicate.js` and
`newspaper.js` use them today:

```javascript
module.exports = {
    data: /* … a builder with blackjack / roulette / slots subcommands */,

    // Per-subcommand window: a slots pull is not a blackjack hand.
    cooldownAmount: interaction =>
        interaction.options.getSubcommand() === 'blackjack' ? 10 : 3,

    // Per-subcommand bucket: being on cooldown for slots must not lock
    // roulette. Without this, every subcommand shares the key `casino`.
    cooldownKey: interaction => `casino:${interaction.options.getSubcommand()}`,

    async execute(interaction) { /* … */ },
};
```

`cooldownAmount` overrides `cooldown` when both are present. Whatever it
returns is coerced: a non-finite or negative value falls back to 3 seconds, and
the value is clamped to `2^31-1` milliseconds, because Node's `setTimeout`
treats a longer delay as 1 ms and would hand the window straight back. A guild
can also set per-role cooldown overrides for a command from the dashboard; the
lowest override matching the caller's roles replaces whatever these return.

None of this is what *enforces* an economy cooldown. Anything that pays out
claims its own window atomically in Mongo — see the cooldown note in
`src/index.js` and `tests/economyCooldownClaims.test.js`.

#### Autocomplete

Discord sends autocomplete as its own interaction type, not through `execute`.
Declare a sibling method and it is called with the same arguments:

```javascript
async autocomplete(interaction) {
    const query = interaction.options.getFocused().toLowerCase();
    const matches = ITEMS.filter(i => i.name.toLowerCase().includes(query));
    // Discord accepts at most 25, and rejects the whole response over that.
    await interaction.respond(
        matches.slice(0, 25).map(i => ({ name: i.name, value: i.id })),
    );
}
```

The option itself also has to be built with `.setAutocomplete(true)`, or
Discord never sends the interaction. A command with an autocompleting option
and no `autocomplete` method answers with an empty list rather than failing,
and a method that throws is logged and answers empty too — the user sees no
suggestions, not an error. `ai.js`, `pet.js`, `shop.js`, `craft.js` and
`use.js` implement it.

#### Permissions

`requiredPermissions` is the gate that actually holds:

```javascript
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Ban a member')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers),
    requiredPermissions: [PermissionFlagsBits.BanMembers],
    async execute(interaction) { /* … */ },
};
```

Both lines, and they are not redundant. `setDefaultMemberPermissions` is a
*default* Discord hands the server on install: a guild admin can reassign the
command to any role from Server Settings, and Discord then delivers it without
the bot being told anything changed. On its own it is a suggestion.
`requiredPermissions` is re-checked against `interaction.memberPermissions` on
every call, in one place, ahead of the cooldown claim — rather than in fifteen
handlers where the sixteenth forgets. Administrators and the guild owner
satisfy any bit, because Discord folds that into the permissions it sends.

A member missing a bit gets an ephemeral list of what they need and the
interaction is recorded as `missing_permissions`. Keep the builder line too:
it keeps the command out of the picker for people who cannot run it.

### Command with Options

```javascript
const { SlashCommandBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('greet')
        .setDescription('Greet a user')
        .addUserOption(option =>
            option.setName('user')
                .setDescription('User to greet')
                .setRequired(true))
        .addStringOption(option =>
            option.setName('message')
                .setDescription('Custom message')
                .setRequired(false)),
    async execute(interaction) {
        const user = interaction.options.getUser('user');
        const message = interaction.options.getString('message') || 'Hello';
        
        await interaction.reply(`${message}, ${user}!`);
    }
};
```

### Command with Permissions

```javascript
const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('announce')
        .setDescription('Make an announcement')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),
    requiredPermissions: [PermissionFlagsBits.ManageMessages],
    async execute(interaction) {
        // Only users with Manage Messages can use this
        await interaction.reply('Announcement!');
    }
};
```

The builder line alone does not gate anything the server cannot undo — see
[Permissions](#permissions) under the module contract for why both lines are
there.

### Command with Embeds

```javascript
const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Display info'),
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setColor('#0099ff')
            .setTitle('Information')
            .setDescription('Some details here')
            .addFields(
                { name: 'Field 1', value: 'Value 1', inline: true },
                { name: 'Field 2', value: 'Value 2', inline: true }
            )
            .setTimestamp()
            .setFooter({ text: 'Footer text' });
        
        await interaction.reply({ embeds: [embed] });
    }
};
```

## Database Models

### Accessing Guild Settings

```javascript
const Guild = require('../models/Guild');

// Read. findOne answers null for a guild that has no document yet — every guild
// does until something writes one — so nothing may reach into the result
// unguarded.
const settings = await Guild.findOne({ guildId: interaction.guild.id });
if (!settings) return;                     // or create one, below

settings.leveling.enabled = true;
await settings.save();

// Write without a read first. The upsert creates the document when it is
// missing, which is what most write paths want; `name` is required by the
// schema, so it has to be supplied for the insert case.
await Guild.findOneAndUpdate(
    { guildId: guild.id },
    { $set: { 'leveling.enabled': true }, $setOnInsert: { name: guild.name } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
);
```

Prefer the second form for anything on a hot path: it is one round trip instead
of two, and two concurrent read-modify-`save()` pairs on the same document lose
one of the two writes.

### Accessing User Data

A user document is per member per guild: the same person in two servers has two
of them, keyed on `{ userId, guildId }`. Money lives in `balance` (wallet) and
`bank`, not in a `coins` field.

```javascript
const User = require('../models/User');

// Read, with the same caveat: a member who has never earned anything has no
// document.
const user = await User.findOne({
    userId: interaction.user.id,
    guildId: interaction.guild.id
});
const balance = user?.balance ?? 0;

// Award XP and coins. `$inc` through an upsert creates the document on a
// member's first award and is atomic against concurrent awards, which
// `user.xp += 50; user.save()` is not.
await User.findOneAndUpdate(
    { userId: interaction.user.id, guildId: interaction.guild.id },
    { $inc: { xp: 50, balance: 100 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
);
```

Debits are not the mirror image of credits — a balance may not go negative, and
the guard belongs in the filter (`balance: { $gte: cost }`) rather than in a
read beforehand. See `models/User.js` and the economy routes.

### Creating a New Model

```javascript
// src/models/CustomData.js
const { Schema, model } = require('mongoose');

const customSchema = new Schema({
    guildId: { type: String, required: true },
    userId: { type: String, required: true },
    customField: { type: String, default: '' },
    customNumber: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
});

// Compound index for faster queries
customSchema.index({ guildId: 1, userId: 1 }, { unique: true });

module.exports = model('CustomData', customSchema);
```

## Creating a Service

Services contain reusable business logic.

```javascript
// src/services/customService.js

async function doSomething(client, data) {
    try {
        // Service logic here
        return result;
    } catch (error) {
        console.error('Custom service error:', error);
        throw error;
    }
}

async function scheduledTask(client) {
    // Runs on a schedule
}

module.exports = {
    doSomething,
    scheduledTask
};
```

### Using a Service in Commands

```javascript
const { doSomething } = require('../../services/customService');

module.exports = {
    // ... command definition
    async execute(interaction) {
        const result = await doSomething(interaction.client, data);
        await interaction.reply(`Result: ${result}`);
    }
};
```

## AI Service Integration

### Using AI in Custom Commands

```javascript
const { getChatCompletion } = require('../../services/aiService');
const Guild = require('../../models/Guild');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('askabout')
        .setDescription('Ask AI about something')
        .addStringOption(option =>
            option.setName('topic')
                .setDescription('Topic to ask about')
                .setRequired(true)),
    async execute(interaction) {
        await interaction.deferReply();
        
        const topic = interaction.options.getString('topic');
        const settings = await Guild.findOne({ guildId: interaction.guild.id });
        
        const provider = settings?.ai.provider || 'openai';
        const apiKey = provider === 'openai' 
            ? settings?.ai.openaiKey 
            : settings?.ai.geminiKey;
        
        try {
            const response = await getChatCompletion(
                `Tell me about ${topic}`,
                'You are a knowledgeable assistant.',
                provider,
                apiKey
            );
            
            await interaction.editReply(response);
        } catch (error) {
            await interaction.editReply('AI service error. Check configuration.');
        }
    }
};
```

### Custom AI System Prompts

Create AI commands with specific personalities:

```javascript
// Coding tutor
const systemPrompt = 'You are a patient coding tutor. Explain concepts simply with examples.';

// D&D Master
const systemPrompt = 'You are a creative Dungeon Master. Create engaging scenarios.';

// Translator
const systemPrompt = 'You are a translator. Translate the user input to English.';

const response = await getChatCompletion(userInput, systemPrompt, provider, apiKey);
```

## RSS Service Integration

### Adding Custom RSS Features

```javascript
const Parser = require('rss-parser');
const parser = new Parser();

async function getLatestArticles(feedUrl, count = 5) {
    try {
        const feed = await parser.parseURL(feedUrl);
        return feed.items.slice(0, count).map(item => ({
            title: item.title,
            link: item.link,
            date: new Date(item.pubDate || item.isoDate),
            description: item.contentSnippet
        }));
    } catch (error) {
        console.error('RSS parse error:', error);
        return [];
    }
}

// Usage in command
const articles = await getLatestArticles('https://example.com/feed.xml', 3);
```

### Custom News Digest

```javascript
const { sendDailyNews } = require('../../services/rssService');

// Manually trigger for specific guild
await sendDailyNews(client, guildId);
```

## Event Handling

### Creating a Custom Event

```javascript
// src/events/customEvent.js
module.exports = {
    name: 'messageReactionAdd', // Discord.js event name
    async execute(reaction, user, client) {
        // Event logic
        if (reaction.emoji.name === '⭐') {
            console.log(`${user.tag} starred a message`);
        }
    }
};
```

### Common Events

```javascript
// Message events
messageCreate, messageDelete, messageUpdate

// Member events
guildMemberAdd, guildMemberRemove, guildMemberUpdate

// Reaction events
messageReactionAdd, messageReactionRemove

// Voice events
voiceStateUpdate

// Guild events
guildCreate, guildDelete, guildUpdate
```

## Dashboard Customization

### Adding a Dashboard Route

```javascript
// src/dashboard/routes/custom.js
const express = require('express');
const router = express.Router();

function checkAuth(req, res, next) {
    if (req.isAuthenticated()) return next();
    res.redirect('/');
}

router.get('/custom', checkAuth, async (req, res) => {
    res.render('custom', {
        user: req.user,
        // The gateway facade, which createApp attaches to every request.
        // There is no req.client — routes never hold a live Discord client.
        bot: req.bot
    });
});

module.exports = router;
```

### Adding to Dashboard Server

The app is built by a factory, so it can be constructed without a Discord
client and driven with supertest; `listen()` is separate and binds the port.

```javascript
// src/dashboard/server.js — inside createApp(), before the error handler
const customRoutes = require('./routes/custom');
app.use('/custom', customRoutes);
```

Routes read Discord through `req.bot`, the gateway facade, never a live client.
Anything a route throws — synchronously or from a rejected promise — is caught
by the terminal error middleware; it must be, because the dashboard shares a
process with the gateway and an escaped error exits it.

### Creating a Dashboard View

```html
<!-- src/dashboard/views/custom.ejs -->
<!DOCTYPE html>
<html>
<head>
    <title>Custom Page</title>
    <link rel="stylesheet" href="/styles.css">
</head>
<body>
    <h1>Custom Dashboard Page</h1>
    <p>Welcome <%= user.username %></p>
</body>
</html>
```

### Styles and handlers in dashboard views

New views and panels use a class in `public/styles.css` and `addEventListener`
— not a `style=""` attribute and not an `onclick=""` attribute.

This is a security rule, not a taste one. The dashboard's CSP gives each
request its own nonce, but an HTML *attribute* cannot carry a nonce, so the
hundreds of inline styles and handlers already in the views are why the policy
in `src/dashboard/server.js` still has to say `style-src 'unsafe-inline'` and
`script-src-attr 'unsafe-inline'`. The second is the expensive one: it is what
would turn a stored-XSS bug from blocked into exploitable.

Rewriting every existing view at once is not worth doing (#692), so the count
is ratcheted instead. `tests/dashboardInlineAttributes.test.js` records what
each view has today; a file may lower its count but never raise it, and a view
not in that table must have none at all. So:

```html
<!-- No: neither can carry a nonce, and both hold the CSP open. -->
<button class="btn" style="margin-top:1rem" onclick="saveThing()">Save</button>
```

```html
<!-- Yes: the class carries the layout, and the id carries the wiring. -->
<button class="btn panel-save" id="thing-save">Save</button>
```

```javascript
// public/guild-settings.js — panels arrive after the page does, so wire them
// from the panel's own init callback rather than at file scope.
onPanel('thing', panel => {
    panel.querySelector('#thing-save').addEventListener('click', () => saveSettings('thing'));
});
```

If you remove some inline attributes from an existing view, lower its numbers
in that test in the same commit. A stale count is a budget nobody is spending.

Two related conventions worth knowing while writing a panel:

- Channel and role pickers come from `partials/channel-select.ejs` and
  `partials/role-select.ejs` — do not write the option loop again (#671).
  Their locals are documented at the top of each partial.
- A third-party script belongs in `public/vendor/`, vendored from an
  exact-pinned dependency by a `scripts/vendor-*.sh` helper, never loaded from
  a CDN (#685). `script-src` is `'self'` and a nonce, and it stays that way.

### Adding API Endpoints

API routes live one feature per file in `src/dashboard/routes/api/`, and
`routes/api.js` mounts them. The whole router is mounted at `/api` in
`server.js`, so paths inside a sub-router are written without that prefix.

```javascript
// src/dashboard/routes/api/custom.js
const express = require('express');
const router = express.Router();
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');

// Everything the guild's custom widget needs in one read.
router.get('/guild/:guildId/custom', checkAuth, checkGuildAccess, async (req, res) => {
    try {
        res.json(await getCustomData(req.params.guildId));
    } catch (error) {
        console.error('Custom read error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Replaces the guild's custom widget configuration.
router.post('/guild/:guildId/custom', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { field1, field2 } = req.body;
    if (typeof field1 !== 'string') return res.status(400).json({ error: 'field1 is required' });

    try {
        await saveCustomData(req.params.guildId, field1, field2);
        res.json({ success: true });
    } catch (error) {
        console.error('Custom write error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
```

```javascript
// src/dashboard/routes/api.js — with the other router.use lines
router.use(require('./api/custom'));
```

Four rules, all of which the existing routes follow:

- **`checkGuildAccess` on every `:guildId` route.** `checkAuth` alone proves
  only that *someone* is logged in, not that they administer *this* guild —
  that gap was a real cross-tenant write ([#561]). It goes on reads too.
- **`checkWriteRateLimit` on every write.** Origin validation and the read
  limit are applied router-wide in `routes/api.js` and need no per-route
  opt-in; the write limit is still per route.
- **Validate the body before touching the database**, and answer `400` with an
  `{ error }` describing the field. Never let a caller-supplied string reach a
  query as an operator or a path.
- **Write a one-sentence `//` comment above the route.** It becomes that
  endpoint's summary in [API_REFERENCE.md](../API_REFERENCE.md); a route
  without one fails `npm test`. Run `npm run docs:api` after adding a route.

[#561]: https://github.com/TheShield2594/clawdia/issues/561

## Scheduled Tasks

### Using Cron Jobs

```javascript
// In src/events/ready.js or custom service
const cron = require('node-cron');

// Run every day at 9 AM
cron.schedule('0 9 * * *', async () => {
    await dailyTask(client);
});

// Run every hour
cron.schedule('0 * * * *', async () => {
    await hourlyTask(client);
});

// Run every 5 minutes
cron.schedule('*/5 * * * *', async () => {
    await frequentTask(client);
});
```

### Cron Expression Format

```
*    *    *    *    *
┬    ┬    ┬    ┬    ┬
│    │    │    │    │
│    │    │    │    └─── Day of Week (0-7)
│    │    │    └──────── Month (1-12)
│    │    └───────────── Day of Month (1-31)
│    └────────────────── Hour (0-23)
└─────────────────────── Minute (0-59)
```

Examples:
- `0 9 * * *` - Daily at 9 AM
- `*/15 * * * *` - Every 15 minutes
- `0 */6 * * *` - Every 6 hours
- `0 0 * * 0` - Weekly on Sunday at midnight

## Utility Functions

### Creating Embeds

```javascript
// src/utils/embedBuilder.js
const { EmbedBuilder } = require('discord.js');

function createSuccessEmbed(title, description) {
    return new EmbedBuilder()
        .setColor('#43b581')
        .setTitle(`✅ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

function createErrorEmbed(title, description) {
    return new EmbedBuilder()
        .setColor('#f04747')
        .setTitle(`❌ ${title}`)
        .setDescription(description)
        .setTimestamp();
}

module.exports = { createSuccessEmbed, createErrorEmbed };
```

### Time Parsing

```javascript
// src/utils/timeParser.js
function parseTime(timeString) {
    const units = {
        s: 1000,
        m: 60000,
        h: 3600000,
        d: 86400000,
        w: 604800000
    };
    
    const match = timeString.match(/^(\d+)([smhdw])$/);
    if (!match) return null;
    
    const [, amount, unit] = match;
    return parseInt(amount) * units[unit];
}

// Usage: parseTime('1h') => 3600000 (milliseconds)
```

### Permission Checking

```javascript
function hasPermission(member, permission) {
    return member.permissions.has(permission);
}

function hasRole(member, roleId) {
    return member.roles.cache.has(roleId);
}

// Usage
if (!hasPermission(interaction.member, 'ManageMessages')) {
    return interaction.reply('You need Manage Messages permission!');
}
```

## Testing

`npm test` runs the whole suite — every `*.test.js` under `tests/`, about 20
seconds on a laptop. CI runs the same command on every push and pull request,
and the `publish` job that builds the Docker image sits behind `needs: test`, so
a red suite means no image is built at all.

```bash
npm test                            # everything
npx jest tests/birthday.test.js     # one file
npx jest -t "leap day"              # every test whose name matches
npx jest --watch                    # re-run the affected files on save
```

`npm test` deliberately does **not** pass `--forceExit`. It used to (#630), and
that made a leaked handle — an undisconnected mongoose client, a cron nobody
`.unref()`d — invisible: Jest shot it at the end of the run and reported a pass.
Without the flag such a leak hangs after the last assertion instead, which is
the signal. If a suite you wrote hangs the run, something it opened is still
open; CI bounds the step so the hang fails there rather than sitting for hours.

### How the suite is laid out

- One file per subject, named after it: `tests/huntRepair.test.js`,
  `tests/rollPayout.test.js`. `jest.config.js` sets only coverage options, so
  the defaults still apply to collection: anything matching `*.test.js` runs.
- Shared fixtures live in `tests/helpers/`. They are not test files and are not
  collected; require them from a test the way you would any module.
- `tests/integration/` holds the suites that run against a real MongoDB rather
  than a stub — see [Integration tests](#integration-tests) below.
- Some suites guard an invariant rather than a behaviour, and those are the ones
  worth knowing about before you add a command or a script:
  `commandCap.test.js` (Discord's 100-command global limit, plus a ratchet on
  the current count), `commandDocs.test.js` (README's command list against the
  loaded set), `lintGate.test.js` (the lint script and its CI step still exist)
  and `requirePathsResolve.test.js`.

### Writing one

Node is the default environment, and models and services are mocked at the
`require` boundary rather than being pointed at a live MongoDB:

```javascript
'use strict';

jest.mock('../src/models/User', () => ({ findOneAndUpdate: jest.fn() }));

const { __test__ } = require('../src/commands/fun/roll');
const { payoutMultiplier } = __test__;

describe('payoutMultiplier', () => {
    test('exact-number bets pay at the die odds', () => {
        expect(payoutMultiplier({ type: 'exact', number: 3 }, 6)).toBe(6);
    });
});
```

Commands export the internals they want covered under a `__test__` key, which
keeps the test off the interaction plumbing and on the logic that can actually
be wrong.

Anything that touches dashboard front-end code — `src/dashboard/public/*.js`,
the EJS views — needs a DOM, requested per file with a docblock at the top:

```javascript
/**
 * @jest-environment jsdom
 * @jest-environment-options {"customExportConditions": ["node"]}
 */
```

jsdom omits a few Node globals that mongoose's driver reaches for on require;
`tests/dashboardAccessibility.test.js` shows the shim those suites use.

### Integration tests

Mocking at the `require` boundary is the default, and it stops being enough
whenever the thing that can be wrong is a decision the *server* makes. A stub
can be told that a duplicate insert throws; only a server can tell you whether
the unique index that would throw exists. A stub can be told what an update
returns; only a server evaluates `{ $max: [0, { $subtract: ['$balance', 5] }] }`.

`tests/integration/` is where those live. They run against a real mongod started
in-process by `tests/helpers/mongo.js` (#631):

```javascript
const { useMongo, buildIndexes } = require('../helpers/mongo');

useMongo();                            // boots mongod, connects, cleans between tests

const User = require('../../src/models/User');

describe('User', () => {
    beforeEach(() => buildIndexes(User));

    test('refuses a second row for the same member in the same guild', async () => {
        await User.create({ userId: '1', guildId: '2' });
        await expect(User.create({ userId: '1', guildId: '2' }))
            .rejects.toMatchObject({ code: 11000 });
    });
});
```

Two things to know before writing one:

- **Indexes are not built for you.** The connection sets `autoIndex: false`,
  because Mongoose otherwise builds schema indexes in the background without
  waiting — and a test asserting that a unique index rejects a duplicate would
  then be racing the connection. Call `buildIndexes(Model, …)` for the indexes
  your test depends on. It is also the only place a malformed
  `partialFilterExpression` is ever rejected.
- **Documents and indexes are both cleared between tests**, so a test never
  passes on its neighbour's setup.

`mongodb-memory-server` downloads a mongod binary the first time it runs and
caches it per machine. If that host is unreachable the suite fails rather than
skipping — a green run has to mean the tests ran — and the failure names the two
ways out, `MONGOMS_SYSTEM_BINARY` and `MONGOMS_DOWNLOAD_URL`.

### Coverage, and the two ratchets on it

`npm run test:coverage` measures; CI runs the same thing with `--ci`. Two
separate guards then apply, and they answer different questions.

**The global floor** lives in `jest.config.js` as `coverageThreshold.global`. It
is measured over all of `src/` — not Jest's default, which counts a file only
once some test requires it and so reports a percentage of the code that is
already tested. Raise the floors when coverage rises; nothing may lower them.

**The per-subsystem floors** live in `coverage-floors.json` and are applied by
`npm run coverage:check`. One number over the whole tree cannot say *where* the
coverage is: `src/services/ai/mcp` is at 94% and `src/commands/economy` at 18%,
so deleting every MCP test would cost about four points of a 37% total and the
global ratchet would stay green. A floor per directory is what notices. The same
file records the files with no executed line at all — that list may shrink and
must not grow, and an entry that has since been covered is an error too, since a
stale one is standing permission to un-cover the file.

`coveredOnlyByIntegration` is the second list in that file, and it is there
because the check runs against whichever suites the run included. `tests/integration/`
needs a real mongod, so a contributor whose machine cannot fetch one runs
without it while CI runs with it — and a file only those suites reach reads as
zero-coverage in the first run and covered in the second. Listing it separately
is what makes both runs agree. `src/models/MigrationRecord.js` is the current
example. For the same reason the directory floors are recorded from the
integration-excluded run, matching what `jest.config.js` does, so the number CI
sees is that or better: `src/migrations` measures 45.8% locally and 81.8% in CI.

Both are ratchets, not targets. When coverage genuinely rises:

```bash
npm run test:coverage
npm run coverage:check -- --update   # never lowers a floor
```

`--update` will not write a number below one already recorded, so it cannot be
used to make a failure go away — a directory that dropped has to be fixed or
explained.

### Logging

Everything the process writes goes through pino (`src/utils/logger.js`). The
entry points install a bridge over `console.*`, so the ~660 call sites already
in the tree get a level, an ISO timestamp and JSON output without being
rewritten — which means the way to log in this codebase is still `console.*`,
and it is not a stopgap:

```javascript
// The [TAG] prefix is the convention, and it is load-bearing: the bridge lifts
// it out and emits it as `component`, which is what a log backend filters on.
console.log('[QUESTS] Rebuilt %d dailies', count);
console.warn('[QUESTS] Skipping guild %s: no settings document', guildId);

// Pass the Error itself rather than error.message. The bridge routes the first
// Error argument into `err`, so the stack is a queryable field instead of text
// flattened into the message.
console.error('[QUESTS] Rebuild failed:', error);
```

Reach for the logger directly when you have structured fields worth keeping:

```javascript
const { logger } = require('../utils/logger');

logger.info({ component: 'QUESTS', guildId, durationMs }, 'Rebuilt dailies');
logger.debug({ component: 'QUESTS', questId }, 'Skipped, already complete');
```

`logger.debug` and `logger.trace` are free when `LOG_LEVEL` is above them — the
call returns before it formats anything — so they are worth leaving in.

**Correlation.** Dashboard requests run inside a context carrying a `requestId`,
and every line written anywhere below them picks it up automatically. Open one
around any other unit of work worth following end to end:

```javascript
const { withContext, addContext } = require('../utils/logger');

await withContext({ jobId, component: 'RSS' }, async () => {
    // every log line in here, however deep, carries jobId
    await pollAllFeeds();
});

addContext({ guildId });   // extends the context already in force
```

**Do not log a credential.** `REDACT_PATHS` in `src/utils/logger.js` censors
`token`, `authorization`, cookies and `apiKey` wherever they appear in a record,
but that is a backstop, not permission — an interpolated string
(`` `key=${apiKey}` ``) is text by the time it arrives and nothing can catch it.

Two things are deliberately *not* wired into the logger. `console.*` is left
alone in `scripts/` and in `src/deploy-commands.js`, which are terminal tools
whose output is the point; and the bridge is installed by `src/index.js` and
`src/shard.js` only, so a test that asserts on `console.error` still sees the
real console. Tests that want the structured record should use
`createLogger({ format: 'json', out })` — see `tests/structuredLogging.test.js`.

## Schema Migrations

`src/migrations/` holds the numbered files that reshape the database, and
`src/migrations/runner.js` applies them. Two facts drive everything about
writing one:

- **They run at boot, automatically**, after the database connects and before
  the bot logs in — see [Schema migrations](../SETUP_GUIDE.md#schema-migrations)
  for the operator's side of that.
- **A failure aborts startup.** Booting on a half-applied schema is worse than
  not booting, so a migration that throws takes the process down with it.

### Writing a migration

Add a file named `NNN_short_description.js` — the number is the apply order, and
it is the next one after the highest already there. It exports a `name` (which
becomes the `MigrationRecord`, so it must never change once shipped), an `up()`,
and a rollback story:

```javascript
// src/migrations/019_add_streak_field.js
const User = require('../models/User');

module.exports = {
    name: '019_add_streak_field',

    // `timeoutMs` receives the budget actually in force (the default 30s, or
    // MIGRATION_TIMEOUT_MS if the operator raised it). Pass it to any query
    // that could run long: the runner stops *waiting* at the budget, it cannot
    // cancel work already sent to the server.
    async up({ timeoutMs }) {
        const result = await User.collection.updateMany(
            { dailyStreak: { $exists: false } },
            { $set: { dailyStreak: 0 } },
            { maxTimeMS: timeoutMs }
        );
        console.log(`[MIGRATIONS] 019: set dailyStreak on ${result.modifiedCount} users`);
    },

    async down() {
        await User.collection.updateMany({}, { $unset: { dailyStreak: '' } });
    },
};
```

Every migration must declare one of two rollback stories, and
`tests/migrationRollback.test.js` fails the build if one does not:

| Export | Use it when |
|---|---|
| `async down()` | The change can be computed backwards — an added field, a created index |
| `irreversible: true` | It cannot: a dropped field, merged documents, a clamped value. Declaring it is what makes the runner take a `mongodump` first, which is then the only way back |

Two optional exports:

- `timeoutMs` — this migration is heavier than the 30s default. The larger of
  this and `MIGRATION_TIMEOUT_MS` applies, so an operator raising the env var is
  never overruled by a file.
- `optional: true` — its failure should not stop the bot booting. Only for work
  the bot is merely *faster* with, such as building an index: it is left
  unrecorded and retried on the next boot, so re-running it later, out of order,
  has to be harmless.

### Rules that are not obvious

- **Never edit a shipped migration.** Its `MigrationRecord` already exists on
  every deployment that has run it, so an edit runs nowhere and the two halves
  of the fleet diverge silently. Write the next number instead.
- **Use `Model.collection`, not the Mongoose model, for bulk rewrites.** Schema
  defaults, setters and validators are written against *today's* schema and will
  quietly rewrite fields the migration is not about.
- **Make it idempotent where you can.** A migration killed after the write but
  before its record is written runs again on the next boot.
- **Do not read from `src/services` or anything above `models`.** Migrations sit
  in the lowest layer (see [Which way dependencies run](#which-way-dependencies-run)),
  and the code above them is on its way to changing.

### Testing a migration

`tests/migrationRunner.test.js` and `tests/migrationRollback.test.js` cover the
runner and the declarations; `tests/integration/migrations.test.js` applies the
real files against a real mongod, which is where a migration's own behaviour
belongs:

```bash
npx jest tests/migrationRollback.test.js
npx jest tests/integration/migrations.test.js   # needs a downloadable mongod
```

Rolling back locally, to check that `down()` does what it says:

```bash
npm run migrate:rollback -- 019_add_streak_field
```

## Best Practices

### Error Handling

```javascript
async execute(interaction) {
    try {
        await interaction.deferReply();
        
        // Your logic
        const result = await someAsyncOperation();
        
        await interaction.editReply(`Success: ${result}`);
    } catch (error) {
        console.error('Command error:', error);
        
        const errorMessage = 'An error occurred. Please try again later.';
        
        if (interaction.deferred) {
            await interaction.editReply(errorMessage);
        } else {
            await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
        }
    }
}
```

### Deferred Replies

For long-running commands:

```javascript
async execute(interaction) {
    // Show "bot is thinking" immediately
    await interaction.deferReply();
    
    // Do long operation
    const result = await longOperation();
    
    // Edit the deferred reply
    await interaction.editReply(`Result: ${result}`);
}
```

### Ephemeral Replies

For a reply only the person who ran the command can see:

```javascript
const { MessageFlags } = require('discord.js');

await interaction.reply({
    content: 'Only you can see this!',
    flags: MessageFlags.Ephemeral
});
```

`flags: MessageFlags.Ephemeral`, not `ephemeral: true`. The boolean option is
deprecated in discord.js v14 — it still works, and logs a deprecation warning
on every call — and this codebase does not use it anywhere. Write the flag and
your file matches the other 800-odd reply sites; write the boolean and the next
person to grep for the pattern finds one file that disagrees.

The same flag goes on `deferReply` when the eventual reply should be private:
`await interaction.deferReply({ flags: MessageFlags.Ephemeral })`. Deferring
publicly and then editing does not make the reply private afterwards.

### Button Interactions

```javascript
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const row = new ActionRowBuilder()
    .addComponents(
        new ButtonBuilder()
            .setCustomId('confirm')
            .setLabel('Confirm')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
    );

await interaction.reply({
    content: 'Choose an option:',
    components: [row]
});

// Handle button click in interactionCreate event
if (interaction.isButton()) {
    if (interaction.customId === 'confirm') {
        await interaction.update({ content: 'Confirmed!', components: [] });
    }
}
```

## Deployment

### Building Docker Image

```bash
docker build -t clawdia:latest .
```

### Running Locally

```bash
npm install
npm start       # Start the bot — it registers its own slash commands
```

`npm start` publishes the command set to Discord on connect, and only when it
differs from the set last published (the fingerprint lives in the
`commanddeployments` collection). That is what makes the Docker deploy work at
all: the image is `CMD ["node", "src/index.js"]` and nothing in either stack
file runs a registration step.

```bash
npm run deploy               # publish now, without starting the bot
DEPLOY_COMMANDS=always npm start   # re-publish on every boot
DEPLOY_COMMANDS=never npm start    # never publish; you drive it by hand
```

While iterating on a command's *shape* — its name, description or options — the
gate notices the change and re-publishes on the next restart. Only the handler
body changes nothing Discord holds, so nothing is sent.

### Environment Variables

Always use environment variables for sensitive data:

```javascript
const token = process.env.DISCORD_TOKEN;
const apiKey = process.env.CUSTOM_API_KEY;
```

Never hardcode tokens or API keys!

## Resources

- [Discord.js Guide](https://discordjs.guide/)
- [Discord.js Documentation](https://discord.js.org/)
- [Discord API Documentation](https://discord.com/developers/docs/)
- [MongoDB Documentation](https://docs.mongodb.com/)
- [Express.js Documentation](https://expressjs.com/)
- [Node-cron Documentation](https://www.npmjs.com/package/node-cron)

## Contributing

This file is the *how* — how to add a command, a model, a route, a migration.
[CONTRIBUTING.md](../CONTRIBUTING.md) is the *process*: getting set up, what has
to be green before a pull request is worth opening, the coverage ratchets, and
the handful of things about this codebase that surprise people.

Happy coding! 🚀