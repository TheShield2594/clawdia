const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ButtonBuilder,
    ButtonStyle,
} = require('discord.js');

const TIMEOUT_MS = 3 * 60 * 1000;
const PAGE_SIZE = 10;
const COLOR = '#5865F2';

const CATEGORIES = [
    {
        id: 'economy',
        emoji: '📦',
        label: 'Economy',
        preview: 'balance, work, hunt, fish, games',
        commands: [
            { name: 'balance',        description: 'Check your wallet and bank balance' },
            { name: 'daily',          description: 'Claim your daily coin reward (24h cooldown)' },
            { name: 'work',           description: 'Earn coins by working a shift (1h cooldown)' },
            { name: 'deposit',        description: 'Deposit coins into your bank' },
            { name: 'withdraw',       description: 'Withdraw coins from your bank' },
            { name: 'transfer',       description: 'Transfer coins to another user' },
            { name: 'inventory',      description: 'View your or another user\'s inventory' },
            { name: 'shop',           description: 'Browse the item shop' },
            { name: 'use',            description: 'Use an item from your inventory' },
            { name: 'jobs',           description: 'Browse all available jobs and pay ranges' },
            { name: 'crime',          description: 'Attempt a crime for coins (40% success, 4h cooldown)' },
            { name: 'rob',            description: 'Try to rob another member\'s wallet' },
            { name: 'mine',           description: 'Dig for ore in the mines (2h cooldown)' },
            { name: 'hunt',           description: 'Hunt animals in your zone (30s cooldown)' },
            { name: 'huntinv',        description: 'View and manage your hunt inventory' },
            { name: 'huntprofile',    description: 'View your or another player\'s hunter profile' },
            { name: 'huntquests',     description: 'View and claim your daily hunt quests' },
            { name: 'huntshop',       description: 'Buy hunting consumables and ammunition' },
            { name: 'buygun',         description: 'Purchase a weapon for hunting' },
            { name: 'zone',           description: 'Manage your hunting zones' },
            { name: 'repair',         description: 'Repair your equipped weapon' },
            { name: 'craft',          description: 'Craft items from hunting materials' },
            { name: 'prestige',       description: 'Reset hunter level for permanent prestige bonuses (requires Level 50)' },
            { name: 'fish',           description: 'Cast your line and catch fish (25s cooldown)' },
            { name: 'fishinv',        description: 'View and manage your fishing inventory' },
            { name: 'fishprofile',    description: 'View your or another player\'s fishing profile' },
            { name: 'fishquests',     description: 'View and claim your daily fishing quests' },
            { name: 'fishshop',       description: 'Browse and purchase fishing supplies' },
            { name: 'buyrod',         description: 'Purchase a fishing rod or upgrade an existing one' },
            { name: 'location',       description: 'Manage your fishing locations' },
            { name: 'fishrepair',     description: 'Repair your equipped fishing rod' },
            { name: 'fishprestige',   description: 'Reset fisher level for permanent prestige bonuses (requires Level 50)' },
            { name: 'blackjack',      description: 'Play blackjack against the dealer' },
            { name: 'baccarat',       description: 'Play a game of baccarat' },
            { name: 'slots',          description: 'Spin the slot machine' },
            { name: 'roulette',       description: 'Play roulette' },
            { name: 'crash',          description: 'Play the crash game' },
            { name: 'plinko',         description: 'Drop a ball through the plinko board' },
            { name: 'wheel',          description: 'Spin the prize wheel' },
            { name: 'higherlower',    description: 'Guess higher or lower to win coins' },
            { name: 'doubleornothing', description: 'Risk your coins for double or nothing' },
            { name: 'duel',           description: 'Challenge another user to a coin duel' },
            { name: 'quiz',           description: 'Answer trivia questions to win coins' },
        ],
    },
    {
        id: 'moderation',
        emoji: '🛡️',
        label: 'Moderation',
        preview: 'ban, kick, warn, cases, tickets',
        commands: [
            { name: 'ban',       description: 'Ban a member from the server' },
            { name: 'kick',      description: 'Kick a member from the server' },
            { name: 'warn',      description: 'Manage member warnings' },
            { name: 'mute',      description: 'Timeout a member' },
            { name: 'unmute',    description: 'Remove timeout from a member' },
            { name: 'unban',     description: 'Unban a user from the server' },
            { name: 'softban',   description: 'Ban then unban to purge recent messages' },
            { name: 'massban',   description: 'Ban multiple users by ID (raid cleanup)' },
            { name: 'clear',     description: 'Delete multiple messages' },
            { name: 'slowmode',  description: 'Set or clear slowmode for a channel' },
            { name: 'lockdown',  description: 'Lock or unlock all text channels server-wide' },
            { name: 'case',      description: 'View a moderation case' },
            { name: 'cases',     description: 'List moderation cases for a user' },
            { name: 'closecase', description: 'Close a moderation case' },
            { name: 'note',      description: 'Add a note to a case or assign/label it' },
            { name: 'ticket',    description: 'Ticket system for support requests' },
            { name: 'appeal',    description: 'Appeal a moderation case against you' },
        ],
    },
    {
        id: 'music',
        emoji: '🎵',
        label: 'Music',
        preview: 'play, skip, queue',
        commands: [
            { name: 'play',       description: 'Play a song in your voice channel (requires DJ role)' },
            { name: 'skip',       description: 'Skip the current song' },
            { name: 'stop',       description: 'Stop the music and clear the queue' },
            { name: 'queue',      description: 'View the music queue' },
            { name: 'nowplaying', description: 'Show the currently playing song' },
        ],
    },
    {
        id: 'leveling',
        emoji: '⭐',
        label: 'Leveling',
        preview: 'rank, leaderboard, level roles',
        commands: [
            { name: 'rank',        description: 'View your rank card showing level, XP, and position' },
            { name: 'leaderboard', description: 'View the top 10 members on the server leaderboard' },
            { name: 'levelrole',   description: 'Manage roles awarded when members reach a level' },
            { name: 'setlevel',    description: 'Directly assign a level to a member (admin)' },
        ],
    },
    {
        id: 'fun',
        emoji: '🎮',
        label: 'Fun',
        preview: '8ball, coinflip, roll',
        commands: [
            { name: '8ball',    description: 'Ask the magic 8-ball a question' },
            { name: 'coinflip', description: 'Flip a coin — heads or tails' },
            { name: 'roll',     description: 'Roll dice with a given number of sides' },
        ],
    },
    {
        id: 'utility',
        emoji: '🔧',
        label: 'Utility',
        preview: 'avatar, polls, giveaway, bible',
        commands: [
            { name: 'avatar',     description: 'Fetch and display a user\'s full-size avatar' },
            { name: 'userinfo',   description: 'Show info about a user (account age, roles, etc.)' },
            { name: 'serverinfo', description: 'Display server stats: members, channels, boost level' },
            { name: 'ping',       description: 'Check the bot\'s latency' },
            { name: 'poll',       description: 'Create a button-based poll' },
            { name: 'giveaway',   description: 'Manage giveaways' },
            { name: 'birthday',   description: 'Manage birthdays' },
            { name: 'bible',      description: 'Look up a Bible verse or get the daily verse' },
            { name: 'starboard',  description: 'Configure the starboard' },
            { name: 'suggest',    description: 'Submit a suggestion to the server' },
            { name: 'role',       description: 'Self-assign or remove a role from reaction role panels' },
            { name: 'vc',         description: 'Manage your temporary voice channel' },
        ],
    },
    {
        id: 'ai',
        emoji: '🤖',
        label: 'AI',
        preview: 'AI chat & reminders',
        commands: [
            { name: 'remind',   description: 'Set a reminder — bot will DM you after the specified time' },
            { name: '@Ultrabot', description: 'Mention or ping the bot to start an AI conversation', mention: true },
        ],
    },
    {
        id: 'community',
        emoji: '👥',
        label: 'Community',
        preview: 'season, quests, streak, track',
        commands: [
            { name: 'quests', description: 'View your active daily and weekly quests' },
            { name: 'season', description: 'View season pass progress or manage the current season' },
            { name: 'streak', description: 'View your activity streak' },
            { name: 'track',  description: 'View or set your progression track' },
        ],
    },
    {
        id: 'admin',
        emoji: '⚙️',
        label: 'Admin',
        preview: 'settings, raid mode, news',
        commands: [
            { name: 'settings',  description: 'Get the dashboard link to configure the bot' },
            { name: 'raidmode',  description: 'Configure raid detection and case management settings' },
            { name: 'dailynews', description: 'Manually trigger the daily news digest' },
        ],
    },
];

