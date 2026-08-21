const express = require('express');
const router = express.Router();
const Guild = require('../../../models/Guild');
const { checkAuth, checkGuildAccess, checkWriteRateLimit } = require('../../lib/middleware');
const { sanitizeMongoValue, logAuditEvent } = require('../../lib/apiHelpers');
const { rescheduleDailyNews } = require('../../../services/rssService');
const { rescheduleBibleVerse } = require('../../../services/dailyBibleService');

// Top-level Guild schema keys that the dashboard is allowed to update.
// This whitelist prevents prototype pollution (__proto__, constructor, etc.)
// and limits surface area to only fields the dashboard UI actually manages.
// Keep in sync with the field names the saveSettings() function in
// guild-settings.ejs actually sends — anything missing causes a 400.
const ALLOWED_SETTING_PARENTS = new Set([
    'welcome', 'farewell', 'birthdays',
    'moderation', 'leveling', 'levelRoles',
    'economy', 'shop', 'jobs', 'jobTiers',
    'achievements',
    'raidDetection', 'antiNuke', 'caseSettings',
    'starboard', 'eventLog', 'quests',
    'season', 'progressionTracks', 'commandPolicies',
    'suggestions', 'ai', 'tempVoice', 'bibleVerse',
    'dailyNews', 'dailyNewsProfiles', 'rssFeeds',
    'autoRoles', 'reactionRoles',
    'giveaways', 'notifications',
    'newspaper', 'heist', 'exploration',
    'dynamicPricing'
]);

function isAllowedSettingKey(key) {
    if (typeof key !== 'string') return false;
    const top = key.split('.')[0];
    return ALLOWED_SETTING_PARENTS.has(top);
}

// Field-level validation for welcome settings before they reach Mongoose (fix #12).
// Returns an error string, or null if valid.
function validateWelcomeUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('welcome.') && key !== 'welcome') continue;
        const field = key.split('.')[1];
        if (field === 'message' || field === 'dmMessage') {
            if (typeof value !== 'string') return `welcome.${field} must be a string`;
            if (value.length > 4000) return `welcome.${field} exceeds 4000 characters`;
        }
        if (field === 'enabled' || field === 'cardEnabled' || field === 'dmEnabled') {
            if (typeof value !== 'boolean') return `welcome.${field} must be a boolean`;
        }
        if (field === 'channelId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'welcome.channelId must be a valid Discord snowflake or null';
            }
        }
    }
    return null;
}

function validateFarewellUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('farewell.') && key !== 'farewell') continue;
        const field = key.split('.')[1];
        if (field === 'message') {
            if (typeof value !== 'string') return 'farewell.message must be a string';
            if (value.length > 4000) return 'farewell.message exceeds 4000 characters';
        }
        if (field === 'enabled') {
            if (typeof value !== 'boolean') return 'farewell.enabled must be a boolean';
        }
        if (field === 'channelId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'farewell.channelId must be a valid Discord snowflake or null';
            }
        }
    }
    return null;
}

function validateBirthdaysUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('birthdays.') && key !== 'birthdays') continue;
        const field = key.split('.')[1];
        if (field === 'message') {
            if (typeof value !== 'string') return 'birthdays.message must be a string';
            if (value.length > 2000) return 'birthdays.message exceeds 2000 characters';
        }
        if (field === 'enabled') {
            if (typeof value !== 'boolean') return 'birthdays.enabled must be a boolean';
        }
        if (field === 'channelId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'birthdays.channelId must be a valid Discord snowflake or null';
            }
        }
        if (field === 'roleId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'birthdays.roleId must be a valid Discord snowflake or null';
            }
        }
        if (field === 'wishingHourUtc') {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 23) {
                return 'birthdays.wishingHourUtc must be an integer between 0 and 23';
            }
        }
    }
    return null;
}

function validateEventLogUpdate(updates) {
    const EVENT_LOG_BOOLEAN_FIELDS = new Set([
        'enabled', 'logMessageEdit', 'logMessageDelete', 'logMessageBulkDelete',
        'logMemberJoin', 'logMemberLeave', 'logNicknameChange', 'logUsernameChange',
        'logAvatarChange', 'logTimeout', 'logBoost',
        'logRoleChanges', 'logChannelChanges',
        'logVoiceJoin', 'logVoiceLeave', 'logVoiceMove', 'logVoiceMuteDeafen',
        'logInviteCreate', 'logInviteDelete', 'logServerUpdate', 'logEmojiUpdate',
        'logWebhookUpdate', 'logBotAdd',
        'logThreadCreate', 'logThreadDelete', 'logThreadArchive',
    ]);
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('eventLog.') && key !== 'eventLog') continue;
        const field = key.split('.')[1];
        if (EVENT_LOG_BOOLEAN_FIELDS.has(field)) {
            if (typeof value !== 'boolean') return `eventLog.${field} must be a boolean`;
        }
        if (field === 'channelId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'eventLog.channelId must be a valid Discord snowflake or null';
            }
        }
    }
    return null;
}

