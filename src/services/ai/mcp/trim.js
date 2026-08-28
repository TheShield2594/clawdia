'use strict';

/**
 * Cutting an over-long tool result down to what the reply can hold (#838).
 *
 * Both of the toolkit's caps used to do this with `text.slice(0, limit)`, and
 * the failure that causes is specific rather than cosmetic. A tool result is
 * usually JSON, so slicing lands in the middle of a string, an escape sequence
 * or a nesting level, and what reaches the model is a document that cannot be
 * parsed and whose last field is a half-written value. In a one-shot answer
 * that is merely lossy. In a multi-step chain it poisons the round after it:
 * the model reads `"path": "src/servi` as a filename and calls the next tool
 * with it, and the failure surfaces three steps downstream as a tool error
 * about a file that does not exist.
 *
 * The fix is to drop whole units instead of bytes.
 *
 *   - A JSON array is the common shape — search hits, files, issues, rows —
 *     and it has an obvious unit. Elements come out of the middle until the
 *     rest fits, and what is left is re-serialised, so the model is handed
 *     valid JSON containing genuinely complete records rather than an invalid
 *     document ending mid-record.
 *   - A JSON object usually carries one big array and some small scalars
 *     (`{ total, nextCursor, items: [...] }`). Shrinking the array keeps the
 *     cursor and the count, which are exactly the fields a next step needs.
 *   - Anything else — prose, a diff, a log, a directory listing — gets a head
 *     and a tail rather than a head alone. The end of a log is where the error
 *     is, and the end of a diff is where the file it belongs to is named; a
 *     head-only cut reliably removes the half that was worth reading.
 *
 * Every path says what it dropped and in what unit, because "some of this is
 * missing" is what stops a model reporting three results as though they were
 * the whole answer. The note is prose *after* the JSON rather than an entry
 * inside it: a marker pushed into an array changes the type of its elements,
 * and a model that has been handed forty objects and a string has been given a
 * new bug to work around rather than a smaller answer.
 *
 * Deterministic and local, rather than the cheap-model summarisation pass the
 * issue also offers. Summarising costs a provider round trip inside a tool
 * loop the user is already watching an ellipsis through, it costs tokens
 * against the same budget this is trying to protect, and it puts a model's
 * paraphrase where the model below expects the server's own field names — a
 * summarised directory listing is no longer something you can call the next
 * tool with. This keeps the records verbatim and drops the ones that do not
 * fit, which is the property a chain actually needs.
 */

// Below this there is no room for two JSON records and a note, so the shapes
// below cannot produce anything more useful than a plain cut.
const MIN_STRUCTURED_LIMIT = 200;

// How much of a plain-text budget goes to the head. The head carries what the
// output *is* — the command, the header row, the first hits — and the tail
// carries how it ended, which is shorter and usually the error.
const HEAD_SHARE = 0.7;

// Elements kept from the front when an array has to lose its middle. Whatever
// the budget, a couple from each end says more about the shape of the answer
// than the same count taken from the front alone.
const MIN_HEAD_ITEMS = 1;
const MIN_TAIL_ITEMS = 1;

/** `value` as pretty JSON, or null when it will not serialise. */
function stringify(value) {
    try {
        const json = JSON.stringify(value, null, 1);
        return typeof json === 'string' ? json : null;
    } catch {
        return null;
    }
}

/**
 * `text` parsed as JSON, or null.
 *
 * Only a container is interesting: a bare string or number that is over the
 * limit is one long scalar, and there is nothing structural to drop out of it.
 */
function parseContainer(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
        const parsed = JSON.parse(trimmed);
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
}

/**
 * The largest number of elements from `items` whose serialisation fits, taken
 * from both ends, or null when not even the minimum does.
 *
 * A binary search rather than a loop that adds one element at a time: a tool
 * returning ten thousand rows would otherwise serialise the array ten thousand
 * times to find out where it stops fitting.
 */