function buildLandingEmbed() {
    const lines = CATEGORIES.map(cat =>
        `${cat.emoji} **${cat.label}** — ${cat.commands.length} commands: ${cat.preview}`
    );
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle('🤖 Ultrabot Help')
        .setDescription(
            'Select a category below to see available commands.\n\n' +
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            lines.join('\n') +
            '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        )
        .setFooter({ text: 'Select a category from the dropdown below' });
}

function buildCategoryEmbed(cat, page) {
    const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
    const slice = cat.commands.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const lines = slice.map(cmd =>
        cmd.mention
            ? `\`${cmd.name}\` — ${cmd.description}`
            : `\`/${cmd.name}\` — ${cmd.description}`
    );
    return new EmbedBuilder()
        .setColor(COLOR)
        .setTitle(`${cat.emoji} ${cat.label} Commands`)
        .setDescription(
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n' +
            lines.join('\n') +
            '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
        )
        .setFooter({ text: `Page ${page + 1} of ${totalPages} • ${cat.commands.length} commands total` });
}

function buildSelectRow(disabled = false) {
    const menu = new StringSelectMenuBuilder()
        .setCustomId('help_category')
        .setPlaceholder('Select a category…')
        .setDisabled(disabled)
        .addOptions(
            CATEGORIES.map(cat =>
                new StringSelectMenuOptionBuilder()
                    .setLabel(`${cat.emoji} ${cat.label}`)
                    .setDescription(`${cat.commands.length} commands: ${cat.preview}`)
                    .setValue(cat.id)
            )
        );
    return new ActionRowBuilder().addComponents(menu);
}

function buildNavRow(id, cat, page, disabled = false) {
    const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
    const backBtn = new ButtonBuilder()
        .setCustomId(`help_back_${id}`)
        .setLabel('↩ Back')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled);

    if (totalPages <= 1) {
        return new ActionRowBuilder().addComponents(backBtn);
    }

    const prevBtn = new ButtonBuilder()
        .setCustomId(`help_prev_${id}`)
        .setLabel('◀')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || page === 0);

    const nextBtn = new ButtonBuilder()
        .setCustomId(`help_next_${id}`)
        .setLabel('▶')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled || page >= totalPages - 1);

    return new ActionRowBuilder().addComponents(prevBtn, backBtn, nextBtn);
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Browse all bot commands by category'),
    async execute(interaction) {
        const id = interaction.id;
        const state = { view: 'landing', catId: null, page: 0 };

        await interaction.reply({
            embeds: [buildLandingEmbed()],
            components: [buildSelectRow()],
        });

        const message = await interaction.fetchReply();

        const collector = message.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: TIMEOUT_MS,
        });

        collector.on('collect', async i => {
            if (i.customId === 'help_category') {
                const cat = CATEGORIES.find(c => c.id === i.values[0]);
                state.view = 'category';
                state.catId = cat.id;
                state.page = 0;
                await i.update({
                    embeds: [buildCategoryEmbed(cat, 0)],
                    components: [buildNavRow(id, cat, 0)],
                });
            } else if (i.customId === `help_back_${id}`) {
                state.view = 'landing';
                state.catId = null;
                state.page = 0;
                await i.update({
                    embeds: [buildLandingEmbed()],
                    components: [buildSelectRow()],
                });
            } else if (i.customId === `help_prev_${id}`) {
                const cat = CATEGORIES.find(c => c.id === state.catId);
                const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
                state.page = Math.max(0, Math.min(state.page - 1, totalPages - 1));
                await i.update({
                    embeds: [buildCategoryEmbed(cat, state.page)],
                    components: [buildNavRow(id, cat, state.page)],
                });
            } else if (i.customId === `help_next_${id}`) {
                const cat = CATEGORIES.find(c => c.id === state.catId);
                const totalPages = Math.ceil(cat.commands.length / PAGE_SIZE);
                state.page = Math.max(0, Math.min(state.page + 1, totalPages - 1));
                await i.update({
                    embeds: [buildCategoryEmbed(cat, state.page)],
                    components: [buildNavRow(id, cat, state.page)],
                });
            }
        });

        collector.on('end', async (_, reason) => {
            if (reason !== 'time') return;
            if (state.view === 'landing') {
                await interaction.editReply({ components: [buildSelectRow(true)] }).catch(() => {});
            } else {
                const cat = CATEGORIES.find(c => c.id === state.catId);
                await interaction.editReply({
                    components: [buildNavRow(id, cat, state.page, true)],
                }).catch(() => {});
            }
        });
    },
};