const VALID_BIBLE_TRANSLATIONS = new Set(['kjv', 'niv', 'asv', 'web', 'ylt', 'darby', 'bbe', 'webbe']);

function validateBibleVerseUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('bibleVerse.') && key !== 'bibleVerse') continue;
        const field = key.split('.')[1];
        if (field === 'enabled' || field === 'autoRespond') {
            if (typeof value !== 'boolean') return `bibleVerse.${field} must be a boolean`;
        }
        if (field === 'channelId' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
                return 'bibleVerse.channelId must be a valid Discord snowflake or null';
            }
        }
        if (field === 'time' && value !== null && value !== '') {
            if (typeof value !== 'string' || !/^\d{1,2}:\d{2}$/.test(value)) {
                return 'bibleVerse.time must be in HH:MM format (e.g. 08:00)';
            }
            const [h, m] = value.split(':').map(Number);
            if (h < 0 || h > 23 || m < 0 || m > 59) {
                return 'bibleVerse.time must be a valid 24-hour time (00:00–23:59)';
            }
        }
        if (field === 'timezone' && value !== null && value !== '') {
            if (typeof value !== 'string') return 'bibleVerse.timezone must be a string';
            try {
                Intl.DateTimeFormat(undefined, { timeZone: value });
            } catch {
                return `bibleVerse.timezone "${value}" is not a valid IANA timezone`;
            }
        }
        if (field === 'translation') {
            if (!VALID_BIBLE_TRANSLATIONS.has(value)) {
                return `bibleVerse.translation must be one of: ${[...VALID_BIBLE_TRANSLATIONS].join(', ')}`;
            }
        }
    }
    return null;
}

function validateSnowflakeOrNull(value, label) {
    if (value === null || value === '' || value === undefined) return null;
    if (typeof value !== 'string' || !/^\d{17,20}$/.test(value)) {
        return `${label} must be a valid Discord snowflake or null`;
    }
    return null;
}

function validateNewspaperUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('newspaper.') && key !== 'newspaper') continue;
        const field = key.split('.')[1];
        if (field === 'channelId') {
            const err = validateSnowflakeOrNull(value, 'newspaper.channelId');
            if (err) return err;
        }
        if (field === 'quoteChannelIds') {
            if (!Array.isArray(value) || value.length > 100) return 'newspaper.quoteChannelIds must be an array of at most 100 channel ids';
            for (const id of value) {
                const err = validateSnowflakeOrNull(id, 'newspaper.quoteChannelIds entry');
                if (err) return err;
            }
        }
    }
    return null;
}

// Field-level validation for exploration settings before they reach Mongoose.
// Returns an error string, or null if valid.
function validateExplorationUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('exploration.') && key !== 'exploration') continue;
        const field = key.split('.')[1];
        if (field === 'enabled' || field === 'announceSecrets') {
            if (typeof value !== 'boolean') return `exploration.${field} must be a boolean`;
        }
        if (field === 'dropRateMultiplier') {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.1 || value > 5) {
                return 'exploration.dropRateMultiplier must be a number between 0.1 and 5';
            }
        }
        if (field === 'rareEventBonus') {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 0.25) {
                return 'exploration.rareEventBonus must be a number between 0 and 0.25';
            }
        }
        if (field === 'disabledRegions') {
            if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || v.length > 64)) {
                return 'exploration.disabledRegions must be an array of at most 100 region id strings';
            }
        }
    }
    return null;
}

function validateDynamicPricingUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('dynamicPricing.') && key !== 'dynamicPricing') continue;
        const field = key.split('.')[1];
        if (field === 'enabled') {
            if (typeof value !== 'boolean') return 'dynamicPricing.enabled must be a boolean';
        }
        if (field === 'volatility') {
            if (!['low', 'medium', 'high'].includes(value)) return "dynamicPricing.volatility must be 'low', 'medium', or 'high'";
        }
        if (field === 'priceBand') {
            if (typeof value !== 'number' || !Number.isFinite(value) || value < 0.05 || value > 0.9) {
                return 'dynamicPricing.priceBand must be a number between 0.05 and 0.9';
            }
        }
        if (field === 'recalcMinutes') {
            if (typeof value !== 'number' || !Number.isInteger(value) || value < 15 || value > 1440) {
                return 'dynamicPricing.recalcMinutes must be an integer between 15 and 1440';
            }
        }
    }
    return null;
}

