'use strict';

// Private-thread tickets / modmail (#1012).
//
// A ticket is a private thread the bot opens in the guild's configured tickets
// channel. The opener and the members of the configured support roles are added
// to it, and the bot posts an opening embed carrying Claim / Close / Transcript
// buttons. Closing archives and locks the thread, files a `ticket` Case (so the
// ticket shows in the dashboard's moderation list next to warns and appeals) and
// posts a transcript to the log channel.
//
// The design constraints the issue set, and where each is met:
//
//   * No new gateway permission beyond the invite set — private threads need
//     Create Private Threads, Send Messages in Threads and Manage Threads, which
//     were added to src/config/invitePermissions.js with this feature.
//   * Close is idempotent and survives the thread having been deleted by hand:
//     the record is removed with one atomic `$pull` that *is* the claim (a second
//     close finds nothing to pull and no-ops), and every Discord call it then
//     makes is best-effort.
//   * A per-member cap and an open cooldown, because this is a spam surface.

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, AttachmentBuilder,
    PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags,
} = require('discord.js');
const Guild = require('../models/Guild');
const { createCase } = require('./caseService');
const { getGuildSettings } = require('../utils/guildSettingsCache');
const { handlesGuild } = require('../utils/sharding');
const COLORS = require('../utils/embedColors');

// customId prefixes the interaction router matches on. The panel's open button
// is distinct from the in-thread controls so a stale panel message keeps working
// across restarts (the handlers look nothing up by collector).
const BUTTON_OPEN = 'ticket_open';
const BUTTON_CLAIM = 'ticket_claim';
const BUTTON_CLOSE = 'ticket_close';
const BUTTON_TRANSCRIPT = 'ticket_transcript';
const MODAL_OPEN = 'ticket_modal_open';
const MODAL_SUBJECT_INPUT = 'subject';

// How many messages a transcript reads at most. A ticket is a support thread,
// not a channel's whole history, so this is generous; the cap only bounds the
// pathological case rather than trimming a normal ticket.
const TRANSCRIPT_MESSAGE_CAP = 1000;
const TRANSCRIPT_PAGE = 100;

// How many members the bot will explicitly add per ticket. The opener is always
// added; support staff are added from the role's cached members up to this, and
// the opening message also pings the roles so anyone not added still sees it.
const MAX_SUPPORT_MEMBERS_ADDED = 40;

// Process-local open cooldown. A ticket close is a rare event and the cooldown
// only needs to stop a member reopening within seconds of closing, so a
// per-process map is enough — a restart clearing it costs nothing (the per-user
// cap still bounds concurrent tickets, which is the durable guard). Keyed by
// `${guildId}:${userId}` → epoch ms of the last open.
const lastOpenAt = new Map();

function cooldownKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

// Members whose open is in flight, keyed like the cooldown (#1159). Opening
// awaits Discord (thread create) between the cap check and the write, so two
// modal submits or `/ticket open` calls from one member could both pass the
// check. This refuses the second while the first is still running; the
// conditional write in openTicket is what holds the cap across processes and
// against a stale settings cache.
const openInFlight = new Set();

/** Test seam: forget every recorded open cooldown. */
function _resetCooldowns() {
    lastOpenAt.clear();
    openInFlight.clear();
}

function cappedMessage(count) {
    return `You already have ${count} open ticket(s). Close one before opening another.`;
}

// Atomic per-guild ticket counter, initialised to 1 when absent, in one
// round-trip — the same shape caseService uses for case ids.
async function getNextTicketId(guildId) {
    const result = await Guild.findOneAndUpdate(
        { guildId },
        [{ $set: { 'tickets.nextTicketId': { $ifNull: [{ $add: ['$tickets.nextTicketId', 1] }, 1] } } }],
        { updatePipeline: true, upsert: true, new: true, projection: { 'tickets.nextTicketId': 1 } }
    );
    return result.tickets.nextTicketId;
}

// The channel a close posts its transcript and record to: the ticket log when
// set, otherwise the moderation log, otherwise nothing.
function resolveLogChannelId(settings) {
    return settings?.tickets?.logChannelId || settings?.moderation?.logChannelId || null;
}

