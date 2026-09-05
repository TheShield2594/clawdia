'use strict';

const { guardedDispatcher, assertPublicHttpUrl } = require('../../utils/outboundGuard');
const { request, discardBody, readCapped } = require('../../utils/httpFetch');

/**
 * Image attachments, on their way from a Discord message to a model (#839).
 *
 * A user posting a screenshot and asking "what's wrong with this?" used to get
 * an answer to the text alone: `message.attachments` was never read, so the
 * question arrived at the provider with its subject missing. This module is the
 * transport half of the fix — which attachments are eligible, what they cost,
 * and getting the bytes — and each provider module owns the wire shape it puts
 * them in, the same way it already owns its tool-definition shape.
 *
 * Three things are bounded here, because image tokens are the most expensive
 * input a message can carry:
 *
 *   - how many images one message may send (MAX_IMAGES). This is the answer to
 *     the rate-limit question: a message stays one slot in the guild's AI
 *     allowance, and what a slot can cost is capped instead. A guild that
 *     allows ten messages does not want the eleventh refused because somebody
 *     dragged in a photo album.
 *   - how large one may be (MAX_IMAGE_BYTES), checked against Discord's
 *     declared size before fetching and against the actual body after, since
 *     the declared size is somebody else's number.
 *   - how large all of them may be together (MAX_TOTAL_BYTES).
 *
 * The URLs come from Discord's own CDN, and are still checked as though they
 * did not: a plain http(s) URL, not a literal private address, dialled through
 * the dispatcher that refuses to open a socket into private or reserved space. An
 * attachment URL is not user-typed today, but this module hands whatever it is
 * given to an HTTP client, and it should not be one refactor away from fetching
 * the metadata service on somebody's say-so.
 */

// What a provider can be asked to look at. An allow list rather than
// `contentType.startsWith('image/')`: SVG is a document with a script in it,
// TIFF and BMP are accepted by nobody here, and every format below is one all
// four vision-capable providers understand (Gemini excepted for GIF, which it
// drops itself).
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

// Filename extensions, for the attachment Discord did not label. Rare, but a
// missing `contentType` should not cost the user their screenshot.
const EXTENSION_MIME = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif'
};

// Per message. Three is enough for "here are the before and after and the
// error", and each one is roughly a thousand input tokens before anybody has
// typed a word — see budget.js, which charges them against the context window.
const MAX_IMAGES = 3;

// Per image and for the message. 5MB is the ceiling Anthropic documents for an
// image in a request, and the smallest of the four, so it is the one that
// matters.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;

// The user is watching a typing indicator while this runs, and the CDN serving
// these is the one that just served them to Discord.
const FETCH_TIMEOUT_MS = 10_000;

/** The mime type for one attachment, or null when it is not an image we take. */
function mimeTypeOf(attachment) {
    const declared = String(attachment?.contentType || '').split(';')[0].trim().toLowerCase();
    if (IMAGE_MIME_TYPES.has(declared)) return declared;
    if (declared) return null;

    const ext = String(attachment?.name || '').toLowerCase().split('.').pop();
    const guessed = EXTENSION_MIME[ext];
    return guessed && IMAGE_MIME_TYPES.has(guessed) ? guessed : null;
}

/**
 * The image attachments on a message, and what was left behind.
 *
 * `skipped` is a count rather than a list: it exists so the model can be told
 * "there was an image here you cannot see" instead of confidently answering a
 * question about something it was never shown, and a count is all that sentence
 * needs.
 */
function collectImages(message) {
    const all = message?.attachments;
    const list = all ? (typeof all.values === 'function' ? [...all.values()] : [...all]) : [];

    const images = [];
    let skipped = 0;
    let bytes = 0;

    for (const attachment of list) {
        const mimeType = mimeTypeOf(attachment);
        const url = attachment?.url;
        if (!mimeType || !url) {
            // Only images are counted as missed. A user attaching a .zip and
            // asking an unrelated question has not lost anything.
            if (mimeType) skipped++;
            continue;
        }
        const size = Number(attachment.size) || 0;
        if (size > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES || bytes + size > MAX_TOTAL_BYTES) {
            skipped++;
            continue;
        }
        bytes += size;
        images.push({ url, mimeType, name: attachment.name || 'image', size });
    }

    return { images, skipped };
}

