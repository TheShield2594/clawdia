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
    async execute(interaction) {
        // Only users with Manage Messages can use this
        await interaction.reply('Announcement!');
    }
};
```

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

`--forceExit` is in the npm script rather than in a config: a few suites leave a
mongoose connection or a timer handle open, and without it Jest waits on them
after the last assertion has already passed.

### How the suite is laid out

- One file per subject, named after it: `tests/huntRepair.test.js`,
  `tests/rollPayout.test.js`. There is no `jest.config.js` — the defaults apply,
  so anything matching `*.test.js` is collected.
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

### Logging

```javascript
// Simple console logging
console.log('[INFO]', 'Something happened');
console.error('[ERROR]', 'Error occurred:', error);

// With timestamps
const timestamp = new Date().toISOString();
console.log(`[${timestamp}] Event occurred`);
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
            await interaction.reply({ content: errorMessage, ephemeral: true });
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

For private responses:

```javascript
await interaction.reply({
    content: 'Only you can see this!',
    ephemeral: true
});
```

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
npm run deploy  # Deploy commands to Discord
npm start       # Start the bot
```

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

When adding new features:

1. Create commands in appropriate category folder
2. Use existing patterns and conventions
3. Add proper error handling
4. Test thoroughly before committing
5. Update documentation
6. Consider dashboard integration

Happy coding! 🚀