// The controls the opening embed carries. Kept in one place so the panel and the
// opening message agree, and a rename does not drift between them.
function ticketControlRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BUTTON_CLAIM).setLabel('Claim').setStyle(ButtonStyle.Primary).setEmoji('🙋'),
        new ButtonBuilder().setCustomId(BUTTON_CLOSE).setLabel('Close').setStyle(ButtonStyle.Danger).setEmoji('🔒'),
        new ButtonBuilder().setCustomId(BUTTON_TRANSCRIPT).setLabel('Transcript').setStyle(ButtonStyle.Secondary).setEmoji('🧾'),
    );
}

// The single "Open a ticket" button an admin posts anywhere.
function ticketPanelRow() {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(BUTTON_OPEN).setLabel('Open a ticket').setStyle(ButtonStyle.Primary).setEmoji('🎫'),
    );
}

/**
 * Whether a member may run the staff-only ticket controls (claim, close,
 * transcript, panel). A member qualifies by holding a configured support role,
 * or Manage Threads / Manage Guild — the same people who could act on the thread
 * through Discord directly.
 */
function isSupportMember(member, settings) {
    if (!member) return false;
    const perms = member.permissions;
    if (perms?.has?.(PermissionFlagsBits.ManageThreads) || perms?.has?.(PermissionFlagsBits.ManageGuild)) return true;
    const supportRoleIds = settings?.tickets?.supportRoleIds || [];
    return supportRoleIds.some(roleId => member.roles?.cache?.has(roleId));
}

// The Discord auto-archive bucket closest to (and not under) the configured idle
// window, so a thread the bot never gets to sweep still archives itself near the
// intended time. Discord only accepts these four values (minutes).
function autoArchiveMinutesFor(autoCloseHours) {
    if (!autoCloseHours || autoCloseHours <= 0) return 10080; // no idle-close: max
    const minutes = autoCloseHours * 60;
    for (const bucket of [60, 1440, 4320, 10080]) {
        if (minutes <= bucket) return bucket;
    }
    return 10080;
}

/**
 * Open a ticket for `member` in `guild`.
 *
 * @returns {Promise<{ok: boolean, code?: string, message?: string, thread?: object, ticketId?: number}>}
 *   `code` on failure is one of: disabled, no-channel, capped, cooldown,
 *   create-failed — so a caller can word the refusal for its surface.
 */
async function openTicket({ guild, member, subject = '', settings }) {
    const guildSettings = settings || await Guild.findOne({ guildId: guild.id });
    const cfg = guildSettings?.tickets;

    if (!cfg?.enabled) return { ok: false, code: 'disabled', message: 'Tickets are not enabled on this server.' };
    if (!cfg.channelId) return { ok: false, code: 'no-channel', message: 'No tickets channel has been configured yet.' };

    const parent = guild.channels.cache.get(cfg.channelId) || await guild.channels.fetch(cfg.channelId).catch(() => null);
    if (!parent || parent.type !== ChannelType.GuildText) {
        return { ok: false, code: 'no-channel', message: 'The configured tickets channel no longer exists.' };
    }

    const key = cooldownKey(guild.id, member.id);
    if (openInFlight.has(key)) {
        return { ok: false, code: 'cooldown', message: 'Your ticket is already being opened — give it a moment.' };
    }
    openInFlight.add(key);
    try {
        return await openTicketExclusive({ guild, member, subject, cfg, parent, key });
    } finally {
        openInFlight.delete(key);
    }
}

