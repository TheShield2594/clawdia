const Automation = require('../models/Automation');
const AutomationLog = require('../models/AutomationLog');
const Guild = require('../models/Guild');
const { executeAction } = require('./composioService');
const cron = require('node-cron');

// Scheduled automation cron handles, keyed by automationId string
const cronHandles = new Map();

// In-memory set of guildIds that have at least one active message_keyword automation.
// Prevents a DB round-trip on every non-bot message when no keyword automations exist.
const keywordGuilds = new Set();

// ------------------------------------------------------------------
// Variable substitution
// ------------------------------------------------------------------

function substitute(value, ctx) {
    if (typeof value !== 'string') return value;
    return value.replace(/\{([\w.]+)\}/g, (match, key) => {
        const parts = key.split('.');
        let v = ctx;
        for (const part of parts) v = v?.[part];
        return v != null ? String(v) : match;
    });
}

function substituteInput(input, ctx) {
    if (input == null || typeof input !== 'object') return input;
    if (Array.isArray(input)) return input.map(item => substituteInput(item, ctx));
    const result = {};
    for (const [k, v] of Object.entries(input)) {
        result[k] = (v != null && typeof v === 'object' && !Array.isArray(v))
            ? substituteInput(v, ctx)
            : substitute(v, ctx);
    }
    return result;
}

// Strip fields that may contain PII before persisting the log context
function sanitizeCtx(ctx) {
    const safe = { ...ctx };
    if (safe.message) safe.message = { channelId: safe.message.channelId };
    return safe;
}

// ------------------------------------------------------------------
// Core: run all enabled automations for a guild that match triggerType
// ------------------------------------------------------------------

async function fire(guildId, triggerType, ctx) {
    let automations;
    try {
        automations = await Automation.find({ guildId, enabled: true, 'trigger.type': triggerType });
    } catch (err) {
        console.error(`[AutomationEngine] DB error fetching automations for ${guildId}:`, err.message);
        return;
    }

    if (!automations.length) return;

    let apiKey = null;
    try {
        const guild = await Guild.findOne({ guildId }, { 'integrations.composioApiKey': 1 }).lean();
        apiKey = guild?.integrations?.composioApiKey || null;
    } catch {}

    for (const automation of automations) {
        if (!matchesTriggerConfig(automation.trigger, ctx)) continue;

        const resolvedInput = substituteInput(automation.action.input, ctx);
        let success = false;
        let error = null;

        try {
            await executeAction(guildId, apiKey, automation.action.actionName, resolvedInput);
            success = true;
        } catch (err) {
            error = err.message;
            console.error(`[AutomationEngine] Action failed for automation "${automation.name}":`, err.message);
        }

        automation.runCount += 1;
        automation.lastRunAt = new Date();
        await automation.save().catch(() => null);

        await AutomationLog.create({
            guildId,
            automationId: automation._id,
            automationName: automation.name,
            triggerType,
            success,
            error,
            contextData: sanitizeCtx(ctx),
            executedAt: new Date()
        }).catch(() => null);
    }
}

// Return false if the event doesn't satisfy the automation's trigger config
function matchesTriggerConfig(trigger, ctx) {
    const cfg = trigger.config || {};

    if (trigger.type === 'message_keyword') {
        if (!cfg.keyword) return true;
        return (ctx.message?.content || '').toLowerCase().includes(cfg.keyword.toLowerCase());
    }

    if (trigger.type === 'role_assigned') {
        if (!cfg.roleId) return true;
        return ctx.role?.id === cfg.roleId;
    }

    if (trigger.type === 'moderation_action') {
        if (!cfg.actionType) return true;
        return ctx.action?.type === cfg.actionType;
    }

    if (trigger.type === 'level_up') {
        if (!cfg.level) return true;
        return ctx.level >= Number(cfg.level);
    }

    return true;
}

// ------------------------------------------------------------------
// Scheduled automations (cron)
// ------------------------------------------------------------------

