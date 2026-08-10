'use strict';

/**
 * Discord embed length budgets. discord.js throws rather than truncating, so a
 * list that grows with player progress has to be packed before it is sent —
 * otherwise the whole command fails the moment a collection gets large enough.
 */
const EMBED_LIMITS = {
    FIELD_VALUE: 1024,
    DESCRIPTION: 4096,
};

/**
 * Pack pre-rendered lines into embed field values, none exceeding `limit`.
 *
 * The first field carries `name`; continuations are titled "<name> (cont.)" so
 * the list reads as one section. A single line longer than the limit is
 * truncated rather than dropped — losing the tail of one entry beats losing the
 * whole embed.
 *
 * @param {string} name    field name for the first chunk
 * @param {string[]} lines rendered lines, joined with `separator`
 * @param {object} [opts]  { limit, separator, inline, maxFields }
 * @returns {Array<{name: string, value: string, inline: boolean}>}
 */
function packFields(name, lines, {
    limit = EMBED_LIMITS.FIELD_VALUE,
    separator = '\n',
    inline = false,
    maxFields = Infinity,
} = {}) {
    const fields = [];
    let current = '';

    const flush = () => {
        if (!current) return;
        fields.push({
            name: fields.length === 0 ? name : `${name} (cont.)`,
            value: current,
            inline,
        });
        current = '';
    };

    for (const line of lines) {
        const piece = truncate(line, limit);
        if (!current) {
            current = piece;
        } else if (current.length + separator.length + piece.length <= limit) {
            current += separator + piece;
        } else {
            flush();
            if (fields.length >= maxFields) return fields;
            current = piece;
        }
    }
    flush();

    return fields.length > maxFields ? fields.slice(0, maxFields) : fields;
}

/**
 * Join lines into an embed description that fits the budget, dropping whole
 * lines off the end rather than emitting a half-rendered one. Returns the text
 * plus how many lines did not make it, so callers can say so.
 *
 * @returns {{ text: string, omitted: number }}
 */
function fitDescription(lines, { limit = EMBED_LIMITS.DESCRIPTION, separator = '\n' } = {}) {
    const kept = [];
    let length = 0;

    for (const line of lines) {
        const cost = kept.length ? separator.length + line.length : line.length;
        if (length + cost > limit) break;
        kept.push(line);
        length += cost;
    }

    return { text: kept.join(separator), omitted: lines.length - kept.length };
}

/** Hard-truncate a single string to `limit`, marking the cut with an ellipsis. */
function truncate(text, limit) {
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

module.exports = { EMBED_LIMITS, packFields, fitDescription, truncate };