// The rest of openTicket, run while `key` holds the in-flight slot.
async function openTicketExclusive({ guild, member, subject, cfg, parent, key }) {
    // Per-member cap: how many of this member's tickets are already open. A
    // cheap pre-check against the settings we have, so an ordinary refusal
    // costs no ticket id and no thread; the write below is the real guard.
    const openForMember = (cfg.open || []).filter(t => t.openerId === member.id).length;
    const cap = cfg.perUserCap ?? 1;
    if (openForMember >= cap) {
        return { ok: false, code: 'capped', message: cappedMessage(openForMember) };
    }

    // Open cooldown. Stamped now, before the awaits below, so a second open
    // arriving after this one finishes sees it; rolled back if this one fails.
    const cooldownMs = (cfg.cooldownSeconds ?? 0) * 1000;
    const previousOpenAt = lastOpenAt.get(key);
    if (cooldownMs > 0) {
        const remaining = (previousOpenAt || 0) + cooldownMs - Date.now();
        if (remaining > 0) {
            return { ok: false, code: 'cooldown', message: `Please wait ${Math.ceil(remaining / 1000)}s before opening another ticket.` };
        }
        lastOpenAt.set(key, Date.now());
    }
    const releaseCooldown = () => {
        if (cooldownMs <= 0) return;
        if (previousOpenAt === undefined) lastOpenAt.delete(key);
        else lastOpenAt.set(key, previousOpenAt);
    };

    const cleanSubject = String(subject || '').trim().slice(0, 200);
    const ticketId = await getNextTicketId(guild.id);

    let thread;
    try {
        thread = await parent.threads.create({
            name: `ticket-${String(ticketId).padStart(4, '0')}-${member.user.username}`.slice(0, 100),
            type: ChannelType.PrivateThread,
            invitable: false,
            autoArchiveDuration: autoArchiveMinutesFor(cfg.autoCloseHours),
            reason: `Ticket #${ticketId} opened by ${member.user.tag}`,
        });
    } catch (err) {
        releaseCooldown();
        console.error(`[tickets] failed to create thread in guild ${guild.id}:`, err.message);
        return { ok: false, code: 'create-failed', message: 'I could not open a ticket thread. Check my Create Private Threads permission on the tickets channel.' };
    }

    // Record the ticket before wiring the thread up, so a failure adding members
    // or posting the embed still leaves a row the sweep and the close path can
    // find rather than a live thread nothing tracks.
    //
    // The push only lands while the member is still under the cap *as stored*
    // (#1159): the count and the push are one atomic update, so opens racing
    // from another process, or checked against a cached settings document that
    // predates this member's last ticket, cannot go past `perUserCap`. A refused
    // push means the thread is surplus — nobody has been added to it or pinged
    // yet — so it is deleted and the member told they are at the cap.
    const recorded = await Guild.updateOne(
        {
            guildId: guild.id,
            $expr: { $lt: [
                { $size: { $filter: {
                    input: { $ifNull: ['$tickets.open', []] },
                    cond: { $eq: ['$$this.openerId', { $literal: member.id }] },
                } } },
                cap,
            ] },
        },
        { $push: { 'tickets.open': {
            ticketId, threadId: thread.id, channelId: parent.id,
            openerId: member.id, subject: cleanSubject, claimedBy: null, openedAt: new Date(),
        } } },
    );
    if (!recorded?.matchedCount) {
        releaseCooldown();
        await thread.delete('Ticket refused: member already at the open-ticket cap').catch(() => {});
        return { ok: false, code: 'capped', message: cappedMessage(cap) };
    }

    // Add the opener, then support staff from the role caches (best-effort,
    // capped); the opening message also pings the roles so anyone the cache
    // missed still sees the thread.
    await thread.members.add(member.id).catch(() => {});
    let added = 0;
    for (const roleId of cfg.supportRoleIds || []) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        for (const staff of role.members.values()) {
            if (added >= MAX_SUPPORT_MEMBERS_ADDED) break;
            if (staff.id === member.id) continue;
            await thread.members.add(staff.id).catch(() => {});
            added += 1;
        }
        if (added >= MAX_SUPPORT_MEMBERS_ADDED) break;
    }

    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle(`🎫 Ticket #${String(ticketId).padStart(4, '0')}`)
        .setDescription(cfg.openingMessage || 'Thanks for reaching out — a member of the team will be with you shortly.')
        .addFields({ name: 'Opened by', value: `<@${member.id}>`, inline: true })
        .setTimestamp();
    if (cleanSubject) embed.addFields({ name: 'Subject', value: cleanSubject, inline: false });

    const mentions = [`<@${member.id}>`, ...(cfg.supportRoleIds || []).map(id => `<@&${id}>`)].join(' ');
    await thread.send({
        content: mentions,
        embeds: [embed],
        components: [ticketControlRow()],
        // The client default pings users only; the support roles are meant to be.
        allowedMentions: { users: [member.id], roles: cfg.supportRoleIds || [] }
    }).catch(err => {
        console.error(`[tickets] failed to post opening message for ticket ${ticketId} in guild ${guild.id}:`, err.message);
    });

    return { ok: true, thread, ticketId };
}