async function loadScheduledAutomations() {
    try {
        const scheduled = await Automation.find({ enabled: true, 'trigger.type': 'scheduled' });
        for (const automation of scheduled) {
            scheduleAutomation(automation);
        }

        // Populate keyword guild cache
        const keywordDocs = await Automation.distinct('guildId', { enabled: true, 'trigger.type': 'message_keyword' });
        for (const guildId of keywordDocs) keywordGuilds.add(guildId);

        console.log(`[AutomationEngine] Loaded ${scheduled.length} scheduled automation(s), ${keywordGuilds.size} guild(s) with keyword triggers`);
    } catch (err) {
        console.error('[AutomationEngine] Failed to load automations:', err.message);
    }
}

function scheduleAutomation(automation) {
    const cronExpr = automation.trigger.config?.cron;
    if (!cronExpr || !cron.validate(cronExpr)) return;

    unscheduleAutomation(automation._id.toString());

    const tz = automation.trigger.config?.timezone;
    const handle = cron.schedule(cronExpr, async () => {
        const ctx = {
            guild: { id: automation.guildId },
            timestamp: new Date().toISOString()
        };
        await fire(automation.guildId, 'scheduled', ctx);
    }, tz ? { timezone: tz } : undefined);

    cronHandles.set(automation._id.toString(), handle);
}

function unscheduleAutomation(automationId) {
    const handle = cronHandles.get(automationId);
    if (handle) {
        handle.stop();
        cronHandles.delete(automationId);
    }
}

function refreshScheduledAutomation(automation) {
    if (automation.trigger?.type !== 'scheduled') return;
    if (automation.enabled) {
        scheduleAutomation(automation);
    } else {
        unscheduleAutomation(automation._id.toString());
    }
}

// ------------------------------------------------------------------
// Discord event hooks
// ------------------------------------------------------------------

function init(client) {
    client.on('guildMemberAdd', async (member) => {
        const ctx = buildUserCtx(member.user, member.guild);
        await fire(member.guild.id, 'member_join', ctx);
    });

    client.on('guildMemberRemove', async (member) => {
        const ctx = buildUserCtx(member.user, member.guild);
        await fire(member.guild.id, 'member_leave', ctx);
    });

    client.on('messageCreate', async (message) => {
        if (message.author.bot || !message.guild) return;
        // Skip DB call entirely when no automations use keyword triggers for this guild
        if (!keywordGuilds.has(message.guild.id)) return;

        const ctx = {
            user:    { id: message.author.id, name: message.author.username, tag: message.author.tag },
            guild:   { id: message.guild.id, name: message.guild.name },
            message: { content: message.content, channelId: message.channelId },
            timestamp: new Date().toISOString()
        };
        await fire(message.guild.id, 'message_keyword', ctx);
    });

    client.on('guildMemberUpdate', async (oldMember, newMember) => {
        if (!newMember.guild) return;
        const addedRoles = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id));
        for (const role of addedRoles.values()) {
            // Skip the synthetic @everyone role (its id matches the guild id)
            if (role.id === newMember.guild.id) continue;
            const ctx = {
                user:  { id: newMember.user.id, name: newMember.user.username, tag: newMember.user.tag },
                role:  { id: role.id, name: role.name },
                guild: { id: newMember.guild.id, name: newMember.guild.name },
                timestamp: new Date().toISOString()
            };
            await fire(newMember.guild.id, 'role_assigned', ctx);
        }
    });

    loadScheduledAutomations().catch(console.error);

    console.log('[AutomationEngine] Initialized');
}

async function fireModerationAction(guildId, targetUser, moderator, actionType, reason) {
    const ctx = {
        user:   { id: targetUser.id, name: targetUser.username, tag: targetUser.tag },
        mod:    { id: moderator.id,  name: moderator.username },
        action: { type: actionType, reason: reason || '' },
        guild:  { id: guildId },
        timestamp: new Date().toISOString()
    };
    await fire(guildId, 'moderation_action', ctx);
}

async function fireLevelUp(guildId, user, level) {
    const ctx = {
        user:  { id: user.id, name: user.username, tag: user.tag },
        level,
        guild: { id: guildId },
        timestamp: new Date().toISOString()
    };
    await fire(guildId, 'level_up', ctx);
}

function buildUserCtx(user, guild) {
    return {
        user:  { id: user.id, name: user.username, tag: user.tag },
        guild: { id: guild.id, name: guild.name },
        timestamp: new Date().toISOString()
    };
}

module.exports = { init, fire, fireModerationAction, fireLevelUp, refreshScheduledAutomation };
