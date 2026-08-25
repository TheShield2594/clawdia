'use strict';

/**
 * A name from an MCP server, as something safe to put in a Discord message.
 *
 * Tool names, tool titles and error strings all come from the far side and are
 * whatever that server decided to call things — and every one of them ends up
 * in a message this bot posts to a channel. Here they are display text, so they
 * are reduced to characters that cannot open markup, look like a mention, or
 * run to three lines. A server that names a tool `@everyone` gets to be called
 * everyone.
 *
 * This is belt, not braces: what actually stops a message pinging is
 * `allowedMentions` on the send. The stripping is here so the text also *reads*
 * as a name rather than as something the bot is saying.
 *
 * It lives in utils because both the reply footer (a service) and the `/ai mcp`
 * embeds (a view) need it, and views sit below services — a view reaching up
 * for it is the dependency direction that lets cycles in.
 */

const MAX_LABEL_LENGTH = 40;

function toolLabel(text, maxLength = MAX_LABEL_LENGTH) {
    const clean = String(text || '').replace(/[^A-Za-z0-9._\- ]+/g, '').trim();
    if (!clean) return 'tool';
    return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
}

module.exports = { toolLabel, MAX_LABEL_LENGTH };