function fitItems(items, wrap, limit) {
    const measure = count => {
        const head = Math.max(MIN_HEAD_ITEMS, Math.ceil(count * HEAD_SHARE));
        const kept = count >= items.length
            ? items
            : [...items.slice(0, head), ...items.slice(items.length - Math.max(MIN_TAIL_ITEMS, count - head))];
        const json = stringify(wrap(kept));
        return json === null ? null : { kept, json };
    };

    const smallest = measure(MIN_HEAD_ITEMS + MIN_TAIL_ITEMS);
    if (!smallest || smallest.json.length > limit) return null;

    let best = smallest;
    let low = MIN_HEAD_ITEMS + MIN_TAIL_ITEMS;
    let high = items.length - 1;

    while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        const attempt = measure(mid);
        if (attempt && attempt.json.length <= limit) {
            best = attempt;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return best;
}

/**
 * The note that goes after a trimmed result.
 *
 * It says the unit and both numbers, because "truncated" alone tells a model
 * that something stopped, not that it is holding three of fifty records — and
 * a model told the first is liable to answer as though it had all fifty.
 */
function note(kept, total, unit) {
    return `\n[trimmed to fit the reply: ${kept} of ${total} ${unit} shown, taken from the start and the end. `
        + 'Say so if the answer depends on what is missing, and narrow the call rather than guessing at it.]';
}

// The seam between the two halves, which is also what stops them reading as one
// continuous piece of output — two adjacent log lines a thousand lines apart.
function elision(count, unit) {
    return `\n[… ${count} ${unit} omitted …]\n`;
}

// The smallest thing that is still an honest answer, for a budget with no room
// for a sentence. Nine characters buys the difference between output the model
// knows is partial and output it will summarise as though it were whole.
const SHORT_MARKER = '\n[cut…]';

function shortCut(text, limit) {
    if (limit <= SHORT_MARKER.length) return text.slice(0, limit);
    return text.slice(0, limit - SHORT_MARKER.length) + SHORT_MARKER;
}

/** Whichever array property of `object` is longest, or null. */
function largestArrayKey(object) {
    let best = null;
    for (const [key, value] of Object.entries(object)) {
        if (Array.isArray(value) && (!best || value.length > object[best].length)) best = key;
    }
    return best && object[best].length > 1 ? best : null;
}

/**
 * Head and tail of `text` on line boundaries, for a result with no structure to
 * preserve.
 *
 * Snapping to a newline is what keeps the two halves readable — a cut mid-line
 * reads as a corrupted line rather than as an omission — and it is abandoned
 * when the nearest boundary is most of the budget away, which is the one-very-
 * long-line case where snapping would throw away the whole allowance.
 */
function headAndTail(text, limit, unit = 'characters') {
    // Both pieces of furniture are measured against their own upper bounds —
    // nothing shown can exceed `limit`, and nothing omitted can exceed the
    // whole text — so the reserve is never an under-estimate and the result
    // never exceeds the budget it was given.
    const reserve = note(limit, text.length, unit).length + elision(text.length, unit).length;
    const room = limit - reserve;
    // Not enough left for two halves and a sentence explaining them. The one
    // thing that still has to survive is the fact that something was dropped:
    // a result that fits exactly and says nothing about what it lost is the
    // failure this module exists to stop, and it is worse at a small budget
    // than a large one, because a small budget cuts more.
    if (room < 80) return shortCut(text, limit);

    const headRoom = Math.floor(room * HEAD_SHARE);
    const tailRoom = room - headRoom;

    let head = text.slice(0, headRoom);
    const headBreak = head.lastIndexOf('\n');
    if (headBreak > headRoom / 2) head = head.slice(0, headBreak);

    let tail = text.slice(text.length - tailRoom);
    const tailBreak = tail.indexOf('\n');
    if (tailBreak >= 0 && tailBreak < tailRoom / 2) tail = tail.slice(tailBreak + 1);

    const shown = head.length + tail.length;
    return head + elision(text.length - shown, unit) + tail + note(shown, text.length, unit);
}

/**
 * `text` cut to `limit` characters, dropping whole records where it can.
 *
 * Never returns more than `limit` from the structured paths; the plain-text
 * path is held to the same budget for its content and then adds its note, which
 * is the one thing worth going a line over — a result that fits exactly and
 * says nothing about what it lost is the failure this module exists to stop.
 */
function trimResult(text, limit) {
    if (typeof text !== 'string' || text.length <= limit || limit <= 0) return text;
    if (limit < MIN_STRUCTURED_LIMIT) return shortCut(text, limit);

    const parsed = parseContainer(text);

    if (Array.isArray(parsed) && parsed.length > 1) {
        const room = limit - note(limit, parsed.length, 'items').length;
        const fitted = room > 0 ? fitItems(parsed, kept => kept, room) : null;
        if (fitted) return fitted.json + note(fitted.kept.length, parsed.length, 'items');
    }

    if (parsed && !Array.isArray(parsed)) {
        const key = largestArrayKey(parsed);
        if (key) {
            const items = parsed[key];
            const room = limit - note(limit, items.length, `${key} entries`).length;
            const fitted = room > 0 ? fitItems(items, kept => ({ ...parsed, [key]: kept }), room) : null;
            // The scalars beside the array — a total, a next cursor — are what a
            // following step needs, and they survive here where a byte-slice
            // would have taken whichever of them sorted last.
            if (fitted) return fitted.json + note(fitted.kept.length, items.length, `${key} entries`);
        }
    }

    return headAndTail(text, limit);
}

module.exports = { trimResult, headAndTail, MIN_STRUCTURED_LIMIT, HEAD_SHARE, SHORT_MARKER };