/**
 * Claim the ticket a thread belongs to for `member`. Idempotent-ish: claiming an
 * already-claimed ticket reports who holds it rather than reassigning it.
 *
 * @returns {Promise<{ok: boolean, code?: string, message?: string, ticketId?: number}>}
 */
async function claimTicket({ guild, threadId, member }) {
    const doc = await Guild.findOne(
        { guildId: guild.id, 'tickets.open.threadId': threadId },
        { 'tickets.open.$': 1 }
    );
    const record = doc?.tickets?.open?.[0];
    if (!record) return { ok: false, code: 'not-ticket', message: 'This thread is not an open ticket.' };
    if (record.claimedBy) {
        return { ok: false, code: 'claimed', message: `This ticket is already claimed by <@${record.claimedBy}>.` };
    }

    // The `$eq: null` in the filter is the claim: two staff clicking at once, one
    // update matches and the other finds it already set.
    const res = await Guild.updateOne(
        { guildId: guild.id, 'tickets.open': { $elemMatch: { threadId, claimedBy: null } } },
        { $set: { 'tickets.open.$.claimedBy': member.id } }
    );
    if (!res.modifiedCount) {
        return { ok: false, code: 'claimed', message: 'This ticket was just claimed by someone else.' };
    }
    return { ok: true, ticketId: record.ticketId };
}

/**
 * Build a plain-text transcript of a thread. Best-effort: returns null if the
 * thread is gone or its messages cannot be read.
 *
 * @returns {Promise<AttachmentBuilder|null>}
 */
async function buildTranscript(thread, ticketId) {
    if (!thread) return null;
    const collected = [];
    let before;
    try {
        while (collected.length < TRANSCRIPT_MESSAGE_CAP) {
            const batch = await thread.messages.fetch({ limit: TRANSCRIPT_PAGE, ...(before ? { before } : {}) });
            if (!batch.size) break;
            collected.push(...batch.values());
            before = batch.last().id;
            if (batch.size < TRANSCRIPT_PAGE) break;
        }
    } catch (err) {
        console.error(`[tickets] transcript fetch failed for thread ${thread.id}:`, err.message);
        if (!collected.length) return null;
    }

    // fetch returns newest-first per page; sort ascending so the transcript reads
    // top to bottom.
    collected.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
    const lines = collected.map(msg => {
        const when = new Date(msg.createdTimestamp).toISOString();
        const author = msg.author ? `${msg.author.tag}` : 'unknown';
        const attachments = msg.attachments?.size ? ` [${msg.attachments.size} attachment(s)]` : '';
        const content = msg.content || (msg.embeds?.length ? '[embed]' : '');
        return `[${when}] ${author}: ${content}${attachments}`;
    });
    const header = `Transcript for ticket #${String(ticketId).padStart(4, '0')} — ${thread.name}\nGenerated ${new Date().toISOString()}\n${'-'.repeat(60)}\n`;
    const body = header + (lines.join('\n') || '(no messages)') + '\n';
    return new AttachmentBuilder(Buffer.from(body, 'utf8'), {
        name: `ticket-${String(ticketId).padStart(4, '0')}-transcript.txt`,
        description: `Plain-text transcript of ticket #${String(ticketId).padStart(4, '0')}, one message per line.`,
    });
}

