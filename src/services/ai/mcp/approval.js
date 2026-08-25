'use strict';

const { ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { rejectOtherUser } = require('../../../utils/collectorOwner');
const { toolLabel } = require('../../../utils/toolLabel');

/**
 * Asking a person before a tool call that writes something.
 *
 * The block list already covers tools nobody should ever call. This is for the
 * ones a guild wants available but not unattended — filing an issue, sending a
 * mail, moving a calendar event — where the answer is not "never" but "not
 * without me". The model asks for the call as usual; it just does not happen
 * until somebody clicks.
 *
 * What the model is told about a refusal matters as much as the refusal: a
 * declined call comes back as text saying so, so the reply carries on and
 * explains itself rather than ending on a tool result that never arrived.
 */

// Long enough to notice a message and read it, short enough that a turn nobody
// is watching does not sit on the provider's clock. On expiry the call is not
// run, which is the same answer as Cancel and a different message.
const CONFIRM_TIMEOUT_MS = 60_000;

// Arguments come from the model and can be any size at all; this is a preview
// for a human, not the payload.
const MAX_ARGS_CHARS = 500;

const APPROVE = 'mcp-approve';
const DENY = 'mcp-deny';

const NOT_YOURS = 'Only the person who asked, or someone who can manage this server, can answer this.';

/**
 * The arguments as a code block a human can read.
 *
 * Backticks are stripped rather than escaped: the value is model output being
 * put inside a fence, and one backtick in the wrong place turns the rest of the
 * message into prose. Everything that could ping is handled by allowedMentions
 * on the send, which is the part a string cannot get wrong.
 */
function renderArgs(args) {
    if (!args || typeof args !== 'object' || !Object.keys(args).length) return '';

    let json;
    try {
        json = JSON.stringify(args, null, 1);
    } catch {
        return '';
    }
    const clean = json.replace(/`/g, "'");
    const body = clean.length > MAX_ARGS_CHARS ? `${clean.slice(0, MAX_ARGS_CHARS)}\n… (truncated)` : clean;
    return `\n\`\`\`json\n${body}\n\`\`\``;
}

// What the server said about the tool, when it said anything worth repeating.
function describeTool(annotations) {
    if (annotations?.title) return ` — ${toolLabel(annotations.title)}`;
    if (annotations?.destructiveHint === true) return ' — the server marks this as destructive';
    if (annotations?.readOnlyHint === false) return ' — the server marks this as writing';
    return '';
}

function buttons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(APPROVE).setLabel('Run it').setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId(DENY).setLabel('Cancel').setStyle(ButtonStyle.Secondary).setDisabled(disabled)
    );
}

/**
 * A `confirmTool` for one Discord message's turn.
 *
 * Handed to the toolkit, which calls it before any tool the guild's policy says
 * needs approving, and waits on the answer. Several can be in flight at once —
 * a round's calls run concurrently — so each prompt is its own message with its
 * own buttons and its own clock.
 *
 * @param {object} message the message that started the turn
 * @returns {(call: object) => Promise<{approved: boolean, timedOut?: boolean}>}
 */
function createToolConfirmer(message, { timeoutMs = CONFIRM_TIMEOUT_MS } = {}) {
    return async ({ server, tool, args, annotations }) => {
        const heading = `<@${message.author.id}> — run \`${toolLabel(server)} · ${toolLabel(tool)}\`?${describeTool(annotations)}`;
        const content = `🔧 ${heading}${renderArgs(args)}`;

        const prompt = await message.channel.send({
            content,
            components: [buttons()],
            // The asker is pinged because they are the one being waited on;
            // nothing in the tool name or the arguments can ping anybody,
            // whatever the model or the server put there.
            allowedMentions: { users: [message.author.id] }
        });

        const filter = interaction => {
            if (interaction.customId !== APPROVE && interaction.customId !== DENY) return false;
            // Whoever asked can answer for themselves; anyone who could have
            // configured the connection in the first place can answer for them.
            if (interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return true;
            return !rejectOtherUser(interaction, message.author.id, NOT_YOURS);
        };

        try {
            const click = await prompt.awaitMessageComponent({ filter, time: timeoutMs });
            const approved = click.customId === APPROVE;
            await click.update({
                content: `${content}\n${approved ? '✅' : '🚫'} ${approved ? 'Approved' : 'Cancelled'} by <@${click.user.id}>`,
                components: [],
                allowedMentions: { parse: [] }
            }).catch(() => {});
            return { approved };
        } catch {
            // awaitMessageComponent rejects on expiry. Take the buttons away so
            // a click an hour later cannot land on a turn that is long over.
            await prompt.edit({
                content: `${content}\n⏳ Nobody answered — not run.`,
                components: [],
                allowedMentions: { parse: [] }
            }).catch(() => {});
            return { approved: false, timedOut: true };
        }
    };
}

module.exports = { createToolConfirmer, CONFIRM_TIMEOUT_MS, renderArgs };
