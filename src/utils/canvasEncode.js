'use strict';

/**
 * Encodes a node-canvas surface without blocking the event loop.
 *
 * `canvas.toBuffer()` — the argument-less form, and the `toBuffer('image/png')`
 * form — is a fully synchronous encode. It is not a cheap one: the 800×300
 * welcome card measures around 10 ms, more once a real avatar has been
 * composited in, and every millisecond of it is a millisecond the gateway
 * cannot read a heartbeat (#592).
 *
 * node-canvas also exposes a callback form, and that one hands the PNG encode
 * to libuv's thread pool. The pixels are still drawn on the main thread — that
 * part is the canvas API and cannot move — but the encode, which is the
 * expensive half, stops being ours.
 */

/**
 * @param {import('canvas').Canvas} canvas
 * @param {string} [mimeType] anything node-canvas encodes; only PNG is used here.
 * @returns {Promise<Buffer>}
 */
function encodeCanvas(canvas, mimeType = 'image/png') {
    return new Promise((resolve, reject) => {
        canvas.toBuffer((err, buffer) => {
            if (err) return reject(err);
            resolve(buffer);
        }, mimeType);
    });
}

module.exports = { encodeCanvas };