/**
 * Close the ticket a thread belongs to.
 *
 * Idempotent and safe when the thread was deleted by hand: the record is removed
 * with one atomic `$pull` that acts as the claim, and every Discord call below is
 * best-effort. A second close (or a close of an untracked thread) returns
 * `{ ok: false, code: 'already-closed' }` having done nothing.
 *
 * @param {object} opts
 * @param {import('discord.js').Guild} [opts.guild]  resolved guild (interactive paths)
 * @param {import('discord.js').Client} [opts.client] client, for the sweep which has no guild
 * @param {string} opts.guildId
 * @param {string} opts.threadId
 * @param {string} opts.closedById  the moderator (or the bot's id for a sweep)
 * @param {string} [opts.reason]
 * @returns {Promise<{ok: boolean, code?: string, ticketId?: number}>}
 */
async function closeTicket({ guild, client, guildId, threadId, closedById, reason = 'Closed' }) {
    const resolvedGuildId = guildId || guild?.id;

    // The claim: remove the open record iff it is still there. `new: false`
    // returns the pre-update document, from which we read the removed record.
    const before = await Guild.findOneAndUpdate(
        { guildId: resolvedGuildId, 'tickets.open.threadId': threadId },
        { $pull: { 'tickets.open': { threadId } } },
        { new: false, projection: { 'tickets.open': 1, 'tickets.logChannelId': 1, 'moderation.logChannelId': 1 } }
    );
    const record = before?.tickets?.open?.find(t => t.threadId === threadId);
    if (!record) return { ok: false, code: 'already-closed' };

    const resolvedGuild = guild || client?.guilds?.cache?.get(resolvedGuildId) || null;

    // File the Case first — it is the durable record, and it must not be lost to
    // a Discord call failing afterwards. Ticket cases never carry an SLA
    // (createCase only sets one for ban/kick/mute).
    const modCase = await createCase({
        guildId: resolvedGuildId,
        type: 'ticket',
        targetUserId: record.openerId,
        moderatorId: closedById || record.claimedBy || record.openerId,
        reason: record.subject ? `Ticket: ${record.subject}` : `Ticket #${record.ticketId}`,
    }).catch(err => { console.error(`[tickets] case write failed for ticket ${record.ticketId}:`, err.message); return null; });

    // Everything past here is best-effort: the ticket is already closed in the
    // database, and a deleted thread or a missing permission must not turn that
    // into a throw.
    let thread;
    try {
        thread = resolvedGuild ? (resolvedGuild.channels.cache.get(threadId) || await resolvedGuild.channels.fetch(threadId).catch(() => null)) : null;
    } catch { thread = null; }

    const transcript = thread ? await buildTranscript(thread, record.ticketId).catch(() => null) : null;

    // Post the closing record + transcript to the log channel.
    const logChannelId = resolveLogChannelId({
        tickets: { logChannelId: before?.tickets?.logChannelId },
        moderation: { logChannelId: before?.moderation?.logChannelId },
    });
    if (resolvedGuild && logChannelId) {
        const logChannel = resolvedGuild.channels.cache.get(logChannelId) || await resolvedGuild.channels.fetch(logChannelId).catch(() => null);
        if (logChannel?.isTextBased?.()) {
            const embed = new EmbedBuilder()
                .setColor(COLORS.NEUTRAL)
                .setTitle(`🎫 Ticket #${String(record.ticketId).padStart(4, '0')} closed`)
                .addFields(
                    { name: 'Opened by', value: `<@${record.openerId}>`, inline: true },
                    { name: 'Closed by', value: closedById ? `<@${closedById}>` : 'Auto-close (idle)', inline: true },
                )
                .setTimestamp();
            if (record.subject) embed.addFields({ name: 'Subject', value: record.subject });
            if (modCase) embed.setFooter({ text: `Case #${modCase.caseId}` });
            await logChannel.send({ embeds: [embed], ...(transcript ? { files: [transcript] } : {}) }).catch(err => {
                console.error(`[tickets] failed to post close log for ticket ${record.ticketId}:`, err.message);
            });
        }
    }

    // Lock and archive the thread last, so the transcript above read it while it
    // was still open. Both are best-effort.
    if (thread) {
        await thread.send({ content: `🔒 Ticket closed${closedById ? ` by <@${closedById}>` : ' (idle)'}${reason && reason !== 'Closed' ? ` — ${reason}` : ''}.` }).catch(() => {});
        await thread.setLocked(true, reason).catch(() => {});
        await thread.setArchived(true, reason).catch(() => {});
    }

    return { ok: true, ticketId: record.ticketId, caseId: modCase?.caseId ?? null };
}