function validateHeistUpdate(updates) {
    for (const [key, value] of Object.entries(updates)) {
        if (!key.startsWith('heist.') && key !== 'heist') continue;
        const field = key.split('.')[1];
        if (field === 'announceChannelId') {
            const err = validateSnowflakeOrNull(value, 'heist.announceChannelId');
            if (err) return err;
        }
    }
    return null;
}

router.post('/guild/:guildId/settings', checkAuth, checkGuildAccess, checkWriteRateLimit, async (req, res) => {
    const { guildId } = req.params;
    const updates = req.body;

    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
        return res.status(400).json({ error: 'Request body must be a plain object' });
    }

    const rejectedKeys = Object.keys(updates).filter(k => !isAllowedSettingKey(k));
    if (rejectedKeys.length) {
        return res.status(400).json({ error: `Disallowed setting key(s): ${rejectedKeys.join(', ')}` });
    }

    const welcomeError = validateWelcomeUpdate(updates);
    if (welcomeError) return res.status(400).json({ error: welcomeError });

    const farewellError = validateFarewellUpdate(updates);
    if (farewellError) return res.status(400).json({ error: farewellError });

    const birthdaysError = validateBirthdaysUpdate(updates);
    if (birthdaysError) return res.status(400).json({ error: birthdaysError });

    const bibleVerseError = validateBibleVerseUpdate(updates);
    if (bibleVerseError) return res.status(400).json({ error: bibleVerseError });

    const eventLogError = validateEventLogUpdate(updates);
    if (eventLogError) return res.status(400).json({ error: eventLogError });

    const newspaperError = validateNewspaperUpdate(updates);
    if (newspaperError) return res.status(400).json({ error: newspaperError });

    const dynamicPricingError = validateDynamicPricingUpdate(updates);
    if (dynamicPricingError) return res.status(400).json({ error: dynamicPricingError });

    const heistError = validateHeistUpdate(updates);
    if (heistError) return res.status(400).json({ error: heistError });

    const explorationError = validateExplorationUpdate(updates);
    if (explorationError) return res.status(400).json({ error: explorationError });

    try {
        const guildSettings = await Guild.findOne({ guildId });

        if (!guildSettings) {
            return res.status(404).json({ error: 'Guild not found' });
        }

        // Shop item images live inline at guild.shop[].imageData. The dashboard
        // never round-trips those Buffers, so a naive replace of the shop array
        // would wipe every saved image. Preserve imageData/imageType from the
        // existing items, matched by itemId.
        if (Array.isArray(updates.shop)) {
            const existingImages = new Map();
            for (const item of guildSettings.shop || []) {
                if (item && item.itemId && item.imageData) {
                    existingImages.set(item.itemId, { imageData: item.imageData, imageType: item.imageType });
                }
            }
            updates.shop = updates.shop.map(item => {
                if (!item || !item.itemId) return item;
                const preserved = existingImages.get(item.itemId);
                if (!preserved) return item;
                return { ...item, imageData: preserved.imageData, imageType: preserved.imageType };
            });
        }

        // H1: Strip any MongoDB operator keys ($ne, $regex, etc.) before writing.
        Object.keys(updates).forEach(key => {
            guildSettings.set(key, sanitizeMongoValue(updates[key]));
        });

        await guildSettings.save();

        // L1: Record what changed and who changed it.
        await logAuditEvent(req, guildId, 'settings_update', { keys: Object.keys(updates) });

        const shouldRescheduleDailyNews = Object.keys(updates).some(key => key.startsWith('dailyNews.') || key === 'dailyNewsProfiles');
        if (shouldRescheduleDailyNews) {
            rescheduleDailyNews(req.client, guildId);
        }

        const shouldRescheduleBible = Object.keys(updates).some(key => key.startsWith('bibleVerse.'));
        if (shouldRescheduleBible) {
            rescheduleBibleVerse(req.client, guildId);
        }

        // Deliberately does not echo the saved document. It carries every shop
        // item's imageData Buffer (base64-inflated in JSON) plus up to 3000
        // analytics.commandUsage entries, and the client only ever reads this
        // body on a non-2xx response.
        res.json({ success: true });
    } catch (error) {
        if (error.name === 'ValidationError') {
            return res.status(400).json({ error: error.message });
        }
        console.error('API error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
module.exports.validateEventLogUpdate = validateEventLogUpdate;
