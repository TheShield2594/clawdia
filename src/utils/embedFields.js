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
function packFields(name, lines, opts = {}) {
    return packFieldsCapped(name, lines, opts).fields;
}

/**
 * packFields, told how many fields it may spend and reporting how many lines
 * did not fit in them.
 *
 * An embed has two budgets, not one: 1,024 characters per field value and
 * 6,000 across the whole embed. Spilling into continuation fields respects the
 * first and eventually blows the second, so a section that grows with player
 * progress caps its spill and says what was left out — a count the caller can
 * print, rather than entries that quietly stop appearing.
 *
 * The count is of input lines, kept as the packing runs. It cannot be
 * recovered afterwards by splitting the packed values on the separator: a
 * single line may contain the separator itself (an item and its lore line are
 * one entry joined by a newline), which is how you end up dividing a split
 * length by two and hoping.
 *
 * @returns {{ fields: Array<{name: string, value: string, inline: boolean}>, omitted: number }}
 */
function packFieldsCapped(name, lines, {
    limit = EMBED_LIMITS.FIELD_VALUE,
    separator = '\n',
    inline = false,
    maxFields = Infinity,
} = {}) {
    const fields = [];
    let current = '';
    let held  = 0;   // input lines sitting in `current`
    let shown = 0;   // input lines that reached a field

    /** Push `current` as a field. False when the cap leaves no room for it. */
    const flush = () => {
        if (!current) return true;
        if (fields.length >= maxFields) return false;
        fields.push({
            name: fields.length === 0 ? name : `${name} (cont.)`,
            value: current,
            inline,
        });
        shown += held;
        current = '';
        held = 0;
        return true;
    };

    for (const line of lines) {
        const piece = truncate(line, limit);
        if (!current) {
            current = piece;
            held = 1;
        } else if (current.length + separator.length + piece.length <= limit) {
            current += separator + piece;
            held += 1;
        } else if (!flush()) {
            return { fields, omitted: lines.length - shown };
        } else {
            current = piece;
            held = 1;
        }
    }
    flush();

    return { fields, omitted: lines.length - shown };
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

/**
 * Split lines into groups, each of which joins to no more than `limit`
 * characters — one group per embed the caller then pages through.
 *
 * `fitDescription` is the right answer when the tail genuinely doesn't matter
 * (the lowest-ranked trophies of a hundred). It is the wrong one for a list the
 * player *acts on* by position: a weapon dropped off the end can never be
 * equipped or discarded, because its number is only ever shown by the embed
 * that just hid it. Those lists get paged instead, so nothing becomes
 * unreachable by owning too much.
 *
 * A single line longer than the limit is truncated into a group of its own
 * rather than dropped.
 *
 * @returns {string[][]} groups of lines, in order; empty input gives [].
 */
function chunkByLength(lines, {
    limit = EMBED_LIMITS.DESCRIPTION,
    separator = '\n',
    maxPerChunk = Infinity,
} = {}) {
    const chunks = [];
    let current = [];
    let length  = 0;

    for (const line of lines) {
        const piece = truncate(line, limit);
        const cost  = current.length ? separator.length + piece.length : piece.length;

        if (current.length && (length + cost > limit || current.length >= maxPerChunk)) {
            chunks.push(current);
            current = [];
            length  = 0;
        }

        length += current.length ? separator.length + piece.length : piece.length;
        current.push(piece);
    }

    if (current.length) chunks.push(current);
    return chunks;
}

/** Hard-truncate a single string to `limit`, marking the cut with an ellipsis. */
function truncate(text, limit) {
    if (text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

module.exports = { EMBED_LIMITS, packFields, packFieldsCapped, fitDescription, chunkByLength, truncate };