/**
 * Post the "Open a ticket" panel button to a channel.
 *
 * @returns {Promise<object>} the sent message
 */
async function postTicketPanel(channel, settings) {
    const embed = new EmbedBuilder()
        .setColor(COLORS.INFO)
        .setTitle('🎫 Need help?')
        .setDescription(settings?.tickets?.openingMessage
            ? `Press the button below to open a private ticket with the team.`
            : 'Press the button below to open a private ticket with the team.');
    return channel.send({ embeds: [embed], components: [ticketPanelRow()] });
}

/**
 * Idle auto-close sweep (scheduler, GUILD scope). For each guild the client
 * handles that has tickets enabled with a positive `autoCloseHours`, close any
 * open ticket whose thread has seen no activity within the window — or whose
 * thread has been deleted (a close that just files the record and clears the
 * row).
 */
async function sweepIdleTickets(client) {
    const guilds = await Guild.find(
        { 'tickets.enabled': true, 'tickets.autoCloseHours': { $gt: 0 }, 'tickets.open.0': { $exists: true } },
        { guildId: 1, 'tickets.autoCloseHours': 1, 'tickets.open': 1 }
    ).lean();

    for (const g of guilds) {
        if (!handlesGuild(g.guildId, client)) continue;
        const guild = client.guilds.cache.get(g.guildId);
        if (!guild) continue;
        const idleMs = g.tickets.autoCloseHours * 3600000;
        const cutoff = Date.now() - idleMs;

        for (const record of g.tickets.open || []) {
            const thread = guild.channels.cache.get(record.threadId)
                || await guild.channels.fetch(record.threadId).catch(() => null);

            // Thread deleted by hand: close the record so it stops being swept.
            if (!thread) {
                await closeTicket({ guild, guildId: g.guildId, threadId: record.threadId, closedById: null, reason: 'Thread deleted' })
                    .catch(err => console.error(`[tickets] sweep close (missing thread) failed for guild ${g.guildId}:`, err.message));
                continue;
            }

            // Last activity: the most recent message's timestamp, or the thread's
            // own archive timestamp / creation as a floor.
            const lastTs = thread.lastMessage?.createdTimestamp
                ?? (thread.lastMessageId ? Number((BigInt(thread.lastMessageId) >> 22n) + 1420070400000n) : null)
                ?? thread.archiveTimestamp
                ?? new Date(record.openedAt).getTime();
            if (lastTs > cutoff) continue;

            await closeTicket({ guild, guildId: g.guildId, threadId: record.threadId, closedById: null, reason: 'Idle auto-close' })
                .catch(err => console.error(`[tickets] sweep close failed for guild ${g.guildId}:`, err.message));
        }
    }
}

// ── Interaction handlers ────────────────────────────────────────────────────
//
// Routed from events/interactionCreate.js by customId prefix, the same way the
// heist and 8-ball buttons are — no collector, so a ticket's controls keep
// working across a restart and on a thread opened long ago.

function isTicketButton(customId) {
    return customId === BUTTON_OPEN || customId === BUTTON_CLAIM
        || customId === BUTTON_CLOSE || customId === BUTTON_TRANSCRIPT;
}

function isTicketModal(customId) {
    return customId === MODAL_OPEN;
}

