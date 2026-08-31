'use strict';

/**
 * Reaction roles, grouped into the panels an admin actually sees.
 *
 * `settings.reactionRoles` is flat — one row per emoji, each repeating the
 * message and channel it belongs to — because that is the shape the reaction
 * handler wants: it has a message id and an emoji and needs a role. The
 * dashboard wants the opposite, one entry per published message with its
 * mappings inside, and it used to build that inline in reactionroles.ejs.
 *
 * It lives here now because there are two consumers (#689). The panel list is
 * patched in place after a create or a delete instead of reloading the page, so
 * the API returns this same shape and the browser re-renders from it — and a
 * grouping that disagreed with the template's would show a different list after
 * a mutation than a refresh does.
 *
 * Insertion order, which is the order the rows were pushed, so a newly
 * published panel appears at the end where the admin left it.
 *
 * @param {Array<{messageId: string, channelId: string, emoji: string, roleId: string}>} reactionRoles
 * @returns {Array<{messageId: string, channelId: string, mappings: Array<{emoji: string, roleId: string}>}>}
 */
function groupReactionRolePanels(reactionRoles) {
    const byMessage = new Map();

    for (const row of reactionRoles || []) {
        if (!row || !row.messageId) continue;
        let panel = byMessage.get(row.messageId);
        if (!panel) {
            panel = { messageId: row.messageId, channelId: row.channelId, mappings: [] };
            byMessage.set(row.messageId, panel);
        }
        panel.mappings.push({ emoji: row.emoji, roleId: row.roleId });
    }

    return [...byMessage.values()];
}

module.exports = { groupReactionRolePanels };