/**
 * Fetch the bytes, base64 them, and drop whatever did not arrive.
 *
 * Every provider here takes an image inline. Anthropic and OpenAI would also
 * take the URL and fetch it themselves, which would save this round trip — and
 * would mean two of the four providers depending on a signed CDN link staying
 * valid for as long as somebody else's queue takes, with a failure that surfaces
 * as an opaque 400. One code path, and the bytes are in hand before the request
 * is made.
 *
 * A fetch that fails costs its image and nothing else: the question still
 * reaches the model, and `skipped` grows so it can be told what is missing.
 */
async function fetchImages(images) {
    const loaded = [];
    let skipped = 0;
    let bytes = 0;

    for (const image of images) {
        try {
            // Throws for a scheme that is not http(s), or a literal address in
            // private or reserved space; the dispatcher below covers the
            // hostname that only resolves there sometimes, and every redirect
            // hop.
            assertPublicHttpUrl(image.url, 'attachment URL');
            const response = await request(image.url, {
                timeout: FETCH_TIMEOUT_MS,
                dispatcher: guardedDispatcher()
            });
            if (!response.ok) {
                await discardBody(response);
                throw new Error(`HTTP ${response.status}`);
            }
            // `readCapped` stops reading at the ceiling rather than buffering
            // whatever arrives and measuring it afterwards, so an attachment
            // that is larger than it claimed costs the read and not the memory.
            const buffer = await readCapped(response, MAX_IMAGE_BYTES);
            // Discord's declared size is somebody else's number, and the total
            // across the message is checked here rather than per image.
            if (!buffer.length || bytes + buffer.length > MAX_TOTAL_BYTES) {
                skipped++;
                continue;
            }
            bytes += buffer.length;
            loaded.push({ ...image, base64: buffer.toString('base64') });
        } catch (err) {
            console.warn(`[AI vision] could not read attachment ${image.name}: ${err.message}`);
            skipped++;
        }
    }

    return { images: loaded, skipped };
}

/**
 * Turn what `collectImages` found into what the provider will be given.
 *
 * `supported` is the provider's answer for the configured model, asked by the
 * caller: a model that cannot see is not worth the download, and the user is
 * still owed the note saying their screenshot did not make it.
 *
 * Two steps rather than one so the cheap half can run early — whether there is
 * an image at all decides whether a message with no text is a question — and
 * the network half runs where the rest of the turn's round trips do.
 */
async function loadImages(found, { supported = false } = {}) {
    const images = found?.images || [];
    const skipped = found?.skipped || 0;
    if (!images.length) return { images: [], skipped, unsupported: 0 };
    if (!supported) return { images: [], skipped, unsupported: images.length };

    const fetched = await fetchImages(images);
    return { images: fetched.images, skipped: skipped + fetched.skipped, unsupported: 0 };
}

/**
 * The line that tells the model what it is not being shown, or ''.
 *
 * Without it a model asked "what's wrong with this?" alongside an image it
 * never received will answer anyway, from the text and its imagination. With
 * it, the user is told the truth — that the picture did not make it — which is
 * the only useful answer available.
 */
function visionNotice({ skipped = 0, unsupported = 0 } = {}) {
    if (!skipped && !unsupported) return '';

    const missing = skipped + unsupported;
    const reason = unsupported
        ? 'the configured model cannot read images'
        : 'they could not be attached (too large, too many, or an unsupported format)';
    return `\n\n---\nThe user's message carried ${missing} image attachment${missing === 1 ? '' : 's'} `
        + `that ${missing === 1 ? 'is' : 'are'} not included in this conversation, because ${reason}. `
        + 'Do not guess at what it shows — say plainly that you cannot see it.';
}

/** A data URL, for the providers whose image block is spelled as one. */
function dataUrl(image) {
    return `data:${image.mimeType};base64,${image.base64}`;
}

module.exports = {
    collectImages,
    fetchImages,
    loadImages,
    visionNotice,
    dataUrl,
    mimeTypeOf,
    IMAGE_MIME_TYPES,
    MAX_IMAGES,
    MAX_IMAGE_BYTES,
    MAX_TOTAL_BYTES
};
