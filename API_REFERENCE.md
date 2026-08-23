# Clawdia API Reference

## Developer Guide for Extending Clawdia

This guide is for developers who want to add custom features or modify existing functionality.

## Project Structure

```
src/
├── commands/          # Slash commands by category
│   ├── admin/        # Administrator commands
│   ├── ai/           # AI-related commands
│   ├── economy/      # Economy system
│   ├── fun/          # Fun/entertainment
│   ├── leveling/     # XP and leveling
│   ├── moderation/   # Moderation tools
│   ├── music/        # Music player
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

// Get guild settings
const settings = await Guild.findOne({ guildId: interaction.guild.id });

// Update settings
settings.leveling.enabled = true;
await settings.save();

// Create new guild
await Guild.create({
    guildId: guild.id,
    name: guild.name
});
```

### Accessing User Data

```javascript
const User = require('../models/User');

// Get user data
const user = await User.findOne({ 
    userId: interaction.user.id, 
    guildId: interaction.guild.id 
});

// Update user data
user.xp += 50;
user.coins += 100;
await user.save();

// Create new user
await User.create({
    userId: user.id,
    guildId: guild.id,
    xp: 0,
    level: 1,
    coins: 0
});
```

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
        client: req.client
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

### Adding API Endpoints

```javascript
// In src/dashboard/routes/api.js

router.get('/api/custom/:guildId', checkAuth, async (req, res) => {
    try {
        const { guildId } = req.params;
        
        // Your logic here
        const data = await getCustomData(guildId);
        
        res.json({ success: true, data });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.post('/api/custom/:guildId', checkAuth, async (req, res) => {
    try {
        const { guildId } = req.params;
        const { field1, field2 } = req.body;
        
        // Your logic here
        await saveCustomData(guildId, field1, field2);
        
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: 'Internal server error' });
    }
});
```

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