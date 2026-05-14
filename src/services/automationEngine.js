const Automation = require('../models/Automation');
const AutomationLog = require('../models/AutomationLog');
const { executeAction } = require('./composioService');
const cron = require('node-cron');

// Scheduled automation cron handles, keyed by automationId string
const cronHandles = new Map();

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
    if (!input || typeof input !== 'object') return input;
    const result = {};
    for (const [k, v] of Object.entries(input)) {
        result[k] = typeof v === 'object' ? substituteInput(v, ctx) : substitute(v, ctx);
    }
    return result;
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

    for (const automation of automations) {
        // Extra trigger-specific filtering
        if (!matchesTriggerConfig(automation.trigger, ctx)) continue;

        const resolvedInput = substituteInput(automation.action.input, ctx);
        let success = false;
        let error = null;

        try {
            await executeAction(guildId, automation.action.actionName, resolvedInput);
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
            contextData: ctx,
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
        console.log(`[AutomationEngine] Loaded ${scheduled.length} scheduled automation(s)`);
    } catch (err) {
        console.error('[AutomationEngine] Failed to load scheduled automations:', err.message);
    }
}

function scheduleAutomation(automation) {
    const cronExpr = automation.trigger.config?.cron;
    if (!cronExpr || !cron.validate(cronExpr)) return;

    // Cancel any existing handle
    unscheduleAutomation(automation._id.toString());

    const handle = cron.schedule(cronExpr, async () => {
        const ctx = {
            guild: { id: automation.guildId },
            timestamp: new Date().toISOString()
        };
        await fire(automation.guildId, 'scheduled', ctx);
    });

    cronHandles.set(automation._id.toString(), handle);
}

function unscheduleAutomation(automationId) {
    const handle = cronHandles.get(automationId);
    if (handle) {
        handle.stop();
        cronHandles.delete(automationId);
    }
}

// Called from automation dashboard/API when an automation is created/updated/deleted
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
        for (const [, role] of addedRoles) {
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

// Called from moderation commands to fire moderation_action triggers
async function fireModerationAction(guildId, targetUser, moderator, actionType, reason) {
    const ctx = {
        user:   { id: targetUser.id, name: targetUser.username, tag: targetUser.tag },
        mod:    { id: moderator.id,   name: moderator.username },
        action: { type: actionType, reason: reason || '' },
        guild:  { id: guildId },
        timestamp: new Date().toISOString()
    };
    await fire(guildId, 'moderation_action', ctx);
}

// Called from leveling event handler when a user levels up
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