async function handleTicketButton(interaction) {
    if (interaction.customId === BUTTON_OPEN) {
        // The panel button collects an optional subject through a modal before
        // opening — a modal cannot follow a deferred reply, so it is shown first.
        const modal = new ModalBuilder().setCustomId(MODAL_OPEN).setTitle('Open a ticket');
        const input = new TextInputBuilder()
            .setCustomId(MODAL_SUBJECT_INPUT)
            .setLabel('What do you need help with? (optional)')
            .setStyle(TextInputStyle.Short)
            .setMaxLength(200)
            .setRequired(false);
        modal.addComponents(new ActionRowBuilder().addComponents(input));
        return interaction.showModal(modal);
    }

    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ content: 'Tickets only work inside a server.', flags: MessageFlags.Ephemeral });
    }
    const settings = await getGuildSettings(guild.id);
    const threadId = interaction.channelId;

    if (interaction.customId === BUTTON_CLAIM) {
        if (!isSupportMember(interaction.member, settings)) {
            return interaction.reply({ content: 'Only support staff can claim tickets.', flags: MessageFlags.Ephemeral });
        }
        const result = await claimTicket({ guild, threadId, member: interaction.member });
        if (!result.ok) return interaction.reply({ content: result.message, flags: MessageFlags.Ephemeral });
        return interaction.reply({ content: `🙋 Ticket claimed by <@${interaction.user.id}>.` });
    }

    if (interaction.customId === BUTTON_CLOSE) {
        // Support staff, or the member who opened this ticket, may close it.
        const record = await findOpenTicket(guild.id, threadId);
        if (!record) return interaction.reply({ content: 'This thread is not an open ticket.', flags: MessageFlags.Ephemeral });
        const isOpener = record.openerId === interaction.user.id;
        if (!isOpener && !isSupportMember(interaction.member, settings)) {
            return interaction.reply({ content: 'Only support staff or the person who opened this ticket can close it.', flags: MessageFlags.Ephemeral });
        }
        await interaction.reply({ content: '🔒 Closing this ticket…' });
        const result = await closeTicket({ guild, guildId: guild.id, threadId, closedById: interaction.user.id, reason: 'Closed from thread' });
        if (!result.ok) {
            return interaction.followUp({ content: 'This ticket is already closed.', flags: MessageFlags.Ephemeral }).catch(() => {});
        }
        return undefined;
    }

    if (interaction.customId === BUTTON_TRANSCRIPT) {
        if (!isSupportMember(interaction.member, settings)) {
            return interaction.reply({ content: 'Only support staff can pull a transcript.', flags: MessageFlags.Ephemeral });
        }
        const record = await findOpenTicket(guild.id, threadId);
        if (!record) return interaction.reply({ content: 'This thread is not an open ticket.', flags: MessageFlags.Ephemeral });
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const transcript = await buildTranscript(interaction.channel, record.ticketId);
        if (!transcript) return interaction.editReply({ content: 'Could not read this thread to build a transcript.' });
        return interaction.editReply({ content: 'Here is the transcript so far:', files: [transcript] });
    }

    return undefined;
}

async function handleTicketModal(interaction) {
    if (interaction.customId !== MODAL_OPEN) return undefined;
    const guild = interaction.guild;
    if (!guild) {
        return interaction.reply({ content: 'Tickets only work inside a server.', flags: MessageFlags.Ephemeral });
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subject = interaction.fields.getTextInputValue(MODAL_SUBJECT_INPUT);
    const result = await openTicket({ guild, member: interaction.member, subject });
    if (!result.ok) return interaction.editReply({ content: result.message });
    return interaction.editReply({ content: `🎫 Ticket opened: <#${result.thread.id}>` });
}

// One open-ticket record by thread, or null. Used by the close/transcript
// handlers to check the opener and the ticket id.
async function findOpenTicket(guildId, threadId) {
    const doc = await Guild.findOne(
        { guildId, 'tickets.open.threadId': threadId },
        { 'tickets.open.$': 1 }
    );
    return doc?.tickets?.open?.[0] || null;
}

module.exports = {
    BUTTON_OPEN, BUTTON_CLAIM, BUTTON_CLOSE, BUTTON_TRANSCRIPT, MODAL_OPEN, MODAL_SUBJECT_INPUT,
    openTicket, claimTicket, closeTicket, buildTranscript, postTicketPanel, sweepIdleTickets,
    isSupportMember, ticketControlRow, ticketPanelRow, resolveLogChannelId, autoArchiveMinutesFor,
    isTicketButton, isTicketModal, handleTicketButton, handleTicketModal, findOpenTicket,
    _resetCooldowns,
};
